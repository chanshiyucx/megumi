use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Cursor};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use clap::{Parser, Subcommand};
use fast_image_resize as fr;
use image::ImageReader;
use memmap2::Mmap;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use turbojpeg::{Decompressor, Image as JpegImage, PixelFormat, ScalingFactor};
const MANIFEST_FILE: &str = "manifest.json";
const COMIC_MANIFEST_DIR: &str = "manifests";
const STATE_FILE: &str = ".megumi/state.json";
const TAGS_FILE: &str = ".megumi/tags.json";
const THUMBNAIL_DIR: &str = "thumbnail";
const SCHEMA_VERSION: u32 = 4;
const THUMBNAIL_WIDTH: u32 = 256;
const THUMBNAIL_QUALITY: u8 = 72;
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png"];
const BOOK_EXTENSIONS: &[&str] = &["txt"];
const PROGRESS_REPORT_INTERVAL: usize = 500;
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

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    generated_at: String,
    libraries: Vec<LibraryManifest>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
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
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct ComicSummaryManifest {
    title: String,
    cover_key: String,
    cover_mtime_ms: u64,
    detail_version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComicManifest {
    schema_version: u32,
    title: String,
    pages: Vec<PageManifest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PageManifest {
    key: String,
    thumbnail_key: String,
    width: u32,
    height: u32,
    mtime_ms: u64,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct AuthorManifest {
    name: String,
    books: Vec<BookManifest>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct BookManifest {
    title: String,
    key: String,
    mtime_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BookDetailManifest {
    schema_version: u32,
    title: String,
    line_count: usize,
    chapters: Vec<ChapterManifest>,
}

#[derive(Debug, Serialize)]
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
    images: BTreeMap<String, FileTags>,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug)]
struct PendingOutput {
    output_path: PathBuf,
    data: Vec<u8>,
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

enum LibraryScan {
    Comic {
        title: String,
        comics: Vec<ComicScan>,
    },
    Book {
        title: String,
        authors: Vec<AuthorScan>,
    },
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
    processed_images: AtomicUsize,
    built_thumbnails: AtomicUsize,
    reused_thumbnails: AtomicUsize,
    synced_tag_targets: AtomicUsize,
    changed_tag_targets: AtomicUsize,
    report_every: usize,
}

impl BuildProgress {
    fn new(report_every: usize) -> Self {
        Self {
            processed_images: AtomicUsize::new(0),
            built_thumbnails: AtomicUsize::new(0),
            reused_thumbnails: AtomicUsize::new(0),
            synced_tag_targets: AtomicUsize::new(0),
            changed_tag_targets: AtomicUsize::new(0),
            report_every,
        }
    }

    fn record_processed(&self, thumbnail_built: bool) {
        if thumbnail_built {
            self.built_thumbnails.fetch_add(1, Ordering::Relaxed);
        } else {
            self.reused_thumbnails.fetch_add(1, Ordering::Relaxed);
        }
        self.report_if_due(self.processed_images.fetch_add(1, Ordering::Relaxed) + 1);
    }

    fn record_tag_sync(&self, changed: bool) {
        self.synced_tag_targets.fetch_add(1, Ordering::Relaxed);
        if changed {
            self.changed_tag_targets.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn report_if_due(&self, processed: usize) {
        if self.report_every > 0 && processed.is_multiple_of(self.report_every) {
            eprintln!(
                "processed {processed} images ({} thumbnails built, {} reused)",
                self.built_thumbnails.load(Ordering::Relaxed),
                self.reused_thumbnails.load(Ordering::Relaxed)
            );
        }
    }

    fn snapshot(&self) -> BuildProgressSnapshot {
        BuildProgressSnapshot {
            processed_images: self.processed_images.load(Ordering::Relaxed),
            built_thumbnails: self.built_thumbnails.load(Ordering::Relaxed),
            reused_thumbnails: self.reused_thumbnails.load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug)]
struct BuildProgressSnapshot {
    processed_images: usize,
    built_thumbnails: usize,
    reused_thumbnails: usize,
}

#[derive(Debug)]
struct BuildContext {
    source: PathBuf,
    output: PathBuf,
    previous_state: BuildState,
    next_state: BuildState,
    pending_detail_manifests: Vec<PendingOutput>,
    progress: BuildProgress,
    remote_tags: Option<RemoteTags>,
    full_rebuild: bool,
    matched_previous_files: AtomicUsize,
}

struct LoadedBuildState {
    state: BuildState,
    missing: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Build(args) => build(args),
    }
}

fn build(args: BuildArgs) -> Result<()> {
    let source = args
        .source
        .canonicalize()
        .with_context(|| format!("source directory does not exist: {}", args.source.display()))?;
    if !source.is_dir() {
        bail!("source is not a directory: {}", source.display());
    }

    let output = source.clone();
    let loaded_state = load_build_state(&output)?;
    let previous_state = loaded_state.state;
    let remote_tags = load_remote_tags(&source)?;
    let applied_tags = remote_tags
        .clone()
        .or_else(|| previous_state.applied_tags.clone());
    let mut ctx = BuildContext {
        source: source.clone(),
        output: output.clone(),
        previous_state,
        next_state: BuildState {
            applied_tags,
            ..BuildState::default()
        },
        pending_detail_manifests: Vec::new(),
        progress: BuildProgress::new(PROGRESS_REPORT_INTERVAL),
        remote_tags,
        full_rebuild: loaded_state.missing,
        matched_previous_files: AtomicUsize::new(0),
    };

    let (library_scans, image_paths) = collect_library_scans(&ctx)?;
    let thumbnail_pool = rayon::ThreadPoolBuilder::new()
        .num_threads(recommended_thumbnail_workers())
        .build()
        .context("create thumbnail worker pool")?;
    let processed_images = thumbnail_pool.install(|| {
        image_paths
            .par_iter()
            .map_init(ThumbnailWorker::new, |worker, image_path| {
                process_image(&ctx, image_path, worker)
            })
            .collect::<Result<Vec<_>>>()
    })?;
    let libraries = build_libraries(&mut ctx, library_scans, processed_images)?;
    warn_missing_tag_targets(&ctx);
    let manifest = Manifest {
        schema_version: SCHEMA_VERSION,
        generated_at: now_rfc3339()?,
        libraries,
    };

    commit_pending_outputs(&mut ctx.pending_detail_manifests)?;
    write_manifest_if_changed(&ctx.output.join(MANIFEST_FILE), &manifest)?;
    if ctx.full_rebuild {
        cleanup_orphaned_outputs(&ctx)?;
    } else if ctx.matched_previous_files.load(Ordering::Relaxed) != ctx.previous_state.files.len() {
        cleanup_removed_outputs(&ctx)?;
    }
    if ctx.full_rebuild || ctx.previous_state != ctx.next_state {
        write_json(&ctx.output.join(STATE_FILE), &ctx.next_state)?;
    }

    let progress = ctx.progress.snapshot();
    let synced_tag_targets = ctx.progress.synced_tag_targets.load(Ordering::Relaxed);
    if synced_tag_targets > 0 {
        eprintln!(
            "synced {synced_tag_targets} local tag targets ({} changed)",
            ctx.progress.changed_tag_targets.load(Ordering::Relaxed)
        );
    }
    println!(
        "built {} with {} tracked source files; processed {} images ({} thumbnails built, {} reused)",
        ctx.output.join(MANIFEST_FILE).display(),
        ctx.next_state.files.len(),
        progress.processed_images,
        progress.built_thumbnails,
        progress.reused_thumbnails
    );
    Ok(())
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

    (baseline * 3 / 4).clamp(1, 12)
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

fn collect_library_scans(ctx: &BuildContext) -> Result<(Vec<LibraryScan>, Vec<PathBuf>)> {
    let root = inspect_directory(&ctx.source)?;
    let mut libraries = Vec::new();
    let mut image_paths = Vec::new();
    for library_dir in root.directories {
        if let Some(library) = collect_library_scan(ctx, &library_dir, &mut image_paths)? {
            libraries.push(library);
        }
    }
    Ok((libraries, image_paths))
}

fn collect_library_scan(
    ctx: &BuildContext,
    library_dir: &Path,
    image_paths: &mut Vec<PathBuf>,
) -> Result<Option<LibraryScan>> {
    let title = display_name(library_dir);
    let contents = inspect_directory(library_dir)?;
    if !contents.images.is_empty() || !contents.books.is_empty() {
        bail!(
            "library contains content files directly; expected content directories: {}",
            library_dir.display()
        );
    }
    if contents.directories.is_empty() {
        bail!(
            "library has no content directories: {}",
            library_dir.display()
        );
    }

    let mut children = Vec::with_capacity(contents.directories.len());
    for child_dir in &contents.directories {
        let child = inspect_directory(child_dir)?;
        if !child.directories.is_empty() {
            bail!(
                "content directory contains nested directories: {}",
                child_dir.display()
            );
        }
        if child.images.is_empty() && child.books.is_empty() {
            eprintln!(
                "warning: skipping empty content directory: {}",
                child_dir.display()
            );
            continue;
        }
        if !child.images.is_empty() && !child.books.is_empty() {
            bail!(
                "content directory mixes comic images and text books: {}",
                child_dir.display()
            );
        }
        children.push((child_dir.clone(), child));
    }

    if children.is_empty() {
        eprintln!(
            "warning: skipping library with no valid content directories: {}",
            library_dir.display()
        );
        return Ok(None);
    }

    let has_images = children.iter().any(|(_, child)| !child.images.is_empty());
    let has_books = children.iter().any(|(_, child)| !child.books.is_empty());
    if has_images && has_books {
        bail!(
            "library mixes comic images and text books: {}",
            library_dir.display()
        );
    }

    if has_books {
        let mut authors = Vec::with_capacity(children.len());
        for (author_dir, child) in children {
            authors.push(AuthorScan {
                name: display_name(&author_dir),
                book_paths: child.books,
            });
        }
        return Ok(Some(LibraryScan::Book { title, authors }));
    }

    let mut comics = Vec::with_capacity(children.len());
    for (comic_dir, child) in children {
        let rel = relative_key(&ctx.source, &comic_dir)?;
        let comic_title = display_name(&comic_dir);
        let is_new_comic = !ctx.previous_state.comics.contains_key(&rel);
        sync_comic_tags(ctx, &comic_dir, &comic_title, is_new_comic)?;

        let thumbnail_dir = ctx.output.join(THUMBNAIL_DIR).join(&rel);
        fs::create_dir_all(&thumbnail_dir).with_context(|| {
            format!(
                "create thumbnail directory for comic: {}",
                comic_dir.display()
            )
        })?;

        let image_count = child.images.len();
        image_paths.extend(child.images);
        comics.push(ComicScan {
            path: comic_dir,
            rel,
            title: comic_title,
            image_count,
        });
    }
    Ok(Some(LibraryScan::Comic { title, comics }))
}

fn build_libraries(
    ctx: &mut BuildContext,
    scans: Vec<LibraryScan>,
    processed_images: Vec<ProcessedImage>,
) -> Result<Vec<LibraryManifest>> {
    let mut processed_images = processed_images.into_iter();
    let mut libraries = Vec::with_capacity(scans.len());

    for scan in scans {
        match scan {
            LibraryScan::Comic { title, comics } => {
                let mut manifests = Vec::with_capacity(comics.len());
                for comic in comics {
                    manifests.push(build_comic(ctx, comic, &mut processed_images)?);
                }
                libraries.push(LibraryManifest::Comic {
                    title,
                    comics: manifests,
                });
            }
            LibraryScan::Book { title, authors } => {
                let mut manifests = Vec::with_capacity(authors.len());
                for author in authors {
                    manifests.push(build_author(ctx, author)?);
                }
                libraries.push(LibraryManifest::Book {
                    title,
                    authors: manifests,
                });
            }
        }
    }

    if processed_images.next().is_some() {
        bail!("internal error: unassigned processed image");
    }
    Ok(libraries)
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
        queue_json_output(
            &ctx.output,
            &detail_key,
            &manifest,
            &mut ctx.pending_detail_manifests,
        )?;
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
    if previous.is_some() {
        ctx.matched_previous_files.fetch_add(1, Ordering::Relaxed);
    }
    sync_image_tags(ctx, source_path, &rel, previous.is_none())?;
    let unchanged = previous.is_some_and(|state| {
        state.size == size
            && state.mtime_ms == mtime_ms
            && state.width.is_some()
            && state.height.is_some()
    });

    let (width, height, thumbnail_built) = if unchanged && output_thumb.is_file() {
        let state = previous.expect("checked above");
        (state.width.unwrap_or(0), state.height.unwrap_or(0), false)
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

fn process_book(ctx: &mut BuildContext, source_path: &Path) -> Result<BookManifest> {
    let rel = relative_key(&ctx.source, source_path)?;
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
    if previous.is_some() {
        ctx.matched_previous_files.fetch_add(1, Ordering::Relaxed);
    }
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
        queue_json_output(
            &ctx.output,
            &detail_key,
            &manifest,
            &mut ctx.pending_detail_manifests,
        )?;
    }

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
}

fn inspect_directory(path: &Path) -> Result<DirectoryContents> {
    let mut directories = Vec::new();
    let mut images = Vec::new();
    let mut books = Vec::new();
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
            }
        }
    }
    directories.sort_by(|a, b| compare_path_names(a, b));
    images.sort_by(|a, b| compare_path_names(a, b));
    books.sort_by(|a, b| compare_path_names(a, b));
    Ok(DirectoryContents {
        directories,
        images,
        books,
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

fn load_build_state(output: &Path) -> Result<LoadedBuildState> {
    let path = output.join(STATE_FILE);
    if !path.exists() {
        return Ok(LoadedBuildState {
            state: BuildState::default(),
            missing: true,
        });
    }
    let raw = fs::read(&path).with_context(|| format!("read state: {}", path.display()))?;
    let state = serde_json::from_slice(&raw)
        .with_context(|| format!("parse current build state: {}", path.display()))?;
    Ok(LoadedBuildState {
        state,
        missing: false,
    })
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
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&tmp, data).with_context(|| format!("write temporary file: {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("write file: {}", path.display()))?;
    Ok(())
}

fn queue_json_output<T: Serialize>(
    output: &Path,
    key: &str,
    value: &T,
    pending_outputs: &mut Vec<PendingOutput>,
) -> Result<()> {
    pending_outputs.push(PendingOutput {
        output_path: output.join(key),
        data: serde_json::to_vec(value)?,
    });
    Ok(())
}

fn commit_pending_outputs(pending_outputs: &mut Vec<PendingOutput>) -> Result<()> {
    for pending in pending_outputs.drain(..) {
        if fs::read(&pending.output_path).is_ok_and(|existing| existing == pending.data) {
            continue;
        }
        write_bytes_atomic(&pending.output_path, &pending.data)?;
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
    for source_key in ctx.previous_state.files.keys() {
        if ctx.next_state.files.contains_key(source_key) {
            continue;
        }
        let source_path = Path::new(source_key);
        if has_extension(source_path, IMAGE_EXTENSIONS) {
            remove_generated_file(&ctx.output, &thumbnail_key_for(source_key))?;
        } else if has_extension(source_path, BOOK_EXTENSIONS) {
            let detail_key = detail_manifest_key_for(&strip_extension(source_key));
            remove_generated_file(&ctx.output, &detail_key)?;
        }
    }

    for (comic_path, previous) in &ctx.previous_state.comics {
        if !ctx.next_state.comics.contains_key(comic_path) {
            remove_generated_file(&ctx.output, &previous.detail_key)?;
        }
    }
    Ok(())
}

fn cleanup_orphaned_outputs(ctx: &BuildContext) -> Result<()> {
    let expected_thumbnails: BTreeSet<_> = ctx
        .next_state
        .files
        .keys()
        .filter(|source_key| has_extension(Path::new(source_key), IMAGE_EXTENSIONS))
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

    fn test_build_args(source: &Path) -> BuildArgs {
        BuildArgs {
            source: source.to_path_buf(),
        }
    }

    fn build_test_library(source: &Path) {
        build(test_build_args(source)).unwrap();
    }

    fn write_test_image(path: &Path, color: [u8; 3]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        RgbImage::from_pixel(20, 30, Rgb(color)).save(path).unwrap();
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
        let initial_state_mtime = source
            .join(STATE_FILE)
            .metadata()
            .unwrap()
            .modified()
            .unwrap();
        let state: serde_json::Value =
            serde_json::from_slice(&fs::read(source.join(STATE_FILE)).unwrap()).unwrap();
        assert!(state.get("version").is_none());
        assert!(state.get("books").is_none());
        assert!(state["files"]["Comics/One/001.png"].get("key").is_none());
        assert!(
            state["files"]["Comics/One/001.png"]
                .get("thumbnailKey")
                .is_none()
        );
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
        fs::remove_file(source.join(STATE_FILE)).unwrap();
        thread::sleep(Duration::from_millis(20));

        build_test_library(source);

        assert!(!stale_thumbnail.exists());
        assert!(!stale_manifest.exists());
        assert!(thumbnail.metadata().unwrap().modified().unwrap() > thumbnail_mtime);
        assert!(source.join("manifests/Comics/One.json").is_file());
    }

    #[test]
    fn missing_state_rebuilds_comic_after_source_file_is_renamed_over_an_existing_name() {
        let temp = TestDir::new();
        let source = &temp.0;
        let second_page = source.join("Comics/One/002.png");
        let third_page = source.join("Comics/One/003.png");
        write_test_image(&second_page, [255, 0, 0]);
        write_test_image(&third_page, [0, 255, 0]);
        build_test_library(source);

        let second_thumbnail = source.join("thumbnail/Comics/One/002.webp");
        let original_second_thumbnail = fs::read(&second_thumbnail).unwrap();
        fs::remove_file(source.join(STATE_FILE)).unwrap();
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
    fn stale_or_malformed_state_fails_without_recovery() {
        let temp = TestDir::new();
        let source = &temp.0;
        write_test_image(&source.join("Comics/One/001.png"), [255, 0, 0]);
        build_test_library(source);

        let thumbnail = source.join("thumbnail/Comics/One/001.webp");
        let thumbnail_bytes = fs::read(&thumbnail).unwrap();
        let mut current_state: serde_json::Value =
            serde_json::from_slice(&fs::read(source.join(STATE_FILE)).unwrap()).unwrap();
        fs::write(source.join(STATE_FILE), r#"{"files":{}}"#).unwrap();

        let stale = build(test_build_args(source)).unwrap_err().to_string();
        assert!(stale.contains("parse current build state"));
        assert_eq!(fs::read(&thumbnail).unwrap(), thumbnail_bytes);

        fs::write(source.join(STATE_FILE), "not json").unwrap();
        let malformed = build(test_build_args(source)).unwrap_err().to_string();
        assert!(malformed.contains("parse current build state"));
        assert_eq!(fs::read(&thumbnail).unwrap(), thumbnail_bytes);

        current_state["version"] = serde_json::json!(4);
        fs::write(
            source.join(STATE_FILE),
            serde_json::to_vec(&current_state).unwrap(),
        )
        .unwrap();
        let unknown = build(test_build_args(source)).unwrap_err().to_string();
        assert!(unknown.contains("parse current build state"));
        assert_eq!(fs::read(thumbnail).unwrap(), thumbnail_bytes);
    }

    #[test]
    fn failed_build_keeps_immediate_thumbnails_but_preserves_manifests_and_state() {
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
        assert_ne!(fs::read(thumbnail).unwrap(), before_thumbnail);
        assert_eq!(
            fs::read(source.join(MANIFEST_FILE)).unwrap(),
            before_manifest
        );
        assert_eq!(
            fs::read(source.join("manifests/Comics/One.json")).unwrap(),
            before_detail
        );
        assert_eq!(fs::read(source.join(STATE_FILE)).unwrap(), before_state);
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
