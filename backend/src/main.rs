use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use clap::{Parser, Subcommand};
use image::imageops::FilterType;
use serde::{Deserialize, Serialize};
const MANIFEST_FILE: &str = "manifest.json";
const COMIC_MANIFEST_DIR: &str = "manifests";
const STATE_FILE: &str = ".megumi/state.json";
const THUMBNAIL_DIR: &str = "thumbnail";
const SCHEMA_VERSION: u32 = 2;
const STATE_VERSION: u32 = 2;
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png"];
const BOOK_EXTENSIONS: &[&str] = &["txt"];

#[derive(Parser)]
#[command(name = "megumi-backend")]
#[command(about = "Build static reader assets and manifest for Megumi")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Scan a source directory and build a static publish directory.
    Build(BuildArgs),
}

#[derive(Parser, Debug)]
struct BuildArgs {
    /// Resource root whose immediate child directories are libraries.
    #[arg(short, long, default_value = ".")]
    source: PathBuf,

    /// Directory for manifests, thumbnails and local build state. Defaults to the source root.
    #[arg(short, long)]
    output: Option<PathBuf>,

    /// Optional public URL prefix used by manifest URL fields.
    #[arg(long)]
    public_base_url: Option<String>,

    /// Generated thumbnail width in pixels.
    #[arg(long, default_value_t = 256)]
    thumbnail_width: u32,

