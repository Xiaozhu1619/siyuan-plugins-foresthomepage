# -*- coding: utf-8 -*-
"""打包成集市可用的 package.zip。

用法：python build.py
"""

import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "package.zip")

# 必须随包发布的文件（plugin.json 中声明了 icon / preview，图片必须在包里）
FILES = [
    "plugin.json",
    "index.js",
    "index.css",
    "i18n/zh_CN.json",
    "i18n/en_US.json",
    "README.md",
    "README.zh_CN.md",
    "icon.png",
    "preview.png",
]


def main():
    missing = [name for name in FILES if not os.path.exists(os.path.join(ROOT, name))]
    if missing:
        print("缺少文件，无法打包：")
        for name in missing:
            print("  -", name)
        return 1

    if os.path.exists(OUT):
        os.remove(OUT)

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in FILES:
            zf.write(os.path.join(ROOT, name), name)

    size = os.path.getsize(OUT)
    print("已生成 package.zip  (%d 个文件, %.1f KiB)" % (len(FILES), size / 1024.0))
    for name in FILES:
        print("  +", name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
