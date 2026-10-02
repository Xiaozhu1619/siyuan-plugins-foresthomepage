/**
 * 开发辅助：用真实插件代码在 jsdom 里渲染主页，导出静态 HTML，
 * 供无头浏览器截图生成 preview.png，也方便在浏览器里直接审视设计。
 *
 * 运行：
 *   NODE_PATH=<managed node workspace>/node_modules node dev/build-preview.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = __dirname;
const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "index.css"), "utf8");
const zhI18n = JSON.parse(fs.readFileSync(path.join(ROOT, "i18n", "zh_CN.json"), "utf8"));

// 演示用的虚构数据，不涉及任何真实文档或个人安排
const NOTES = [
    { id: "n1", text: "「先写完，再写好。」初稿阶段别急着自我审查。", ts: Date.now() - 26 * 60 * 1000 },
    { id: "n2", text: "把常用的三样东西放在手边，其余收进抽屉。", ts: Date.now() - 5 * 3600 * 1000 },
    { id: "n3", text: "好的工具应该消失在动作里。", ts: Date.now() - 30 * 3600 * 1000 },
];

const DOCS = [
    { rootID: "20260101120000-aaaaaaaa", title: "读书笔记 · 第三章", icon: "1f4d4", viewedAt: Date.now() - 4 * 60 * 1000 },
    { rootID: "20260101120001-bbbbbbbb", title: "周报 · 第 39 周", icon: "1f9ea", viewedAt: Date.now() - 42 * 60 * 1000 },
    { rootID: "20260101120002-cccccccc", title: "菜谱 · 番茄牛腩", icon: "1f4da", viewedAt: Date.now() - 3 * 3600 * 1000 },
    { rootID: "20260101120003-dddddddd", title: "会议纪要 · 周五", icon: "", viewedAt: Date.now() - 26 * 3600 * 1000 },
    { rootID: "20260101120004-eeeeeeee", title: "影单 · 待看", icon: "1f343", viewedAt: Date.now() - 76 * 3600 * 1000 },
];

const DAY_DOCS = [{ id: "20261002100000-ffffffff", title: "当天随手记" }];

// 快速访问：虚构的分组与固定项
// 注意：default（未分类）故意留空 —— 它会按新规则自动隐藏，正好当回归观察点
const QUICK = {
    groups: [
        { id: "default", name: "", items: [] },
        { id: "g1", name: "本周常用", items: [
            { id: "20260101120001-bbbbbbbb", title: "周报 · 第 39 周", icon: "1f9ea", addedAt: Date.now() },
            { id: "20260101120003-dddddddd", title: "会议纪要 · 周五", icon: "", addedAt: Date.now() },
            { id: "20260101120000-aaaaaaaa", title: "读书笔记 · 第三章", icon: "1f4d4", addedAt: Date.now() },
        ] },
        { id: "g2", name: "素材库", items: [
            { id: "20260101120004-eeeeeeee", title: "影单 · 待看", icon: "1f343", addedAt: Date.now() },
            { id: "20260101120002-cccccccc", title: "菜谱 · 番茄牛腩", icon: "1f4da", addedAt: Date.now() },
            // 故意超长，用来看「只留前面几个字符 + 省略号」
            { id: "20260101120005-ffffffff", title: "关于如何写好一份技术方案的第一版草稿的一些零散想法", icon: "", addedAt: Date.now() },
        ] },
    ],
};

function hostStub() {
    class Plugin {
        constructor(options) {
            this.app = options.app;
            this.name = options.name;
            this.i18n = options.i18n || {};
            this.storage = {};
        }
        async loadData(name) { return this.storage[name]; }
        async saveData(name, obj) { this.storage[name] = JSON.parse(JSON.stringify(obj)); }
        addCommand() {}
        addTopBar() { return {}; }
        addTab() {}
    }
    return {
        Plugin,
        showMessage: () => {},
        openTab: () => ({}),
        getFrontend: () => "desktop",
        Setting: class { addItem() {} open() {} },
        fetchSyncPost: async (url, data) => {
            if (url === "/api/storage/getRecentDocs") {
                return { code: 0, data: DOCS };
            }
            if (url === "/api/query/sql") {
                if (data.stmt.indexOf("AS total") >= 0) {
                    return { code: 0, data: [{ total: 1284, today: 3 }] };
                }
                if (data.stmt.indexOf("SUM(length)") >= 0) {
                    return { code: 0, data: [{ n: 1860 }] };
                }
                if (data.stmt.indexOf("GROUP BY") >= 0) {
                    const now = new Date();
                    const p = now.getFullYear() + String(now.getMonth() + 1).padStart(2, "0");
                    return {
                        code: 0,
                        data: [
                            { d: p + "02", c: 3 },
                            { d: p + "05", c: 1 },
                            { d: p + "09", c: 5 },
                            { d: p + "14", c: 2 },
                            { d: p + "17", c: 4 },
                            { d: p + "21", c: 1 },
                            { d: p + "26", c: 6 },
                            { d: p + "28", c: 2 },
                        ],
                    };
                }
                return { code: 0, data: DAY_DOCS };
            }
            if (url === "/api/notebook/lsNotebooks") {
                return { code: 0, data: { notebooks: [] } };
            }
            return { code: -1 };
        },
    };
}

const SIYUAN_LIGHT = `
:root {
    --b3-theme-background: #ffffff;
    --b3-theme-surface: #ffffff;
    --b3-theme-surface-lighter: #f7f7f8;
    --b3-theme-on-background: #23262b;
    --b3-theme-on-surface: #6b7280;
    --b3-theme-primary: #3575f0;
    --b3-border-color: #e8e8ec;
    --b3-list-hover: #f2f3f5;
    --b3-theme-primary-lightest: rgba(53, 117, 240, .08);
}
`;

const SIYUAN_DARK = `
:root {
    --b3-theme-background: #1b1c1f;
    --b3-theme-surface: #232428;
    --b3-theme-surface-lighter: #2a2c31;
    --b3-theme-on-background: #e6e7e9;
    --b3-theme-on-surface: #a2a6ad;
    --b3-theme-primary: #5b8dff;
    --b3-border-color: #33363c;
    --b3-list-hover: #2c2e33;
}
`;

/* jsdom 没有布局引擎，所有元素的 getBoundingClientRect 都是 0，
   快速访问算列数时会一路退化到 1 列，静态预览就失去意义了。
   这里按「宽屏桌面」给一份可信的度量：网格内容宽 1260，卡片按 12 栅格换算。 */
