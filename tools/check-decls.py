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
# 这些关键字后面出现的 `/` 是正则开头，不是除号（`return /kw/.test(s)`）
REGEX_KEYWORD_PREV = {
    'return', 'typeof', 'instanceof', 'case', 'in', 'of', 'new', 'delete',
    'void', 'do', 'else', 'yield', 'await', 'throw',
}
IDENT_CHARS = set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$')


def read(p):
    return io.open(p, encoding='utf-8', errors='replace').read()


def strip_noise(src):
    """去掉注释、字符串与正则字面量（替换为等长空白，保留换行以维持行号）。

    `/` 的三种含义靠「上一个有效字符」区分：
      注释 —— 后面紧跟 / 或 *（注释优先级最高，`a // b` 与中文注释都能正确识别）
      正则 —— 前一个有效字符属于 REGEX_PREV_OK（`=` `(` `,` `:` `return` 之后）
      除号 —— 其余（前面是标识符 / `)` / `]`）

    v3.3.20：模板字符串的 `${ ... }` 插值内部按**代码**扫描，不再整体当字符串擦掉。
    以前 `` `${SETTING_ARRAY_MAX}` `` 里的引用根本看不见 —— 而「常量搬了引用没搬声明」
    正是本工具要拦的事故（v2.8.17），工具自己的盲区等于把门留了条缝。
    """
    out = []
    i, n = 0, len(src)
    # 扫描栈：'code' = 代码区（顶层或 ${} 插值内部），'tpl' = 模板字面量文本区。
    # 每个 interp 帧带花括号深度，用来判断插值从哪个 `}` 结束。
    stack = [{'mode': 'code', 'depth': 0, 'interp': False}]
    prev = ''
    word = ''

    def blank(s):
        return ''.join('\n' if ch == '\n' else ' ' for ch in s)

    while i < n:
        top = stack[-1]
        c = src[i]

        if top['mode'] == 'tpl':
            if c == '\\':
                j = min(i + 2, n)          # 转义序列整体抹掉，换行保留
                out.append(blank(src[i:j]))
                i = j
                continue
            if c == '`':
                out.append(' ')
                stack.pop()
                prev = '`'
                word = ''
                i += 1
                continue
            if c == '$' and i + 1 < n and src[i + 1] == '{':
                # 插值开始：`$` 抹掉、`{` 保留（让下层括号配平仍然可见）
                out.append(' ')
                out.append('{')
                stack.append({'mode': 'code', 'depth': 1, 'interp': True})
                prev = '{'
                word = ''
                i += 2
                continue
            out.append(blank(c))
            i += 1
            continue

        # ---------------- code 模式 ----------------
        if c == '/' and i + 1 < n and src[i + 1] in '/*':
            if src[i + 1] == '/':
                j = src.find('\n', i)
                j = n if j < 0 else j
            else:
                j = src.find('*/', i + 2)
                j = n if j < 0 else j + 2
            out.append(blank(src[i:j]))
            i = j
            word = ''
            continue
        if c in '\'"':
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
            out.append(blank(src[start:min(i, n)]))
            i += 1
            prev = q
            word = ''
            continue
        if c == '`':
            out.append(' ')
            stack.append({'mode': 'tpl'})
            prev = '`'
            word = ''
            i += 1
            continue
        if c == '/' and (prev in REGEX_PREV_OK or prev == '' or word in REGEX_KEYWORD_PREV):
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
            word = ''
            continue
        if top['interp']:
            if c == '{':
                top['depth'] += 1
            elif c == '}':
                top['depth'] -= 1
                if top['depth'] == 0:
                    out.append(' ')
                    stack.pop()
                    prev = '}'
                    word = ''
                    i += 1
                    continue
        out.append(c)
        if not c.isspace():
            prev = c
        # 记住上一个标识符单词：`return /re/` 这种正则靠它才认得出来（空格不算分隔）
        if c.isalnum() or c in '_$':
            word += c
        elif not c.isspace():
            word = ''
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
    """裸标识符引用：排除属性访问（.x）、对象字面量键（x:）、关键字。

    v3.3.20：不再要求标识符长度 ≥3。以前 `const fs` / `const kw` / `const wy` /
    `const qq` / `const kg` / `const UA` / `const $` / `const $$` 这些 1~2 字符的
    模块级声明**永远不参与扫描** —— 其中任何一个在移植时丢掉，本工具都查不出来。
    """
    r = set()
    for m in re.finditer(r'(?<![.\w$])([A-Za-z_$][\w$]*)', s):
        name = m.group(1)
        if name in JS_KEYWORDS:
            continue
        if s[m.end():m.end() + 1] == ':':
            continue
        r.add(name)
    return r


def _diff(base_src, target_src):
    """在同一份内存源码上做「基准有声明 / 目标无声明 / 目标有引用」的差集。"""
    s_b, d_b = decls(base_src)
    s_t, d_t = decls(target_src)
    return sorted(refs(s_t) & (d_b - d_t))


def selftest():
    """扫描器自身的回归用例：这些盲区一旦复发，发布闸门就形同虚设。"""
    base = 'const SETTING_ARRAY_MAX = 200\nconst fs = require("fs")\nconst kw = {}\n'
    cases = [
        # (说明, 目标源码, 期望命中)
        ('裸引用', 'function f(){ return SETTING_ARRAY_MAX }\n', ['SETTING_ARRAY_MAX']),
        ('模板插值内引用', 'function f(){ return `n=${SETTING_ARRAY_MAX}` }\n', ['SETTING_ARRAY_MAX']),
        ('模板插值嵌套模板', 'function f(){ return `${`a${fs}`}b` }\n', ['fs']),
        ('短标识符（2 字符）', 'function f(){ return kw }\n', ['kw']),
        ('短标识符（2 字符·属性不误报）', 'function f(o){ return o.kw }\n', []),
        ('字符串内引用', 'function f(){ return "SETTING_ARRAY_MAX" }\n', []),
        ('单行注释内引用', 'function f(){ /* SETTING_ARRAY_MAX */ }\n', []),
        ('块注释内引用', 'function f(){ return 1 }\n/* kw */\n', []),
        ('正则字面量内引用', 'function f(s){ return /kw/.test(s) }\n', []),
    ]
    bad = 0
    for name, target, expect in cases:
        got = _diff(base, target)
        ok = got == sorted(expect)
        print(('  ✓ ' if ok else '  ✗ ') + name + ('' if ok else '  期望 %s / 实际 %s' % (expect, got)))
        if not ok:
            bad += 1
    print('\n自检：%d/%d 通过' % (len(cases) - bad, len(cases)))
    return 0 if not bad else 1


def main(argv):
    if len(argv) >= 2 and argv[1] == '--selftest':
        return selftest()
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
