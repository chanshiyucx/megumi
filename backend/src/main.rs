use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Cursor, Write};
use std::os::raw::c_int;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use clap::{Parser, Subcommand};
use fast_image_resize as fr;
use image::ImageReader;
use memmap2::Mmap;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use turbojpeg::{Decompressor, Image as JpegImage, PixelFormat, ScalingFactor};
mod fsevents;
mod state;

const MANIFEST_FILE: &str = "manifest.json";
const COMIC_MANIFEST_DIR: &str = "manifests";
const TAGS_FILE: &str = ".megumi/tags.json";
const BUILD_LOCK_FILE: &str = ".megumi/build.lock";
const THUMBNAIL_DIR: &str = "thumbnail";
const SCHEMA_VERSION: u32 = 5;
const THUMBNAIL_WIDTH: u32 = 256;
const THUMBNAIL_QUALITY: u8 = 72;
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png"];
const BOOK_EXTENSIONS: &[&str] = &["txt"];
const VIDEO_EXTENSIONS: &[&str] = &["mp4"];
const FULL_SCAN_INTERVAL_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const MAX_THUMBNAIL_WORKERS: usize = 8;
#[cfg(target_os = "macos")]
const TAG_KEY: &str = "com.apple.metadata:_kMDItemUserTags";
#[cfg(target_os = "macos")]
const FINDER_INFO_KEY: &str = "com.apple.FinderInfo";
#[cfg(target_os = "macos")]
const STAR_TAG_NAME: &str = "STAR";
#[cfg(target_os = "macos")]
const STAR_TAG_VALUE: &str = "STAR\n5";
#[cfg(target_os = "macos")]
const DELETE_TAG_NAME: &str = "DELETE";
#[cfg(target_os = "macos")]
const DELETE_TAG_VALUE: &str = "DELETE\n6";
static THUMB_TMP_SEQ: AtomicU64 = AtomicU64::new(0);
static JSON_TMP_SEQ: AtomicU64 = AtomicU64::new(0);
static INTERRUPT_COUNT: AtomicUsize = AtomicUsize::new(0);
static INTERRUPT_HANDLER: OnceLock<()> = OnceLock::new();

unsafe extern "C" {
    fn kill(pid: c_int, sig: c_int) -> c_int;
}

#[derive(Parser)]
#[command(name = "megumi-backend")]
#[command(about = "Build static reader assets and manifest for Megumi")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Scan a source directory and build static reader assets in place.
    Build(BuildArgs),
}

