#!/usr/bin/env bash
set -euo pipefail
: "${OHOS_NDK_HOME:?Set OHOS_NDK_HOME to the SDK native directory containing llvm and sysroot}"
project="$(cd "$(dirname "$0")/.." && pwd)"
ndk="$(cd "$OHOS_NDK_HOME" && pwd)"
test -x "$ndk/llvm/bin/clang"
test -d "$ndk/sysroot"

build_dir="${CARGO_TARGET_DIR:-$project/native/target}"
mkdir -p "$build_dir"
export CARGO_TARGET_DIR="$(cd "$build_dir" && pwd)"
target=aarch64-unknown-linux-ohos
wrappers="$(mktemp -d)"
trap 'rm -rf "$wrappers"' EXIT
export LOFOLD_OH_NDK="$ndk"
cat >"$wrappers/cc" <<'WRAPPER'
#!/usr/bin/env bash
exec "$LOFOLD_OH_NDK/llvm/bin/clang" --target=aarch64-linux-ohos --sysroot="$LOFOLD_OH_NDK/sysroot" "$@"
WRAPPER
chmod +x "$wrappers/cc"
export CC_aarch64_unknown_linux_ohos="$wrappers/cc"
export AR_aarch64_unknown_linux_ohos="$ndk/llvm/bin/llvm-ar"
export RANLIB_aarch64_unknown_linux_ohos="$ndk/llvm/bin/llvm-ranlib"
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_LINKER="$wrappers/cc"
(cd "$project/native" && cargo build --locked --release --target "$target")

destination="$project/entry/libs/arm64-v8a"
mkdir -p "$destination"
"$ndk/llvm/bin/clang++" --target=aarch64-linux-ohos --sysroot="$ndk/sysroot" \
  -std=c++17 -fPIC -O2 -fvisibility=hidden -shared -static-libstdc++ \
  "$project/native/addon.cpp" "$CARGO_TARGET_DIR/$target/release/liblofold_harmony_archive.a" \
  -lace_napi.z -ldl -lm -Wl,-z,defs,-z,now,-z,relro,-soname,liblofold.so \
  -o "$destination/liblofold.so.tmp"
"$ndk/llvm/bin/llvm-strip" --strip-unneeded "$destination/liblofold.so.tmp"
mv "$destination/liblofold.so.tmp" "$destination/liblofold.so"
