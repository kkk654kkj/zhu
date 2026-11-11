'use strict'
# 占位说明：实际用 python 执行（.py 语义）
import ctypes
import os
import sys
from ctypes import wintypes

# 清旧安装包到回收站（FO_DELETE + FOF_ALLOWUNDO）
# 用法: python recycle-old.ps1.py <文件1> [文件2 ...]

class SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [
        ('hwnd', wintypes.HWND),
        ('wFunc', wintypes.UINT),
        ('pFrom', wintypes.LPCWSTR),
        ('pTo', wintypes.LPCWSTR),
        ('fFlags', ctypes.c_uint16),
        ('fAnyOperationsAborted', wintypes.BOOL),
        ('hNameMappings', ctypes.c_void_p),
        ('lpszProgressTitle', wintypes.LPCWSTR),
    ]

FO_DELETE = 3
FOF_ALLOWUNDO = 0x0040
FOF_NOCONFIRMATION = 0x0010
FOF_SILENT = 0x0004

def to_recycle_bin(paths):
    existing = [os.path.abspath(p) for p in paths if os.path.exists(p)]
    if not existing:
        print('没有需要清理的旧包')
        return 0
    joined = '\0'.join(existing) + '\0\0'
    op = SHFILEOPSTRUCTW()
    op.hwnd = None
    op.wFunc = FO_DELETE
    op.pFrom = joined
    op.pTo = None
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT
    res = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if res != 0:
        print(f'回收站操作失败 code={res}')
        return 1
    for p in existing:
        print('已移入回收站:', p)
    return 0

if __name__ == '__main__':
    sys.exit(to_recycle_bin(sys.argv[1:]))
