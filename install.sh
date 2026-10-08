#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_DIR="$CONFIG_DIR/plugins"
PKG="$CONFIG_DIR/package.json"

mkdir -p "$PLUGIN_DIR"
cp "$REPO_DIR/go-usage.ts" "$PLUGIN_DIR/go-usage.ts"

if [ ! -f "$PKG" ]; then
  cp "$REPO_DIR/package.json" "$PKG"
  echo "已创建 $PKG"
elif ! grep -q '@opencode-ai/plugin' "$PKG"; then
  echo "警告：请在 $PKG 的 dependencies 中加入 \"@opencode-ai/plugin\"。" >&2
fi

echo "go-usage 插件已安装到 $PLUGIN_DIR/go-usage.ts，重启 OpenCode 后生效。"
