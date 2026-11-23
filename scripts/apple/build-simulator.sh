#!/usr/bin/env bash
# Builds the shipping UI for Apple Silicon iOS Simulator, without a developer account.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root/apps/desktop"
export PATH="$HOME/.cargo/bin:$PATH"
rustup target add aarch64-apple-ios-sim
project=src-tauri/gen/apple
if [[ ! -d "$project" ]]; then
  pnpm exec tauri ios init --ci --skip-targets-install
fi
icons="$project/Assets.xcassets/AppIcon.appiconset"
mkdir -p "$icons"
sips -s format png -z 1024 1024 src-tauri/icons/icon.png --out "$icons/LoFold.png" >/dev/null
cat > "$icons/Contents.json" <<'JSON'
{"images":[{"filename":"LoFold.png","idiom":"universal","platform":"ios","size":"1024x1024"}],"info":{"author":"xcode","version":1}}
JSON
cp "$root/scripts/apple/simulator-entitlements.plist" "$project/LoFoldSimulator.entitlements"
export XCODE_XCCONFIG_FILE="$root/scripts/apple/simulator.xcconfig"
pnpm exec tauri ios build --ci --no-sign --archive-only --target aarch64-sim -- --locked
app="$(find "$project" -path '*/Products/Applications/*.app' -type d -print -quit)"
[[ -n "$app" ]] || { echo 'Simulator archive is missing the application bundle.' >&2; exit 1; }
plist="$app/Info.plist"
[[ "$(plutil -extract CFBundleSupportedPlatforms.0 raw "$plist")" == iPhoneSimulator ]]
binary="$(plutil -extract CFBundleExecutable raw "$plist")"
# The simulator loads keychain entitlements from the executable, without a device profile.
otool -l "$app/$binary" | grep -F 'sectname __entitlements' >/dev/null
version="$(plutil -extract CFBundleShortVersionString raw "$plist")"
out="$root/output/platform-release"
mkdir -p "$out"
/usr/bin/ditto -c -k --keepParent "$app" "$out/LoFold-$version-iOS-Simulator-arm64.zip"
printf '%s\n' "$app"
