#!/usr/bin/env bash
# 组 stage + 装生产依赖 + 打 app.asar（现行唯一打包口径）
#
# 取代已删除的 pack-one.sh：那条路走 electron-packager 生成整套便携目录，
# 与现在的「只换 resources/app.asar」口径不一致（换装脚本 / mkzip / check-dist 全按 asar 写）。
#
# 用法（仓库根）：
#   bash tools/stage-asar.sh --ref online --version 3.3.72 \
#        --work D:/wb/<ts>/.tmp --out D:/wb/<ts>/.tmp/app-online-372.asar
#
# 参数：
#   --ref       git 引用（online / master / 某个 sha）。用 git archive 取**已提交**内容，
#               不拿工作树，避免把未提交改动打进包。
#   --version   写进 stage/package.json 的版本号（2.8.x / 3.3.x，两条线各自升）
#   --out       app.asar 输出路径
#   --work      中间目录（stage / asartool 落这里），默认 <repo>/.tmp/pack
#   --no-install 跳过 npm install（复用同版本 stage，调试用）
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
REF=""
VER=""
OUT=""
WORK="$REPO/.tmp/pack"
DO_INSTALL=1

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:-}"; shift 2 ;;
    --version) VER="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --work) WORK="${2:-}"; shift 2 ;;
    --no-install) DO_INSTALL=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "!! 未知参数: $1"; exit 1 ;;
  esac
done
[ -n "$REF" ] && [ -n "$VER" ] && [ -n "$OUT" ] || {
  echo "用法: bash tools/stage-asar.sh --ref <online|master|sha> --version <x.y.z> --out <app.asar> [--work <dir>] [--no-install]"
  exit 1
}
case "$OUT" in
  /*|[A-Za-z]:/*) ;;
  *) echo "!! --out 必须是绝对路径: $OUT"; exit 1 ;;
esac

# 否则 exe 会按 node 跑（历史坑：bad option），npm 子进程也一并继承这份干净环境
unset ELECTRON_RUN_AS_NODE NODE_OPTIONS

SHA="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"
SHORT="$(git -C "$REPO" rev-parse --short "$SHA")"
echo "== 来源: $REF → $SHORT =="

STAGE="$WORK/stage-$(echo "$REF" | tr '/\\:' '___')"
if [ "$DO_INSTALL" = "0" ] && [ -f "$STAGE/src/main/main.js" ]; then
  # --no-install 的语义就是「复用现成 stage 只为重打 asar」，别把它删了再报缺依赖
  echo "== 复用已有 stage（--no-install）: $STAGE =="
else
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  # 只取已提交内容；MSYS_NO_PATHCONV 防 git-bash 把 -C 的路径参数改写
  git -C "$REPO" archive --format=tar "$SHA" | MSYS_NO_PATHCONV=1 tar -xf - -C "$STAGE"
fi
test -f "$STAGE/package.json" || { echo "!! stage 里没有 package.json"; exit 1; }
test -f "$STAGE/src/main/main.js" || { echo "!! stage 里没有 src/main/main.js"; exit 1; }
rm -rf "$STAGE/data"   # 万一把用户目录带进来就是隐私事故
# 白名单之外的根条目一律删：运行期只读 package.json + src/（renderer/assets）+ node_modules。
# 以前是逐个点名删 test/tools/docs，结果 .gitignore、pnpm-lock.yaml、截图、交接文档.md
# 都跟着进了包（白涨体积，还把仓库文档分发出去了）。
for entry in "$STAGE"/* "$STAGE"/.[!.]* "$STAGE"/..?*; do
  [ -e "$entry" ] || continue
  case "$(basename "$entry")" in
    package.json|src|node_modules) ;;
    *) rm -rf "$entry" ;;
  esac
done

echo "== 版本号 → $VER =="
node -e '
const fs = require("fs");
const p = process.argv[1] + "/package.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.version = process.argv[2];
fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
console.log("   stage version =", j.version);
' "$STAGE" "$VER"

if [ "$DO_INSTALL" = "1" ]; then
  echo "== npm install --omit=dev =="
  ( cd "$STAGE" && npm install --omit=dev --no-audit --no-fund --loglevel=error )
  # 只允许生产依赖进包：electron 之类 dev 依赖混进来会让 asar 涨十几 MB
  if [ -d "$STAGE/node_modules/electron" ]; then echo "!! stage 里混进了 devDependencies(electron)"; exit 1; fi
fi
test -d "$STAGE/node_modules/music-metadata" || { echo "!! 缺生产依赖 music-metadata"; exit 1; }

# asar CLI 走独立前缀，不污染仓库依赖（第一次会联网装，之后复用）
ASAR="$WORK/asartool/node_modules/@electron/asar/bin/asar.mjs"
if [ ! -f "$ASAR" ]; then
  echo "== 安装 @electron/asar（仅首次） =="
  mkdir -p "$WORK/asartool"
  ( cd "$WORK/asartool" && npm install --no-save --no-audit --no-fund --loglevel=error @electron/asar@4 )
fi
test -f "$ASAR" || { echo "!! asar CLI 不可用: $ASAR"; exit 1; }

echo "== asar pack =="
mkdir -p "$(dirname "$OUT")"
# 不先删旧包：asar pack 本身会覆盖。某些环境（沙箱/安全软件）对「删除文件」有额外拦截，
# 保留旧包让 pack 直接覆盖，少一步可失败的写操作。
node "$ASAR" pack "$STAGE" "$OUT"

# 自检：入口与依赖真在包里，别等换装完才发现打了个空壳
node -e '
const { spawnSync } = require("child_process");
const [cli, asar, need] = process.argv.slice(1);
const r = spawnSync(process.execPath, [cli, "list", asar], { encoding: "utf8", maxBuffer: 64 << 20 });
if (r.status !== 0) { console.error(r.stderr || "asar list 失败"); process.exit(1); }
// Windows 下 list 用反斜杠输出，先归一化再比对
const list = r.stdout.replace(/\\/g, "/");
const miss = need.split(",").filter((f) => !list.includes(f.replace(/^\/+/, "")));
if (miss.length) { console.error("!! asar 内缺文件: " + miss.join(", ")); process.exit(1); }
console.log("   asar 内条目自检通过");
' "$ASAR" "$OUT" "package.json,src/main/main.js,node_modules/music-metadata"

SIZE="$(stat -c %s "$OUT" 2>/dev/null || wc -c < "$OUT")"
echo "== done: $OUT ($SIZE bytes, from $REF@$SHORT) =="
