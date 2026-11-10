#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""模块级标识符声明完整性扫描（交接文档 §5.0 / 第四轮审查报告 §九）

背景
----
`node --check` 只查语法，查不出「引用了不存在的变量」；而 `src/main/main.js` 首行是
`'use strict'`，任何未声明的裸标识符被读取/赋值都会抛 ReferenceError，且几乎都被
各自的 try/catch 或全局 handler 吞掉 —— 表现为「功能静默失效」，而不是崩溃。

v2.8.16 的 4 条 P1 就是这么漏过全部既有验证的：
  cleanupStarted / systemShutdownPending / systemShutdownTimer /
  FORBIDDEN_SETTING_KEYS / lastOpenFiles
（`node --check` 通过、函数扫描通过、17 项冒烟通过，主进程零断言。）

用法
----
  # 1) 以联网版（online）的声明集为基准，查本地版（master）漏声明的标识符
  #    发布前必跑，判据：输出为空、退出码 0
  python tools/check-decls.py --base <基准 main.js> <待查 main.js>

  # 2) 单文件自检：列出「被引用但全文无声明」的候选
  #    需人工排除内置 API / 跨文件全局 / 参数名
  python tools/check-decls.py --self <main.js>

取两个分支的文件（不必切分支）：
  git show online:src/main/main.js > /tmp/online_main.js
  git show master:src/main/main.js > /tmp/master_main.js

退出码
------
  0 = 无命中（--self 恒 0）
  1 = 有命中（发布前应视为阻塞）
  2 = 参数错误
