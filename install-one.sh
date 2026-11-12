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
# robocopy 退出码 0-7 都算成功（1=复制了文件很常见），≥8 才是真失败。
# 用 pipefail + PIPESTATUS[0] 抓真实码；临时 set +e，避免 1-7 被 set -e 当成失败直接退出。
set +e
set -o pipefail
MSYS_NO_PATHCONV=1 robocopy "$PACK" "$DST" /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | tail -2
rc=${PIPESTATUS[0]}
set -e
set +o pipefail
if [ "$rc" -ge 8 ]; then echo "robocopy 失败 rc=$rc（≥8 表示有文件未复制）"; exit 1; fi
[ -n "$MANUAL" ] && [ -f "$MANUAL" ] && cp "$MANUAL" "$DST/使用说明.txt" && echo "   使用说明.txt 已更新"

echo "== 2) 体检 =="
cd "$WS/lx-player" && node tools/check-dist.mjs "$DST" "${5:-}"

echo "== 3) 打便携包 =="
mkdir -p "$ZIPDIR"
cd "$DST"
rm -f "$ZIPDIR/$ZIPNAME"
# v3.3.10 重要：分发 zip 绝不能带 data/ —— 里面有用户的曲库列表、播放历史、
# 设置和日志（隐私）。之前没排除，导致公开发布的包泄露了个人数据。
# 大小写变体 + 嵌套通配，覆盖 Data/、DATA/ 以及子目录里的 data/。
"C:/Windows/System32/tar.exe" -a -cf "$ZIPDIR/$ZIPNAME" \
  --exclude='[Dd][Aa][Tt][Aa]' \
  --exclude='*/[Dd][Aa][Tt][Aa]' \
  --exclude='*/[Dd][Aa][Tt][Aa]/*' *

# v3.3.13：Windows tar.exe 写 zip 时，中文条目名是系统 ANSI(GBK) 原始字节且未置
# UTF-8 标志（实测 flag=0x0008），非中文系统 / Python 解压会按 cp437 解成乱码。
# 打包后立刻用内联 python zipfile 逐条目把名字还原成 Unicode 再写回（自动置 UTF-8
# flag），原子替换原 zip；不新增仓库文件，临时文件落 $ZIPDIR 且随即被 os.replace 吃掉。
if ! python - "$ZIPDIR/$ZIPNAME" <<'PYEOF'
import sys, os, zipfile

src = sys.argv[1]
tmp = src + '.u8tmp'

def fix_name(info):
    name = info.filename
    if info.flag_bits & 0x800:
        return name                      # 已置 UTF-8 标志，名字本身正确
    try:
        # zipfile 对无 UTF-8 标志的条目按 cp437 解码；先还原原始字节，
        # 再按 tar.exe 实际写入的 GBK 解回中文名（纯 ASCII 名往返不变）
        return name.encode('cp437').decode('gbk')
    except (UnicodeEncodeError, UnicodeDecodeError):
        return name                     # 个别非 GBK 名字保留原样，不阻断打包

try:
    with zipfile.ZipFile(src, 'r') as zin, \
         zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        kept = 0
        dropped = 0
        for info in zin.infolist():
            name = fix_name(info)
            # 防御：任何路径段叫 data 的条目都排除（tar 已 exclude，这里再兜底）
            if 'data' in name.replace('\\', '/').lower().split('/'):
                dropped += 1
                continue
            data = zin.read(info)
            if info.is_dir() and not name.endswith('/'):
                name += '/'
            # 传 str 名字：zipfile 对非 ASCII 名自动置 UTF-8 flag (0x800)
            zout.writestr(name, data, compress_type=info.compress_type)
            kept += 1
    os.replace(tmp, src)
    print('   条目名编码修复：保留 %d 个条目，排除 data 条目 %d 个' % (kept, dropped))
except Exception as e:
    if os.path.exists(tmp):
        try: os.remove(tmp)
        except Exception: pass
    print('   条目名编码修复失败：%s' % e, file=sys.stderr)
    sys.exit(1)
PYEOF
then
  echo "!! zip 条目名编码修复失败"; exit 1
fi
ls -la "$ZIPDIR/$ZIPNAME"
# 自检：列出 zip 内全部条目，确认没有任何 data/ 目录混进来（隐私兜底），有则直接失败
ENTRIES=$("C:/Windows/System32/tar.exe" -tf "$ZIPDIR/$ZIPNAME") || { echo "!! 无法读取分发 zip，自检失败"; exit 1; }
if echo "$ENTRIES" | grep -iE '(^|/)data(/|$)' >/dev/null; then
  echo "!! 分发 zip 内混入了 data/ 条目，已终止（禁止分发含用户数据的包）"; exit 1
fi

# 自检 2（v3.3.13）：用 python 确认每个条目名都能被 UTF-8 正确解码、且无 data/ 条目。
# 关键：非 ASCII 名若没置 UTF-8 标志，其 zip 内原始字节是 GBK，按 UTF-8 解码会失败 → 判失败。
if ! python - "$ZIPDIR/$ZIPNAME" <<'PYEOF'
import sys, zipfile

p = sys.argv[1]
bad = []
with zipfile.ZipFile(p, 'r') as z:
    infos = z.infolist()
    for i in infos:
        n = i.filename
        # 还原该条目在 zip 内实际存的文件名字节：有 UTF-8 标志→utf-8，否则→cp437
        raw = n.encode('utf-8') if (i.flag_bits & 0x800) else n.encode('cp437')
        try:
            dec = raw.decode('utf-8')
        except UnicodeDecodeError:
            bad.append('条目名不能按 UTF-8 解码（疑似 GBK/未置标志）: ' + repr(n))
            continue
        if dec != n:
            bad.append('条目名编码往返不一致: ' + repr(n))
        if 'data' in dec.replace('\\', '/').lower().split('/'):
            bad.append('含 data/ 条目: ' + dec)
if bad:
    for b in bad:
        print('   ' + b, file=sys.stderr)
    sys.exit(1)
print('   zip 自检通过：%d 个条目，中文名均为 UTF-8、无 data/ 条目' % len(infos))
PYEOF
then
  echo "!! zip 自检失败（条目名编码或 data/ 泄漏）"; exit 1
fi
echo "== 完成 =="
