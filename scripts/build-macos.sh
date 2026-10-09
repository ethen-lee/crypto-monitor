#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

app="build/CryptoMonitor.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/Web"
iconset="build/AppIcon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" Resources/AppIcon.png --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" Resources/AppIcon.png --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
swiftc -O -parse-as-library -swift-version 5 -target "$(uname -m)-apple-macosx13.0" \
  -framework AppKit -framework WebKit -framework ServiceManagement \
  Sources/CryptoMonitor/*.swift -o "$app/Contents/MacOS/CryptoMonitor"
rsync -a --delete build/web/ "$app/Contents/Resources/Web/"
cp node_modules/lightweight-charts/LICENSE "$app/Contents/Resources/LightweightCharts-LICENSE.txt"
cp THIRD_PARTY_NOTICES.md "$app/Contents/Resources/THIRD_PARTY_NOTICES.md"
if [ -f node_modules/lightweight-charts/NOTICE ]; then
  cp node_modules/lightweight-charts/NOTICE "$app/Contents/Resources/LightweightCharts-NOTICE.txt"
fi
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>CryptoMonitor</string>
  <key>CFBundleIdentifier</key><string>com.ethan.cryptomonitor</string>
  <key>CFBundleName</key><string>Crypto Monitor</string>
  <key>CFBundleDisplayName</key><string>Crypto Monitor</string>
  <key>CFBundleIconFile</key><string>AppIcon.icns</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>TradingView Lightweight Charts is licensed under Apache 2.0.</string>
</dict></plist>
PLIST
codesign --force --deep --sign - "$app"
printf 'Built %s\n' "$PWD/$app"
