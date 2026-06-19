use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use clap::{Parser, Subcommand};
use image::imageops::FilterType;
use serde::{Deserialize, Serialize};
const MANIFEST_FILE: &str = "manifest.json";
const STATE_FILE: &str = ".megumi/state.json";
const THUMBNAIL_DIR: &str = "thumbnail";
const SCHEMA_VERSION: u32 = 1;
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

    /// Directory for manifest, thumbnails and local build state. Defaults to the source root.
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
    comics: Vec<ComicManifest>,
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
struct ComicManifest {
    id: String,
    title: String,
    path: String,
    cover_key: Option<String>,
    cover_thumbnail_key: Option<String>,
    page_count: usize,
    pages: Vec<PageManifest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PageManifest {
    id: String,
    index: usize,
    filename: String,
    key: String,
    url: String,
    thumbnail_key: String,
    thumbnail_url: String,
    width: u32,
    height: u32,
    size: u64,
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
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildState {
    files: BTreeMap<String, FileState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileState {
    size: u64,
    mtime_ms: u64,
    key: String,
    thumbnail_key: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
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
    referenced_keys: BTreeSet<String>,
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
    let previous_state = read_state(&output)?;

    let mut ctx = BuildContext {
        source: source.clone(),
        output,
        public_base_url: args.public_base_url.map(trim_url_suffix),
        thumbnail_width: args.thumbnail_width,
        thumbnail_quality: args.thumbnail_quality,
        previous_state,
        next_state: BuildState::default(),
        referenced_keys: BTreeSet::new(),
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

    write_json_atomic(&ctx.output.join(MANIFEST_FILE), &manifest)?;
    write_json_atomic(&ctx.output.join(STATE_FILE), &ctx.next_state)?;
    prune_unreferenced_files(&ctx)?;

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

fn scan_comic_library(ctx: &mut BuildContext, library_dir: &Path) -> Result<Vec<ComicManifest>> {
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
) -> Result<ComicManifest> {
    image_paths.sort_by(|a, b| natord::compare(&display_name(a), &display_name(b)));
    let rel = relative_key(&ctx.source, comic_dir)?;
    let id = stable_id(&format!("comic:{rel}"));
    let title = display_name(comic_dir);

    let mut pages = Vec::with_capacity(image_paths.len());
    for (index, image_path) in image_paths.into_iter().enumerate() {
        pages.push(process_image(ctx, &image_path, index)?);
    }

    let cover_key = pages.first().map(|page| page.key.clone());
    let cover_thumbnail_key = pages.first().map(|page| page.thumbnail_key.clone());
    Ok(ComicManifest {
        id,
        title,
        path: rel,
        cover_key,
        cover_thumbnail_key,
        page_count: pages.len(),
        pages,
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

fn process_image(ctx: &mut BuildContext, source_path: &Path, index: usize) -> Result<PageManifest> {
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
            && state.key == key
            && state.thumbnail_key.as_deref() == Some(thumbnail_key.as_str())
            && output_thumb.is_file()
            && state.width.is_some()
            && state.height.is_some()
    });

    let (width, height) = if unchanged {
        let state = previous.expect("checked above");
        (state.width.unwrap_or(0), state.height.unwrap_or(0))
    } else {
        create_thumbnail(
            source_path,
            &output_thumb,
            ctx.thumbnail_width,
            ctx.thumbnail_quality,
        )?
    };

    ctx.referenced_keys.insert(thumbnail_key.clone());
    ctx.next_state.files.insert(
        rel.clone(),
        FileState {
            size,
            mtime_ms,
            key: key.clone(),
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
        id: stable_id(&format!("image:{rel}")),
        index,
        filename,
        key: key.clone(),
        url: url_for(ctx, &key),
        thumbnail_key: thumbnail_key.clone(),
        thumbnail_url: url_for(ctx, &thumbnail_key),
        width,
        height,
        size,
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
            key: key.clone(),
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
    Ok(BookManifest {
        id: stable_id(&format!("book:{rel}")),
        title,
        filename,
        key: key.clone(),
        url: url_for(ctx, &key),
        size,
        mtime_ms,
    })
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

fn read_state(output: &Path) -> Result<BuildState> {
    let path = output.join(STATE_FILE);
    if !path.exists() {
        return Ok(BuildState::default());
    }
    let raw =
        fs::read_to_string(&path).with_context(|| format!("read state: {}", path.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("parse state: {}", path.display()))
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create directory: {}", parent.display()))?;
    }
    let data = serde_json::to_vec_pretty(value)?;
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&tmp, data).with_context(|| format!("write temporary file: {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("write file: {}", path.display()))?;
    Ok(())
}

fn prune_unreferenced_files(ctx: &BuildContext) -> Result<()> {
    let dir = ctx.output.join(THUMBNAIL_DIR);
    if !dir.exists() {
        return Ok(());
    }
    prune_thumbnail_dir(ctx, &dir)
}

fn prune_thumbnail_dir(ctx: &BuildContext, dir: &Path) -> Result<()> {
    for entry in fs::read_dir(dir).with_context(|| format!("read directory: {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            prune_thumbnail_dir(ctx, &path)?;
            remove_empty_dir(&path)?;
        } else {
            let key = relative_key(&ctx.output, &path)?;
            if !ctx.referenced_keys.contains(&key) {
                fs::remove_file(&path)
                    .with_context(|| format!("remove stale thumbnail: {}", path.display()))?;
            }
        }
    }
    Ok(())
}

fn remove_empty_dir(path: &Path) -> Result<()> {
    if path
        .read_dir()
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
    {
        fs::remove_dir(path)
            .with_context(|| format!("remove empty thumbnail directory: {}", path.display()))?;
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
    name.starts_with('.') || name == THUMBNAIL_DIR || name == MANIFEST_FILE
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
    Ok(datetime
        .format(&time::format_description::well_known::Rfc3339)
        .context("format timestamp")?)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
