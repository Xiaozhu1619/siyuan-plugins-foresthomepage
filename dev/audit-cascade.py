# -*- coding: utf-8 -*-
"""离线排查：把思源 base.css + 主题 theme.css + 插件 index.css 的真级联算出来。

沙箱里起不了浏览器，截图这条路走不通；那就用选择器匹配 + 优先级排序，
算出「某个元素最终生效的声明」，从而定位设置面板排版错乱的真实原因。

用法：python dev/audit-cascade.py
"""

import re
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 两个路径都按需覆盖，默认值只是本机的示例位置（不含任何个人路径）：
#   SIYUAN_STAGE：思源安装目录下的 stage 目录（Windows Store 版形如
#                 C:/Program Files/WindowsApps/<包名>/app/resources/stage）
#   SIYUAN_THEME：你正在用的主题 theme.css（第三方主题会重写 .b3-* 组件，必须一起算）
STAGE = os.environ.get("SIYUAN_STAGE",
    "C:/Program Files/WindowsApps/89C2A984.SiYuan_3.8.6.0_x64__1qfd3tsw4ngc2/app/resources/stage")
THEME = os.environ.get("SIYUAN_THEME", "")

SKIP_PSEUDO = re.compile(r":(hover|focus|active|focus-visible|focus-within|before|after|first-line|"
                         r"selection|placeholder|checked|disabled|halt)\b")


def load_css(path):
    try:
        text = open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return ""
    return re.sub(r"/\*.*?\*/", "", text, flags=re.S)


def split_rules(css):
    """返回 [(selector_text, decl_text, order)]；@media/@supports 递归展开，@keyframes 跳过。"""
    out = []
    order = 0
    i = 0
    n = len(css)
    while i < n:
        brace = css.find("{", i)
        if brace < 0:
            break
        head = css[i:brace].strip()
        j = brace + 1
        depth = 1
        while j < n and depth:
            if css[j] == "{":
                depth += 1
            elif css[j] == "}":
                depth -= 1
            j += 1
        inner = css[brace + 1:j - 1]
        if head.startswith("@keyframes") or head.startswith("@font-face"):
            pass
        elif head.startswith("@"):
            sub = split_rules(inner)
            out.extend((sel, body, order + k) for k, (sel, body, _) in enumerate(sub))
            order += len(sub) + 1
        else:
            order += 1
            out.append((head, inner.strip(), order))
        i = j
    return out


def unroll_selector(sel):
    """展开 :where()/:is() 与逗号，返回若干简单选择器字符串。"""
    sel = sel.strip()
    if not sel or sel.startswith("@"):
        return []
    # :where(x) / :is(x) → 用第一个参数替换（够用）
    def inline(m):
        inner = m.group(2)
        return inner.split(",")[0].strip()
    sel = re.sub(r":(where|is)\(([^()]*(?:\([^()]*\)[^()]*)*)\)", inline, sel)
    return [s.strip() for s in sel.split(",") if s.strip()]


def specificity(sel):
    s = re.sub(r":not\((.*?)\)", r"\1", sel)
    ids = len(re.findall(r"#[\w-]+", s))
    classes = len(re.findall(r"\.[\w-]+", s)) + len(re.findall(r"\[[^\]]+\]", s)) \
        + len(re.findall(r":(first|last|nth|only)-child", s))
    tags = len(re.findall(r"(?:^|[\s>+~])([a-zA-Z][\w-]*)", s))
    return (ids, classes, tags)


