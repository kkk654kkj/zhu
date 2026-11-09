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

# 参数校验必须在任何 rm -rf 之前：漏传时 "$STAGE/src" 会展开成 "/src"
# （MSYS 下指向 Git 安装目录），相对路径也会误删当前目录下的东西。
if [ -z "$1" ] || [ -z "$2" ] || [ -z "$3" ] || [ -z "$4" ]; then
  echo "用法: bash pack-one.sh <stage目录> <pack目录> <名称> <版本号>"
  echo "  四个参数都必填；<stage目录>/<pack目录> 必须是绝对路径（脚本会自行创建/重建）。"
  exit 1
fi
for p in "$STAGE" "$PACK"; do
  case "$p" in
    /*|[A-Za-z]:/*|[A-Za-z]:\\*) ;;
    *) echo "!! 目标必须是绝对路径（拒绝相对路径以免误删）：$p"; exit 1 ;;
  esac
  case "$p" in
    /|//|[A-Za-z]:/|[A-Za-z]:) echo "!! 拒绝盘符/根目录作为目标：$p"; exit 1 ;;
  esac
  if [ -e "$p" ] && [ ! -d "$p" ]; then echo "!! 目标是文件不是目录：$p"; exit 1; fi
done

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
# 附属文件随包自带（以前成品目录里的 vbs/icon.ico 是历史遗留副本，新机器解包才有）
cp "$LP/packaging/启动播放器.vbs" "$OUT/启动播放器.vbs"
cp "$LP/src/assets/icon.ico" "$OUT/icon.ico"

echo "== done: $OUT =="
ls -la "$OUT/resources/app.asar" "$OUT/engine/mpv.exe" "$OUT/icon.ico" "$OUT/启动播放器.vbs"