const PREVIEW_GRID_CONTENT = 1260;
const QUICK_CONTENT_PADDING = 44;   // 与 index.js 同名常量保持一致

function installPreviewLayout(dom) {
    const box = (w, h) => ({
        left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON: () => ({}),
    });
    dom.window.Element.prototype.getBoundingClientRect = function () {
        if (this.classList && this.classList.contains("fh-grid")) {
            return box(PREVIEW_GRID_CONTENT, 900);
        }
        if (this.classList && this.classList.contains("fh-quick__items")) {
            return box(PREVIEW_GRID_CONTENT - QUICK_CONTENT_PADDING, 200);
        }
        if (this.classList && this.classList.contains("fh-card")) {
            const spanX = parseInt(this.getAttribute("data-span-x") || "4", 10);
            const gap = 18;
            const colW = (PREVIEW_GRID_CONTENT - gap * 11) / 12;
            return box(spanX * colW + (spanX - 1) * gap, 340);
        }
        return box(0, 0);
    };
}

function wrap(title, extraHead, themeMode, bodyHtml) {    const themeVars = themeMode === "dark" ? SIYUAN_DARK : SIYUAN_LIGHT;
    return `<!doctype html>
<html data-theme-mode="${themeMode}">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>html, body { margin: 0; height: 100%; overflow: hidden; }</style>
<style>${themeVars}</style>
<style>${css}</style>
${extraHead}
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

async function renderScenario(options) {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
    global.window = dom.window;
    global.document = dom.window.document;
    global.navigator = dom.window.navigator;
    installPreviewLayout(dom);
    const stub = hostStub();
    const moduleObj = { exports: {} };
    const requireStub = (key) => (key === "siyuan" ? stub : require(key));
    new Function("require", "module", "exports", "window", "document", src)(
        requireStub, moduleObj, {}, dom.window, dom.window.document
    );
    const Cls = moduleObj.exports.default || moduleObj.exports;

    const plugin = new Cls({ app: {}, name: "siyuan-plugins-foresthomepage", i18n: zhI18n });
    await plugin.onload();
    plugin.notes = NOTES.slice();
    plugin.quick = JSON.parse(JSON.stringify(QUICK));
    // 演示用称呼（插件默认留空，这里显式给一个占位名字）
    plugin.settings.userName = "小明";
    plugin.usage = { since: "20260918", days: {} };
    plugin.usage.days[String(new Date().getFullYear()) + String(new Date().getMonth() + 1).padStart(2, "0") + String(new Date().getDate()).padStart(2, "0")] = 2 * 3600 + 15 * 60;
    Object.assign(plugin.settings, options.settings || {});

    const host = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(host);
    plugin.mountView(host, { kind: "tab" });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const state = plugin.views.values().next().value;
    if (options.openDay) {
        await plugin.selectDay(state, options.openDay);
    }
    return host.innerHTML;
}

async function main() {
    const lightBody = await renderScenario({});
    fs.writeFileSync(path.join(OUT, "preview-light.html"),
        wrap("森林主页 · 浅色", "", "light", '<div class="fh-host">' + lightBody + "</div>"), "utf8");

    const darkBody = await renderScenario({});
    fs.writeFileSync(path.join(OUT, "preview-dark.html"),
        wrap("森林主页 · 深色", "", "dark", '<div class="fh-host">' + darkBody + "</div>"), "utf8");

    // 背景图场景使用本地生成的样例图（data URI，离线可用）
    const samplePath = path.join(OUT, "bg-sample.png");
    const bgDataUri = fs.existsSync(samplePath)
        ? "data:image/png;base64," + fs.readFileSync(samplePath).toString("base64")
        : "";
    const bgBody = await renderScenario({
        settings: {
            background: bgDataUri,
            backgroundBlur: 6,
            backgroundDim: 30,
        },
    });
    fs.writeFileSync(path.join(OUT, "preview-bg.html"),
        wrap("森林主页 · 背景图", "", "light", '<div class="fh-host">' + bgBody + "</div>"), "utf8");

    console.log("已生成 dev/preview-light.html / preview-dark.html / preview-bg.html");
    // jsdom 的定时器会让事件循环常驻，显式退出
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
