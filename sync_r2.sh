#!/bin/bash

LOCAL="/Volumes/Xin T7/Megumi"
REMOTE="cf-r2:megumi"
LOG="$HOME/rclone-r2-sync-megumi.log"
MODE="${1:-fast}"
MAX_AGE="31d"
STATE_DIR="$LOCAL/.megumi"
SYNC_STATE="$STATE_DIR/r2-sync.state.json"
CUTOFF_MARKER="$STATE_DIR/r2-sync.cutoff"

COMMON_FLAGS=(
  --progress
  --exclude ".megumi/tags.json"
  --exclude ".megumi/state.sqlite3*"
  --exclude ".megumi/build.lock"
  --exclude ".megumi/r2-sync.*"
  --exclude ".DS_Store"
  --log-file="$LOG"
  --log-level INFO
  --transfers 8
)

sync_tags_to_local() {
  mkdir -p "$STATE_DIR"
  echo ""
  echo "🏷️  同步 tags.json: R2 -> 本地"
  rclone copyto "$REMOTE/.megumi/tags.json" "$LOCAL/.megumi/tags.json" \
    --ignore-times \
    --log-file="$LOG" \
    --log-level INFO
}

read_last_success_epoch() {
  [ -f "$SYNC_STATE" ] || return 1

  local epoch
  epoch="$(sed -n 's/.*"last_success_epoch"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$SYNC_STATE" | head -n 1)"
  [[ "$epoch" =~ ^[0-9]+$ ]] || return 1

  printf '%s\n' "$epoch"
}

write_sync_state() {
  local mode="$1"
  local epoch="$2"
  local tmp_state
  local iso_time

  mkdir -p "$STATE_DIR"
  iso_time="$(TZ=UTC date -r "$epoch" '+%Y-%m-%dT%H:%M:%SZ')"
  tmp_state="$(mktemp "$STATE_DIR/r2-sync.state.json.tmp.XXXXXX")" || return 1

  {
    printf '{\n'
    printf '  "version": 1,\n'
    printf '  "mode": "%s",\n' "$mode"
    printf '  "last_success_epoch": %s,\n' "$epoch"
    printf '  "last_success_at": "%s"\n' "$iso_time"
    printf '}\n'
  } > "$tmp_state"

  mv "$tmp_state" "$SYNC_STATE"
  touch -t "$(date -r "$epoch" '+%Y%m%d%H%M.%S')" "$CUTOFF_MARKER"
}

prepare_cutoff_marker() {
  local epoch="$1"

  mkdir -p "$STATE_DIR"
  touch -t "$(date -r "$epoch" '+%Y%m%d%H%M.%S')" "$CUTOFF_MARKER"
}

write_changed_files() {
  local changed_list="$1"

  (
    set -o pipefail
    cd "$LOCAL" || exit 1
    find . -type f -cnewer "$CUTOFF_MARKER" \
      ! -path "./.megumi/tags.json" \
      ! -path "./.megumi/state.json" \
      ! -path "./.megumi/state.sqlite3*" \
      ! -path "./.megumi/build.lock" \
      ! -path "./.megumi/r2-sync.*" \
      ! -name ".DS_Store" \
      -print | sed 's#^\./##'
  ) > "$changed_list"
}

case "$MODE" in
  fast|full|mark)
    ;;
  *)
    echo "❌ 未知模式: $MODE"
    echo "   用法: $0 [fast|full|mark]"
    exit 1
    ;;
esac

# 检查本地路径是否存在（防止硬盘未挂载时误删 R2 文件）
if [ ! -d "$LOCAL" ]; then
  echo "❌ 本地路径不存在: $LOCAL"
  echo "   请确认硬盘 T7 已连接并挂载"
  exit 1
fi

echo "🔄 开始同步: $(date '+%Y-%m-%d %H:%M:%S')"
echo "   本地: $LOCAL"
echo "   远端: $REMOTE"
resource_status=0
tags_status=0
sync_start_epoch="$(date +%s)"
case "$MODE" in
  fast)
    changed_list="$(mktemp "${TMPDIR:-/tmp}/megumi-r2-changed.XXXXXX")" || exit 1
    trap 'rm -f "$changed_list"' EXIT
    echo "   模式: fast"
    echo "   说明: 上传上次成功后本地新增/修改的资源；不删除 R2 多余对象；tags.json 从 R2 同步到本地"
    echo ""
    last_success_epoch="$(read_last_success_epoch || true)"
    if [ -n "$last_success_epoch" ] && prepare_cutoff_marker "$last_success_epoch"; then
      if write_changed_files "$changed_list"; then
        changed_count="$(wc -l < "$changed_list" | tr -d ' ')"
        echo "   上次资源同步成功: $(date -r "$last_success_epoch" '+%Y-%m-%d %H:%M:%S')"
        echo "   本次待上传候选: $changed_count"
        if [ "$changed_count" -eq 0 ]; then
          resource_status=0
        else
          rclone copy "$LOCAL" "$REMOTE" \
            "${COMMON_FLAGS[@]}" \
            --checkers 16 \
            --no-traverse \
            --ignore-times \
            --files-from-raw "$changed_list"
          resource_status=$?
        fi
      else
        resource_status=1
      fi
    else
      echo "   未找到同步状态；回退为上传最近 $MAX_AGE 新增/修改的资源"
      rclone copy "$LOCAL" "$REMOTE" \
        "${COMMON_FLAGS[@]}" \
        --checkers 16 \
        --no-traverse \
        --max-age "$MAX_AGE"
      resource_status=$?
    fi
    ;;
  full)
    echo "   模式: full"
    echo "   说明: 全量镜像资源；会删除 R2 多余对象；tags.json 从 R2 同步到本地"
    echo ""
    rclone sync "$LOCAL" "$REMOTE" \
      "${COMMON_FLAGS[@]}" \
      --checkers 32 \
      --fast-list
    resource_status=$?
    ;;
  mark)
    echo "   模式: mark"
    echo "   说明: 仅记录当前资源已同步状态；不访问 R2"
    resource_status=0
    ;;
esac

if [ $resource_status -eq 0 ]; then
  if write_sync_state "$MODE" "$sync_start_epoch"; then
    if [ "$MODE" = "mark" ]; then
      tags_status=0
    else
      sync_tags_to_local
      tags_status=$?
    fi
  else
    echo "❌ 写入同步状态失败: $SYNC_STATE"
    resource_status=1
  fi
fi

if [ $resource_status -eq 0 ] && [ $tags_status -eq 0 ]; then
  echo ""
  echo "✅ 同步完成: $(date '+%Y-%m-%d %H:%M:%S')"
else
  echo ""
  if [ $resource_status -ne 0 ]; then
    echo "❌ 资源同步出错，请查看日志: $LOG"
  else
    echo "❌ tags.json 同步到本地失败；资源同步已完成。请查看日志: $LOG"
  fi
  exit 1
fi