"""
import io
import re
import sys

JS_KEYWORDS = {
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
    'return', 'function', 'var', 'let', 'const', 'new', 'delete', 'typeof', 'instanceof',
    'in', 'of', 'this', 'true', 'false', 'null', 'undefined', 'try', 'catch', 'finally',
    'throw', 'class', 'extends', 'super', 'async', 'await', 'yield', 'void', 'with',
    'export', 'import', 'debugger', 'arguments',
}

REGEX_PREV_OK = set('(,=:[!&|?{};+-*%~^<>')
IDENT_CHARS = set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$')


def read(p):
    return io.open(p, encoding='utf-8', errors='replace').read()


def strip_noise(src):
    """去掉注释、字符串与正则字面量（替换为等长空白，保留换行以维持行号）。

    `/` 的三种含义靠「上一个有效字符」区分：
      注释 —— 后面紧跟 / 或 *（注释优先级最高，`a // b` 与中文注释都能正确识别）
      正则 —— 前一个有效字符属于 REGEX_PREV_OK（`=` `(` `,` `:` `return` 之后）
      除号 —— 其余（前面是标识符 / `)` / `]`）
    """
    out = []
    i, n = 0, len(src)
    prev = ''
    while i < n:
        c = src[i]
        if c == '/' and i + 1 < n and src[i + 1] in '/*':
            if src[i + 1] == '/':
                j = src.find('\n', i)
                j = n if j < 0 else j
            else:
                j = src.find('*/', i + 2)
                j = n if j < 0 else j + 2
            out.append(''.join('\n' if ch == '\n' else ' ' for ch in src[i:j]))
            i = j
            continue
        if c in '\'"`':
            q = c
            i += 1
            start = i
            while i < n:
                if src[i] == '\\':
                    i += 2
                    continue
                if src[i] == q:
                    break
                i += 1
            out.append(''.join('\n' if ch == '\n' else ' ' for ch in src[start:i]))
            i += 1
            prev = q
            continue
        if c == '/' and (prev in REGEX_PREV_OK or prev == ''):
            i += 1
            start = i
            in_class = False
            while i < n:
                ch = src[i]
                if ch == '\\':
                    i += 2
                    continue
                if ch == '[':
                    in_class = True
                elif ch == ']':
                    in_class = False
                elif ch == '/' and not in_class:
                    break
                elif ch == '\n':
                    break
                i += 1
            out.append(' ' * (i - start))
            i += 1
            while i < n and (src[i].isalnum() or src[i] == '_'):
                out.append(' ')
                i += 1
            prev = '/'
            continue
        out.append(c)
        if not c.isspace():
            prev = c
        i += 1
    return ''.join(out)


DECL_KW = re.compile(r'\b(?:let|var|const)\b')
CONTINUE_CHARS = set(',=+-*/&|?:([{<>!~^%')


def _decl_list_names(s, start):
    """从 `let/var/const` 之后解析声明列表；处理解构、多变量与续行。"""
    names = []
    i = start
    n = len(s)
    depth = 0
    while i < n:
        ch = s[i]
        if ch in '([{':
            depth += 1
        elif ch in ')]}':
            if depth == 0:
                break
            depth -= 1
        elif depth == 0 and (ch == ';' or ch == '\n'):
            prev_sig = s[i - 1] if i > 0 else ''
            if ch == ';' or prev_sig not in CONTINUE_CHARS:
                break
        i += 1
    body = s[start:i]
    parts, depth, cur = [], 0, []
    for ch in body:
        if ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(''.join(cur))
            cur = []
            continue
        cur.append(ch)
    parts.append(''.join(cur))
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if part[0] in '{[':
            close = ']' if part[0] == '[' else '}'
            idx = part.find(close)
            inner = part[1:idx if idx > 0 else len(part)]
            for sub in inner.split(','):
                nm = sub.split(':')[-1].strip().split('=')[0].strip()
                if re.match(r'^[A-Za-z_$][\w$]*$', nm):
                    names.append(nm)
            continue
        nm = part.split('=')[0].strip().split('.')[0].strip()
        if re.match(r'^[A-Za-z_$][\w$]*$', nm):
            names.append(nm)
    return names


def decls(src):
    """返回 (去噪源码, 已声明标识符集合)。"""
    s = strip_noise(src)
    d = set()
    for m in DECL_KW.finditer(s):
        for nm in _decl_list_names(s, m.end()):
            d.add(nm)
    d |= set(re.findall(r'\bfunction\s+([A-Za-z_$][\w$]*)\s*\(', s))
    d |= set(re.findall(r'\bclass\s+([A-Za-z_$][\w$]*)', s))
    # 函数形参 / 箭头函数形参 / catch 参数 → 视为已声明
    for m in re.finditer(r'\bfunction\s*[A-Za-z_$]*\s*\(([^)]*)\)', s):
        d |= set(re.findall(r'([A-Za-z_$][\w$]*)\s*(?=[,=)]|$)', m.group(1)))
    for m in re.finditer(r'\(([^()]*)\)\s*=>', s):
        d |= set(re.findall(r'([A-Za-z_$][\w$]*)\s*(?=[,=)]|$)', m.group(1)))
    d |= set(re.findall(r'([A-Za-z_$][\w$]*)\s*=>', s))
    d |= set(re.findall(r'\bcatch\s*\(\s*([A-Za-z_$][\w$]*)', s))
    return s, d


def refs(s):
    """裸标识符引用：排除属性访问（.x）、对象字面量键（x:）、关键字。"""
    r = set()
    for m in re.finditer(r'(?<![.\w$])([A-Za-z_$][\w$]{2,})', s):
        name = m.group(1)
        if name in JS_KEYWORDS:
            continue
        if s[m.end():m.end() + 1] == ':':
            continue
        r.add(name)
    return r


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    if argv[1] == '--self':
        target = argv[2]
        s_t, d_t = decls(read(target))
        cand = sorted(refs(s_t) - d_t)
        print('== %s: 引用但无声明候选 %d 个（需人工排除内置 API / 跨文件全局）=='
              % (target, len(cand)))
        for c in cand:
            print('  ' + c)
        return 0
    base, target = argv[2], argv[3]
    s_b, d_b = decls(read(base))
    s_t, d_t = decls(read(target))
    hits = sorted(refs(s_t) & (d_b - d_t))
    print('== %s 引用了、基准有声明、自身无声明: %d 个 ==' % (target, len(hits)))
    lines = s_t.split('\n')
    for h in hits:
        ln = next((i + 1 for i, L in enumerate(lines)
                   if re.search(r'(?<![.\w$])' + re.escape(h) + r'\b', L)), 0)
        print('  %-30s 首个引用 L%d' % (h, ln))
    return 0 if not hits else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
