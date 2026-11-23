#!/usr/bin/env bash
set -euo pipefail
project="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project"
: "${DEVECO_SDK_HOME:?Set DEVECO_SDK_HOME to the HarmonyOS SDK directory}"
export OHOS_NDK_HOME="${OHOS_NDK_HOME:-$DEVECO_SDK_HOME/default/openharmony/native}"
"$project/scripts/build-native.sh"
ohpm install
hvigorw --mode module -p product=default -p module=entry@default -p buildMode=release assembleHap --no-daemon
