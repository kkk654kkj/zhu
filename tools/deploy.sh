#!/usr/bin/env bash
# 换装 + 体检 + 出便携 zip（取代 install-one.sh 里那套 tar + zipfile 重写）
#
# 只做三件事：备份旧 asar → 复制新 asar → check-dist → mkzip。
# 不碰 data/、不碰用户设置、不往成品目录写使用说明。
#
# 用法（仓库根）：
#   bash tools/deploy.sh --asar D:/wb/<ts>/.tmp/app-online-372.asar \
#        --dst "D:/猪专属播放器项目/猪专属播放器联网版" --version 3.3.72 \
#        --zip ZhuPlayer_v3.3.72_Online.zip
#
# 参数：
#   --asar    新打的 app.asar（tools/stage-asar.sh 产物）
#   --dst     成品目录
#   --version 期望版本号（check-dist 会从 asar 里读实际值，两者必须一致）
#   --zip     便携包文件名；不传则不出包
#   --zipdir  安装包目录，默认 D:/猪专属播放器安装包
#   --backup  旧 asar 备份目录，默认与新 asar 同级的 backup-asar/
#   --no-backup 跳过备份（仅限目标目录里本来就没有 app.asar）
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ASAR=""
DST=""
VER=""
ZIPNAME=""
ZIPDIR="D:/猪专属播放器安装包"
BACKUP=""
DO_BACKUP=1

while [ $# -gt 0 ]; do
  case "$1" in
    --asar) ASAR="${2:-}"; shift 2 ;;
    --dst) DST="${2:-}"; shift 2 ;;
    --version) VER="${2:-}"; shift 2 ;;
    --zip) ZIPNAME="${2:-}"; shift 2 ;;
    --zipdir) ZIPDIR="${2:-}"; shift 2 ;;
    --backup) BACKUP="${2:-}"; shift 2 ;;
    --no-backup) DO_BACKUP=0; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "!! 未知参数: $1"; exit 1 ;;
  esac
done
[ -n "$ASAR" ] && [ -n "$DST" ] && [ -n "$VER" ] || {
  echo "用法: bash tools/deploy.sh --asar <app.asar> --dst <成品目录> --version <x.y.z> [--zip <name.zip>]"
  exit 1
}
[ -f "$ASAR" ] || { echo "!! asar 不存在: $ASAR"; exit 1; }
[ -d "$DST" ] || { echo "!! 成品目录不存在: $DST"; exit 1; }

unset ELECTRON_RUN_AS_NODE NODE_OPTIONS

echo "== 1) 备份旧 asar =="
OLD="$DST/resources/app.asar"
if [ "$DO_BACKUP" = "1" ]; then
  if [ -f "$OLD" ]; then
    [ -n "$BACKUP" ] || BACKUP="$(dirname "$ASAR")/backup-asar"
    mkdir -p "$BACKUP"
    TAG="$(basename "$ASAR" .asar)"
    cp -f "$OLD" "$BACKUP/$TAG.prev.asar"
    echo "   $(stat -c %s "$BACKUP/$TAG.prev.asar") bytes → $BACKUP/$TAG.prev.asar"
  else
    echo "   目标里没有 app.asar（首次换装），跳过备份"
  fi
fi

echo "== 2) 复制新 asar =="
mkdir -p "$DST/resources"
cp -f "$ASAR" "$OLD"
echo "   $(stat -c %s "$OLD") bytes → $OLD"

echo "== 3) check-dist（版本必须与 --version 一致） =="
node "$REPO/tools/check-dist.mjs" "$DST" "$VER"

if [ -n "$ZIPNAME" ]; then
  echo "== 4) 出便携包 =="
  mkdir -p "$ZIPDIR"
  python "$REPO/tools/mkzip.py" "$DST" "$ZIPDIR/$ZIPNAME"
fi
echo "== 完成 =="
