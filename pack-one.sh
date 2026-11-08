set -e
# 打包脚本：node pack-one.sh <stage目录> <pack目录> <名称> <版本号>
# 用法（在 lx-player 仓库根目录执行，两个分支各跑一次）
WS="/d/文档/deepseek-harness/default-workspace"
LP="$WS/lx-player"
NODE="C:/Users/LENOVO/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"

STAGE="$1"
PACK="$2"
NAME="$3"
VER="$4"

unset ELECTRON_RUN_AS_NODE NODE_OPTIONS

# 1) 刷新源码（分支当前工作区）
rm -rf "$STAGE/src"
mkdir -p "$STAGE/src"
cp -r "$LP/src/." "$STAGE/src/"
test ! -d "$STAGE/src/src" || { echo "!! 出现 src/src 嵌套"; exit 1; }

# 2) 版本号写进暂存包
node -e "
const fs=require('fs');
const p=process.argv[1]+'/package.json';
const j=JSON.parse(fs.readFileSync(p,'utf8'));
j.version=process.argv[2];
fs.writeFileSync(p, JSON.stringify(j,null,2));
console.log('stage 版本 →', j.version);
" "$STAGE" "$VER"

# 3) 打包
rm -rf "$PACK"
mkdir -p "$PACK"
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
"$NODE" "$WS/node_modules/@electron/packager/bin/electron-packager.mjs" \
  "$STAGE" "$NAME" --platform=win32 --arch=x64 --out="$PACK" \
  --overwrite --prune=true --icon="$LP/src/assets/icon.ico" \
  --app-version="$VER" --electron-version=38.8.6

# 4) 独占引擎
OUT="$PACK/${NAME}-win32-x64"
mkdir -p "$OUT/engine"
cp "D:/lx-dev/mpv/mpv.exe" "$OUT/engine/mpv.exe"

echo "== done: $OUT =="
ls -la "$OUT/resources/app.asar" "$OUT/engine/mpv.exe"
