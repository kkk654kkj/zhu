#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""成品目录 → 便携 zip（发布唯一口径，v2.8.59 / v3.3.72 从 .tmp 收编）

- 只打文件，不写目录条目（Windows 资源管理器解压更顺）
- 排除 data/ 与 .testdata-*（用户曲库/历史/设置/缓存一律不带走）
- 排除根目录 使用说明.txt（说明只留在仓库 docs/，不随包分发）
- 中文条目名用 CP936 原始字节 + 不置 UTF-8 flag（0x0000），与历次发布包一致
- 条目时间戳固定，同一份成品重复打包字节数稳定（便于核对 zip 大小）

用法: python tools/mkzip.py <成品目录> <输出zip> [YYYY-MM-DD]
"""
import os
import sys
import zipfile

DEFAULT_DATE = '2026-11-18'


class GBKZipInfo(zipfile.ZipInfo):
    def _encodeFilenameFlags(self):
        return self.filename.encode('gbk'), self.flag_bits & ~0x800


def skip(rel):
    parts = [p.lower() for p in rel.replace('\\', '/').split('/')]
    if any(p == 'data' or p.startswith('.testdata') for p in parts):
        return True
    return parts[-1] == '使用说明.txt'


def main():
    if len(sys.argv) < 3:
        print(__doc__.strip())
        return 2
    src, out = sys.argv[1], sys.argv[2]
    day = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_DATE
    y, m, d = (int(x) for x in day.split('-'))
    n = 0
    total = 0
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for root, dirs, files in os.walk(src):
            dirs.sort()
            for name in sorted(files):
                full = os.path.join(root, name)
                rel = os.path.relpath(full, src).replace('\\', '/')
                if skip(rel):
                    continue
                st = os.stat(full)
                zi = GBKZipInfo(rel)
                zi.date_time = (y, m, d, 0, 0, 0)
                zi.external_attr = (0o755 if os.access(full, os.X_OK) else 0o644) << 16
                zi.compress_type = zipfile.ZIP_DEFLATED
                with open(full, 'rb') as f:
                    z.writestr(zi, f.read())
                n += 1
                total += st.st_size
    print('entries=%d raw=%d bytes -> %s (%d bytes)' % (n, total, out, os.path.getsize(out)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
