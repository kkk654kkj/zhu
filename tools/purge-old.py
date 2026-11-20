#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""旧版安装包永久删除（2026-11-20 起取代 recycle-old.py）

规则（用户 2026-11-20 明确要求）：
- 旧版本一律**永久删除，不进回收站** —— 回收站里的文件照样占 D 盘空间；
- 历史版本随时能从 GitHub Releases 下回来，本机不留任何旧包；
- 发布新版本时，安装包目录只保留当前两个 zip（播放器 / 联网版各一）。

安全约束：
- 默认只接受 `ZhuPlayer_v*.zip`，防止手滑传错路径把别的文件删了；
- 只删文件，不删目录；传目录直接报错退出；
- 支持 --dry-run 先看清单和总大小。

用法:
  python tools/purge-old.py <文件1> [文件2 ...] [--any] [--dry-run]
"""
import fnmatch
import os
import sys


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = [a for a in sys.argv[1:] if a.startswith('--')]
    allow_any = '--any' in flags
    dry = '--dry-run' in flags
    if not args:
        print(__doc__.strip())
        return 2

    total = 0
    failed = []
    for p in args:
        ap = os.path.abspath(p)
        if os.path.isdir(ap):
            print('!! 拒绝删除目录: %s' % ap, file=sys.stderr)
            failed.append(ap)
            continue
        if not os.path.isfile(ap):
            print('!! 不存在: %s' % ap, file=sys.stderr)
            failed.append(ap)
            continue
        if not allow_any and not fnmatch.fnmatch(os.path.basename(ap), 'ZhuPlayer_v*.zip'):
            print('!! 不是旧版安装包（需要 --any 才删）: %s' % ap, file=sys.stderr)
            failed.append(ap)
            continue
        size = os.path.getsize(ap)
        if dry:
            print('  [dry] %10.1f MB  %s' % (size / 1048576, ap))
            total += size
            continue
        try:
            os.remove(ap)
            print('  已永久删除 %8.1f MB  %s' % (size / 1048576, ap))
            total += size
        except Exception as e:
            print('!! 删除失败 %s: %s' % (ap, e), file=sys.stderr)
            failed.append(ap)

    print('%s合计 %.1f MB，失败 %d 个' % ('[dry] ' if dry else '', total / 1048576, len(failed)))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