def parse_compound(part):
    """把复合选择器拆成 {tag, classes, nots, attrs, pseudos}；不认识的构造返回 None。"""
    out = {"tag": None, "classes": [], "nots": [], "attrs": [], "pseudos": []}
    i = 0
    n = len(part)
    while i < n:
        ch = part[i]
        if ch == "*":
            i += 1
        elif ch == ".":
            m = re.match(r"\.([\w-]+)", part[i:])
            if not m:
                return None
            out["classes"].append(m.group(1))
            i += m.end()
        elif ch == "#":
            return None                       # 我们的元素没有 id
        elif ch == "[":
            close = part.find("]", i)
            if close < 0:
                return None
            body = part[i + 1:close]
            name = body.split("=")[0].split("~")[0].strip().rstrip("|^$*")
            if name != "data-theme-mode":
                return None
            out["attrs"].append(body)
            i = close + 1
        elif ch == ":":
            if part.startswith("::", i):
                return None
            m = re.match(r":([\w-]+)(\(([^()]*(?:\([^()]*\)[^()]*)*)\))?", part[i:])
            if not m:
                return None
            name = m.group(1)
            arg = m.group(3)
            if name == "not":
                if not arg:
                    return None
                out["nots"].append(parse_compound(arg.strip()))
            elif name in ("where", "is"):
                if not arg:
                    return None
                out["pseudos"].append(("where", arg))
            elif name in ("first-child", "last-child", "nth-child", "only-child"):
                out["pseudos"].append((name, arg))
            else:
                return None                   # :hover 之类：整条选择器不参与
            i += m.end()
        elif ch.isalpha() or ch == "_":
            m = re.match(r"[\w-]+", part[i:])
            if out["tag"] is not None:
                return None
            out["tag"] = m.group(0)
            i += m.end()
        else:
            return None
    return out


def compound_match(node, part):
    """node: {'tag':.., 'classes':set}；part: 复合选择器；返回 bool"""
    parsed = parse_compound(part.strip())
    if parsed is None:
        return False
    if parsed["tag"] and node["tag"] != parsed["tag"]:
        return False
    for cls in parsed["classes"]:
        if cls not in node["classes"]:
            return False
    for sub in parsed["nots"]:
        if sub is None:
            return False
        if compound_match(node, _rebuild(sub)):
            return False
    for name, arg in parsed["pseudos"]:
        if name == "where":
            if not any(compound_match(node, _rebuild(parse_compound(a.strip())))
                       for a in arg.split(",") if parse_compound(a.strip()) is not None):
                return False
        elif name == "first-child":
            if node.get("index") != 0:
                return False
        elif name == "last-child":
            if not node.get("is_last"):
                return False
        elif name == "only-child":
            if not node.get("is_only"):
                return False
        elif name == "nth-child":
            idx = node.get("index", 0) + 1
            expr = (arg or "").replace(" ", "")
            mm = re.match(r"^(-?\d*)n(?:\+(\d+))?$", expr)
            if mm:
                a = mm.group(1)
                a = -1 if a == "-" else (int(a) if a else 1)
                b = int(mm.group(2) or 0)
                if a == 0:
                    if idx != b:
                        return False
                else:
                    k = (idx - b) / a
                    if k < 0 or int(k) != k:
                        return False
            elif not expr.isdigit() or int(expr) != idx:
                return False
    return True


def _rebuild(parsed):
    """把 parse_compound 的结果还原成简单选择器文本（用于递归判断 :not()）。"""
    if parsed is None:
        return "\u0000"
    out = parsed["tag"] or ""
    out += "".join("." + c for c in parsed["classes"])
    for sub in parsed["nots"]:
        out += ":not(" + _rebuild(sub) + ")"
    return out or "*"



def _tokenize_selector(sel):
    """拆成 [(combinator, compound), ...]；combinator ∈ {" ", ">", "+", "~"}。"""
    tokens = re.findall(r"[>+~]|[^\s>+~]+", sel)
    if not tokens or tokens[-1] in (">", "+", "~"):
        return None
    parts = []
    comb = " "
    for t in tokens:
        if t in (">", "+", "~"):
            comb = t
        else:
            parts.append((comb, t))
            comb = " "
    return parts


