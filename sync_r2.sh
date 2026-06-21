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
  --exclude ".DS_Store"
  --log-file="$LOG"
  --log-level INFO
  --transfers 8
)

# 检查本地路径是否存在（防止硬盘未挂载时误删 R2 文件）
if [ ! -d "$LOCAL" ]; then
  echo "❌ 本地路径不存在: $LOCAL"
  echo "   请确认硬盘 T7 已连接并挂载"
  exit 1
fi

echo "🔄 开始同步: $(date '+%Y-%m-%d %H:%M:%S')"
echo "   本地: $LOCAL"
echo "   远端: $REMOTE"
case "$MODE" in
  fast)
    echo "   模式: fast"
    echo "   说明: 上传最近 $MAX_AGE 新增/修改的资源；不删除 R2 多余对象；不上传 .megumi/tags.json"
    echo ""
    rclone copy "$LOCAL" "$REMOTE" \
      "${COMMON_FLAGS[@]}" \
      --checkers 16 \
      --no-traverse \
      --max-age "$MAX_AGE"
    ;;
  full)
    echo "   模式: full"
    echo "   说明: 全量镜像资源；会删除 R2 多余对象；不上传 .megumi/tags.json"
    echo ""
    rclone sync "$LOCAL" "$REMOTE" \
      "${COMMON_FLAGS[@]}" \
      --checkers 32 \
      --fast-list
    ;;
  *)
    echo "❌ 未知模式: $MODE"
    echo "   用法: $0 [fast|full]"
    exit 1
    ;;
esac

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ 同步完成: $(date '+%Y-%m-%d %H:%M:%S')"
else
  echo ""
  echo "❌ 同步出错，请查看日志: $LOG"
fi
