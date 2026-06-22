#!/bin/bash

LOCAL="/Volumes/Xin T7/Megumi"
REMOTE="cf-r2:megumi"
LOG="$HOME/rclone-r2-sync-megumi.log"
MODE="${1:-fast}"
MAX_AGE="31d"

COMMON_FLAGS=(
  --progress
  --exclude ".megumi/tags.json"
  --exclude ".megumi/state.json"
  --exclude ".megumi/state.sqlite3*"
  --exclude ".DS_Store"
  --log-file="$LOG"
  --log-level INFO
  --transfers 8
)

sync_tags_to_local() {
  mkdir -p "$LOCAL/.megumi"
  echo ""
  echo "🏷️  同步 tags.json: R2 -> 本地"
  rclone copyto "$REMOTE/.megumi/tags.json" "$LOCAL/.megumi/tags.json" \
    --ignore-times \
    --log-file="$LOG" \
    --log-level INFO
}

case "$MODE" in
  fast|full)
    ;;
  *)
    echo "❌ 未知模式: $MODE"
    echo "   用法: $0 [fast|full]"
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
case "$MODE" in
  fast)
    echo "   模式: fast"
    echo "   说明: 上传最近 $MAX_AGE 新增/修改的资源；不删除 R2 多余对象；tags.json 从 R2 同步到本地"
    echo ""
    rclone copy "$LOCAL" "$REMOTE" \
      "${COMMON_FLAGS[@]}" \
      --checkers 16 \
      --no-traverse \
      --max-age "$MAX_AGE"
    resource_status=$?
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
esac

if [ $resource_status -eq 0 ]; then
  sync_tags_to_local
  tags_status=$?
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