def match_selector(sel, chain):
    """chain: [根 … 目标]。最右侧复合选择器必须命中目标节点本身，
    否则单 token 选择器会误配到祖先上。"""
    parts = _tokenize_selector(sel)
    if not parts:
        return False
    if not compound_match(chain[-1], parts[-1][1]):
        return False
    return _walk(parts, len(parts) - 1, chain, len(chain) - 1)


def _walk(parts, pi, chain, ci):
    """parts[pi] 已确认匹配 chain[ci]，继续向左校验。"""
    if pi == 0:
        return True
    comb = parts[pi][0]          # 本节点与其左侧节点的组合关系
    if comb == ">":
        if ci - 1 < 0:
            return False
        if not compound_match(chain[ci - 1], parts[pi - 1][1]):
            return False
        return _walk(parts, pi - 1, chain, ci - 1)
    if comb in ("+", "~"):
        return False             # 兄弟选择器：脚本不支持，保守判为不匹配
    for k in range(ci - 1, -1, -1):     # 后代：左侧可以是更上层任意节点
        if compound_match(chain[k], parts[pi - 1][1]) and _walk(parts, pi - 1, chain, k):
            return True
    return False


def resolve(target_path, all_rules, props):
    """target_path: [根, …, 目标]；返回 {prop: (value, selector, source)}"""
    wins = {}
    for src, sel, body, order in all_rules:
        for one in unroll_selector(sel):
            if SKIP_PSEUDO.search(one):
                continue
            if not match_selector(one, target_path):
                continue
            spec = specificity(one)
            decls = {}
            for piece in body.split(";"):
                if ":" not in piece:
                    continue
                k, _, v = piece.partition(":")
                k = k.strip()
                v = v.strip()
                if k and not k.startswith("--"):
                    decls[k] = v
            for p in props:
                if p in decls:
                    cand = (spec, order)
                    if p not in wins or cand >= wins[p][0]:
                        wins[p] = (cand, decls[p], one, src)
    return wins


def N(tag, classes="", **kw):
    d = {"tag": tag, "classes": set(classes.split())}
    d.update(kw)
    return d


def show(title, path, all_rules, props):
    print("=" * 78)
    print(title)
    print("  路径:", " ".join(n["tag"] + ("." + ".".join(sorted(n["classes"])) if n["classes"] else "")
                             for n in path))
    result = resolve(path, all_rules, props)
    for p in props:
        if p in result:
            (spec, order), value, sel, src = result[p]
            print("  %-14s = %-42s  <%s> [%s]" % (p, value[:42], sel[:52], src))
        else:
            print("  %-14s = (无)" % p)


