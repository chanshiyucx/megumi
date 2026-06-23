use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::{AuthorManifest, BuildState, ComicState, ComicSummaryManifest, FileState, RemoteTags};

const DATABASE_FILE: &str = ".megumi/state.sqlite3";
const SCHEMA_VERSION: i64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitKind {
    Comic,
    Author,
}

impl UnitKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Comic => "comic",
            Self::Author => "author",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "comic" => Ok(Self::Comic),
            "author" => Ok(Self::Author),
            _ => bail!("unknown cached unit kind: {value}"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CachedUnit {
    pub key: String,
    pub library_key: String,
    pub library_title: String,
    pub title: String,
    pub kind: UnitKind,
    pub comic: Option<ComicSummaryManifest>,
    pub author: Option<AuthorManifest>,
}

pub struct UnitIdentity<'a> {
    pub key: &'a str,
    pub library_key: &'a str,
    pub library_title: &'a str,
    pub title: &'a str,
}

pub struct ComicCommit<'a> {
    pub unit: UnitIdentity<'a>,
    pub summary: &'a ComicSummaryManifest,
    pub files: &'a [(String, FileState)],
    pub comic_state: &'a ComicState,
}

pub struct AuthorCommit<'a> {
    pub unit: UnitIdentity<'a>,
    pub author: &'a AuthorManifest,
    pub files: &'a [(String, FileState)],
}

pub struct StateDb {
    connection: Connection,
    rebuilt: bool,
}

impl StateDb {
    pub fn open(output: &Path) -> Result<Self> {
        let path = output.join(DATABASE_FILE);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create state directory: {}", parent.display()))?;
        }

        let existed = path.exists();
        let mut rebuilt = false;
        if existed && !database_is_usable(&path) {
            backup_database(&path)?;
            rebuilt = true;
        }

        let connection = Connection::open(&path)
            .with_context(|| format!("open build state: {}", path.display()))?;
        configure_connection(&connection)?;

        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .context("read build state schema version")?;
        if version != 0 && version != SCHEMA_VERSION {
            drop(connection);
            backup_database(&path)?;
            rebuilt = true;
            return Self::open_fresh(path, rebuilt);
        }

