#!/bin/bash

LOCAL="/Users/xin/Downloads/megumi"
REMOTE="cf-r2:megumi"
LOG="$HOME/rclone-r2-sync.log"

# 检查本地路径是否存在（防止硬盘未挂载时误删 R2 文件）
if [ ! -d "$LOCAL" ]; then
  echo "❌ 本地路径不存在: $LOCAL"
  echo "   请确认硬盘 T7 已连接并挂载"
  exit 1
fi

echo "🔄 开始同步: $(date '+%Y-%m-%d %H:%M:%S')"
echo "   本地: $LOCAL"
echo "   远端: $REMOTE"
echo ""

rclone sync "$LOCAL" "$REMOTE" \
  --progress \
  --exclude ".megumi/**" \
  --exclude ".DS_Store" \
  --log-file="$LOG" \
  --log-level INFO

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ 同步完成: $(date '+%Y-%m-%d %H:%M:%S')"
else
  echo ""
  echo "❌ 同步出错，请查看日志: $LOG"
fi