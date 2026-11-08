set -e
# 换装 + 出包：bash install-one.sh <pack源> <成品目录> <zip文件名> [说明文件来源]
# 例：bash install-one.sh "D:/文档/deepseek-harness/default-workspace/.tmp/packv4/猪专属播放器-win32-x64" "D:/猪专属播放器" "猪专属播放器_v2.8.6_便携版.zip" "D:/文档/deepseek-harness/default-workspace/lx-player/docs/使用说明.txt"
PACK="$1"
DST="$2"
ZIPNAME="$3"
MANUAL="$4"
WS="D:/文档/deepseek-harness/default-workspace"
ZIPDIR="D:/猪专属播放器安装包"

echo "== 1) 安装新包（robocopy 覆盖；data/ 与附属文件会保留） =="
# MSYS_NO_PATHCONV=1 必须有：否则 git-bash 会把 /E /NFL 这些开关当成路径转换掉（报「无效参数 #3」）
MSYS_NO_PATHCONV=1 robocopy "$PACK" "$DST" /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | tail -2 || true
[ -n "$MANUAL" ] && [ -f "$MANUAL" ] && cp "$MANUAL" "$DST/使用说明.txt" && echo "   使用说明.txt 已更新"

echo "== 2) 体检 =="
cd "$WS/lx-player" && node tools/check-dist.mjs "$DST"

echo "== 3) 打便携包 =="
cd "$DST"
rm -f "$ZIPDIR/$ZIPNAME"
"C:/Windows/System32/tar.exe" -a -cf "$ZIPDIR/$ZIPNAME" *
ls -la "$ZIPDIR/$ZIPNAME"
echo "== 完成 =="
