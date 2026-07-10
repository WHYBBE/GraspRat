#!/bin/bash
# 把 GraspRatQuery 可执行文件组装成 macOS .app bundle。
# 产物输出到仓库根的 build/ 目录（已在 .gitignore 忽略）。
#
# 用法：在 SwiftGraspRat/ 下执行  ./pack-app.sh
set -euo pipefail

APP_NAME="GraspRatQuery"
BUNDLE_ID="top.h-e.grasp-rat-query"
VERSION="0.6.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$REPO_ROOT/build"
APP_DIR="$OUT_DIR/$APP_NAME.app"

echo "[1/4] release 编译…"
swift build -c release
BIN_PATH="$(swift build -c release --show-bin-path)/$APP_NAME"

echo "[2/4] 清理旧 bundle…"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

echo "[3/4] 拷贝可执行文件 + 写 Info.plist…"
cp "$BIN_PATH" "$APP_DIR/Contents/MacOS/$APP_NAME"

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundleDisplayName</key>
    <string>Grasp Rat 查询</string>
    <key>CFBundleIdentifier</key>
    <string>$BUNDLE_ID</string>
    <key>CFBundleVersion</key>
    <string>$VERSION</string>
    <key>CFBundleShortVersionString</key>
    <string>$VERSION</string>
    <key>CFBundleExecutable</key>
    <string>$APP_NAME</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
</dict>
</plist>
PLIST

echo "[4/4] ad-hoc 签名（本机运行免 Gatekeeper 拦截）…"
codesign --force --deep --sign - "$APP_DIR" 2>/dev/null || echo "  codesign 跳过（非致命）"

echo "完成：$APP_DIR"
