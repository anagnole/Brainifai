#!/usr/bin/env bash
LABEL="com.brainifai"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UID_NUM=$(id -u)

install() {
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>             <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$PROJECT_DIR/scripts/start.sh</string>
  </array>
  <key>RunAtLoad</key>         <true/>
  <key>StartInterval</key>    <integer>1800</integer>
  <key>StandardOutPath</key>   <string>$PROJECT_DIR/logs/brainifai.log</string>
  <key>StandardErrorPath</key> <string>$PROJECT_DIR/logs/brainifai.log</string>
  <key>WorkingDirectory</key>  <string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
</dict>
</plist>
EOF
  launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null || \
    launchctl load -w "$PLIST"
  echo "Brainifai LaunchAgent installed. Starting now..."
  launchctl start "$LABEL" 2>/dev/null || true
}

uninstall() {
  launchctl bootout "gui/$UID_NUM" "$PLIST" 2>/dev/null || \
    launchctl unload -w "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Brainifai LaunchAgent removed."
}

status() {
  launchctl list | grep "$LABEL" && echo "Running" || echo "Not loaded"
}

case "${1:-install}" in
  install)   install ;;
  uninstall) uninstall ;;
  status)    status ;;
  *) echo "Usage: $0 [install|uninstall|status]" ;;
esac