#[derive(Parser, Debug)]
struct BuildArgs {
    /// Resource root whose immediate child directories are libraries.
    #[arg(short, long, default_value = ".")]
    source: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    generated_at: String,
    libraries: Vec<LibraryManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[serde(deny_unknown_fields)]
enum LibraryManifest {
    Comic {
        title: String,
        comics: Vec<ComicSummaryManifest>,
    },
    Book {
        title: String,
        authors: Vec<AuthorManifest>,
    },
    Video {
        title: String,
        videos: Vec<VideoManifest>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct VideoManifest {
    title: String,
    key: String,
    cover_key: String,
    mtime_ms: u64,
    size: u64,
    width: u32,
    height: u32,
    duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct ComicSummaryManifest {
    title: String,
    cover_key: String,
    cover_mtime_ms: u64,
    detail_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComicManifest {
    schema_version: u32,
    title: String,
    pages: Vec<PageManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageManifest {
    key: String,
    thumbnail_key: String,
    width: u32,
    height: u32,
    mtime_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct AuthorManifest {
    name: String,
    books: Vec<BookManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct BookManifest {
    title: String,
    key: String,
    mtime_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookDetailManifest {
    schema_version: u32,
    title: String,
    line_count: usize,
    chapters: Vec<ChapterManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChapterManifest {
    title: String,
    line_index: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
struct FileTags {
    starred: Option<bool>,
    deleted: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct RemoteTags {
    version: u32,
    #[serde(default)]
    comics: BTreeMap<String, FileTags>,
    #[serde(default)]
    books: BTreeMap<String, FileTags>,
    #[serde(default)]
    videos: BTreeMap<String, FileTags>,
    #[serde(default)]
    images: BTreeMap<String, FileTags>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct BuildState {
    files: BTreeMap<String, FileState>,
    comics: BTreeMap<String, ComicState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    applied_tags: Option<RemoteTags>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileState {
    size: u64,
    mtime_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComicState {
    detail_key: String,
    fingerprint: String,
}

struct ProcessedImage {
    page: PageManifest,
    state_key: String,
    state: FileState,
}

struct ComicScan {
    path: PathBuf,
    rel: String,
    title: String,
    image_count: usize,
}

struct AuthorScan {
    name: String,
    book_paths: Vec<PathBuf>,
}

struct VideoScan {
    path: PathBuf,
    rel: String,
    title: String,
}

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    #[serde(default)]
    streams: Vec<FfprobeStream>,
    format: Option<FfprobeFormat>,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
}

struct ThumbnailWorker {
    decompressor: Option<Decompressor>,
    resizer: fr::Resizer,
}

impl ThumbnailWorker {
    fn new() -> Self {
        Self {
            decompressor: Decompressor::new().ok(),
            resizer: fr::Resizer::new(),
        }
    }
}

#[derive(Debug)]
struct BuildProgress {
    built_thumbnails: AtomicUsize,
    reused_thumbnails: AtomicUsize,
    synced_tag_targets: AtomicUsize,
    changed_tag_targets: AtomicUsize,
}

impl BuildProgress {
    fn new() -> Self {
        Self {
            built_thumbnails: AtomicUsize::new(0),
            reused_thumbnails: AtomicUsize::new(0),
            synced_tag_targets: AtomicUsize::new(0),
            changed_tag_targets: AtomicUsize::new(0),
        }
    }

    fn record_processed(&self, thumbnail_built: bool) {
        if thumbnail_built {
            self.built_thumbnails.fetch_add(1, Ordering::Relaxed);
        } else {
            self.reused_thumbnails.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn record_tag_sync(&self, changed: bool) {
        self.synced_tag_targets.fetch_add(1, Ordering::Relaxed);
        if changed {
            self.changed_tag_targets.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn snapshot(&self) -> BuildProgressSnapshot {
        BuildProgressSnapshot {
            built_thumbnails: self.built_thumbnails.load(Ordering::Relaxed),
            reused_thumbnails: self.reused_thumbnails.load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug)]
struct BuildProgressSnapshot {
    built_thumbnails: usize,
    reused_thumbnails: usize,
}

#[derive(Debug)]
struct BuildContext {
    source: PathBuf,
    output: PathBuf,
    previous_state: BuildState,
    next_state: BuildState,
    progress: BuildProgress,
    remote_tags: Option<RemoteTags>,
    recovery_image_mtimes: BTreeMap<String, u64>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Build(args) => build(args),
    }
}

fn build(args: BuildArgs) -> Result<()> {
    let build_started = Instant::now();
    install_interrupt_handler()?;
    INTERRUPT_COUNT.store(0, Ordering::SeqCst);
    let source = args
        .source
        .canonicalize()
        .with_context(|| format!("source directory does not exist: {}", args.source.display()))?;
    if !source.is_dir() {
        bail!("source is not a directory: {}", source.display());
    }

    let _build_lock = acquire_build_lock(&source)?;
    let output = source.clone();
    let phase_started = Instant::now();
    let mut database = state::StateDb::open(&output)?;
    log_phase_elapsed("state open", phase_started);
    let now_ms = state::now_ms()?;
    let volume_device = source.metadata()?.dev();
    let volume_changed = database
        .volume_device()?
        .is_some_and(|previous| previous != volume_device);
    let previous_cursor = database.event_cursor()?;
    let periodic_scan_due = database
        .last_full_scan_ms()?
        .is_none_or(|last| now_ms.saturating_sub(last) >= FULL_SCAN_INTERVAL_MS);
    let mut full_scan =
        database.was_rebuilt() || previous_cursor.is_none() || periodic_scan_due || volume_changed;
    let mut cursor = fsevents::current_cursor();

    let phase_started = Instant::now();
    if let Some(previous_cursor) = previous_cursor
        && !full_scan
    {
        match fsevents::changes_since(&source, previous_cursor) {
            Ok(changes) if !changes.requires_full_scan => {
                cursor = changes.cursor.max(cursor);
                database
                    .enqueue_changes(&changes.unit_keys.into_iter().collect::<Vec<_>>(), cursor)?;
            }
            Ok(_) => {
                eprintln!("warning: FSEvents history is incomplete; performing a full scan");
                full_scan = true;
            }
            Err(error) => {
                eprintln!(
                    "warning: cannot read FSEvents history ({error:#}); performing a full scan"
                );
                full_scan = true;
            }
        }
    }
    log_phase_elapsed("change detection", phase_started);

    let phase_started = Instant::now();
    let cached_units = database
        .load_units()?
        .into_iter()
        .map(|unit| (unit.key.clone(), unit))
        .collect::<BTreeMap<_, _>>();
    let dirty_units = database.dirty_units()?.into_iter().collect::<BTreeSet<_>>();
    log_phase_elapsed("state index load", phase_started);

    let phase_started = Instant::now();
    let discovery = discover_units(&source, &cached_units, &dirty_units, full_scan)?;
    for removed in &discovery.removed_units {
        database.remove_unit(removed)?;
    }
    let work_keys = discovery
        .work
        .iter()
        .map(UnitWork::key)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    database.enqueue_changes(&work_keys, cursor)?;
    if full_scan {
        eprintln!("full scan scheduled {} content units", work_keys.len());
    } else {
        eprintln!(
            "incremental scan scheduled {} content units",
            work_keys.len()
        );
    }
    log_phase_elapsed("discovery", phase_started);

    let phase_started = Instant::now();
    let previous_state = database.load_build_state()?;
    let remote_tags = load_remote_tags(&source)?;
    let applied_tags = remote_tags
        .clone()
        .or_else(|| previous_state.applied_tags.clone());
    let recovery_image_mtimes = if previous_state.files.is_empty() {
        load_published_image_mtimes(&output)?
    } else {
        BTreeMap::new()
    };
    let mut next_state = previous_state.clone();
    next_state.applied_tags = applied_tags;
    let mut ctx = BuildContext {
        source: source.clone(),
        output: output.clone(),
        previous_state,
        next_state,
        progress: BuildProgress::new(),
        remote_tags,
        recovery_image_mtimes,
    };
    log_phase_elapsed("build state load", phase_started);

    let phase_started = Instant::now();
    sync_cached_tag_changes(&ctx, &cached_units)?;
    log_phase_elapsed("tag sync", phase_started);

    let thumbnail_pool = rayon::ThreadPoolBuilder::new()
        .num_threads(recommended_thumbnail_workers())
        .build()
        .context("create thumbnail worker pool")?;
    if discovery
        .work
        .iter()
        .any(|work| matches!(work, UnitWork::Video { .. }))
    {
        ensure_video_tools()?;
    }
    let phase_started = Instant::now();
    let mut errors = Vec::new();
    let mut skipped_videos = Vec::new();
    for work in discovery.work {
        if INTERRUPT_COUNT.load(Ordering::SeqCst) > 0 {
            eprintln!("interrupt requested; stopping before the next content unit");
            errors.push("build interrupted".to_string());
            break;
        }
        let result = match work {
            UnitWork::Comic {
                library_key,
                library_title,
                scan,
                image_paths,
            } => build_comic_unit(
                &mut ctx,
                &mut database,
                &thumbnail_pool,
                &library_key,
                &library_title,
                scan,
                image_paths,
            ),
            UnitWork::Author {
                key,
                library_key,
                library_title,
                scan,
            } => build_author_unit(
                &mut ctx,
                &mut database,
                &key,
                &library_key,
                &library_title,
                scan,
            ),
            UnitWork::Video {
                library_key,
                library_title,
                scan,
            } => {
                let unit_key = scan.rel.clone();
                match build_video_unit(&mut ctx, &mut database, &library_key, &library_title, scan)
                {
                    Ok(()) => Ok(()),
                    Err(error) => {
                        eprintln!("warning: skipping video [{unit_key}]: {error:#}");
                        database.remove_unit(&unit_key)?;
                        remove_unit_from_memory_state(&mut ctx.next_state, &unit_key);
                        skipped_videos.push(unit_key);
                        Ok(())
                    }
                }
            }
        };
        if let Err(error) = result {
            eprintln!("error: {error:#}");
            errors.push(format!("{error:#}"));
        }
    }
    let unfinished_units = database.dirty_units()?.len();
    if errors.is_empty() && unfinished_units == 0 {
        log_phase_elapsed("content units", phase_started);
    } else {
        log_phase_elapsed_with_status("content units", "stopped", phase_started);
    }

    if !errors.is_empty() || unfinished_units > 0 {
        let details = if errors.is_empty() {
            String::new()
        } else {
            format!(": {}", errors.join("; "))
        };
        bail!(
            "build did not publish because {} content unit(s) remain unfinished{}",
            unfinished_units,
            details
        );
    }

    if !skipped_videos.is_empty() {
        eprintln!(
            "warning: skipped {} unreadable video(s): {}",
            skipped_videos.len(),
            skipped_videos.join(", ")
        );
    }

    let phase_started = Instant::now();
    let libraries = assemble_libraries(database.load_units()?)?;
    ctx.next_state = database.load_build_state()?;
    warn_missing_tag_targets(&ctx);
    let manifest = Manifest {
        schema_version: SCHEMA_VERSION,
        generated_at: now_rfc3339()?,
        libraries,
    };
    log_phase_elapsed("manifest assembly", phase_started);

    let phase_started = Instant::now();
    write_manifest_if_changed(&ctx.output.join(MANIFEST_FILE), &manifest)?;
    log_phase_elapsed("root manifest publish", phase_started);

    let phase_started = Instant::now();
    cleanup_orphaned_outputs(&ctx)?;
    log_phase_elapsed("cleanup", phase_started);

    let phase_started = Instant::now();
    database.set_applied_tags(ctx.remote_tags.as_ref())?;
    if full_scan {
        database.record_full_scan(now_ms)?;
    }
    database.mark_initialized()?;
    database.set_volume_device(volume_device)?;
    database.set_event_cursor(fsevents::current_cursor())?;
    log_phase_elapsed("state metadata commit", phase_started);

    let synced_tag_targets = ctx.progress.synced_tag_targets.load(Ordering::Relaxed);
    if synced_tag_targets > 0 {
        eprintln!(
            "synced {synced_tag_targets} local tag targets ({} changed)",
            ctx.progress.changed_tag_targets.load(Ordering::Relaxed)
        );
    }
    println!(
        "built {} with {} tracked source files",
        ctx.output.join(MANIFEST_FILE).display(),
        ctx.next_state.files.len()
    );
    log_phase_elapsed("build", build_started);
    Ok(())
}

fn log_phase_elapsed(label: &str, started: Instant) {
    log_phase_elapsed_with_status(label, "done", started);
}

fn log_phase_elapsed_with_status(label: &str, status: &str, started: Instant) {
    eprintln!("{label} {status} ({} ms)", started.elapsed().as_millis());
}

#[derive(Debug)]
struct BuildLock {
    path: PathBuf,
    pid: u32,
}

impl Drop for BuildLock {
    fn drop(&mut self) {
        if read_lock_pid(&self.path).ok().flatten() == Some(self.pid) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn acquire_build_lock(source: &Path) -> Result<BuildLock> {
    let path = source.join(BUILD_LOCK_FILE);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create build lock directory: {}", parent.display()))?;
    }

    let pid = std::process::id();
    loop {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                writeln!(file, "{pid}")
                    .with_context(|| format!("write build lock: {}", path.display()))?;
                return Ok(BuildLock { path, pid });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if let Some(owner_pid) = read_lock_pid(&path)?
                    && process_exists(owner_pid)
                {
                    bail!(
                        "build already running for {} (pid {owner_pid})",
                        source.display()
                    );
                }
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(error).with_context(|| {
                            format!("remove stale build lock: {}", path.display())
                        });
                    }
                }
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("create build lock: {}", path.display()));
            }
        }
    }
}

fn read_lock_pid(path: &Path) -> Result<Option<u32>> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(contents
            .lines()
            .next()
            .and_then(|line| line.trim().parse().ok())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("read build lock: {}", path.display())),
    }
}

fn process_exists(pid: u32) -> bool {
    if pid == 0 || pid > c_int::MAX as u32 {
        return false;
    }
    unsafe { kill(pid as c_int, 0) == 0 }
}

fn install_interrupt_handler() -> Result<()> {
    if INTERRUPT_HANDLER.get().is_some() {
        return Ok(());
    }
    ctrlc::set_handler(|| {
        let count = INTERRUPT_COUNT.fetch_add(1, Ordering::SeqCst) + 1;
        if count == 1 {
            eprintln!("interrupt requested; finishing the current content unit");
        } else {
            eprintln!("second interrupt received; terminating immediately");
            std::process::exit(130);
        }
    })
    .context("install interrupt handler")?;
    let _ = INTERRUPT_HANDLER.set(());
    Ok(())
}

#[cfg(target_os = "macos")]
fn sync_cached_tag_changes(
    ctx: &BuildContext,
    cached_units: &BTreeMap<String, state::CachedUnit>,
) -> Result<()> {
    if ctx.remote_tags.as_ref() == ctx.previous_state.applied_tags.as_ref() {
        return Ok(());
    }
    for unit in cached_units.values() {
        if unit.kind == state::UnitKind::Comic {
            sync_comic_tags(ctx, &ctx.source.join(&unit.key), &unit.title, false)?;
        }
    }
    for path in ctx.previous_state.files.keys() {
        let source_path = ctx.source.join(path);
        if has_extension(Path::new(path), IMAGE_EXTENSIONS) {
            sync_image_tags(ctx, &source_path, path, false)?;
        } else if has_extension(Path::new(path), BOOK_EXTENSIONS) {
            sync_book_tags(ctx, &source_path, &book_title(&source_path), false)?;
        } else if has_extension(Path::new(path), VIDEO_EXTENSIONS) {
            sync_video_tags(ctx, &source_path, &book_title(&source_path), false)?;
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn sync_cached_tag_changes(
    _ctx: &BuildContext,
    _cached_units: &BTreeMap<String, state::CachedUnit>,
) -> Result<()> {
    Ok(())
}

struct UnitDiscovery {
    work: Vec<UnitWork>,
    removed_units: Vec<String>,
}

enum UnitWork {
    Comic {
        library_key: String,
        library_title: String,
        scan: ComicScan,
        image_paths: Vec<PathBuf>,
    },
    Author {
        key: String,
        library_key: String,
        library_title: String,
        scan: AuthorScan,
    },
    Video {
        library_key: String,
        library_title: String,
        scan: VideoScan,
    },
}

impl UnitWork {
    fn key(&self) -> &str {
        match self {
            Self::Comic { scan, .. } => &scan.rel,
            Self::Author { key, .. } => key,
            Self::Video { scan, .. } => &scan.rel,
        }
    }
}

fn discover_units(
    source: &Path,
    cached: &BTreeMap<String, state::CachedUnit>,
    dirty: &BTreeSet<String>,
    full_scan: bool,
) -> Result<UnitDiscovery> {
    let root = inspect_directory(source)?;
    if !root.images.is_empty() || !root.books.is_empty() || !root.videos.is_empty() {
        bail!(
            "resource root contains content files directly: {}",
            source.display()
        );
    }

    let mut seen = BTreeSet::new();
    let mut work = Vec::new();
    for library_dir in root.directories {
        let library_key = relative_key(source, &library_dir)?;
        let library_title = display_name(&library_dir);
        let library = inspect_directory(&library_dir)?;
        if !library.videos.is_empty() {
            if !library.images.is_empty()
                || !library.books.is_empty()
                || !library.directories.is_empty()
            {
                bail!(
                    "library mixes video files with other content: {}",
                    library_dir.display()
                );
            }
            for video_path in library.videos {
                let key = relative_key(source, &video_path)?;
                seen.insert(key.clone());
                let cached_unit = cached.get(&key);
                let should_scan = full_scan
                    || dirty.contains(&key)
                    || cached_unit.is_none()
                    || !cached_video_matches_source(&video_path, cached_unit.unwrap());
                if should_scan {
                    work.push(UnitWork::Video {
                        library_key: library_key.clone(),
                        library_title: library_title.clone(),
                        scan: VideoScan {
                            title: book_title(&video_path),
                            path: video_path,
                            rel: key,
                        },
                    });
                }
            }
            continue;
        }
        if !library.images.is_empty() || !library.books.is_empty() {
            bail!(
                "library contains content files directly; expected content directories: {}",
                library_dir.display()
            );
        }
        let mut library_kind = None;
        for unit_dir in library.directories {
            let key = relative_key(source, &unit_dir)?;
            let cached_unit = cached.get(&key);
            let cached_kind = cached_unit.map(|unit| unit.kind);
            let mut contents = None;
            let mut should_scan = full_scan || dirty.contains(&key) || cached_kind.is_none();
            if !should_scan && cached_kind == Some(state::UnitKind::Author) {
                let current = inspect_directory(&unit_dir)?;
                should_scan =
                    !cached_author_matches_source(source, &current, cached_unit.unwrap())?;
                contents = Some(current);
            }
            let kind = if should_scan {
                let contents = match contents {
                    Some(contents) => contents,
                    None => inspect_directory(&unit_dir)?,
                };
                if !contents.directories.is_empty() || !contents.videos.is_empty() {
                    bail!(
                        "content directory contains nested directories: {}",
                        unit_dir.display()
                    );
                }
                if contents.images.is_empty() && contents.books.is_empty() {
                    eprintln!(
                        "warning: skipping empty content directory: {}",
                        unit_dir.display()
                    );
                    continue;
                }
                seen.insert(key.clone());
                if !contents.images.is_empty() && !contents.books.is_empty() {
                    bail!(
                        "content directory mixes comic images and text books: {}",
                        unit_dir.display()
                    );
                }
                if !contents.images.is_empty() {
                    let image_count = contents.images.len();
                    let title = display_name(&unit_dir);
                    work.push(UnitWork::Comic {
                        library_key: library_key.clone(),
                        library_title: library_title.clone(),
                        scan: ComicScan {
                            path: unit_dir,
                            rel: key,
                            title,
                            image_count,
                        },
                        image_paths: contents.images,
                    });
                    state::UnitKind::Comic
                } else {
                    let title = display_name(&unit_dir);
                    work.push(UnitWork::Author {
                        key,
                        library_key: library_key.clone(),
                        library_title: library_title.clone(),
                        scan: AuthorScan {
                            name: title,
                            book_paths: contents.books,
                        },
                    });
                    state::UnitKind::Author
                }
            } else {
                seen.insert(key.clone());
                cached_kind.expect("cached kind checked above")
            };
            if library_kind
                .replace(kind)
                .is_some_and(|existing| existing != kind)
            {
                bail!(
                    "library mixes comic images and text books: {}",
                    library_dir.display()
                );
            }
        }
    }

    let mut removed_units: Vec<String> = cached
        .keys()
        .filter(|key| !seen.contains(*key))
        .cloned()
        .collect();
    removed_units.extend(
        dirty
            .iter()
            .filter(|key| !seen.contains(*key) && !cached.contains_key(*key))
            .cloned(),
    );
    Ok(UnitDiscovery {
        work,
        removed_units,
    })
}

fn cached_author_matches_source(
    source: &Path,
    contents: &DirectoryContents,
    cached: &state::CachedUnit,
) -> Result<bool> {
    if !contents.directories.is_empty()
        || !contents.images.is_empty()
        || !contents.videos.is_empty()
    {
        return Ok(false);
    }
    let Some(author) = &cached.author else {
        return Ok(false);
    };
    if contents.books.len() != author.books.len() {
        return Ok(false);
    }

    let cached_books = author
        .books
        .iter()
        .map(|book| (book.key.as_str(), book.mtime_ms))
        .collect::<BTreeMap<_, _>>();
    for path in &contents.books {
        let key = relative_key(source, path)?;
        let mtime_ms = modified_ms(&path.metadata()?)?;
        if cached_books.get(key.as_str()) != Some(&mtime_ms) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn cached_video_matches_source(path: &Path, cached: &state::CachedUnit) -> bool {
    if cached.kind != state::UnitKind::Video {
        return false;
    }
    let Some(video) = &cached.video else {
        return false;
    };
    path.metadata().is_ok_and(|metadata| {
        video.size == metadata.len()
            && modified_ms(&metadata).is_ok_and(|mtime_ms| video.mtime_ms == mtime_ms)
    })
}

fn build_comic_unit(
    ctx: &mut BuildContext,
    database: &mut state::StateDb,
    thumbnail_pool: &rayon::ThreadPool,
    library_key: &str,
    library_title: &str,
    scan: ComicScan,
    image_paths: Vec<PathBuf>,
) -> Result<()> {
    let unit_key = scan.rel.clone();
    let title = scan.title.clone();
    let before = ctx.progress.snapshot();
    eprintln!("comic [{unit_key}] start ({} images)", image_paths.len());
    sync_comic_tags(
        ctx,
        &scan.path,
        &title,
        !ctx.previous_state.comics.contains_key(&unit_key),
    )?;
    let thumbnail_dir = ctx.output.join(THUMBNAIL_DIR).join(&unit_key);
    fs::create_dir_all(&thumbnail_dir)
        .with_context(|| format!("create thumbnail directory: {}", thumbnail_dir.display()))?;

    remove_unit_from_memory_state(&mut ctx.next_state, &unit_key);
    let processed_images = thumbnail_pool.install(|| {
        image_paths
            .par_iter()
            .map_init(ThumbnailWorker::new, |worker, path| {
                process_image(ctx, path, worker)
            })
            .collect::<Result<Vec<_>>>()
    })?;
    let summary = build_comic(ctx, scan, &mut processed_images.into_iter())?;
    let files = unit_files(&ctx.next_state, &unit_key);
    let comic_state = ctx
        .next_state
        .comics
        .get(&unit_key)
        .cloned()
        .ok_or_else(|| anyhow!("missing completed comic state: {unit_key}"))?;
    database.save_comic(state::ComicCommit {
        unit: state::UnitIdentity {
            key: &unit_key,
            library_key,
            library_title,
            title: &title,
        },
        summary: &summary,
        files: &files,
        comic_state: &comic_state,
    })?;
    let after = ctx.progress.snapshot();
    eprintln!(
        "comic [{unit_key}] done ({} built, {} reused)",
        after.built_thumbnails - before.built_thumbnails,
        after.reused_thumbnails - before.reused_thumbnails
    );
    Ok(())
}

fn build_author_unit(
    ctx: &mut BuildContext,
    database: &mut state::StateDb,
    unit_key: &str,
    library_key: &str,
    library_title: &str,
    scan: AuthorScan,
) -> Result<()> {
    let title = scan.name.clone();
    let book_count = scan.book_paths.len();
    eprintln!("author [{unit_key}] start ({book_count} books)");
    remove_unit_from_memory_state(&mut ctx.next_state, unit_key);
    let author = build_author(ctx, scan)?;
    let files = unit_files(&ctx.next_state, unit_key);
    database.save_author(state::AuthorCommit {
        unit: state::UnitIdentity {
            key: unit_key,
            library_key,
            library_title,
            title: &title,
        },
        author: &author,
        files: &files,
    })?;
    eprintln!("author [{unit_key}] done ({book_count} books)");
    Ok(())
}

fn build_video_unit(
    ctx: &mut BuildContext,
    database: &mut state::StateDb,
    library_key: &str,
    library_title: &str,
    scan: VideoScan,
) -> Result<()> {
    let unit_key = scan.rel.clone();
    eprintln!("video [{unit_key}] start");
    remove_unit_from_memory_state(&mut ctx.next_state, &unit_key);

    let metadata = scan
        .path
        .metadata()
        .with_context(|| format!("read video metadata: {}", scan.path.display()))?;
    let size = metadata.len();
    let mtime_ms = modified_ms(&metadata)?;
    let previous = ctx.previous_state.files.get(&unit_key);
    sync_video_tags(ctx, &scan.path, &scan.title, previous.is_none())?;

    let cover_key = thumbnail_key_for(&unit_key);
    let cover_path = ctx.output.join(&cover_key);
    let unchanged = previous.is_some_and(|state| {
        state.size == size
            && state.mtime_ms == mtime_ms
            && state.width.is_some()
            && state.height.is_some()
    });

    let (width, height, duration_ms, thumbnail_built) = if unchanged && cover_path.is_file() {
        let probe = probe_video(&scan.path)?;
        (
            previous.and_then(|state| state.width).unwrap_or(probe.0),
            previous.and_then(|state| state.height).unwrap_or(probe.1),
            probe.2,
            false,
        )
    } else {
        let probe = probe_video(&scan.path)?;
        generate_video_thumbnail(&scan.path, &cover_path, probe.2)?;
        (probe.0, probe.1, probe.2, true)
    };
    ctx.progress.record_processed(thumbnail_built);

    let video = VideoManifest {
        title: scan.title.clone(),
        key: unit_key.clone(),
        cover_key,
        mtime_ms,
        size,
        width,
        height,
        duration_ms,
    };
    ctx.next_state.files.insert(
        unit_key.clone(),
        FileState {
            size,
            mtime_ms,
            width: Some(width),
            height: Some(height),
        },
    );
    let files = unit_files(&ctx.next_state, &unit_key);
    database.save_video(state::VideoCommit {
        unit: state::UnitIdentity {
            key: &unit_key,
            library_key,
            library_title,
            title: &scan.title,
        },
        video: &video,
        files: &files,
    })?;
    eprintln!("video [{unit_key}] done");
    Ok(())
}

fn video_tool(variable: &str, fallback: &'static str) -> String {
    std::env::var(variable).unwrap_or_else(|_| fallback.to_string())
}

fn ensure_video_tools() -> Result<()> {
    for (variable, fallback) in [("MEGUMI_FFPROBE", "ffprobe"), ("MEGUMI_FFMPEG", "ffmpeg")] {
        let tool = video_tool(variable, fallback);
        let available = ProcessCommand::new(&tool)
            .arg("-version")
            .output()
            .is_ok_and(|output| output.status.success());
        if !available {
            bail!(
                "{fallback} is required to build video libraries; install FFmpeg or set {variable}"
            );
        }
    }
    Ok(())
}

fn probe_video(path: &Path) -> Result<(u32, u32, u64)> {
    let output = ProcessCommand::new(video_tool("MEGUMI_FFPROBE", "ffprobe"))
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,width,height:format=duration",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .with_context(|| format!("run ffprobe for {}", path.display()))?;
    if !output.status.success() {
        bail!(
            "ffprobe failed for {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    parse_video_probe(&output.stdout, path)
}

fn parse_video_probe(output: &[u8], path: &Path) -> Result<(u32, u32, u64)> {
    let probe: FfprobeOutput = serde_json::from_slice(output)
        .with_context(|| format!("parse ffprobe output for {}", path.display()))?;
    let video = probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"))
        .ok_or_else(|| anyhow!("video stream is missing: {}", path.display()))?;
    let width = video
        .width
        .filter(|value| *value > 0)
        .ok_or_else(|| anyhow!("video width is missing or invalid: {}", path.display()))?;
    let height = video
        .height
        .filter(|value| *value > 0)
        .ok_or_else(|| anyhow!("video height is missing or invalid: {}", path.display()))?;
    let duration = probe
        .format
        .and_then(|format| format.duration)
        .and_then(|duration| duration.parse::<f64>().ok())
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or_else(|| anyhow!("video duration is missing or invalid: {}", path.display()))?;

    if video.codec_name.as_deref() != Some("h264") {
        eprintln!(
            "warning: video {} uses {} instead of h264",
            path.display(),
            video.codec_name.as_deref().unwrap_or("an unknown codec")
        );
    }
    for audio in probe
        .streams
        .iter()
        .filter(|stream| stream.codec_type.as_deref() == Some("audio"))
    {
        if audio.codec_name.as_deref() != Some("aac") {
            eprintln!(
                "warning: video {} uses {} audio instead of aac",
                path.display(),
                audio.codec_name.as_deref().unwrap_or("an unknown codec")
            );
        }
    }

    Ok((width, height, (duration * 1000.0).round() as u64))
}

fn generate_video_thumbnail(source: &Path, dest: &Path, duration_ms: u64) -> Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create video thumbnail directory: {}", parent.display()))?;
    }
    let seq = THUMB_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dest.with_extension(format!("webp.{}.{seq}.tmp", std::process::id()));
    let seek_seconds = duration_ms as f64 / 10_000.0;
    let output = ProcessCommand::new(video_tool("MEGUMI_FFMPEG", "ffmpeg"))
        .args(["-v", "error", "-ss", &format!("{seek_seconds:.3}"), "-i"])
        .arg(source)
        .args([
            "-frames:v",
            "1",
            "-vf",
            "scale=256:-2:flags=lanczos",
            "-c:v",
            "libwebp",
            "-quality",
            "72",
            "-f",
            "webp",
            "-y",
        ])
        .arg(&tmp)
        .output()
        .with_context(|| format!("run ffmpeg for {}", source.display()))?;
    if !output.status.success() {
        let _ = fs::remove_file(&tmp);
        bail!(
            "ffmpeg thumbnail failed for {}: {}",
            source.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    fs::rename(&tmp, dest).with_context(|| format!("write video thumbnail: {}", dest.display()))?;
    Ok(())
}

fn remove_unit_from_memory_state(build_state: &mut BuildState, unit_key: &str) {
    let prefix = format!("{unit_key}/");
    build_state
        .files
        .retain(|path, _| path != unit_key && !path.starts_with(&prefix));
    build_state.comics.remove(unit_key);
}

fn unit_files(build_state: &BuildState, unit_key: &str) -> Vec<(String, FileState)> {
    let prefix = format!("{unit_key}/");
    build_state
        .files
        .iter()
        .filter(|(path, _)| path.as_str() == unit_key || path.starts_with(&prefix))
        .map(|(path, state)| (path.clone(), state.clone()))
        .collect()
}

fn assemble_libraries(units: Vec<state::CachedUnit>) -> Result<Vec<LibraryManifest>> {
    enum Group {
        Comics {
            title: String,
            comics: Vec<ComicSummaryManifest>,
        },
        Books {
            title: String,
            authors: Vec<AuthorManifest>,
        },
        Videos {
            title: String,
            videos: Vec<VideoManifest>,
        },
    }

    let mut groups = BTreeMap::<String, Group>::new();
    for unit in units {
        match unit.kind {
            state::UnitKind::Comic => {
                let summary = unit
                    .comic
                    .ok_or_else(|| anyhow!("cached comic has no summary: {}", unit.key))?;
                match groups.entry(unit.library_key) {
                    std::collections::btree_map::Entry::Vacant(entry) => {
                        entry.insert(Group::Comics {
                            title: unit.library_title,
                            comics: vec![summary],
                        });
                    }
                    std::collections::btree_map::Entry::Occupied(mut entry) => {
                        match entry.get_mut() {
                            Group::Comics { comics, .. } => comics.push(summary),
                            Group::Books { .. } => bail!("cached library mixes comics and books"),
                            Group::Videos { .. } => {
                                bail!("cached library mixes comics and videos")
                            }
                        }
                    }
                }
            }
            state::UnitKind::Author => {
                let author = unit
                    .author
                    .ok_or_else(|| anyhow!("cached author has no summary: {}", unit.key))?;
                match groups.entry(unit.library_key) {
                    std::collections::btree_map::Entry::Vacant(entry) => {
                        entry.insert(Group::Books {
                            title: unit.library_title,
                            authors: vec![author],
                        });
                    }
                    std::collections::btree_map::Entry::Occupied(mut entry) => {
                        match entry.get_mut() {
                            Group::Books { authors, .. } => authors.push(author),
                            Group::Comics { .. } => bail!("cached library mixes comics and books"),
                            Group::Videos { .. } => {
                                bail!("cached library mixes books and videos")
                            }
                        }
                    }
                }
            }
            state::UnitKind::Video => {
                let video = unit
                    .video
                    .ok_or_else(|| anyhow!("cached video has no summary: {}", unit.key))?;
                match groups.entry(unit.library_key) {
                    std::collections::btree_map::Entry::Vacant(entry) => {
                        entry.insert(Group::Videos {
                            title: unit.library_title,
                            videos: vec![video],
                        });
                    }
                    std::collections::btree_map::Entry::Occupied(mut entry) => {
                        match entry.get_mut() {
                            Group::Videos { videos, .. } => videos.push(video),
                            Group::Comics { .. } | Group::Books { .. } => {
                                bail!("cached library mixes videos with other content")
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(groups
        .into_values()
        .map(|group| match group {
            Group::Comics { title, comics } => LibraryManifest::Comic { title, comics },
            Group::Books { title, authors } => LibraryManifest::Book { title, authors },
            Group::Videos { title, videos } => LibraryManifest::Video { title, videos },
        })
        .collect())
}

fn recommended_thumbnail_workers() -> usize {
    let logical = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1);
    let physical = num_cpus::get_physical();
    let baseline = if physical == 0 {
        logical
    } else {
        logical.min(physical)
    };

    (baseline * 3 / 4).clamp(1, MAX_THUMBNAIL_WORKERS)
}

#[cfg(not(target_os = "macos"))]
fn load_remote_tags(_source: &Path) -> Result<Option<RemoteTags>> {
    Ok(None)
}

#[cfg(target_os = "macos")]
fn load_remote_tags(source: &Path) -> Result<Option<RemoteTags>> {
    let tags_path = source.join(TAGS_FILE);
    if !tags_path.exists() {
        return Ok(None);
    }

    let raw =
        fs::read(&tags_path).with_context(|| format!("read tags: {}", tags_path.display()))?;
    let tags: RemoteTags = serde_json::from_slice(&raw)
        .with_context(|| format!("parse tags: {}", tags_path.display()))?;
    if tags.version != 1 {
        bail!(
            "unsupported tags version {} in {}",
            tags.version,
            tags_path.display()
        );
    }

    Ok(Some(tags))
}

#[cfg(target_os = "macos")]
fn sync_comic_tags(ctx: &BuildContext, path: &Path, key: &str, is_new: bool) -> Result<()> {
    sync_target_tags(ctx, path, key, is_new, |tags| &tags.comics)
}

#[cfg(target_os = "macos")]
fn sync_image_tags(ctx: &BuildContext, path: &Path, key: &str, is_new: bool) -> Result<()> {
    sync_target_tags(ctx, path, key, is_new, |tags| &tags.images)
}

#[cfg(target_os = "macos")]
fn sync_book_tags(ctx: &BuildContext, path: &Path, key: &str, is_new: bool) -> Result<()> {
    sync_target_tags(ctx, path, key, is_new, |tags| &tags.books)
}

#[cfg(target_os = "macos")]
fn sync_video_tags(ctx: &BuildContext, path: &Path, key: &str, is_new: bool) -> Result<()> {
    sync_target_tags(ctx, path, key, is_new, |tags| &tags.videos)
}

#[cfg(target_os = "macos")]
fn sync_target_tags(
    ctx: &BuildContext,
    path: &Path,
    key: &str,
    is_new: bool,
    select: fn(&RemoteTags) -> &BTreeMap<String, FileTags>,
) -> Result<()> {
    let Some(current) = ctx.remote_tags.as_ref() else {
        return Ok(());
    };
    let desired = desired_local_tags(select(current).get(key));
    let previously_applied = ctx
        .previous_state
        .applied_tags
        .as_ref()
        .map(|tags| desired_local_tags(select(tags).get(key)));
    if !is_new && previously_applied == Some(desired) {
        return Ok(());
    }

    let changed = set_path_tags(path, desired)
        .with_context(|| format!("sync macOS tags: {}", path.display()))?;
    ctx.progress.record_tag_sync(changed);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn sync_comic_tags(_ctx: &BuildContext, _path: &Path, _key: &str, _is_new: bool) -> Result<()> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn sync_image_tags(_ctx: &BuildContext, _path: &Path, _key: &str, _is_new: bool) -> Result<()> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn sync_book_tags(_ctx: &BuildContext, _path: &Path, _key: &str, _is_new: bool) -> Result<()> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn sync_video_tags(_ctx: &BuildContext, _path: &Path, _key: &str, _is_new: bool) -> Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn desired_local_tags(tags: Option<&FileTags>) -> FileTags {
    let tags = tags.copied().unwrap_or_default();
    FileTags {
        starred: Some(tags.starred == Some(true)),
        deleted: Some(tags.deleted == Some(true)),
    }
}

#[cfg(target_os = "macos")]
fn warn_missing_tag_targets(ctx: &BuildContext) {
    let Some(tags) = ctx.remote_tags.as_ref() else {
        return;
    };
    let comic_titles: BTreeSet<_> = ctx
        .next_state
        .comics
        .keys()
        .filter_map(|key| Path::new(key).file_name()?.to_str())
        .collect();
    let book_titles: BTreeSet<_> = ctx
        .next_state
        .files
        .keys()
        .filter(|key| has_extension(Path::new(key), BOOK_EXTENSIONS))
        .map(|key| book_title(Path::new(key)))
        .collect();
    let video_titles: BTreeSet<_> = ctx
        .next_state
        .files
        .keys()
        .filter(|key| has_extension(Path::new(key), VIDEO_EXTENSIONS))
        .map(|key| book_title(Path::new(key)))
        .collect();
    let mut missing = Vec::new();

    for (key, file_tags) in &tags.comics {
        if has_active_remote_tag(file_tags) && !comic_titles.contains(key.as_str()) {
            missing.push(format!("comic:{key}"));
        }
    }
    for (key, file_tags) in &tags.books {
        if has_active_remote_tag(file_tags) && !book_titles.contains(key) {
            missing.push(format!("book:{key}"));
        }
    }
    for (key, file_tags) in &tags.videos {
        if has_active_remote_tag(file_tags) && !video_titles.contains(key) {
            missing.push(format!("video:{key}"));
        }
    }
    for (key, file_tags) in &tags.images {
        if has_active_remote_tag(file_tags) && !ctx.next_state.files.contains_key(key) {
            missing.push(format!("image:{key}"));
        }
    }

    if !missing.is_empty() {
        let sample = missing
            .iter()
            .take(10)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        let suffix = if missing.len() > 10 { ", ..." } else { "" };
        eprintln!(
            "warning: {} remote tag targets are not present locally; will retry on a later build: {sample}{suffix}",
            missing.len()
        );
    }
}

#[cfg(target_os = "macos")]
fn has_active_remote_tag(tags: &FileTags) -> bool {
    tags.starred == Some(true) || tags.deleted == Some(true)
}

#[cfg(not(target_os = "macos"))]
fn warn_missing_tag_targets(_ctx: &BuildContext) {}

#[cfg(target_os = "macos")]
fn get_tag_name(tag: &str) -> &str {
    tag.split('\n').next().unwrap_or("")
}

#[cfg(target_os = "macos")]
fn has_tag(tags_list: &[String], tag_name: &str) -> bool {
    tags_list
        .iter()
        .any(|tag| get_tag_name(tag).eq_ignore_ascii_case(tag_name))
}

#[cfg(target_os = "macos")]
fn update_local_tag(
    tags_list: &mut Vec<String>,
    tag_name: &str,
    tag_value: &str,
    should_have: Option<bool>,
) {
    let Some(should_have) = should_have else {
        return;
    };
    let currently_has = has_tag(tags_list, tag_name);
    match (should_have, currently_has) {
        (true, false) => tags_list.push(tag_value.to_string()),
        (false, true) => tags_list.retain(|tag| !get_tag_name(tag).eq_ignore_ascii_case(tag_name)),
        _ => {}
    }
}

#[cfg(target_os = "macos")]
fn set_path_tags(path: &Path, tags: FileTags) -> Result<bool> {
    let mut tags_list = Vec::new();
    if let Ok(Some(value)) = xattr::get(path, TAG_KEY)
        && let Ok(plist::Value::Array(existing_tags)) = plist::from_bytes(&value)
    {
        for tag in existing_tags {
            if let Some(text) = tag.as_string() {
                tags_list.push(text.to_string());
            }
        }
    }

    let before = tags_list.clone();
    update_local_tag(&mut tags_list, STAR_TAG_NAME, STAR_TAG_VALUE, tags.starred);
    update_local_tag(
        &mut tags_list,
        DELETE_TAG_NAME,
        DELETE_TAG_VALUE,
        tags.deleted,
    );

    if tags_list == before {
        return Ok(false);
    }

    let plist_tags = tags_list.into_iter().map(plist::Value::String).collect();
    let value = plist::Value::Array(plist_tags);
    let mut buf = Vec::new();
    value.to_writer_xml(&mut buf)?;
    xattr::set(path, TAG_KEY, &buf)?;

    if let Ok(Some(mut data)) = xattr::get(path, FINDER_INFO_KEY) {
        if data.len() < 32 {
            return Ok(true);
        }
        data[9] &= !0x0E;
        xattr::set(path, FINDER_INFO_KEY, &data)?;
    }

    Ok(true)
}

fn build_comic(
    ctx: &mut BuildContext,
    scan: ComicScan,
    processed_images: &mut impl Iterator<Item = ProcessedImage>,
) -> Result<ComicSummaryManifest> {
    let ComicScan {
        path,
        rel,
        title,
        image_count,
    } = scan;

    let mut pages = Vec::with_capacity(image_count);
    for _ in 0..image_count {
        let processed = processed_images
            .next()
            .ok_or_else(|| anyhow!("missing processed image for comic: {}", path.display()))?;
        ctx.next_state
            .files
            .insert(processed.state_key, processed.state);
        pages.push(processed.page);
    }

    if pages.is_empty() {
        bail!("comic has no readable pages: {}", path.display());
    }

    let cover_key = pages[0].thumbnail_key.clone();
    let cover_mtime_ms = pages[0].mtime_ms;
    let detail_key = detail_manifest_key_for(&rel);
    let detail_version = comic_fingerprint(&pages, &ctx.next_state.files)?;
    let comic_state = ComicState {
        detail_key: detail_key.clone(),
        fingerprint: detail_version.clone(),
    };
    let detail_unchanged = ctx.previous_state.comics.get(&rel) == Some(&comic_state)
        && ctx.output.join(&detail_key).is_file();
    ctx.next_state.comics.insert(rel.clone(), comic_state);

    if !detail_unchanged {
        let manifest = ComicManifest {
            schema_version: SCHEMA_VERSION,
            title: title.clone(),
            pages,
        };
        write_json_output_if_changed(&ctx.output, &detail_key, &manifest)?;
    }

    Ok(ComicSummaryManifest {
        title,
        cover_key,
        cover_mtime_ms,
        detail_version,
    })
}

fn build_author(ctx: &mut BuildContext, scan: AuthorScan) -> Result<AuthorManifest> {
    let mut books = Vec::with_capacity(scan.book_paths.len());
    for book_path in scan.book_paths {
        books.push(process_book(ctx, &book_path)?);
    }

    Ok(AuthorManifest {
        name: scan.name,
        books,
    })
}

fn process_image(
    ctx: &BuildContext,
    source_path: &Path,
    worker: &mut ThumbnailWorker,
) -> Result<ProcessedImage> {
    let rel = relative_key(&ctx.source, source_path)?;
    let metadata = source_path
        .metadata()
        .with_context(|| format!("read metadata: {}", source_path.display()))?;
    let size = metadata.len();
    let mtime_ms = modified_ms(&metadata)?;
    let key = rel.clone();
    let thumbnail_key = thumbnail_key_for(&rel);
    let output_thumb = ctx.output.join(&thumbnail_key);

    let previous = ctx.previous_state.files.get(&rel);
    sync_image_tags(ctx, source_path, &rel, previous.is_none())?;
    let unchanged = previous.is_some_and(|state| {
        state.size == size
            && state.mtime_ms == mtime_ms
            && state.width.is_some()
            && state.height.is_some()
    });

    let recoverable_thumbnail = previous.is_none()
        && output_thumb.is_file()
        && ctx
            .recovery_image_mtimes
            .get(&rel)
            .is_none_or(|published_mtime| *published_mtime == mtime_ms)
        && output_thumb
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .is_some_and(|modified| modified.as_millis() >= u128::from(mtime_ms));
    let (width, height, thumbnail_built) = if unchanged && output_thumb.is_file() {
        let state = previous.expect("checked above");
        (state.width.unwrap_or(0), state.height.unwrap_or(0), false)
    } else if recoverable_thumbnail {
        let (width, height) = read_image_dimensions(source_path)?;
        (width, height, false)
    } else {
        let (width, height) = create_thumbnail(
            source_path,
            &output_thumb,
            THUMBNAIL_WIDTH,
            THUMBNAIL_QUALITY,
            worker,
        )?;
        (width, height, true)
    };
    ctx.progress.record_processed(thumbnail_built);

    Ok(ProcessedImage {
        page: PageManifest {
            key: key.clone(),
            thumbnail_key: thumbnail_key.clone(),
            width,
            height,
            mtime_ms,
        },
        state_key: rel,
        state: FileState {
            size,
            mtime_ms,
            width: Some(width),
            height: Some(height),
        },
    })
}

fn load_published_image_mtimes(output: &Path) -> Result<BTreeMap<String, u64>> {
    let mut mtimes = BTreeMap::new();
    for key in managed_files(output, COMIC_MANIFEST_DIR)? {
        let path = output.join(&key);
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        let Some(pages) = value.get("pages").and_then(|pages| pages.as_array()) else {
            continue;
        };
        for page in pages {
            if let (Some(key), Some(mtime_ms)) = (
                page.get("key").and_then(|key| key.as_str()),
                page.get("mtimeMs").and_then(|mtime| mtime.as_u64()),
            ) {
                mtimes.insert(key.to_string(), mtime_ms);
            }
        }
    }
    Ok(mtimes)
}

fn read_image_dimensions(source: &Path) -> Result<(u32, u32)> {
    ImageReader::open(source)
        .with_context(|| format!("open image header: {}", source.display()))?
        .with_guessed_format()
        .with_context(|| format!("detect image format: {}", source.display()))?
        .into_dimensions()
        .with_context(|| format!("read image dimensions: {}", source.display()))
}

fn process_book(ctx: &mut BuildContext, source_path: &Path) -> Result<BookManifest> {
    let rel = relative_key(&ctx.source, source_path)?;
    let book_key = strip_extension(&rel);
    eprintln!("book [{book_key}] start");
    let metadata = source_path
        .metadata()
        .with_context(|| format!("read metadata: {}", source_path.display()))?;
    let size = metadata.len();
    let mtime_ms = modified_ms(&metadata)?;
    let key = rel.clone();
    let detail_key = detail_manifest_key_for(&strip_extension(&rel));
    let file_state = FileState {
        size,
        mtime_ms,
        width: None,
        height: None,
    };
    let previous = ctx.previous_state.files.get(&rel);
    let detail_unchanged = previous == Some(&file_state) && ctx.output.join(&detail_key).is_file();
    ctx.next_state.files.insert(rel.clone(), file_state);

    let title = book_title(source_path);
    sync_book_tags(ctx, source_path, &title, previous.is_none())?;

    if !detail_unchanged {
        let content = scan_book_chapters(source_path)?;
        let manifest = BookDetailManifest {
            schema_version: SCHEMA_VERSION,
            title: title.clone(),
            line_count: content.line_count,
            chapters: content.chapters,
        };
        write_json_output_if_changed(&ctx.output, &detail_key, &manifest)?;
    }
    eprintln!("book [{book_key}] done");

    Ok(BookManifest {
        title,
        key,
        mtime_ms,
    })
}

struct BookChapterScan {
    line_count: usize,
    chapters: Vec<ChapterManifest>,
}

fn scan_book_chapters(source_path: &Path) -> Result<BookChapterScan> {
    let file = File::open(source_path)
        .with_context(|| format!("open book for chapter scan: {}", source_path.display()))?;
    let reader = BufReader::new(file);
    let mut line_index = 0;
    let mut chapters = Vec::new();

    for line in reader.lines() {
        let line = line.with_context(|| format!("read book: {}", source_path.display()))?;
        if line.trim().is_empty() {
            continue;
        }

        if let Some(title) = extract_chapter_title(&line) {
            chapters.push(ChapterManifest { title, line_index });
        }
        line_index += 1;
    }

    Ok(BookChapterScan {
        line_count: line_index,
        chapters,
    })
}

fn extract_chapter_title(line: &str) -> Option<String> {
    let trimmed = line.trim();

    const SPECIAL_CHAPTERS: &[&str] = &["序章", "终章", "番外", "后记", "尾声"];
    for &prefix in SPECIAL_CHAPTERS {
        if trimmed.starts_with(prefix) {
            return Some(trimmed.to_string());
        }
    }

    if !trimmed.starts_with('第') {
        return None;
    }

    let mut chars = trimmed.chars();
    let _ = chars.next();
    let mut has_number = false;
    const CHAPTER_SUFFIXES: &[char] = &['章', '回', '节', '卷', '集', '幕'];

    for c in chars {
        if is_chapter_number_char(c) {
            has_number = true;
            continue;
        }

        return (has_number && CHAPTER_SUFFIXES.contains(&c)).then(|| trimmed.to_string());
    }

    None
}

fn is_chapter_number_char(c: char) -> bool {
    c.is_ascii_digit()
        || matches!(
            c,
            '０' | '１'
                | '２'
                | '３'
                | '４'
                | '５'
                | '６'
                | '７'
                | '８'
                | '９'
                | '一'
                | '二'
                | '三'
                | '四'
                | '五'
                | '六'
                | '七'
                | '八'
                | '九'
                | '十'
                | '百'
                | '千'
        )
}

struct DirectoryContents {
    directories: Vec<PathBuf>,
    images: Vec<PathBuf>,
    books: Vec<PathBuf>,
    videos: Vec<PathBuf>,
}

fn inspect_directory(path: &Path) -> Result<DirectoryContents> {
    let mut directories = Vec::new();
    let mut images = Vec::new();
    let mut books = Vec::new();
    let mut videos = Vec::new();
    for entry in
        fs::read_dir(path).with_context(|| format!("read directory: {}", path.display()))?
    {
        let entry = entry?;
        let child = entry.path();
        if is_ignored_entry(&child) {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            directories.push(child);
        } else if file_type.is_file() {
            if has_extension(&child, IMAGE_EXTENSIONS) {
                images.push(child);
            } else if has_extension(&child, BOOK_EXTENSIONS) {
                books.push(child);
            } else if has_extension(&child, VIDEO_EXTENSIONS) {
                videos.push(child);
            }
        }
    }
    directories.sort_by(|a, b| compare_path_names(a, b));
    images.sort_by(|a, b| compare_path_names(a, b));
    books.sort_by(|a, b| compare_path_names(a, b));
    videos.sort_by(|a, b| compare_path_names(a, b));
    Ok(DirectoryContents {
        directories,
        images,
        books,
        videos,
    })
}

fn compare_path_names(a: &Path, b: &Path) -> std::cmp::Ordering {
    let a = a.file_name().unwrap_or_default().to_string_lossy();
    let b = b.file_name().unwrap_or_default().to_string_lossy();
    natord::compare(&a, &b)
}

fn create_thumbnail(
    source: &Path,
    dest: &Path,
    target_width: u32,
    quality: u8,
    worker: &mut ThumbnailWorker,
) -> Result<(u32, u32)> {
    let file = File::open(source).with_context(|| format!("open image: {}", source.display()))?;
    // SAFETY: the mapping is read-only and scoped to this function while the file handle is alive.
    let mmap = unsafe { Mmap::map(&file) }
        .with_context(|| format!("memory-map image: {}", source.display()))?;

    let (pixels, src_width, src_height, original_width, original_height) = if is_jpeg(&mmap)
        && let Some(decompressor) = worker.decompressor.as_mut()
    {
        decode_jpeg_for_thumbnail(&mmap, decompressor, target_width)
            .or_else(|_| decode_image_for_thumbnail(&mmap))
            .with_context(|| format!("decode image: {}", source.display()))?
    } else {
        decode_image_for_thumbnail(&mmap)
            .with_context(|| format!("decode image: {}", source.display()))?
    };

    let target_height = thumbnail_height(original_width, original_height, target_width)?;
    let resized = resize_rgb(
        pixels,
        src_width,
        src_height,
        target_width,
        target_height,
        &mut worker.resizer,
    )?;

    let seq = THUMB_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dest.with_extension(format!("webp.{}.{seq}.tmp", std::process::id()));
    let encoder = webp::Encoder::from_rgb(&resized, target_width, target_height);
    let encoded = encoder.encode(f32::from(quality));
    if fs::read(dest).is_ok_and(|existing| existing == *encoded) {
        return Ok((original_width, original_height));
    }
    if let Err(error) = fs::write(&tmp, &*encoded)
        .with_context(|| format!("write temporary thumbnail: {}", tmp.display()))
    {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    if let Err(error) =
        fs::rename(&tmp, dest).with_context(|| format!("write thumbnail: {}", dest.display()))
    {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    Ok((original_width, original_height))
}

fn is_jpeg(data: &[u8]) -> bool {
    data.len() >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF
}

fn decode_jpeg_for_thumbnail(
    data: &[u8],
    decompressor: &mut Decompressor,
    target_width: u32,
) -> Result<(Vec<u8>, u32, u32, u32, u32)> {
    let header = decompressor.read_header(data)?;
    let original_width: u32 = header
        .width
        .try_into()
        .map_err(|_| anyhow!("JPEG width overflow"))?;
    let original_height: u32 = header
        .height
        .try_into()
        .map_err(|_| anyhow!("JPEG height overflow"))?;
    let scale_ratio = original_width / target_width.max(1);
    let (num, denom) = match scale_ratio {
        ratio if ratio >= 8 => (1, 8),
        ratio if ratio >= 4 => (1, 4),
        ratio if ratio >= 2 => (1, 2),
        _ => (1, 1),
    };

    let scaled_width = (header.width * num).div_ceil(denom);
    let scaled_height = (header.height * num).div_ceil(denom);
    let pitch = scaled_width * 3;
    let mut pixels = vec![0u8; pitch * scaled_height];
    let image = JpegImage {
        pixels: &mut pixels[..],
        width: scaled_width,
        pitch,
        height: scaled_height,
        format: PixelFormat::RGB,
    };

    decompressor.set_scaling_factor(ScalingFactor::new(num, denom))?;
    decompressor.decompress(data, image)?;

    Ok((
        pixels,
        scaled_width
            .try_into()
            .map_err(|_| anyhow!("scaled JPEG width overflow"))?,
        scaled_height
            .try_into()
            .map_err(|_| anyhow!("scaled JPEG height overflow"))?,
        original_width,
        original_height,
    ))
}

fn decode_image_for_thumbnail(data: &[u8]) -> Result<(Vec<u8>, u32, u32, u32, u32)> {
    let image = ImageReader::new(Cursor::new(data))
        .with_guessed_format()?
        .decode()?;
    let width = image.width();
    let height = image.height();
    Ok((image.into_rgb8().into_raw(), width, height, width, height))
}

fn thumbnail_height(width: u32, height: u32, target_width: u32) -> Result<u32> {
    if width == 0 {
        bail!("image width is zero");
    }
    ((height as u64 * target_width as u64) / width as u64)
        .max(1)
        .try_into()
        .map_err(|_| anyhow!("thumbnail height overflow"))
}

fn resize_rgb(
    pixels: Vec<u8>,
    src_width: u32,
    src_height: u32,
    target_width: u32,
    target_height: u32,
    resizer: &mut fr::Resizer,
) -> Result<Vec<u8>> {
    let src_image =
        fr::images::Image::from_vec_u8(src_width, src_height, pixels, fr::PixelType::U8x3)
            .map_err(|error| anyhow!("create resize source buffer: {error}"))?;
    let mut dst_image = fr::images::Image::new(target_width, target_height, fr::PixelType::U8x3);
    let options =
        fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Bilinear));
    resizer
        .resize(&src_image, &mut dst_image, Some(&options))
        .map_err(|error| anyhow!("resize image: {error}"))?;
    Ok(dst_image.into_vec())
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    write_bytes_atomic(path, &serde_json::to_vec(value)?)
}

fn write_manifest_if_changed(path: &Path, value: &Manifest) -> Result<bool> {
    if let Ok(existing) = fs::read(path)
        && let Ok(previous) = serde_json::from_slice::<Manifest>(&existing)
        && previous.schema_version == value.schema_version
        && previous.libraries == value.libraries
    {
        return Ok(false);
    }
    write_json(path, value)?;
    Ok(true)
}

fn write_bytes_atomic(path: &Path, data: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create directory: {}", parent.display()))?;
    }
    let seq = JSON_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}.{seq}.tmp", std::process::id()));
    fs::write(&tmp, data).with_context(|| format!("write temporary file: {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("write file: {}", path.display()))?;
    Ok(())
}

fn write_json_output_if_changed<T: Serialize>(output: &Path, key: &str, value: &T) -> Result<()> {
    let path = output.join(key);
    let data = serde_json::to_vec(value)?;
    if fs::read(&path).is_ok_and(|existing| existing == data) {
        return Ok(());
    }
    write_bytes_atomic(&path, &data)?;
    Ok(())
}

fn comic_fingerprint(
    pages: &[PageManifest],
    files: &BTreeMap<String, FileState>,
) -> Result<String> {
    let mut hasher = blake3::Hasher::new();
    for page in pages {
        let state = files
            .get(&page.key)
            .ok_or_else(|| anyhow!("missing state for comic page {}", page.key))?;
        hash_field(&mut hasher, page.key.as_bytes());
        hasher.update(&state.size.to_le_bytes());
        hasher.update(&state.mtime_ms.to_le_bytes());
        hasher.update(&page.width.to_le_bytes());
        hasher.update(&page.height.to_le_bytes());
        hash_field(&mut hasher, page.thumbnail_key.as_bytes());
    }
    Ok(hasher.finalize().to_hex()[..16].to_string())
}

fn hash_field(hasher: &mut blake3::Hasher, value: &[u8]) {
    hasher.update(&(value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn cleanup_orphaned_outputs(ctx: &BuildContext) -> Result<()> {
    let expected_thumbnails: BTreeSet<_> = ctx
        .next_state
        .files
        .keys()
        .filter(|source_key| {
            has_extension(Path::new(source_key), IMAGE_EXTENSIONS)
                || has_extension(Path::new(source_key), VIDEO_EXTENSIONS)
        })
        .map(|source_key| thumbnail_key_for(source_key))
        .collect();
    for key in managed_files(&ctx.output, THUMBNAIL_DIR)? {
        if !expected_thumbnails.contains(&key) {
            remove_generated_file(&ctx.output, &key)?;
        }
    }

    let expected_manifests: BTreeSet<String> = ctx
        .next_state
        .comics
        .values()
        .map(|state| state.detail_key.clone())
        .chain(
            ctx.next_state
                .files
                .keys()
                .filter(|key| has_extension(Path::new(key), BOOK_EXTENSIONS))
                .map(|key| detail_manifest_key_for(&strip_extension(key))),
        )
        .collect();
    for key in managed_files(&ctx.output, COMIC_MANIFEST_DIR)? {
        if !expected_manifests.contains(key.as_str()) {
            remove_generated_file(&ctx.output, &key)?;
        }
    }
    Ok(())
}

fn managed_files(output: &Path, directory: &str) -> Result<Vec<String>> {
    let root = output.join(directory);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut pending = vec![root.clone()];
    let mut files = Vec::new();
    while let Some(path) = pending.pop() {
        for entry in
            fs::read_dir(&path).with_context(|| format!("read directory: {}", path.display()))?
        {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() {
                files.push(relative_key(output, &entry.path())?);
            }
        }
    }
    Ok(files)
}

fn remove_generated_file(output: &Path, key: &str) -> Result<()> {
    let (managed_root, relative) = if let Some(relative) = key.strip_prefix("thumbnail/") {
        (output.join(THUMBNAIL_DIR), relative)
    } else if let Some(relative) = key.strip_prefix("manifests/") {
        (output.join(COMIC_MANIFEST_DIR), relative)
    } else {
        bail!("state references unmanaged generated file: {key}");
    };
    if relative.is_empty()
        || Path::new(relative)
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        bail!("state contains invalid generated path: {key}");
    }

    let path = managed_root.join(relative);
    if path.exists() {
        fs::remove_file(&path)
            .with_context(|| format!("remove stale generated file: {}", path.display()))?;

        let mut parent = path.parent();
        while let Some(directory) = parent {
            if directory == managed_root || !directory.starts_with(&managed_root) {
                break;
            }
            if directory
                .read_dir()
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false)
            {
                fs::remove_dir(directory).with_context(|| {
                    format!("remove empty generated directory: {}", directory.display())
                })?;
                parent = directory.parent();
            } else {
                break;
            }
        }
    }
    Ok(())
}

fn relative_key(root: &Path, path: &Path) -> Result<String> {
    let rel = path
        .strip_prefix(root)
        .with_context(|| format!("{} is not under {}", path.display(), root.display()))?;
    let mut parts = Vec::new();
    for component in rel.components() {
        let text = component.as_os_str().to_string_lossy();
        if text.is_empty() || text == "." {
            continue;
        }
        parts.push(text.to_string());
    }
    Ok(parts.join("/"))
}

fn has_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            extensions
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(ext))
        })
}

fn is_ignored_entry(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    name.starts_with('.')
        || name == THUMBNAIL_DIR
        || name == COMIC_MANIFEST_DIR
        || name == MANIFEST_FILE
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string()
}

fn book_title(path: &Path) -> String {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    path.file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(&filename)
        .to_string()
}

fn modified_ms(metadata: &fs::Metadata) -> Result<u64> {
    Ok(metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX))
}

fn thumbnail_key_for(rel: &str) -> String {
    let mut path = PathBuf::from(THUMBNAIL_DIR);
    path.push(rel);
    path.set_extension("webp");
    path.to_string_lossy().replace('\\', "/")
}

fn detail_manifest_key_for(rel: &str) -> String {
    format!("{COMIC_MANIFEST_DIR}/{rel}.json")
}

fn strip_extension(key: &str) -> String {
    let mut path = PathBuf::from(key);
    path.set_extension("");
    path.to_string_lossy()
        .trim_end_matches('.')
        .replace('\\', "/")
}

fn now_rfc3339() -> Result<String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?;
    let offset = time::UtcOffset::UTC;
    let datetime = time::OffsetDateTime::from_unix_timestamp(now.as_secs() as i64)?
        .replace_nanosecond(now.subsec_nanos())?
        .to_offset(offset);
    datetime
        .format(&time::format_description::well_known::Rfc3339)
        .context("format timestamp")
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::Duration;

    static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let unique = format!(
                "megumi-test-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
                TEST_DIR_COUNTER.fetch_add(1, Ordering::Relaxed)
            );
            let path = std::env::temp_dir().join(unique);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn build_lock_rejects_an_active_owner() {
        let temp = TestDir::new();
        let lock = acquire_build_lock(&temp.0).unwrap();

        let error = acquire_build_lock(&temp.0).unwrap_err().to_string();

        assert!(error.contains("build already running"));
        drop(lock);
        assert!(!temp.0.join(BUILD_LOCK_FILE).exists());
    }

    #[test]
    fn build_lock_removes_a_stale_owner() {
        let temp = TestDir::new();
        let lock_path = temp.0.join(BUILD_LOCK_FILE);
        fs::create_dir_all(lock_path.parent().unwrap()).unwrap();
        fs::write(&lock_path, u32::MAX.to_string()).unwrap();

        let lock = acquire_build_lock(&temp.0).unwrap();

        assert_eq!(read_lock_pid(&lock_path).unwrap(), Some(std::process::id()));
        drop(lock);
        assert!(!lock_path.exists());
    }

    fn test_build_args(source: &Path) -> BuildArgs {
        BuildArgs {
            source: source.to_path_buf(),
        }
    }

    fn build_test_library(source: &Path) {
        build(test_build_args(source)).unwrap();
    }

    fn remove_sqlite_state(source: &Path) {
        for name in ["state.sqlite3", "state.sqlite3-wal", "state.sqlite3-shm"] {
            let path = source.join(".megumi").join(name);
            if path.exists() {
                fs::remove_file(path).unwrap();
            }
        }
    }

    fn write_test_image(path: &Path, color: [u8; 3]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        RgbImage::from_pixel(20, 30, Rgb(color)).save(path).unwrap();
    }

    #[test]
    fn discovers_flat_mp4_files_as_video_units() {
        let temp = TestDir::new();
        let video = temp.0.join("Videos/Clip.MP4");
        fs::create_dir_all(video.parent().unwrap()).unwrap();
        fs::write(&video, b"not needed during discovery").unwrap();

        let discovery = discover_units(&temp.0, &BTreeMap::new(), &BTreeSet::new(), true).unwrap();

        assert_eq!(discovery.work.len(), 1);
        assert_eq!(discovery.work[0].key(), "Videos/Clip.MP4");
        assert!(matches!(discovery.work[0], UnitWork::Video { .. }));
    }

    #[test]
    fn rejects_video_libraries_mixed_with_other_content() {
        let temp = TestDir::new();
        fs::create_dir_all(temp.0.join("Mixed/Comic")).unwrap();
        fs::write(temp.0.join("Mixed/Clip.mp4"), b"video").unwrap();
        write_test_image(&temp.0.join("Mixed/Comic/001.jpg"), [1, 2, 3]);

        let result = discover_units(&temp.0, &BTreeMap::new(), &BTreeSet::new(), true);
        assert!(result.is_err());
        let error = result.err().unwrap().to_string();

        assert!(error.contains("mixes video files with other content"));
    }

    #[test]
    fn parses_video_dimensions_duration_and_browser_codecs() {
        let output = br#"{
          "streams": [
            {"codec_type":"video","codec_name":"h264","width":1920,"height":1080},
            {"codec_type":"audio","codec_name":"aac"}
          ],
          "format":{"duration":"12.345"}
        }"#;

        assert_eq!(
            parse_video_probe(output, Path::new("Clip.mp4")).unwrap(),
            (1920, 1080, 12_345)
        );
    }

    #[cfg(target_os = "macos")]
    fn write_tags_json(source: &Path, value: serde_json::Value) {
        let path = source.join(TAGS_FILE);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    #[cfg(target_os = "macos")]
    fn read_tag_values(path: &Path) -> Vec<String> {
        let Some(value) = xattr::get(path, TAG_KEY).unwrap() else {
            return Vec::new();
        };
        let Ok(plist::Value::Array(tags)) = plist::from_bytes(&value) else {
            return Vec::new();
        };
        tags.into_iter()
            .filter_map(|tag| tag.as_string().map(str::to_string))
            .collect()
    }

    #[cfg(target_os = "macos")]
    fn read_tag_flags(path: &Path) -> (bool, bool) {
        let tags = read_tag_values(path);
        (
            has_tag(&tags, STAR_TAG_NAME),
            has_tag(&tags, DELETE_TAG_NAME),
        )
    }

    #[test]
    fn thumbnail_keys_keep_original_directory_and_use_webp() {
        assert_eq!(
            thumbnail_key_for("Comics/ComicA/001.jpg"),
            "thumbnail/Comics/ComicA/001.webp"
        );
    }

    #[test]
    fn comic_manifest_keys_append_json_without_replacing_extensions() {
        assert_eq!(
            detail_manifest_key_for("Comics/Comic.v1"),
            "manifests/Comics/Comic.v1.json"
        );
        assert_eq!(
            detail_manifest_key_for(&strip_extension("Books/Author/Book.v1.txt")),
            "manifests/Books/Author/Book.v1.json"
        );
    }

    #[test]
    fn fixed_library_structure_is_enforced() {
        let direct = TestDir::new();
        write_test_image(&direct.0.join("Comics/001.png"), [255, 0, 0]);
        let error = build(test_build_args(&direct.0)).unwrap_err().to_string();
        assert!(error.contains("contains content files directly"));

        let mixed = TestDir::new();
        write_test_image(&mixed.0.join("Library/Comic/001.png"), [255, 0, 0]);
        fs::create_dir_all(mixed.0.join("Library/Author")).unwrap();
        fs::write(mixed.0.join("Library/Author/Book.txt"), "content").unwrap();
        let error = build(test_build_args(&mixed.0)).unwrap_err().to_string();
        assert!(error.contains("mixes comic images and text books"));
    }

    #[test]
    fn failed_full_scan_discovery_preserves_previous_event_cursor() {
        let temp = TestDir::new();
        let source = &temp.0;
        let mut database = state::StateDb::open(source).unwrap();
        database.set_event_cursor(123).unwrap();
        drop(database);
        write_test_image(&source.join("001.png"), [255, 0, 0]);

        let error = build(test_build_args(source)).unwrap_err().to_string();

        assert!(error.contains("resource root contains content files directly"));
        let database = state::StateDb::open(source).unwrap();
        assert_eq!(database.event_cursor().unwrap(), Some(123));
    }

    #[test]
    fn failed_full_scan_build_preserves_previous_full_scan_timestamp() {
        let temp = TestDir::new();
        let source = &temp.0;
        let mut database = state::StateDb::open(source).unwrap();
        database.record_full_scan(123).unwrap();
        drop(database);
        let good_page = source.join("Comics/One/001.png");
        let bad_page = source.join("Comics/Two/001.png");
        write_test_image(&good_page, [255, 0, 0]);
        fs::create_dir_all(bad_page.parent().unwrap()).unwrap();
        fs::write(&bad_page, "invalid image").unwrap();

        let error = build(test_build_args(source)).unwrap_err().to_string();

        assert!(error.contains("decode image"));
        let database = state::StateDb::open(source).unwrap();
        assert_eq!(database.last_full_scan_ms().unwrap(), Some(123));
    }

    #[test]
    fn empty_content_directories_are_skipped() {
        let temp = TestDir::new();
        fs::create_dir_all(temp.0.join("Novel/AUTO")).unwrap();
        let author = temp.0.join("Novel/Author");
        fs::create_dir_all(&author).unwrap();
        fs::write(author.join("Book.txt"), "content").unwrap();

        build_test_library(&temp.0);

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(temp.0.join(MANIFEST_FILE)).unwrap()).unwrap();
        let authors = manifest["libraries"][0]["authors"].as_array().unwrap();
        assert_eq!(authors.len(), 1);
        assert_eq!(authors[0]["name"], "Author");
    }

    #[test]
    fn empty_cached_content_directory_is_removed_from_state_and_outputs() {
        let temp = TestDir::new();
        let source = &temp.0;
        let page = source.join("Comics/One/001.png");
        write_test_image(&page, [255, 0, 0]);
        build_test_library(source);
        assert!(source.join("manifests/Comics/One.json").is_file());
        assert!(source.join("thumbnail/Comics/One/001.webp").is_file());

        fs::remove_file(&page).unwrap();
        build_test_library(source);

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(source.join(MANIFEST_FILE)).unwrap()).unwrap();
        assert!(manifest["libraries"].as_array().unwrap().is_empty());
        let database = state::StateDb::open(source).unwrap();
        assert!(database.load_units().unwrap().is_empty());
        assert!(!source.join("manifests/Comics/One.json").exists());
        assert!(!source.join("thumbnail/Comics/One/001.webp").exists());
    }

    #[test]
    fn removed_books_are_pruned_without_an_event_hint() {
        let temp = TestDir::new();
        let source = &temp.0;
        let first_book = source.join("Books/Author/One.txt");
        let second_book = source.join("Books/Author/Two.txt");
        fs::create_dir_all(first_book.parent().unwrap()).unwrap();
        fs::write(&first_book, "第一章 开始\nfirst").unwrap();
        fs::write(&second_book, "第一章 开始\nsecond").unwrap();
        build_test_library(source);
        assert!(source.join("manifests/Books/Author/One.json").is_file());
        assert!(source.join("manifests/Books/Author/Two.json").is_file());

        fs::remove_file(&first_book).unwrap();
        let mut database = state::StateDb::open(source).unwrap();
        database.record_full_scan(state::now_ms().unwrap()).unwrap();
        database
            .set_event_cursor(fsevents::current_cursor())
            .unwrap();
        drop(database);
        build_test_library(source);

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(source.join(MANIFEST_FILE)).unwrap()).unwrap();
        let books = manifest["libraries"][0]["authors"][0]["books"]
            .as_array()
            .unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0]["key"], "Books/Author/Two.txt");
        assert!(!source.join("manifests/Books/Author/One.json").exists());
        assert!(source.join("manifests/Books/Author/Two.json").is_file());

        fs::remove_dir_all(second_book.parent().unwrap()).unwrap();
        let mut database = state::StateDb::open(source).unwrap();
        database.record_full_scan(state::now_ms().unwrap()).unwrap();
        database
            .set_event_cursor(fsevents::current_cursor())
            .unwrap();
        drop(database);
        build_test_library(source);

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(source.join(MANIFEST_FILE)).unwrap()).unwrap();
        assert!(manifest["libraries"].as_array().unwrap().is_empty());
        let database = state::StateDb::open(source).unwrap();
        assert!(database.load_units().unwrap().is_empty());
        assert!(!source.join("manifests/Books/Author/Two.json").exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_syncs_remote_tags_to_macos_xattrs_and_clears_absent_values() {
        let temp = TestDir::new();
        let source = &temp.0;
        let comic_one = source.join("Comics/One");
        let comic_two = source.join("Comics/Two");
        let image_one = comic_one.join("001.png");
        let image_two = comic_two.join("001.png");
        let first_book = source.join("Books/Author/One.txt");
        let duplicate_book = source.join("Books/Other/One.txt");

        write_test_image(&image_one, [255, 0, 0]);
        write_test_image(&image_two, [0, 255, 0]);
        fs::create_dir_all(first_book.parent().unwrap()).unwrap();
        fs::create_dir_all(duplicate_book.parent().unwrap()).unwrap();
        fs::write(&first_book, "first").unwrap();
        fs::write(&duplicate_book, "duplicate").unwrap();

        let other_tag = plist::Value::Array(vec![plist::Value::String("OTHER\n1".to_string())]);
        let mut other_tag_buf = Vec::new();
        other_tag.to_writer_xml(&mut other_tag_buf).unwrap();
        xattr::set(&comic_two, TAG_KEY, &other_tag_buf).unwrap();
        set_path_tags(
            &image_two,
            FileTags {
                starred: Some(true),
                deleted: Some(true),
            },
        )
        .unwrap();

        write_tags_json(
            source,
            serde_json::json!({
                "version": 1,
                "comics": { "One": { "starred": true } },
                "books": { "One": { "deleted": true } },
                "images": { "Comics/One/001.png": { "starred": true, "deleted": true } },
                "chapters": { "One:序章": { "starred": true } },
                "updatedAt": "2026-06-21T08:36:47.233Z"
            }),
        );

        build_test_library(source);

        assert_eq!(read_tag_flags(&comic_one), (true, false));
        assert_eq!(read_tag_flags(&image_one), (true, true));
        assert_eq!(read_tag_flags(&first_book), (false, true));
        assert_eq!(read_tag_flags(&duplicate_book), (false, true));
        assert_eq!(read_tag_flags(&image_two), (false, false));
        assert!(has_tag(&read_tag_values(&comic_two), "OTHER"));

        write_tags_json(
            source,
            serde_json::json!({
                "version": 1,
                "comics": {},
                "books": {},
                "images": {},
                "chapters": {}
            }),
        );
        build_test_library(source);

        assert_eq!(read_tag_flags(&comic_one), (false, false));
        assert_eq!(read_tag_flags(&image_one), (false, false));
        assert_eq!(read_tag_flags(&first_book), (false, false));
        assert_eq!(read_tag_flags(&duplicate_book), (false, false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unchanged_tag_snapshot_skips_existing_targets_but_syncs_new_files() {
        let temp = TestDir::new();
        let source = &temp.0;
        let existing_image = source.join("Comics/One/001.png");
        let future_image = source.join("Comics/One/002.png");
        write_test_image(&existing_image, [255, 0, 0]);
        write_tags_json(
            source,
            serde_json::json!({
                "version": 1,
                "comics": {},
                "books": {},
                "images": {
                    "Comics/One/001.png": { "starred": true },
                    "Comics/One/002.png": { "starred": true }
                }
            }),
        );

        build_test_library(source);
        assert_eq!(read_tag_flags(&existing_image), (true, false));

        set_path_tags(
            &existing_image,
            FileTags {
                starred: Some(false),
                deleted: Some(false),
            },
        )
        .unwrap();
        write_test_image(&future_image, [0, 255, 0]);
        build_test_library(source);

        assert_eq!(read_tag_flags(&existing_image), (false, false));
        assert_eq!(read_tag_flags(&future_image), (true, false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn malformed_tags_json_fails_without_rewriting_existing_tags() {
        let temp = TestDir::new();
        let source = &temp.0;
        let comic = source.join("Comics/One");
        write_test_image(&comic.join("001.png"), [255, 0, 0]);
        set_path_tags(
            &comic,
            FileTags {
                starred: Some(true),
                deleted: Some(false),
            },
        )
        .unwrap();

        let tags_path = source.join(TAGS_FILE);
        fs::create_dir_all(tags_path.parent().unwrap()).unwrap();
        fs::write(&tags_path, "{ invalid json").unwrap();

        let error = build(test_build_args(source)).unwrap_err().to_string();
        assert!(error.contains("parse tags"));
        assert_eq!(read_tag_flags(&comic), (true, false));
    }

    #[test]
    fn build_is_incremental_and_prunes_removed_comics() {
        let temp = TestDir::new();
        let source = &temp.0;
        let first_page = source.join("Comics/One/001.png");
        let second_page = source.join("Comics/One/002.png");
        write_test_image(&first_page, [255, 0, 0]);
        write_test_image(&second_page, [0, 255, 0]);

        let author = source.join("Books/Author");
        fs::create_dir_all(&author).unwrap();
        fs::write(author.join("One.txt"), "first").unwrap();
        fs::write(author.join("Two.txt"), "序章\nsecond\n\n第一章 开始\nbody").unwrap();

        build_test_library(source);

        let root_manifest = source.join(MANIFEST_FILE);
        let comic_manifest = source.join("manifests/Comics/One.json");
        let first_thumbnail = source.join("thumbnail/Comics/One/001.webp");
        let second_thumbnail = source.join("thumbnail/Comics/One/002.webp");
        let initial_root_mtime = root_manifest.metadata().unwrap().modified().unwrap();
        let initial_comic_mtime = comic_manifest.metadata().unwrap().modified().unwrap();
        let database = state::StateDb::open(source).unwrap();
        let state = database.load_build_state().unwrap();
        assert_eq!(state.files.len(), 4);
        assert_eq!(state.comics["Comics/One"].fingerprint.len(), 16);
        drop(database);

        thread::sleep(Duration::from_millis(20));
        build_test_library(source);

        assert_eq!(
            root_manifest.metadata().unwrap().modified().unwrap(),
            initial_root_mtime
        );
        assert_eq!(
            comic_manifest.metadata().unwrap().modified().unwrap(),
            initial_comic_mtime
        );
        fs::remove_file(second_page).unwrap();
        build_test_library(source);
        let reduced_detail: serde_json::Value =
            serde_json::from_slice(&fs::read(&comic_manifest).unwrap()).unwrap();
        assert_eq!(reduced_detail["pages"].as_array().unwrap().len(), 1);
        assert!(!second_thumbnail.exists());

        fs::rename(source.join("Comics/One"), source.join("Comics/Two")).unwrap();
        fs::remove_file(author.join("One.txt")).unwrap();
        fs::write(author.join("Three.txt"), "third").unwrap();
        build_test_library(source);

        assert!(!comic_manifest.exists());
        assert!(!first_thumbnail.exists());
        assert!(!source.join("manifests/Books/Author/One.json").exists());
        assert!(source.join("manifests/Books/Author/Three.json").is_file());
        assert!(source.join("manifests/Comics/Two.json").is_file());
        assert!(source.join("thumbnail/Comics/Two/001.webp").is_file());

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(root_manifest).unwrap()).unwrap();
        assert_eq!(manifest["schemaVersion"], SCHEMA_VERSION);
        assert!(manifest.get("sourceRoot").is_none());
        assert!(manifest.get("publicBaseUrl").is_none());
        let libraries = manifest["libraries"].as_array().unwrap();
        let comics = libraries
            .iter()
            .find(|library| library["kind"] == "comic")
            .unwrap();
        assert_eq!(comics["comics"][0]["title"], "Two");
        assert!(comics.get("authors").is_none());
        assert!(comics.get("path").is_none());
        assert!(comics.get("id").is_none());
        assert!(comics["comics"][0].get("id").is_none());
        assert!(comics["comics"][0].get("path").is_none());
        assert!(comics["comics"][0].get("createdAt").is_none());
        assert!(comics["comics"][0].get("detailKey").is_none());
        assert!(comics["comics"][0].get("coverThumbnailKey").is_none());
        assert!(comics["comics"][0].get("coverKey").is_some());
        assert!(comics["comics"][0]["coverMtimeMs"].as_u64().is_some());
        assert!(
            comics["comics"][0]["detailVersion"]
                .as_str()
                .is_some_and(|value| value.len() == 16)
        );
        let books = libraries
            .iter()
            .find(|library| library["kind"] == "book")
            .unwrap();
        assert!(books.get("comics").is_none());
        assert!(books.get("path").is_none());
        assert!(books.get("id").is_none());
        let books = books["authors"][0]["books"].as_array().unwrap();
        let titles = books
            .iter()
            .map(|book| book["title"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(titles, ["Three", "Two"]);
        assert_eq!(books[1]["key"], "Books/Author/Two.txt");
        assert!(books[1].get("id").is_none());
        assert!(books[1].get("url").is_none());
        assert!(books[1].get("size").is_none());
        assert!(books[1]["mtimeMs"].as_u64().is_some());
        assert_eq!(
            books[1]["mtimeMs"],
            modified_ms(&author.join("Two.txt").metadata().unwrap()).unwrap()
        );
        assert!(books[1].get("chapters").is_none());
        assert!(books[1].get("detailKey").is_none());

        let book_detail: serde_json::Value = serde_json::from_slice(
            &fs::read(source.join("manifests/Books/Author/Two.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(book_detail["schemaVersion"], SCHEMA_VERSION);
        assert_eq!(book_detail["title"], "Two");
        assert!(book_detail.get("mtimeMs").is_none());
        assert_eq!(book_detail["lineCount"], 4);
        assert!(book_detail.get("id").is_none());
        assert!(book_detail.get("path").is_none());
        assert!(book_detail.get("key").is_none());
        assert_eq!(book_detail["chapters"][0]["title"], "序章");
        assert_eq!(book_detail["chapters"][0]["lineIndex"], 0);
        assert_eq!(book_detail["chapters"][1]["title"], "第一章 开始");
        assert_eq!(book_detail["chapters"][1]["lineIndex"], 2);

        let detail: serde_json::Value =
            serde_json::from_slice(&fs::read(source.join("manifests/Comics/Two.json")).unwrap())
                .unwrap();
        assert_eq!(detail["schemaVersion"], SCHEMA_VERSION);
        assert_eq!(detail["title"], "Two");
        assert!(detail.get("id").is_none());
        assert!(detail.get("path").is_none());
        assert!(detail.get("pageCount").is_none());
        assert!(detail["pages"][0].get("url").is_none());
        assert!(detail["pages"][0].get("index").is_none());
        assert!(detail["pages"][0].get("filename").is_none());
        assert_eq!(
            comics["comics"][0]["coverMtimeMs"],
            detail["pages"][0]["mtimeMs"]
        );
    }

    #[test]
    fn build_clears_stale_dirty_keys_for_ignored_files() {
        let temp = TestDir::new();
        let source = &temp.0;
        write_test_image(&source.join("Comics/One/001.png"), [255, 0, 0]);
        build_test_library(source);

        let mut database = state::StateDb::open(source).unwrap();
        database
            .enqueue_changes(
                &["Comics/.DS_Store".to_string()],
                fsevents::current_cursor(),
            )
            .unwrap();
        assert_eq!(
            database.dirty_units().unwrap(),
            vec!["Comics/.DS_Store".to_string()]
        );
        drop(database);

        build_test_library(source);

        let database = state::StateDb::open(source).unwrap();
        assert!(database.dirty_units().unwrap().is_empty());
    }

    #[test]
    fn missing_state_rebuilds_outputs_and_clears_orphans() {
        let temp = TestDir::new();
        let source = &temp.0;
        write_test_image(&source.join("Comics/One/001.png"), [255, 0, 0]);
        build_test_library(source);
        let thumbnail = source.join("thumbnail/Comics/One/001.webp");
        let thumbnail_mtime = thumbnail.metadata().unwrap().modified().unwrap();
        let stale_thumbnail = source.join("thumbnail/old.webp");
        let stale_manifest = source.join("manifests/old.json");
        fs::create_dir_all(stale_thumbnail.parent().unwrap()).unwrap();
        fs::create_dir_all(stale_manifest.parent().unwrap()).unwrap();
        fs::write(&stale_thumbnail, "stale").unwrap();
        fs::write(&stale_manifest, "stale").unwrap();
        remove_sqlite_state(source);
        thread::sleep(Duration::from_millis(20));

        build_test_library(source);

        assert!(!stale_thumbnail.exists());
        assert!(!stale_manifest.exists());
        assert_eq!(
            thumbnail.metadata().unwrap().modified().unwrap(),
            thumbnail_mtime
        );
        assert!(source.join("manifests/Comics/One.json").is_file());
    }

    #[test]
    fn missing_state_rebuilds_comic_after_source_file_is_renamed_over_an_existing_name() {
        let temp = TestDir::new();
        let source = &temp.0;
        let second_page = source.join("Comics/One/002.png");
        let third_page = source.join("Comics/One/003.png");
        write_test_image(&second_page, [255, 0, 0]);
        thread::sleep(Duration::from_millis(20));
        write_test_image(&third_page, [0, 255, 0]);
        build_test_library(source);

        let second_thumbnail = source.join("thumbnail/Comics/One/002.webp");
        let original_second_thumbnail = fs::read(&second_thumbnail).unwrap();
        remove_sqlite_state(source);
        thread::sleep(Duration::from_millis(20));
        fs::remove_file(&second_page).unwrap();
        fs::rename(&third_page, &second_page).unwrap();

        build_test_library(source);

        assert_ne!(
            fs::read(second_thumbnail).unwrap(),
            original_second_thumbnail
        );
    }

    #[test]
    fn incremental_build_rebuilds_comic_after_source_file_is_renamed_over_an_existing_name() {
        let temp = TestDir::new();
        let source = &temp.0;
        let first_page = source.join("Comics/One/001.png");
        let second_page = source.join("Comics/One/002.png");
        let third_page = source.join("Comics/One/003.png");
        let fourth_page = source.join("Comics/One/004.png");
        write_test_image(&first_page, [0, 0, 255]);
        write_test_image(&second_page, [255, 0, 0]);
        thread::sleep(Duration::from_millis(20));
        write_test_image(&third_page, [0, 255, 0]);
        build_test_library(source);

        let first_thumbnail = source.join("thumbnail/Comics/One/001.webp");
        let second_thumbnail = source.join("thumbnail/Comics/One/002.webp");
        let first_thumbnail_mtime = first_thumbnail.metadata().unwrap().modified().unwrap();
        let original_second_thumbnail = fs::read(&second_thumbnail).unwrap();
        thread::sleep(Duration::from_millis(20));
        fs::remove_file(&second_page).unwrap();
        fs::rename(&third_page, &second_page).unwrap();
        write_test_image(&fourth_page, [255, 255, 0]);

        build_test_library(source);

        assert_eq!(
            first_thumbnail.metadata().unwrap().modified().unwrap(),
            first_thumbnail_mtime
        );
        assert_ne!(
            fs::read(second_thumbnail).unwrap(),
            original_second_thumbnail
        );
        assert!(!source.join("thumbnail/Comics/One/003.webp").exists());
        assert!(source.join("thumbnail/Comics/One/004.webp").is_file());
    }

    #[test]
    fn malformed_sqlite_state_is_backed_up_and_rebuilt() {
        let temp = TestDir::new();
        let source = &temp.0;
        write_test_image(&source.join("Comics/One/001.png"), [255, 0, 0]);
        build_test_library(source);

        let thumbnail = source.join("thumbnail/Comics/One/001.webp");
        let thumbnail_bytes = fs::read(&thumbnail).unwrap();
        remove_sqlite_state(source);
        let database_path = source.join(".megumi/state.sqlite3");
        fs::write(&database_path, "not sqlite").unwrap();

        build_test_library(source);

        assert_eq!(fs::read(&thumbnail).unwrap(), thumbnail_bytes);
        assert!(
            fs::read_dir(source.join(".megumi"))
                .unwrap()
                .flatten()
                .any(|entry| entry.file_name().to_string_lossy().contains("corrupt-"))
        );
    }

    #[test]
    fn failed_build_keeps_immediate_unit_outputs_but_preserves_root_manifest() {
        let temp = TestDir::new();
        let source = &temp.0;
        let first_page = source.join("Comics/One/001.png");
        let second_page = source.join("Comics/Two/001.png");
        write_test_image(&first_page, [255, 0, 0]);
        write_test_image(&second_page, [0, 255, 0]);
        build_test_library(source);

        let thumbnail = source.join("thumbnail/Comics/One/001.webp");
        let before_thumbnail = fs::read(&thumbnail).unwrap();
        let before_manifest = fs::read(source.join(MANIFEST_FILE)).unwrap();
        let before_detail = fs::read(source.join("manifests/Comics/One.json")).unwrap();

        thread::sleep(Duration::from_millis(20));
        write_test_image(&first_page, [0, 0, 255]);
        fs::write(&second_page, "invalid image").unwrap();

        let error = build(test_build_args(source)).unwrap_err().to_string();
        assert!(error.contains("decode image"));
        assert_ne!(fs::read(&thumbnail).unwrap(), before_thumbnail);
        assert_eq!(
            fs::read(source.join(MANIFEST_FILE)).unwrap(),
            before_manifest
        );
        assert_ne!(
            fs::read(source.join("manifests/Comics/One.json")).unwrap(),
            before_detail
        );
        let checkpointed_thumbnail_mtime = thumbnail.metadata().unwrap().modified().unwrap();
        fs::remove_file(&second_page).unwrap();
        write_test_image(&second_page, [0, 255, 0]);
        build_test_library(source);
        assert_eq!(
            thumbnail.metadata().unwrap().modified().unwrap(),
            checkpointed_thumbnail_mtime
        );
    }

    #[test]
    fn unreadable_image_fails_build() {
        let temp = TestDir::new();
        let source = &temp.0;
        let good_page = source.join("Comics/One/001.png");
        let bad_page = source.join("Comics/One/002.png");
        write_test_image(&good_page, [255, 0, 0]);
        fs::create_dir_all(bad_page.parent().unwrap()).unwrap();
        fs::write(&bad_page, "invalid image").unwrap();

        assert!(build(test_build_args(source)).is_err());
    }
}
