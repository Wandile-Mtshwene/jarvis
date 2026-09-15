#!/bin/bash
# Build "Jarvis.app" — a double-clickable macOS launcher that boots the local
# Jarvis server (if not already running) and opens The Eye as a standalone,
# chrome-less app window. Uses Chrome's engine so the Web Speech voice works.
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP="$ROOT/Jarvis.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Jarvis</string>
  <key>CFBundleDisplayName</key><string>Jarvis</string>
  <key>CFBundleIdentifier</key><string>com.wandile.jarvis</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Jarvis</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSMicrophoneUsageDescription</key><string>Jarvis listens for the wake word and your commands.</string>
</dict></plist>
PLIST

cat > "$APP/Contents/MacOS/Jarvis" <<PLIST
#!/bin/bash
DIR="$ROOT"
PORT=3000
URL="http://localhost:\$PORT"
# Boot the server if it isn't already answering.
if ! /usr/bin/curl -sf "\$URL" >/dev/null 2>&1; then
  /bin/zsh -lc "cd '\$DIR' && npm run start >/tmp/jarvis.log 2>&1 &"
  for i in \$(seq 1 60); do /usr/bin/curl -sf "\$URL" >/dev/null 2>&1 && break; sleep 0.5; done
fi
# Open The Eye as its own app window (isolated Chrome profile → own Dock entry).
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -x "\$CHROME" ]; then
  "\$CHROME" --user-data-dir="\$HOME/.jarvis-app" --app="\$URL" \\
    --no-first-run --no-default-browser-check --start-maximized >/dev/null 2>&1 &
else
  /usr/bin/open "\$URL"
fi
PLIST

chmod +x "$APP/Contents/MacOS/Jarvis"
codesign --force --deep --sign - "$APP" 2>/dev/null || true
echo "Built $APP"
echo "Drag it to /Applications, or double-click to launch."