    /// WebP quality for generated thumbnails.
    #[arg(long, default_value_t = 72)]
    thumbnail_quality: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    generated_at: String,
    source_root: String,
    public_base_url: Option<String>,
    libraries: Vec<LibraryManifest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryManifest {
    id: String,
    title: String,
    kind: LibraryKind,
    path: String,
    comics: Vec<ComicSummaryManifest>,
    authors: Vec<AuthorManifest>,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum LibraryKind {
    Comic,
    Book,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComicSummaryManifest {
    id: String,
    title: String,
    path: String,
    cover_thumbnail_key: Option<String>,
    page_count: usize,
    created_at: u64,
    detail_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComicManifest {
    schema_version: u32,
    id: String,
    title: String,
    path: String,
    page_count: usize,
    pages: Vec<PageManifest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PageManifest {
    filename: String,
    key: String,
    thumbnail_key: String,
    width: u32,
    height: u32,
    mtime_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorManifest {
    id: String,
    name: String,
    path: String,
    books: Vec<BookManifest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BookManifest {
    id: String,
    title: String,
    filename: String,
    key: String,
    url: String,
    size: u64,
    mtime_ms: u64,
    chapters: Vec<ChapterManifest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChapterManifest {
    title: String,
    line_index: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildState {
    version: u32,
    files: BTreeMap<String, FileState>,
    comics: BTreeMap<String, ComicState>,
}

impl Default for BuildState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            files: BTreeMap::new(),
            comics: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileState {
    size: u64,
    mtime_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    thumbnail_key: Option<String>,
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

#[derive(Debug)]
struct PendingOutput {
    staged_path: PathBuf,
    output_path: PathBuf,
}

#[derive(Debug)]
struct StagingDir {
    path: PathBuf,
}

impl StagingDir {
    fn create(output: &Path) -> Result<Self> {
        let state_dir = output.join(".megumi");
        fs::create_dir_all(&state_dir)
            .with_context(|| format!("create state directory: {}", state_dir.display()))?;
        for entry in fs::read_dir(&state_dir)
            .with_context(|| format!("read state directory: {}", state_dir.display()))?
        {
            let entry = entry?;
            if entry.file_type()?.is_dir()
                && entry.file_name().to_string_lossy().starts_with("staging-")
            {
                fs::remove_dir_all(entry.path()).with_context(|| {
                    format!(
                        "remove abandoned staging directory: {}",
                        entry.path().display()
                    )
                })?;
            }
        }
        let unique = format!(
            "staging-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let path = state_dir.join(unique);
        fs::create_dir_all(&path)
            .with_context(|| format!("create staging directory: {}", path.display()))?;
        Ok(Self { path })
    }
}

impl Drop for StagingDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[derive(Debug)]
struct BuildContext {
    source: PathBuf,
    output: PathBuf,
    public_base_url: Option<String>,
    thumbnail_width: u32,
    thumbnail_quality: u8,
    previous_state: BuildState,
    next_state: BuildState,
    staging: StagingDir,
    pending_thumbnails: Vec<PendingOutput>,
    pending_comic_manifests: Vec<PendingOutput>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Build(args) => build(args),
    }
}

fn build(args: BuildArgs) -> Result<()> {
    if args.thumbnail_width == 0 {
        bail!("thumbnail width must be greater than zero");
    }
    if args.thumbnail_quality > 100 {
        bail!("thumbnail quality must be between 0 and 100");
    }

    let source = args
        .source
        .canonicalize()
        .with_context(|| format!("source directory does not exist: {}", args.source.display()))?;
    if !source.is_dir() {
        bail!("source is not a directory: {}", source.display());
    }

    let output_arg = args.output.unwrap_or_else(|| source.clone());
    fs::create_dir_all(&output_arg)
        .with_context(|| format!("create output directory: {}", output_arg.display()))?;
    let output = output_arg.canonicalize().unwrap_or(output_arg);
    let previous_state = load_build_state(&output)?;
    let staging = StagingDir::create(&output)?;

    let mut ctx = BuildContext {
        source: source.clone(),
        output: output.clone(),
        public_base_url: args.public_base_url.map(trim_url_suffix),
        thumbnail_width: args.thumbnail_width,
        thumbnail_quality: args.thumbnail_quality,
        previous_state,
        next_state: BuildState::default(),
        staging,
        pending_thumbnails: Vec::new(),
        pending_comic_manifests: Vec::new(),
    };

    let libraries = scan_libraries(&mut ctx)?;
    let manifest = Manifest {
        schema_version: SCHEMA_VERSION,
        generated_at: now_rfc3339()?,
        source_root: source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("source")
            .to_string(),
        public_base_url: ctx.public_base_url.clone(),
        libraries,
    };

    commit_staged_outputs(&mut ctx.pending_thumbnails)?;
    commit_staged_outputs(&mut ctx.pending_comic_manifests)?;
    write_manifest_if_changed(&ctx.output.join(MANIFEST_FILE), &manifest)?;
    cleanup_removed_outputs(&ctx)?;
    write_json_if_changed(&ctx.output.join(STATE_FILE), &ctx.next_state)?;

    println!(
        "built {} with {} tracked source files",
        ctx.output.join(MANIFEST_FILE).display(),
        ctx.next_state.files.len()
    );
    Ok(())
}

fn scan_libraries(ctx: &mut BuildContext) -> Result<Vec<LibraryManifest>> {
    let mut library_dirs = read_child_dirs(&ctx.source)?;
    library_dirs.sort_by(|a, b| natord::compare(&display_name(a), &display_name(b)));

    let mut libraries = Vec::new();
    for library_dir in library_dirs {
        let rel = relative_key(&ctx.source, &library_dir)?;
        let kind = detect_library_kind(&library_dir)?;
        let title = display_name(&library_dir);
        let id = stable_id(&format!("library:{rel}"));
        let (comics, authors) = match kind {
            LibraryKind::Comic => (scan_comic_library(ctx, &library_dir)?, Vec::new()),
            LibraryKind::Book => (Vec::new(), scan_book_library(ctx, &library_dir)?),
        };

        libraries.push(LibraryManifest {
            id,
            title,
            kind,
            path: rel,
            comics,
            authors,
        });
    }
    Ok(libraries)
}

fn scan_comic_library(
    ctx: &mut BuildContext,
    library_dir: &Path,
) -> Result<Vec<ComicSummaryManifest>> {
    let mut comic_dirs = read_child_dirs(library_dir)?;
    comic_dirs.sort_by(|a, b| natord::compare(&display_name(a), &display_name(b)));

    let direct_pages = image_files_in(library_dir)?;
    if !direct_pages.is_empty() {
        return Ok(vec![scan_comic(ctx, library_dir, direct_pages)?]);
    }

    let mut comics = Vec::new();
    for comic_dir in comic_dirs {
        let pages = image_files_in(&comic_dir)?;
        if !pages.is_empty() {
            comics.push(scan_comic(ctx, &comic_dir, pages)?);
        }
    }
    Ok(comics)
}

fn scan_comic(
    ctx: &mut BuildContext,
    comic_dir: &Path,
    mut image_paths: Vec<PathBuf>,
) -> Result<ComicSummaryManifest> {
    image_paths.sort_by(|a, b| natord::compare(&display_name(a), &display_name(b)));
    let rel = relative_key(&ctx.source, comic_dir)?;
    let id = stable_id(&format!("comic:{rel}"));
    let title = display_name(comic_dir);

    let mut pages = Vec::with_capacity(image_paths.len());
    for image_path in image_paths {
        pages.push(process_image(ctx, &image_path)?);
    }

    let cover_thumbnail_key = pages.first().map(|page| page.thumbnail_key.clone());
    let created_at = pages.first().map(|page| page.mtime_ms).unwrap_or_default();
    let page_count = pages.len();
    let detail_key = comic_manifest_key_for(&rel);
    let comic_state = ComicState {
        detail_key: detail_key.clone(),
        fingerprint: comic_fingerprint(&pages, &ctx.next_state.files)?,
    };
    let detail_unchanged = ctx.previous_state.comics.get(&rel) == Some(&comic_state)
        && ctx.output.join(&detail_key).is_file();
    ctx.next_state.comics.insert(rel.clone(), comic_state);

    if !detail_unchanged {
        let manifest = ComicManifest {
            schema_version: SCHEMA_VERSION,
            id: id.clone(),
            title: title.clone(),
            path: rel.clone(),
            page_count,
            pages,
        };
        stage_json_output(
            &ctx.staging,
            &ctx.output,
            &detail_key,
            &manifest,
            &mut ctx.pending_comic_manifests,
        )?;
    }

    Ok(ComicSummaryManifest {
        id,
        title,
        path: rel,
        cover_thumbnail_key,
        page_count,
        created_at,
        detail_key,
    })
}

fn scan_book_library(ctx: &mut BuildContext, library_dir: &Path) -> Result<Vec<AuthorManifest>> {
    let direct_books = book_files_in(library_dir)?;
    if !direct_books.is_empty() {
        return Ok(vec![scan_author(ctx, library_dir, direct_books)?]);
    }

    let mut author_dirs = read_child_dirs(library_dir)?;
    author_dirs.sort_by(|a, b| natord::compare(&display_name(a), &display_name(b)));

    let mut authors = Vec::new();
    for author_dir in author_dirs {
        let books = book_files_in(&author_dir)?;
        if !books.is_empty() {
            authors.push(scan_author(ctx, &author_dir, books)?);
        }
    }
    Ok(authors)
}

fn scan_author(
    ctx: &mut BuildContext,
    author_dir: &Path,
    mut book_paths: Vec<PathBuf>,
) -> Result<AuthorManifest> {
    book_paths.sort_by(|a, b| natord::compare(&display_name(a), &display_name(b)));
    let rel = relative_key(&ctx.source, author_dir)?;
    let id = stable_id(&format!("author:{rel}"));
    let name = display_name(author_dir);

    let mut books = Vec::with_capacity(book_paths.len());
    for book_path in book_paths {
        books.push(process_book(ctx, &book_path)?);
    }

    Ok(AuthorManifest {
        id,
        name,
        path: rel,
        books,
    })
}

fn process_image(ctx: &mut BuildContext, source_path: &Path) -> Result<PageManifest> {
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
    let unchanged = previous.is_some_and(|state| {
        state.size == size
            && state.mtime_ms == mtime_ms
            && state.thumbnail_key.as_deref() == Some(thumbnail_key.as_str())
            && output_thumb.is_file()
            && state.width.is_some()
            && state.height.is_some()
    });

    let (width, height) = if unchanged {
        let state = previous.expect("checked above");
        (state.width.unwrap_or(0), state.height.unwrap_or(0))
    } else {
        let staged_thumb = ctx.staging.path.join(&thumbnail_key);
        let dimensions = create_thumbnail(
            source_path,
            &staged_thumb,
            ctx.thumbnail_width,
            ctx.thumbnail_quality,
        )?;
        ctx.pending_thumbnails.push(PendingOutput {
            staged_path: staged_thumb,
            output_path: output_thumb.clone(),
        });
        dimensions
    };

    ctx.next_state.files.insert(
        rel.clone(),
        FileState {
            size,
            mtime_ms,
            thumbnail_key: Some(thumbnail_key.clone()),
            width: Some(width),
            height: Some(height),
        },
    );

    let filename = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    Ok(PageManifest {
        filename,
        key: key.clone(),
        thumbnail_key: thumbnail_key.clone(),
        width,
        height,
        mtime_ms,
    })
}

fn process_book(ctx: &mut BuildContext, source_path: &Path) -> Result<BookManifest> {
    let rel = relative_key(&ctx.source, source_path)?;
    let metadata = source_path
        .metadata()
        .with_context(|| format!("read metadata: {}", source_path.display()))?;
    let size = metadata.len();
    let mtime_ms = modified_ms(&metadata)?;
    let key = rel.clone();
    ctx.next_state.files.insert(
        rel.clone(),
        FileState {
            size,
            mtime_ms,
            thumbnail_key: None,
            width: None,
            height: None,
        },
    );

    let filename = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let title = source_path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(&filename)
        .to_string();
    let chapters = scan_book_chapters(source_path)?;
    Ok(BookManifest {
        id: stable_id(&format!("book:{rel}")),
        title,
        filename,
        key: key.clone(),
        url: url_for(ctx, &key),
        size,
        mtime_ms,
        chapters,
    })
}

fn scan_book_chapters(source_path: &Path) -> Result<Vec<ChapterManifest>> {
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

    Ok(chapters)
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

fn detect_library_kind(path: &Path) -> Result<LibraryKind> {
    if !book_files_in(path)?.is_empty() {
        return Ok(LibraryKind::Book);
    }

    for child in read_child_dirs(path)? {
        if !book_files_in(&child)?.is_empty() {
            return Ok(LibraryKind::Book);
        }
    }
    Ok(LibraryKind::Comic)
}

fn read_child_dirs(path: &Path) -> Result<Vec<PathBuf>> {
    let mut dirs = Vec::new();
    for entry in
        fs::read_dir(path).with_context(|| format!("read directory: {}", path.display()))?
    {
        let entry = entry?;
        let child = entry.path();
        if is_ignored_entry(&child) {
            continue;
        }
        if entry.file_type()?.is_dir() {
            dirs.push(child);
        }
    }
    Ok(dirs)
}

fn image_files_in(path: &Path) -> Result<Vec<PathBuf>> {
    files_with_extensions(path, IMAGE_EXTENSIONS)
}

fn book_files_in(path: &Path) -> Result<Vec<PathBuf>> {
    files_with_extensions(path, BOOK_EXTENSIONS)
}

fn files_with_extensions(path: &Path, extensions: &[&str]) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in
        fs::read_dir(path).with_context(|| format!("read directory: {}", path.display()))?
    {
        let entry = entry?;
        let child = entry.path();
        if is_ignored_entry(&child) {
            continue;
        }
        if entry.file_type()?.is_file() && has_extension(&child, extensions) {
            files.push(child);
        }
    }
    files.sort_by(|a, b| natord::compare(&display_name(a), &display_name(b)));
    Ok(files)
}

fn create_thumbnail(
    source: &Path,
    dest: &Path,
    target_width: u32,
    quality: u8,
) -> Result<(u32, u32)> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create directory: {}", parent.display()))?;
    }

    let image =
        image::open(source).with_context(|| format!("decode image: {}", source.display()))?;
    let width = image.width();
    let height = image.height();
    let target_height = ((height as u64 * target_width as u64) / width.max(1) as u64)
        .max(1)
        .try_into()
        .map_err(|_| anyhow!("thumbnail height overflow for {}", source.display()))?;
    let resized = image.resize_exact(target_width, target_height, FilterType::Triangle);
    let rgb = resized.to_rgb8();

    let tmp = dest.with_extension(format!("webp.{}.tmp", std::process::id()));
    let encoder = webp::Encoder::from_rgb(&rgb, rgb.width(), rgb.height());
    let encoded = encoder.encode(f32::from(quality));
    fs::write(&tmp, &*encoded)
        .with_context(|| format!("write temporary thumbnail: {}", tmp.display()))?;
    fs::rename(&tmp, dest).with_context(|| format!("write thumbnail: {}", dest.display()))?;
    Ok((width, height))
}

fn load_build_state(output: &Path) -> Result<BuildState> {
    let path = output.join(STATE_FILE);
    if !path.exists() {
        clear_managed_outputs(output)?;
        return Ok(BuildState::default());
    }
    let raw = fs::read(&path).with_context(|| format!("read state: {}", path.display()))?;
    let value: serde_json::Value =
        serde_json::from_slice(&raw).with_context(|| format!("parse state: {}", path.display()))?;

    let version = value.get("version");
    if version.is_none() || version.and_then(serde_json::Value::as_u64) == Some(1) {
        clear_managed_outputs(output)?;
        fs::remove_file(&path)
            .with_context(|| format!("remove legacy state: {}", path.display()))?;
        return Ok(BuildState::default());
    }

    let Some(version) = version.and_then(serde_json::Value::as_u64) else {
        bail!("invalid state version in {}", path.display());
    };
    if version != u64::from(STATE_VERSION) {
        bail!("unsupported state version {version} in {}", path.display());
    }

    serde_json::from_value(value).with_context(|| format!("parse state: {}", path.display()))
}

fn clear_managed_outputs(output: &Path) -> Result<()> {
    for directory in [THUMBNAIL_DIR, COMIC_MANIFEST_DIR] {
        let path = output.join(directory);
        if path.exists() {
            fs::remove_dir_all(&path)
                .with_context(|| format!("remove managed directory: {}", path.display()))?;
        }
    }
    Ok(())
}

fn write_json_if_changed<T: Serialize>(path: &Path, value: &T) -> Result<bool> {
    let data = serde_json::to_vec(value)?;
    if fs::read(path).is_ok_and(|existing| existing == data) {
        return Ok(false);
    }
    write_bytes_atomic(path, &data)?;
    Ok(true)
}

fn write_manifest_if_changed<T: Serialize>(path: &Path, value: &T) -> Result<bool> {
    let mut next = serde_json::to_value(value)?;
    if let Ok(existing) = fs::read(path)
        && let Ok(mut previous) = serde_json::from_slice::<serde_json::Value>(&existing)
    {
        previous["generatedAt"] = serde_json::Value::Null;
        next["generatedAt"] = serde_json::Value::Null;
        if previous == next {
            return Ok(false);
        }
    }
    write_json_if_changed(path, value)
}

fn write_bytes_atomic(path: &Path, data: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create directory: {}", parent.display()))?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&tmp, data).with_context(|| format!("write temporary file: {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("write file: {}", path.display()))?;
    Ok(())
}

fn stage_json_output<T: Serialize>(
    staging: &StagingDir,
    output: &Path,
    key: &str,
    value: &T,
    pending_outputs: &mut Vec<PendingOutput>,
) -> Result<()> {
    let staged_path = staging.path.join(key);
    if let Some(parent) = staged_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create staging directory: {}", parent.display()))?;
    }
    let data = serde_json::to_vec(value)?;
    fs::write(&staged_path, data)
        .with_context(|| format!("write staged JSON: {}", staged_path.display()))?;
    pending_outputs.push(PendingOutput {
        staged_path,
        output_path: output.join(key),
    });
    Ok(())
}

fn commit_staged_outputs(pending_outputs: &mut Vec<PendingOutput>) -> Result<()> {
    for pending in pending_outputs.drain(..) {
        if let Some(parent) = pending.output_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create directory: {}", parent.display()))?;
        }
        fs::rename(&pending.staged_path, &pending.output_path).with_context(|| {
            format!(
                "commit staged output {} to {}",
                pending.staged_path.display(),
                pending.output_path.display()
            )
        })?;
    }
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

fn cleanup_removed_outputs(ctx: &BuildContext) -> Result<()> {
    let current_thumbnails: BTreeSet<_> = ctx
        .next_state
        .files
        .values()
        .filter_map(|state| state.thumbnail_key.as_deref())
        .collect();
    for (source_key, previous) in &ctx.previous_state.files {
        let current_key = ctx
            .next_state
            .files
            .get(source_key)
            .and_then(|state| state.thumbnail_key.as_deref());
        if let Some(previous_key) = previous.thumbnail_key.as_deref()
            && current_key != Some(previous_key)
            && !current_thumbnails.contains(previous_key)
        {
            remove_generated_file(&ctx.output, previous_key)?;
        }
    }

    let current_manifests: BTreeSet<_> = ctx
        .next_state
        .comics
        .values()
        .map(|state| state.detail_key.as_str())
        .collect();
    for (comic_path, previous) in &ctx.previous_state.comics {
        let current_key = ctx
            .next_state
            .comics
            .get(comic_path)
            .map(|state| state.detail_key.as_str());
        if current_key != Some(previous.detail_key.as_str())
            && !current_manifests.contains(previous.detail_key.as_str())
        {
            remove_generated_file(&ctx.output, &previous.detail_key)?;
        }
    }
    Ok(())
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

fn modified_ms(metadata: &fs::Metadata) -> Result<u64> {
    Ok(metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX))
}

fn stable_id(input: &str) -> String {
    blake3::hash(input.as_bytes()).to_hex()[..16].to_string()
}

fn thumbnail_key_for(rel: &str) -> String {
    let mut path = PathBuf::from(THUMBNAIL_DIR);
    path.push(rel);
    path.set_extension("webp");
    path.to_string_lossy().replace('\\', "/")
}

fn comic_manifest_key_for(rel: &str) -> String {
    format!("{COMIC_MANIFEST_DIR}/{rel}.json")
}

fn url_for(ctx: &BuildContext, key: &str) -> String {
    let encoded = percent_encode_key(key);
    match &ctx.public_base_url {
        Some(base) => format!("{base}/{encoded}"),
        None => encoded,
    }
}

fn trim_url_suffix(mut value: String) -> String {
    while value.ends_with('/') {
        value.pop();
    }
    value
}

fn percent_encode_key(key: &str) -> String {
    let mut encoded = String::new();
    for byte in key.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
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
    use std::thread;
    use std::time::Duration;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let unique = format!(
                "megumi-test-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
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

    fn test_build_args(source: &Path) -> BuildArgs {
        BuildArgs {
            source: source.to_path_buf(),
            output: None,
            public_base_url: None,
            thumbnail_width: 16,
            thumbnail_quality: 72,
        }
    }

    fn build_test_library(source: &Path) {
        build(test_build_args(source)).unwrap();
    }

    fn write_test_image(path: &Path, color: [u8; 3]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        RgbImage::from_pixel(20, 30, Rgb(color)).save(path).unwrap();
    }

    #[test]
    fn ids_are_stable_and_short() {
        assert_eq!(stable_id("comic:a"), stable_id("comic:a"));
        assert_ne!(stable_id("comic:a"), stable_id("comic:b"));
        assert_eq!(stable_id("comic:a").len(), 16);
    }

    #[test]
    fn trims_public_base_url_suffix() {
        assert_eq!(
            trim_url_suffix("https://cdn.example.com///".to_string()),
            "https://cdn.example.com"
        );
    }

    #[test]
    fn percent_encodes_url_keys_without_escaping_slashes() {
        assert_eq!(
            percent_encode_key("作者/Book One.txt"),
            "%E4%BD%9C%E8%80%85/Book%20One.txt"
        );
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
            comic_manifest_key_for("Comics/Comic.v1"),
            "manifests/Comics/Comic.v1.json"
        );
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
        let initial_state_mtime = source
            .join(STATE_FILE)
            .metadata()
            .unwrap()
            .modified()
            .unwrap();
        let state: serde_json::Value =
            serde_json::from_slice(&fs::read(source.join(STATE_FILE)).unwrap()).unwrap();
        assert_eq!(state["version"], STATE_VERSION);
        assert!(state["files"]["Comics/One/001.png"].get("key").is_none());
        assert!(
            state["files"]["Books/Author/One.txt"]
                .get("thumbnailKey")
                .is_none()
        );
        assert!(
            state["comics"]["Comics/One"]["fingerprint"]
                .as_str()
                .is_some_and(|value| value.len() == 16)
        );

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
        assert_eq!(
            source
                .join(STATE_FILE)
                .metadata()
                .unwrap()
                .modified()
                .unwrap(),
            initial_state_mtime
        );

        fs::remove_file(second_page).unwrap();
        build_test_library(source);
        let reduced_detail: serde_json::Value =
            serde_json::from_slice(&fs::read(&comic_manifest).unwrap()).unwrap();
        assert_eq!(reduced_detail["pageCount"], 1);
        assert!(!second_thumbnail.exists());

        fs::rename(source.join("Comics/One"), source.join("Comics/Two")).unwrap();
        fs::remove_file(author.join("One.txt")).unwrap();
        fs::write(author.join("Three.txt"), "third").unwrap();
        build_test_library(source);

        assert!(!comic_manifest.exists());
        assert!(!first_thumbnail.exists());
        assert!(source.join("manifests/Comics/Two.json").is_file());
        assert!(source.join("thumbnail/Comics/Two/001.webp").is_file());

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(root_manifest).unwrap()).unwrap();
        assert_eq!(manifest["schemaVersion"], 2);
        let libraries = manifest["libraries"].as_array().unwrap();
        let comics = libraries
            .iter()
            .find(|library| library["kind"] == "comic")
            .unwrap();
        assert_eq!(comics["comics"][0]["title"], "Two");
        let books = libraries
            .iter()
            .find(|library| library["kind"] == "book")
            .unwrap()["authors"][0]["books"]
            .as_array()
            .unwrap();
        let titles = books
            .iter()
            .map(|book| book["title"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(titles, ["Three", "Two"]);
        assert_eq!(books[1]["chapters"][0]["title"], "序章");
        assert_eq!(books[1]["chapters"][0]["lineIndex"], 0);
        assert_eq!(books[1]["chapters"][1]["title"], "第一章 开始");
        assert_eq!(books[1]["chapters"][1]["lineIndex"], 2);

        let detail: serde_json::Value =
            serde_json::from_slice(&fs::read(source.join("manifests/Comics/Two.json")).unwrap())
                .unwrap();
        assert_eq!(detail["schemaVersion"], 2);
        assert_eq!(detail["pageCount"], 1);
        assert!(detail["pages"][0].get("url").is_none());
        assert!(detail["pages"][0].get("index").is_none());
    }

    #[test]
    fn missing_state_clears_untracked_managed_outputs() {
        let temp = TestDir::new();
        let source = &temp.0;
        write_test_image(&source.join("Comics/One/001.png"), [255, 0, 0]);
        let stale_thumbnail = source.join("thumbnail/old.webp");
        let stale_manifest = source.join("manifests/old.json");
        let stale_staging = source.join(".megumi/staging-abandoned/file.tmp");
        fs::create_dir_all(stale_thumbnail.parent().unwrap()).unwrap();
        fs::create_dir_all(stale_manifest.parent().unwrap()).unwrap();
        fs::create_dir_all(stale_staging.parent().unwrap()).unwrap();
        fs::write(&stale_thumbnail, "stale").unwrap();
        fs::write(&stale_manifest, "stale").unwrap();
        fs::write(&stale_staging, "stale").unwrap();

        build_test_library(source);

        assert!(!stale_thumbnail.exists());
        assert!(!stale_manifest.exists());
        assert!(!stale_staging.exists());
        assert!(source.join("thumbnail/Comics/One/001.webp").is_file());
        assert!(source.join("manifests/Comics/One.json").is_file());
    }

    #[test]
    fn legacy_state_is_removed_and_outputs_are_rebuilt() {
        let temp = TestDir::new();
        let source = &temp.0;
        write_test_image(&source.join("Comics/One/001.png"), [255, 0, 0]);
        build_test_library(source);

        let thumbnail = source.join("thumbnail/Comics/One/001.webp");
        let detail = source.join("manifests/Comics/One.json");
        fs::write(&thumbnail, "legacy thumbnail").unwrap();
        fs::write(&detail, "legacy detail").unwrap();
        fs::write(source.join(STATE_FILE), r#"{"files":{}}"#).unwrap();

        build_test_library(source);

        let thumbnail_bytes = fs::read(&thumbnail).unwrap();
        assert_ne!(thumbnail_bytes, b"legacy thumbnail");
        assert_eq!(&thumbnail_bytes[..4], b"RIFF");
        assert_eq!(&thumbnail_bytes[8..12], b"WEBP");
        let detail_json: serde_json::Value =
            serde_json::from_slice(&fs::read(detail).unwrap()).unwrap();
        assert_eq!(detail_json["schemaVersion"], SCHEMA_VERSION);
        let state: serde_json::Value =
            serde_json::from_slice(&fs::read(source.join(STATE_FILE)).unwrap()).unwrap();
        assert_eq!(state["version"], STATE_VERSION);
    }

    #[test]
    fn malformed_and_unknown_state_stop_without_deleting_outputs() {
        let temp = TestDir::new();
        let source = &temp.0;
        write_test_image(&source.join("Comics/One/001.png"), [255, 0, 0]);
        build_test_library(source);
        let thumbnail = source.join("thumbnail/Comics/One/001.webp");
        let thumbnail_bytes = fs::read(&thumbnail).unwrap();

        fs::write(source.join(STATE_FILE), "not json").unwrap();
        let malformed = build(test_build_args(source)).unwrap_err().to_string();
        assert!(malformed.contains("parse state"));
        assert_eq!(fs::read(&thumbnail).unwrap(), thumbnail_bytes);

        fs::write(
            source.join(STATE_FILE),
            r#"{"version":99,"files":{},"comics":{}}"#,
        )
        .unwrap();
        let unknown = build(test_build_args(source)).unwrap_err().to_string();
        assert!(unknown.contains("unsupported state version 99"));
        assert_eq!(fs::read(thumbnail).unwrap(), thumbnail_bytes);
    }

    #[test]
    fn failed_build_discards_staged_thumbnails_and_preserves_published_state() {
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
        let before_state = fs::read(source.join(STATE_FILE)).unwrap();

        thread::sleep(Duration::from_millis(20));
        write_test_image(&first_page, [0, 0, 255]);
        fs::write(&second_page, "invalid image").unwrap();

        let error = build(test_build_args(source)).unwrap_err().to_string();
        assert!(error.contains("decode image"));
        assert_eq!(fs::read(thumbnail).unwrap(), before_thumbnail);
        assert_eq!(
            fs::read(source.join(MANIFEST_FILE)).unwrap(),
            before_manifest
        );
        assert_eq!(
            fs::read(source.join("manifests/Comics/One.json")).unwrap(),
            before_detail
        );
        assert_eq!(fs::read(source.join(STATE_FILE)).unwrap(), before_state);
        let staging_leftovers = fs::read_dir(source.join(".megumi"))
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("staging-"))
            .count();
        assert_eq!(staging_leftovers, 0);
    }
}