def main():
    base = load_css(os.path.join(STAGE, "build", "desktop", "base.6ebf9935cf77dd602cbe.css"))
    if not base:
        print("找不到 base.css"); return 1
    theme = load_css(THEME)
    mine = load_css(os.path.join(ROOT, "index.css"))

    all_rules = []
    bump = 0
    for src, css in (("base", base), ("theme", theme), ("mine", mine)):
        local = split_rules(css)
        for sel, body, order in local:
            # 三份样式表各自的 order 都从 1 开始，直接比较会串味；
            # 这里按真实注入顺序叠加基准值：base → theme → 插件（插件最晚，同优先级时赢）
            all_rules.append((src, sel, body, order + bump))
        bump += len(local) + 10

    layout_props = ["display", "flex-direction", "flex", "flex-wrap", "width", "max-width",
                    "min-width", "margin-top", "align-items", "align-self", "padding",
                    "overflow", "overflow-y", "height", "max-height", "gap", "row-gap"]

    # —— 现状：direction 未声明 → 思源默认 column（控件挂成 .config-item 直接子节点）——
    content = N("div", "b3-dialog__content")
    item = N("div", "b3-label config-item fn__flex", index=0, is_last=False)
    titlebox = N("div", "fn__flex-1")
    cname = N("div", "config-name")
    desc = N("div", "b3-label__text")
    space = N("span", "fn__space")

    quick = N("div", "fh-set-quick fn__size200 fn__flex-center")
    qlist = N("div", "fh-set-quick__list")
    qgroup = N("div", "fh-set-quick__group")
    qhead = N("div", "fh-set-quick__head")
    qname = N("span", "fh-set-quick__name")
    qitem = N("div", "fh-set-quick__item")

    cards = N("div", "fh-set-cards fn__size200 fn__flex-center")
    cardslist = N("div", "fh-set-cards__list")

    rng = N("div", "fh-set-range fn__size200 fn__flex-center")
    rnginput = N("input", "fh-range fn__flex-1")
    rngval = N("span", "fh-set-range__value")

    print("### 现状（所有设置项都没写 direction → 思源默认 column）###\n")
    show("【快速访问内容】控件本体", [content, item, quick], all_rules, layout_props)
    show("【快速访问内容】列表容器", [content, item, quick, qlist], all_rules, layout_props)
    show("【快速访问内容】分组头部", [content, item, quick, qlist, qgroup, qhead], all_rules, layout_props)
    show("【快速访问内容】分组名", [content, item, quick, qlist, qgroup, qhead, qname], all_rules, layout_props)
    show("【快速访问内容】单个条目", [content, item, quick, qlist, qgroup, qitem], all_rules, layout_props)
    show("【显示的卡片】列表", [content, item, cards, cardslist], all_rules, layout_props)
    show("【滑杆行】", [content, item, rng], all_rules, layout_props)
    show("【滑杆】本体", [content, item, rng, rnginput], all_rules, layout_props)

    # —— 改成 direction:"row" ——
    rowitem = N("div", "b3-label config-item", index=0, is_last=False)
    fhblock = N("div", "fn__block")
    quick_row = N("div", "fh-set-quick fn__block")
    rng_row = N("div", "fh-set-range fn__block")
    cards_row = N("div", "fh-set-cards fn__block")
    target_row = N("div", "fh-target fn__block")
    action_row = N("button", "b3-button b3-button--outline fh-set-action fn__block")
    qname = N("span", "fh-set-quick__name")
    qcount = N("span", "fh-set-quick__count")
    qspacer = N("span", "fh-set-quick__spacer")
    qdel = N("button", "b3-button b3-button--outline fh-set-quick__del")
    card = N("label", "fh-set-card")

    print("\n### 改成 direction:\"row\" 之后（当前实现）###\n")
    show("【快速访问内容】控件本体", [content, rowitem, fhblock, quick_row], all_rules, layout_props)
    show("【快速访问内容】列表容器", [content, rowitem, fhblock, quick_row, qlist], all_rules, layout_props)
    show("【快速访问内容】组名", [content, rowitem, fhblock, quick_row, qlist, qgroup, qhead, qname],
         all_rules, layout_props + ["font-size", "font-weight", "letter-spacing"])
    show("【快速访问内容】数量胶囊", [content, rowitem, fhblock, quick_row, qlist, qgroup, qhead, qcount],
         all_rules, layout_props + ["font-size"])
    show("【快速访问内容】撑开元素", [content, rowitem, fhblock, quick_row, qlist, qgroup, qhead, qspacer],
         all_rules, ["flex", "display"])
    show("【快速访问内容】条目行", [content, rowitem, fhblock, quick_row, qlist, qgroup, qitem],
         all_rules, layout_props)
    show("【显示的卡片】药丸", [content, rowitem, fhblock, cards_row, cardslist, card],
         all_rules, layout_props + ["border", "font-size"])
    show("【滑杆行】", [content, rowitem, fhblock, rng_row], all_rules, layout_props)
    show("【滑杆】本体", [content, rowitem, fhblock, rng_row, rnginput], all_rules, layout_props)
    show("【灵感归宿】", [content, rowitem, fhblock, target_row], all_rules, layout_props)
    show("【独立按钮】", [content, rowitem, fhblock, action_row],
         all_rules, ["display", "width", "max-width", "height", "padding", "font-size"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
