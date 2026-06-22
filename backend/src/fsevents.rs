use std::collections::BTreeSet;
use std::path::{Component, Path};
use std::time::Duration;

use anyhow::{Context, Result};
use fsevent_stream::ffi::{
    FSEventsGetCurrentEventId, kFSEventStreamCreateFlagFileEvents, kFSEventStreamCreateFlagNoDefer,
    kFSEventStreamCreateFlagWatchRoot,
};
use fsevent_stream::flags::StreamFlags;
use fsevent_stream::stream::create_event_stream;
use futures_util::StreamExt;

#[derive(Debug, Default)]
pub struct ChangeBatch {
    pub unit_keys: BTreeSet<String>,
    pub requires_full_scan: bool,
    pub cursor: u64,
}

pub fn current_cursor() -> u64 {
    // This CoreServices accessor has no preconditions and is thread-safe.
    unsafe { FSEventsGetCurrentEventId() }
}

pub fn changes_since(root: &Path, since: u64) -> Result<ChangeBatch> {
    let flags = kFSEventStreamCreateFlagNoDefer
        | kFSEventStreamCreateFlagFileEvents
        | kFSEventStreamCreateFlagWatchRoot;
    let (stream, mut handler) = create_event_stream([root], since, Duration::ZERO, flags)
        .with_context(|| format!("create FSEvents history stream for {}", root.display()))?;
    let mut stream = stream.into_flatten();
    let root = root.to_path_buf();
    let result = futures_executor::block_on(async move {
        let mut batch = ChangeBatch {
            cursor: since,
            ..ChangeBatch::default()
        };
        while let Some(event) = stream.next().await {
            batch.cursor = batch.cursor.max(event.id);
            if event.flags.contains(StreamFlags::HISTORY_DONE) {
                break;
            }
            if event.flags.intersects(
                StreamFlags::USER_DROPPED
                    | StreamFlags::KERNEL_DROPPED
                    | StreamFlags::IDS_WRAPPED
                    | StreamFlags::ROOT_CHANGED
                    | StreamFlags::MOUNT
                    | StreamFlags::UNMOUNT,
            ) {
                batch.requires_full_scan = true;
                continue;
            }
            if event.flags.contains(StreamFlags::MUST_SCAN_SUBDIRS) {
                record_recursive_rescan(&root, &event.path, &mut batch);
                continue;
            }
            if is_metadata_only(event.flags) {
                continue;
            }
            record_path_change(&root, &event.path, &mut batch);
        }
        batch
    });
    handler.abort();
    Ok(result)
}

fn record_recursive_rescan(root: &Path, path: &Path, batch: &mut ChangeBatch) {
    let Ok(relative) = path.strip_prefix(root) else {
        batch.requires_full_scan = true;
        return;
    };
    let parts = normal_parts(relative);
    if parts
        .first()
        .is_some_and(|name| is_managed_or_ignored(name))
    {
        return;
    }
    if parts.len() >= 2 {
        batch.unit_keys.insert(format!("{}/{}", parts[0], parts[1]));
    } else {
        batch.requires_full_scan = true;
    }
}

fn is_metadata_only(flags: StreamFlags) -> bool {
    if flags.contains(StreamFlags::ITEM_XATTR_MOD)
        && !flags.intersects(
            StreamFlags::ITEM_CREATED
                | StreamFlags::ITEM_REMOVED
                | StreamFlags::ITEM_RENAMED
                | StreamFlags::ITEM_CLONED,
        )
    {
        return true;
    }
    let content_flags = StreamFlags::ITEM_CREATED
        | StreamFlags::ITEM_REMOVED
        | StreamFlags::ITEM_RENAMED
        | StreamFlags::ITEM_MODIFIED
        | StreamFlags::ITEM_CLONED;
    !flags.intersects(content_flags)
        && flags.intersects(
            StreamFlags::INODE_META_MOD
                | StreamFlags::FINDER_INFO_MOD
                | StreamFlags::ITEM_CHANGE_OWNER
                | StreamFlags::ITEM_XATTR_MOD,
        )
}

fn record_path_change(root: &Path, path: &Path, batch: &mut ChangeBatch) {
    let Ok(relative) = path.strip_prefix(root) else {
        batch.requires_full_scan = true;
        return;
    };
    let parts = normal_parts(relative);
    let Some(first) = parts.first() else {
        return;
    };
    if is_managed_or_ignored(first) {
        return;
    }
    if parts.len() < 2 {
        return;
    }
    batch.unit_keys.insert(format!("{}/{}", parts[0], parts[1]));
}

fn normal_parts(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect()
}

fn is_managed_or_ignored(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "thumbnail" | "manifests" | "manifest.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_content_changes_to_their_unit() {
        let root = Path::new("/library");
        let mut batch = ChangeBatch::default();
        record_path_change(root, Path::new("/library/Comics/One/001.jpg"), &mut batch);
        assert_eq!(batch.unit_keys, BTreeSet::from(["Comics/One".to_string()]));
    }

    #[test]
    fn ignores_generated_outputs() {
        let root = Path::new("/library");
        let mut batch = ChangeBatch::default();
        record_path_change(
            root,
            Path::new("/library/thumbnail/Comics/One/001.webp"),
            &mut batch,
        );
        assert!(batch.unit_keys.is_empty());
    }

    #[test]
    fn recursive_rescan_is_scoped_to_a_content_unit() {
        let root = Path::new("/library");
        let mut batch = ChangeBatch::default();
        record_recursive_rescan(root, Path::new("/library/Comics/One"), &mut batch);
        assert_eq!(batch.unit_keys, BTreeSet::from(["Comics/One".to_string()]));
        assert!(!batch.requires_full_scan);
    }
}
