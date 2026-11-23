#!/usr/bin/env bash
# Offline signing. The release key is owned by the publisher, outside the repository.
set -euo pipefail
if [[ $# -ne 2 ]]; then
  echo "Usage: $0 input-unsigned.apk output.apk" >&2
  exit 2
fi
: "${ANDROID_HOME:?Set the Android SDK path}"
: "${LOFOLD_ANDROID_KEYSTORE:?Set the local release keystore path}"
: "${LOFOLD_ANDROID_SIGN_PASS:?Read the signing password from the local credential store}"
build_tools="$ANDROID_HOME/build-tools/${ANDROID_BUILD_TOOLS_VERSION:-36.0.0}"
input=$1
output=$2
if [[ -e "$output" ]]; then
  echo "The output APK already exists." >&2
  exit 1
fi
work=$(mktemp -d "$(dirname "$output")/lofold-sign.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
"$build_tools/zipalign" -P 16 -f 4 "$input" "$work/aligned.apk"
"$build_tools/apksigner" sign --ks "$LOFOLD_ANDROID_KEYSTORE" --ks-key-alias "${LOFOLD_ANDROID_SIGN_ALIAS:-release}" \
  --ks-pass env:LOFOLD_ANDROID_SIGN_PASS --v4-signing-enabled false --out "$work/release.apk" "$work/aligned.apk"
"$build_tools/zipalign" -P 16 -c 4 "$work/release.apk"
"$build_tools/apksigner" verify --verbose --print-certs "$work/release.apk"
mv "$work/release.apk" "$output"