        initialize_schema(&connection)?;
        Ok(Self {
            connection,
            rebuilt,
        })
    }

    fn open_fresh(path: PathBuf, rebuilt: bool) -> Result<Self> {
        let connection = Connection::open(&path)
            .with_context(|| format!("create build state: {}", path.display()))?;
        configure_connection(&connection)?;
        initialize_schema(&connection)?;
        Ok(Self {
            connection,
            rebuilt,
        })
    }

    pub fn was_rebuilt(&self) -> bool {
        self.rebuilt
    }

    pub fn mark_initialized(&mut self) -> Result<()> {
        let transaction = self.connection.transaction()?;
        set_meta(&transaction, "initialized", "1")?;
        transaction.commit()?;
        Ok(())
    }

    pub fn record_full_scan(&mut self, full_scan_ms: u64) -> Result<()> {
        let transaction = self.connection.transaction()?;
        set_meta(&transaction, "last_full_scan_ms", &full_scan_ms.to_string())?;
        transaction.commit()?;
        Ok(())
    }

    pub fn last_full_scan_ms(&self) -> Result<Option<u64>> {
        self.meta("last_full_scan_ms")?
            .map(|value| {
                value
                    .parse()
                    .with_context(|| format!("parse last full scan timestamp: {value}"))
            })
            .transpose()
    }

    pub fn event_cursor(&self) -> Result<Option<u64>> {
        self.meta("fsevent_cursor")?
            .map(|value| {
                value
                    .parse()
                    .with_context(|| format!("parse FSEvents cursor: {value}"))
            })
            .transpose()
    }

    pub fn volume_device(&self) -> Result<Option<u64>> {
        self.meta("volume_device")?
            .map(|value| {
                value
                    .parse()
                    .with_context(|| format!("parse cached volume device: {value}"))
            })
            .transpose()
    }

    pub fn set_volume_device(&mut self, device: u64) -> Result<()> {
        let transaction = self.connection.transaction()?;
        set_meta(&transaction, "volume_device", &device.to_string())?;
        transaction.commit()?;
        Ok(())
    }

    pub fn set_event_cursor(&mut self, cursor: u64) -> Result<()> {
        let transaction = self.connection.transaction()?;
        set_meta(&transaction, "fsevent_cursor", &cursor.to_string())?;
        transaction.commit()?;
        Ok(())
    }

    pub fn enqueue_changes(&mut self, unit_keys: &[String], cursor: u64) -> Result<()> {
        let transaction = self.connection.transaction()?;
        for key in unit_keys {
            transaction.execute(
                "INSERT OR IGNORE INTO dirty_units(unit_key) VALUES (?1)",
                [key],
            )?;
        }
        set_meta(&transaction, "fsevent_cursor", &cursor.to_string())?;
        transaction.commit()?;
        Ok(())
    }

    pub fn dirty_units(&self) -> Result<Vec<String>> {
        let mut statement = self
            .connection
            .prepare("SELECT unit_key FROM dirty_units ORDER BY unit_key")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("read dirty content units")
    }

    pub fn load_build_state(&self) -> Result<BuildState> {
        let mut files = BTreeMap::new();
        let mut statement = self
            .connection
            .prepare("SELECT path, size, mtime_ms, width, height FROM files ORDER BY path")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                FileState {
                    size: row.get(1)?,
                    mtime_ms: row.get(2)?,
                    width: row.get(3)?,
                    height: row.get(4)?,
                },
            ))
        })?;
        for row in rows {
            let (path, state) = row?;
            files.insert(path, state);
        }

        let mut comics = BTreeMap::new();
        let mut statement = self
            .connection
            .prepare("SELECT unit_key, detail_key, fingerprint FROM comics ORDER BY unit_key")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                ComicState {
                    detail_key: row.get(1)?,
                    fingerprint: row.get(2)?,
                },
            ))
        })?;
        for row in rows {
            let (key, state) = row?;
            comics.insert(key, state);
        }

        let applied_tags = self
            .meta("applied_tags")?
            .map(|json| serde_json::from_str(&json).context("parse cached applied tags"))
            .transpose()?;
        Ok(BuildState {
            files,
            comics,
            applied_tags,
        })
    }

    pub fn load_units(&self) -> Result<Vec<CachedUnit>> {
        let mut statement = self.connection.prepare(
            "SELECT unit_key, library_key, library_title, title, kind, result_json
             FROM units WHERE result_json IS NOT NULL ORDER BY unit_key",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;
        let mut units = Vec::new();
        for row in rows {
            let (key, library_key, library_title, title, kind, result_json) = row?;
            let kind = UnitKind::parse(&kind)?;
            let (comic, author) = match kind {
                UnitKind::Comic => (
                    Some(
                        serde_json::from_str(&result_json)
                            .with_context(|| format!("parse cached comic summary for {key}"))?,
                    ),
                    None,
                ),
                UnitKind::Author => (
                    None,
                    Some(
                        serde_json::from_str(&result_json)
                            .with_context(|| format!("parse cached author summary for {key}"))?,
                    ),
                ),
            };
            units.push(CachedUnit {
                key,
                library_key,
                library_title,
                title,
                kind,
                comic,
                author,
            });
        }
        Ok(units)
    }

    pub fn save_comic(&mut self, commit: ComicCommit<'_>) -> Result<()> {
        let unit = commit.unit;
        let transaction = self.connection.transaction()?;
        upsert_unit(
            &transaction,
            unit.key,
            unit.library_key,
            unit.library_title,
            unit.title,
            UnitKind::Comic,
            &serde_json::to_string(commit.summary)?,
        )?;
        replace_unit_files(&transaction, unit.key, commit.files)?;
        transaction.execute(
            "INSERT INTO comics(unit_key, detail_key, fingerprint) VALUES (?1, ?2, ?3)
             ON CONFLICT(unit_key) DO UPDATE SET detail_key=excluded.detail_key,
             fingerprint=excluded.fingerprint",
            params![
                unit.key,
                commit.comic_state.detail_key,
                commit.comic_state.fingerprint
            ],
        )?;
        transaction.execute("DELETE FROM dirty_units WHERE unit_key = ?1", [unit.key])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn save_author(&mut self, commit: AuthorCommit<'_>) -> Result<()> {
        let unit = commit.unit;
        let transaction = self.connection.transaction()?;
        upsert_unit(
            &transaction,
            unit.key,
            unit.library_key,
            unit.library_title,
            unit.title,
            UnitKind::Author,
            &serde_json::to_string(commit.author)?,
        )?;
        replace_unit_files(&transaction, unit.key, commit.files)?;
        transaction.execute("DELETE FROM comics WHERE unit_key = ?1", [unit.key])?;
        transaction.execute("DELETE FROM dirty_units WHERE unit_key = ?1", [unit.key])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn remove_unit(&mut self, unit_key: &str) -> Result<()> {
        let transaction = self.connection.transaction()?;
        transaction.execute("DELETE FROM units WHERE unit_key = ?1", [unit_key])?;
        transaction.execute("DELETE FROM dirty_units WHERE unit_key = ?1", [unit_key])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn set_applied_tags(&mut self, tags: Option<&RemoteTags>) -> Result<()> {
        let transaction = self.connection.transaction()?;
        match tags {
            Some(tags) => set_meta(&transaction, "applied_tags", &serde_json::to_string(tags)?)?,
            None => {
                transaction.execute("DELETE FROM metadata WHERE key='applied_tags'", [])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    fn meta(&self, key: &str) -> Result<Option<String>> {
        self.connection
            .query_row("SELECT value FROM metadata WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .optional()
            .with_context(|| format!("read build metadata: {key}"))
    }
}

fn database_is_usable(path: &Path) -> bool {
    let Ok(connection) = Connection::open(path) else {
        return false;
    };
    let check = connection.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0));
    matches!(check, Ok(value) if value == "ok")
}

fn configure_connection(connection: &Connection) -> Result<()> {
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .context("enable SQLite WAL mode")?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .context("set SQLite synchronous mode")?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .context("enable SQLite foreign keys")?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .context("set SQLite busy timeout")?;
    Ok(())
}

fn backup_database(path: &Path) -> Result<()> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let backup = path.with_extension(format!("sqlite3.corrupt-{timestamp}"));
    fs::rename(path, &backup)
        .with_context(|| format!("preserve unusable build state as {}", backup.display()))?;
    for suffix in ["-wal", "-shm"] {
        let companion = PathBuf::from(format!("{}{suffix}", path.display()));
        if companion.exists() {
            let _ = fs::remove_file(companion);
        }
    }
    eprintln!(
        "warning: build state was unusable; preserved it as {} and will rebuild",
        backup.display()
    );
    Ok(())
}

fn initialize_schema(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(&format!(
            "BEGIN;
         CREATE TABLE IF NOT EXISTS metadata(
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS units(
             unit_key TEXT PRIMARY KEY,
             library_key TEXT NOT NULL,
             library_title TEXT NOT NULL,
             title TEXT NOT NULL,
             kind TEXT NOT NULL CHECK(kind IN ('comic', 'author')),
             result_json TEXT
         );
         CREATE TABLE IF NOT EXISTS files(
             path TEXT PRIMARY KEY,
             unit_key TEXT NOT NULL REFERENCES units(unit_key) ON DELETE CASCADE,
             size INTEGER NOT NULL,
             mtime_ms INTEGER NOT NULL,
             width INTEGER,
             height INTEGER
         );
         CREATE INDEX IF NOT EXISTS files_unit_key ON files(unit_key);
         CREATE TABLE IF NOT EXISTS comics(
             unit_key TEXT PRIMARY KEY REFERENCES units(unit_key) ON DELETE CASCADE,
             detail_key TEXT NOT NULL,
             fingerprint TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS dirty_units(
             unit_key TEXT PRIMARY KEY
         );
         PRAGMA user_version={SCHEMA_VERSION};
         COMMIT;"
        ))
        .context("initialize build state schema")?;
    Ok(())
}

fn set_meta(transaction: &Transaction<'_>, key: &str, value: &str) -> Result<()> {
    transaction.execute(
        "INSERT INTO metadata(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn replace_unit_files(
    transaction: &Transaction<'_>,
    unit_key: &str,
    files: &[(String, FileState)],
) -> Result<()> {
    transaction.execute("DELETE FROM files WHERE unit_key=?1", [unit_key])?;
    let mut statement = transaction.prepare(
        "INSERT INTO files(path, unit_key, size, mtime_ms, width, height)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for (path, state) in files {
        statement.execute(params![
            path,
            unit_key,
            state.size,
            state.mtime_ms,
            state.width,
            state.height
        ])?;
    }
    Ok(())
}

fn upsert_unit(
    transaction: &Transaction<'_>,
    unit_key: &str,
    library_key: &str,
    library_title: &str,
    title: &str,
    kind: UnitKind,
    result_json: &str,
) -> Result<()> {
    transaction.execute(
        "INSERT INTO units(unit_key, library_key, library_title, title, kind, result_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(unit_key) DO UPDATE SET library_key=excluded.library_key,
         library_title=excluded.library_title, title=excluded.title, kind=excluded.kind,
         result_json=excluded.result_json",
        params![
            unit_key,
            library_key,
            library_title,
            title,
            kind.as_str(),
            result_json
        ],
    )?;
    Ok(())
}

pub fn now_ms() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| anyhow!("system clock is before Unix epoch: {error}"))?
        .as_millis()
        .try_into()
        .map_err(|_| anyhow!("current timestamp does not fit in u64"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commits_a_comic_as_one_unit() {
        let root = std::env::temp_dir().join(format!("megumi-state-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let mut db = StateDb::open(&root).unwrap();
        let summary = ComicSummaryManifest {
            title: "One".into(),
            cover_key: "thumbnail/Comics/One/001.webp".into(),
            cover_mtime_ms: 1,
            detail_version: "abc".into(),
        };
        let comic = ComicState {
            detail_key: "manifests/Comics/One.json".into(),
            fingerprint: "abc".into(),
        };
        let files = [(
            "Comics/One/001.jpg".into(),
            FileState {
                size: 10,
                mtime_ms: 1,
                width: Some(10),
                height: Some(20),
            },
        )];
        db.save_comic(ComicCommit {
            unit: UnitIdentity {
                key: "Comics/One",
                library_key: "Comics",
                library_title: "Comics",
                title: "One",
            },
            summary: &summary,
            files: &files,
            comic_state: &comic,
        })
        .unwrap();

        assert_eq!(db.load_units().unwrap().len(), 1);
        assert_eq!(db.load_build_state().unwrap().files.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn removing_a_unit_cascades_files_and_comic_state() {
        let root =
            std::env::temp_dir().join(format!("megumi-state-test-{}-cascade", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let mut db = StateDb::open(&root).unwrap();
        let summary = ComicSummaryManifest {
            title: "One".into(),
            cover_key: "thumbnail/Comics/One/001.webp".into(),
            cover_mtime_ms: 1,
            detail_version: "abc".into(),
        };
        let comic = ComicState {
            detail_key: "manifests/Comics/One.json".into(),
            fingerprint: "abc".into(),
        };
        let files = [(
            "Comics/One/001.jpg".into(),
            FileState {
                size: 10,
                mtime_ms: 1,
                width: Some(10),
                height: Some(20),
            },
        )];
        db.save_comic(ComicCommit {
            unit: UnitIdentity {
                key: "Comics/One",
                library_key: "Comics",
                library_title: "Comics",
                title: "One",
            },
            summary: &summary,
            files: &files,
            comic_state: &comic,
        })
        .unwrap();

        db.remove_unit("Comics/One").unwrap();

        let state = db.load_build_state().unwrap();
        assert!(db.load_units().unwrap().is_empty());
        assert!(state.files.is_empty());
        assert!(state.comics.is_empty());
        let _ = fs::remove_dir_all(root);
    }
}
