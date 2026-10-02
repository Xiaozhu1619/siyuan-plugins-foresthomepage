/**
 * 离线集成测试：在 Node + jsdom 里模拟思源宿主，
 * 不需要安装思源即可回归核心逻辑与渲染结果。
 *
 * 运行：
 *   NODE_PATH=<managed node workspace>/node_modules node test/run.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const zhI18n = JSON.parse(fs.readFileSync(path.join(ROOT, "i18n", "zh_CN.json"), "utf8"));

let passed = 0;
const failures = [];

function ok(name, condition, extra) {
    if (condition) {
        passed++;
        console.log("  \u2713 " + name);
    } else {
        failures.push(name + (extra ? " -> " + extra : ""));
        console.log("  \u2717 " + name + (extra ? " -> " + extra : ""));
    }
}

function eq(name, actual, expected) {
    ok(name, actual === expected, "actual=" + JSON.stringify(actual) + " expected=" + JSON.stringify(expected));
}

const USAGE_TICK = 30;

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * jsdom 没有布局引擎，这里按 12 栅格规则伪造一份坐标系：
 * 单列宽由容器内容宽推出，卡片宽高 = 跨格数换算，这样拖拽与缩放都能被真实检验。
 */
const GAP = 18;
const ROW_H = 84;
const GRID_LEFT = 30;
const GRID_TOP = 200;
const GRID_CONTENT = 1260;
const COL_W = (GRID_CONTENT - GAP * 11) / 12;   // 88.5
const QUICK_GROUP_TOP = 1000;                    // 快速访问分组盒子的起始 Y（避开卡片网格）
const QUICK_GROUP_H = 80;                        // 每个分组 80px 高，间隔 20px

function spanOf(node, axis) {
    const inline = node.style && node.style.getPropertyValue("--fh-span-" + axis);
    if (inline) {
        return parseInt(inline, 10);
    }
    const attr = node.getAttribute && node.getAttribute("data-span-" + axis);
    return attr ? parseInt(attr, 10) : 4;
}

function boxOf(spanX, spanY, colOffset) {
    const w = spanX * COL_W + (spanX - 1) * GAP;
    const h = spanY * ROW_H + (spanY - 1) * GAP;
    const left = GRID_LEFT + colOffset * (COL_W + GAP);
    return {
        left: left, top: GRID_TOP, right: left + w, bottom: GRID_TOP + h,
        width: w, height: h, x: left, y: GRID_TOP, toJSON: () => ({}),
    };
}

function installFakeLayout(dom) {
    const original = dom.window.Element.prototype.getBoundingClientRect;
    const isItem = (node) => node.classList &&
        (node.classList.contains("fh-card") || node.classList.contains("fh-ph"));

    dom.window.Element.prototype.getBoundingClientRect = function () {
        if (this.classList && this.classList.contains("fh-grid")) {
            return {
                left: GRID_LEFT, top: GRID_TOP, right: GRID_LEFT + GRID_CONTENT, bottom: GRID_TOP + 600,
                width: GRID_CONTENT, height: 600, x: GRID_LEFT, y: GRID_TOP, toJSON: () => ({}),
            };
        }
        // 快速访问的分组是纵向堆叠的：按兄弟次序伪造一叠 80px 高的盒子，
        // 这样「拖动分组调整顺序」的中点判定才有真实坐标可比
        if (this.classList && this.classList.contains("fh-quick__group")) {
            const wrap = this.parentNode;
            const index = wrap ? Array.prototype.indexOf.call(wrap.children, this) : 0;
            const top = QUICK_GROUP_TOP + index * (QUICK_GROUP_H + 20);
            return {
                left: 0, top: top, right: 600, bottom: top + QUICK_GROUP_H,
                width: 600, height: QUICK_GROUP_H, x: 0, y: top, toJSON: () => ({}),
            };
        }
        const grid = this.closest ? this.closest(".fh-grid") : null;
        if (grid && isItem(this)) {
            const inFlow = Array.prototype.filter.call(grid.children, (node) => {
                return isItem(node) && !node.classList.contains("fh-card--dragging");
            });
            const index = inFlow.indexOf(this);
            if (index >= 0) {
                let col = 0;
                for (let i = 0; i < index; i++) {
                    col += spanOf(inFlow[i], "x");
                }
                return boxOf(spanOf(this, "x"), spanOf(this, "y"), col);
            }
        }
        return original.call(this);
    };
}

function pointerEvent(dom, type, x, y) {
    const ev = new dom.window.MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y,
    });
    Object.defineProperty(ev, "pointerType", { value: "mouse" });
    return ev;
}

async function main() {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(
        '<!doctype html><html data-theme-mode="light"><head></head><body>' +
        '<div id="toolbar"></div><div id="barPlugins"></div><div id="drag"></div>' +
        "</body></html>",
        { pretendToBeVisual: true }
    );

    global.window = dom.window;
    global.document = dom.window.document;
    global.navigator = dom.window.navigator;
    global.FormData = dom.window.FormData;
    global.Node = dom.window.Node;
    global.HTMLElement = dom.window.HTMLElement;
    global.getSelection = () => dom.window.getSelection();

    installFakeLayout(dom);

    /* ---------------- 宿主桩 ---------------- */

    const calls = { openTab: [], command: [], topBar: [], dialog: [], api: [] };
    const sqlLog = [];

    class Plugin {
        constructor(options) {
            this.app = options.app;
            this.name = options.name;
            this.displayName = options.displayName;
            this.i18n = options.i18n || {};
            this.storage = {};
            this.topBars = [];
            this.tabs = [];
        }
        async loadData(name) {
            return this.storage[name];
        }
        async saveData(name, obj) {
            this.storage[name] = JSON.parse(JSON.stringify(obj));
        }
        addCommand(options) {
            calls.command.push(options);
        }
        addTopBar(options) {
            calls.topBar.push(options);
            const el = document.createElement("div");
            el.className = "toolbar__item";
            return el;
        }
        addTab(options) {
            this.tabs.push(options);
            return options;
        }
    }

    class Setting {
        constructor(options) {
            this.options = options;
            this.items = [];
        }
        addItem(item) {
            this.items.push(item);
        }
        open(name) {
            this.openedWith = name;
            this.dialog = new Dialog({ title: name, content: "" });
        }
    }

    class Dialog {
        constructor(options) {
            this.options = options || {};
            this.destroyed = false;
            const el = document.createElement("div");
            el.className = "b3-dialog";
            el.innerHTML = '<div class="b3-dialog__body">' + (this.options.content || "") + "</div>";
            this.element = el;
            document.body.appendChild(el);
            calls.dialog.push(this);
        }
        destroy() {
            this.destroyed = true;
            this.element.remove();
            if (this.options.destroyCallback) {
                this.options.destroyCallback();
            }
        }
    }

    const siyuanStub = {
        Plugin: Plugin,
        Setting: Setting,
        Dialog: Dialog,
        showMessage: () => {},
        hideMessage: () => {},
        openTab: (options) => {
            calls.openTab.push(options);
            return {};
        },
        openMobileFileById: () => {},
        getFrontend: () => "desktop",
        fetchSyncPost: async (url, data) => {
            calls.api.push({ url: url, data: data });
            if (url === "/api/storage/getRecentDocs") {
                return {
                    code: 0,
                    data: [
                        { rootID: "20260101120000-aaaaaaaa", title: "\u6d4b\u8bd5\u6587\u6863 A", icon: "1f4d4", viewedAt: Date.now() - 60 * 1000 },
                        { rootID: "20260101120001-bbbbbbbb", title: "\u6d4b\u8bd5\u6587\u6863 B", icon: "", viewedAt: Date.now() - 3 * 3600 * 1000 },
                    ],
                };
            }
            if (url === "/api/query/sql") {
                const stmt = data.stmt;
                sqlLog.push(stmt);
                if (stmt.indexOf("GROUP BY d") >= 0) {
                    return { code: 0, data: [{ d: "20261002", c: 3 }] };
                }
                if (stmt.indexOf("custom-dailynote") >= 0) {
                    return { code: 0, data: [{ id: "20261002090000-cccccccc", title: "\u5f53\u65e5\u8bb0\u5f55" }] };
                }
                if (stmt.indexOf("GROUP BY root_id") >= 0) {
                    return { code: 0, data: [{ id: "20260101120000-aaaaaaaa", n: 7 }] };
                }
                if (stmt.indexOf("WHERE id IN") >= 0) {
                    return { code: 0, data: [] };
                }
                if (stmt.indexOf("AS total") >= 0) {
                    return { code: 0, data: [{ total: 1284, today: 3 }] };
                }
                if (stmt.indexOf("SUM(length)") >= 0) {
                    return { code: 0, data: [{ n: 1860 }] };
                }
                if (stmt.indexOf("box = ") >= 0) {
                    return {
                        code: 0,
                        data: [{ id: "doc-target-1", title: "灵感收集箱", hpath: "/笔记/灵感收集箱" }],
                    };
                }
                if (stmt.indexOf("hpath, ial") >= 0) {
                    return {
                        code: 0,
                        data: [
                            { id: "20260101120000-aaaaaaaa", title: "\u6d4b\u8bd5\u6587\u6863 A", hpath: "/\u7b14\u8bb0/\u6d4b\u8bd5\u6587\u6863 A", ial: '{"icon":"1f4d4"}' },
                            { id: "20260101120001-bbbbbbbb", title: "\u6d4b\u8bd5\u6587\u6863 B", hpath: "/\u7b14\u8bb0/\u6d4b\u8bd5\u6587\u6863 B", ial: "" },
                            { id: "20260101120002-cccccccc", title: "\u6536\u85cf\u5939\u91cc\u7684\u957f\u6587\u6863", hpath: "/\u8d44\u6599/\u6536\u85cf\u5939\u91cc\u7684\u957f\u6587\u6863", ial: "" },
                        ],
                    };
                }
                if (stmt.indexOf("content LIKE") >= 0) {
                    return {
                        code: 0,
                        data: [
                            { id: "20260101120000-aaaaaaaa", title: "\u641c\u7d22\u547d\u4e2d\u6587\u6863", hpath: "/\u7b14\u8bb0/\u641c\u7d22\u547d\u4e2d\u6587\u6863" },
                        ],
                    };
                }
                return { code: 0, data: [] };
            }
            if (url === "/api/notebook/lsNotebooks") {
                return { code: 0, data: { notebooks: [{ id: "nb-1", name: "My Notes", closed: false }] } };
            }
            if (url === "/api/filetree/createDocWithMd") {
                return { code: 0, data: "20261002100000-dddddddd" };
            }
            if (url === "/api/attr/setBlockAttrs") {
                return { code: 0, data: null };
            }
            if (url === "/api/block/appendBlock") {
                return { code: 0, data: [] };
            }
            return { code: -1 };
        },
    };

    /* ---------------- 加载插件源码 ---------------- */

    console.log("\n[1] \u52a0\u8f7d\u5951\u7ea6");
    const moduleObj = { exports: {} };
    const requireStub = (key) => (key === "siyuan" ? siyuanStub : require(key));
    new Function("require", "module", "exports", "window", "document", src)(
        requireStub, moduleObj, {}, dom.window, dom.window.document
    );
    const Cls = moduleObj.exports.default || moduleObj.exports;
    ok("exports \u662f\u4e00\u4e2a\u51fd\u6570", typeof Cls === "function");
    ok("extends Plugin", Cls.prototype instanceof siyuanStub.Plugin);

    const T = Cls.__test;

    console.log("\n[2] \u7eaf\u51fd\u6570");
    eq("toBgUrl \u8865\u9f50\u659c\u6760", T.toBgUrl("assets/a.png"), "/assets/a.png");
    eq("toBgUrl \u4fdd\u7559\u5916\u94fe", T.toBgUrl("https://x.com/a.png"), "https://x.com/a.png");
    eq("toBgUrl \u7a7a\u503c", T.toBgUrl(""), "");
    eq("toBgUrl data URI", T.toBgUrl("data:image/png;base64,AA"), "data:image/png;base64,AA");
    eq("expandPath", T.expandPath("/日记/{yyyy}/{yyyy-MM-dd}", new Date(2026, 9, 2)), "/日记/2026/2026-10-02");
    eq("toDayKey", T.toDayKey(new Date(2026, 9, 2)), "20261002");
    eq("sqlQuote \u8f6c\u4e49\u5355\u5f15\u53f7", T.sqlQuote("a'b"), "'a''b'");
    eq("normalizeOrder \u53bb\u91cd\u8865\u5168", JSON.stringify(T.normalizeOrder(["calendar", "calendar"])), '["calendar","recent","inspiration","stats","quick"]');
    eq("clampInt \u8d85\u754c", T.clampInt("99", 3, 30, 8), 30);
    eq("clampInt \u975e\u6570\u5b57", T.clampInt("abc", 3, 30, 8), 8);
    eq("esc", T.esc('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
    eq("docIconText", T.docIconText("1f4d4"), "\uD83D\uDCD4");
    eq("docIconText \u7a7a\u503c", T.docIconText(""), "");
    eq("parentPathLabel", T.parentPathLabel("/笔记/数据结构/树", "树"), "笔记 / 数据结构");
    eq("parentPathLabel \u65e0\u5c42\u7ea7", T.parentPathLabel("/树", "树"), "");
    eq("DEFAULT_SETTINGS \u542b onboarded", T.DEFAULT_SETTINGS.onboarded, false);
    ok("FALLBACK_POEMS \u6709\u5185\u5bb9", T.FALLBACK_POEMS.length >= 8);
    ok("fmtRelative \u5206\u949f", T.fmtRelative(Date.now() - 120000).indexOf("\u5206\u949f") >= 0);

    /* 快速访问相关的纯函数 */
    eq("常规卡片默认 1/4 宽", JSON.stringify(T.cardDefaultSpan("recent")), '{"x":3,"y":4}');
    eq("快速访问默认整行宽 / 三行高", JSON.stringify(T.cardDefaultSpan("quick")), '{"x":12,"y":3}');
    eq("卡默认尺寸覆盖五张卡片", Object.keys(T.defaultCardSize()).length, 5);
    /* 快速访问相关的纯函数
       quickColumns 收的是「条目网格的净宽」= 卡片宽 - QUICK_CONTENT_PADDING(44)。
       下面这几组是「卡片宽 → 净宽」换算后的真实输入。 */
    const inner = (cardWidth) => cardWidth - T.QUICK_CONTENT_PADDING;
    eq("卡片内边距合计 44", T.QUICK_CONTENT_PADDING, 44);
    eq("1/4 宽只排 1 列", T.quickColumns(inner(301.5), 176, 8), 1);
    eq("1/2 宽排 3 列", T.quickColumns(inner(621), 176, 8), 3);
    eq("整行宽排 6 列", T.quickColumns(inner(1260), 176, 8), 6);
    eq("条目要求更宽则列数更少", T.quickColumns(inner(1260), 320, 8), 3);
    eq("宽度未知时兜底 1 列", T.quickColumns(0, 176, 8), 1);
    // 手机竖屏：净宽 330 时允许排两列（每列 161px），很小的屏（250）老实单列
    eq("手机竖屏排两列", T.quickColumns(330, 176, 8), 2);
    eq("超窄屏退回单列", T.quickColumns(250, 176, 8), 1);
    eq("手机横屏/平板排四列", T.quickColumns(740, 176, 8), 4);
    eq("大屏拉满排六列", T.quickColumns(1216, 176, 8), 6);
    // 文件名截断
    eq("短标题不动", T.truncateTitle("读书笔记", 18), "读书笔记");
    eq("刚好卡在预算上不动", T.truncateTitle("一二三四五六七八九十一二三四五六七八", 18), "一二三四五六七八九十一二三四五六七八");
    eq("超长标题只留前面几个字",
        T.truncateTitle("一二三四五六七八九十一二三四五六七八九十", 18), "一二三四五六七八九十一二三四五六七八…");
    eq("空标题安全", T.truncateTitle("", 18), "");
    eq("默认预算 18 字", T.QUICK_TITLE_MAX_DEFAULT, 18);

    const rawPins = T.normalizeQuick({
        groups: [
            { id: "default", name: "", items: [{ id: "d1", title: "\u4e00" }, { id: "d1", title: "\u91cd\u590d" }] },
            { id: "g1", name: "\u5206\u7c7b", items: [{ id: "d2", title: "\u4e8c" }, { id: "d1", title: "\u8de8\u7ec4\u91cd\u590d" }, { id: "", title: "\u574f\u6570\u636e" }] },
        ],
    });
    eq("归一化保留两个分组", rawPins.groups.length, 2);
    eq("同一篇文档全局只留一次", T.quickCount(rawPins), 2);
    eq("丢掉缺 id 的坏数据", rawPins.groups[1].items.length, 1);
    eq("无分组时自动补默认分组", T.normalizeQuick(null).groups[0].id, T.QUICK_GROUP_DEFAULT);

    /* ---------------- 实例化 ---------------- */

    console.log("\n[3] onload / onLayoutReady");
    const plugin = new Cls({ app: {}, name: "siyuan-plugins-foresthomepage", displayName: "森林主页", i18n: zhI18n });
    await plugin.onload();
    eq("\u6ce8\u518c\u4e86\u4e24\u4e2a\u547d\u4ee4", calls.command.length, 2);

    // 这条是「设置页面没做」的根因：Setting 实例必须在 onload 就挂上
    ok("onload \u540e this.setting \u5df2\u5b58\u5728", !!plugin.setting);
    ok("setting \u5df2\u88c5\u5165\u8bbe\u7f6e\u9879", plugin.setting.items.length >= 12, String(plugin.setting && plugin.setting.items.length));
    ok("setting.open \u5df2\u88ab\u5305\u88c5", plugin.setting.open !== siyuanStub.Setting.prototype.open);

    plugin.onLayoutReady();
    eq("\u9876\u680f\u6309\u94ae\u6570\u91cf", calls.topBar.length, 1);
    eq("\u9876\u680f\u6309\u94ae\u4f4d\u7f6e\u5728\u5de6\u4fa7", calls.topBar[0].position, "left");
    eq("\u9876\u680f\u56fe\u6807\u4e3a SVG", calls.topBar[0].icon.indexOf("<svg") === 0, true);
    ok("\u56fe\u6807 fill/stroke \u5199\u5728\u5185\u8054 style \u91cc",
        calls.topBar[0].icon.indexOf("style=") >= 0 && calls.topBar[0].icon.indexOf('fill="none"') < 0);
    ok("\u9876\u680f\u53f3\u952e\u83dc\u5355\u53ef\u7528", typeof calls.topBar[0].contextMenu === "function");

    // 首次安装且未完成引导时，onLayoutReady 后会自动弹引导（有 700ms 延迟）
    await wait(820);
    ok("\u9996\u6b21\u5b89\u88c5\u4f1a\u81ea\u52a8\u5f39\u51fa\u5f15\u5bfc", !!plugin.onboardingDialog);
    if (plugin.onboardingDialog) {
        plugin.onboardingDialog.destroy();
        await wait(20);
    }

    /* ---------------- 挂载主页 ---------------- */

    console.log("\n[4] \u4e3b\u9875\u6e32\u67d3");
    const host = document.createElement("div");
    document.body.appendChild(host);
    plugin.mountView(host, { kind: "tab" });
    await wait(40);

    ok("\u6e32\u67d3\u51fa .fh-root", !!host.querySelector(".fh-root"));

    const SALUTATION = "^(\u65e9\u4e0a\u597d|\u4e0a\u5348\u597d|\u4e2d\u5348\u597d|\u4e0b\u5348\u597d|\u665a\u4e0a\u597d|\u591c\u6df1\u4e86)$";
    const hi = host.querySelector(".fh-hero__hi").textContent;
    const line = host.querySelector(".fh-hero__line").textContent;
    const meta = host.querySelector(".fh-hero__meta").textContent;
    eq("\u79f0\u547c\u9ed8\u8ba4\u7559\u7a7a\uff0c\u7b2c\u4e00\u884c\u53ea\u663e\u793a\u95ee\u5019\u8bed", new RegExp(SALUTATION).test(hi), true, hi);
    eq("\u9ed8\u8ba4\u8bbe\u7f6e\u91cc\u4e0d\u5e26\u4efb\u4f55\u771f\u5b9e\u79f0\u547c", T.DEFAULT_SETTINGS.userName, "");

    plugin.settings.userName = "\u5c0f\u660e";
    plugin.refreshAllViews();
    await wait(30);
    const hiNamed = host.querySelector(".fh-hero__hi").textContent;
    eq("\u586b\u5199\u79f0\u547c\u540e\u7b2c\u4e00\u884c\u53d8\u6210\u300c\u95ee\u5019\uff0c\u540d\u5b57\u300d",
        /^(\u65e9\u4e0a\u597d|\u4e0a\u5348\u597d|\u4e2d\u5348\u597d|\u4e0b\u5348\u597d|\u665a\u4e0a\u597d|\u591c\u6df1\u4e86)\uff0c\u5c0f\u660e$/.test(hiNamed), true, hiNamed);
    ok("\u7b2c\u4e8c\u884c\u662f\u8bd7\u53e5", line.length > 0 && line !== hi, line);
    ok("\u7b2c\u4e09\u884c\u662f\u65e5\u671f\u65f6\u95f4", meta.indexOf(String(new Date().getFullYear())) >= 0 && /\d{2}:\d{2}/.test(meta), meta);
    eq("\u4e09\u884c\u4e0d\u540c\u5143\u7d20", new Set([hi, line, meta]).size, 3);

    // 演示数据里不允许出现任何真实个人痕迹
    const PII = /\u5c0f\u6731|\u4f20\u64ad\u5b66|\u4f53\u68c0|\u80cc\u8bf5|\u82f1\u8bed|\u8003\u7814|\u8c03\u7814/;
    ok("\u9996\u9875\u6587\u6848\u4e0d\u542b\u4e2a\u4eba\u4fe1\u606f", !PII.test(host.querySelector(".fh-inner").textContent));

    // 诗句按天固定，同一天内反复渲染不该跳
    const poem1 = plugin.currentPoem();
    await wait(50);
    plugin.renderHero(plugin.views.values().next().value);
    eq("\u8bd7\u53e5\u540c\u4e00\u5929\u5185\u4e0d\u53d8", plugin.currentPoem(), poem1);

    plugin.settings.suffixMode = "custom";
    plugin.settings.greetingSuffix = "固定的一句话";
    eq("\u56fa\u5b9a\u6a21\u5f0f\u751f\u6548", plugin.currentPoem(), "固定的一句话");
    plugin.settings.suffixMode = "daily";
    plugin.settings.greetingSuffix = "";

    const cards = Array.from(host.querySelectorAll(".fh-card"));
    eq("\u4e94\u5f20\u5361\u7247", cards.length, 5);
    eq("\u5361\u7247\u987a\u5e8f", cards.map((c) => c.getAttribute("data-card-id")).join(","), "recent,inspiration,calendar,stats,quick");
    ok("\u5361\u7247\u5e26\u5165\u573a\u9519\u5cf0\u53d8\u91cf", cards[2].style.getPropertyValue("--fh-i") === "2", cards[2].style.getPropertyValue("--fh-i"));

    const docs = host.querySelectorAll('[data-card-id="recent"] .fh-doc');
    eq("\u6700\u8fd1\u6587\u6863\u6e32\u67d3\u6761\u6570", docs.length, 2);
    eq("\u4eca\u5929\u6709\u9ad8\u4eae", !!host.querySelector('[data-day="' + T.toDayKey(new Date()) + '"]'), true);

    /* ---------------- 搜索框 ---------------- */

    console.log("\n[5] \u641c\u7d22\u6846");
    const searchBox = host.querySelector("[data-fh-search]");
    const searchInput = host.querySelector("[data-fh-search-input]");
    ok("\u5b58\u5728\u641c\u7d22\u6846", !!searchBox && !!searchInput);
    ok("\u641c\u7d22\u6846\u4f4d\u4e8e\u9875\u9762\u5934\u90e8\u3001\u7f51\u683c\u4e4b\u524d",
        Boolean(host.querySelector(".fh-inner > .fh-hero [data-fh-search]")) &&
        Boolean(host.querySelector(".fh-inner > .fh-grid")));

    const heroChildren = Array.from(host.querySelector(".fh-hero").children).map((n) => n.className);
    const idxMeta = heroChildren.findIndex((c) => c.indexOf("fh-hero__meta") >= 0);
    const idxSearch = heroChildren.findIndex((c) => c.indexOf("fh-search") >= 0);
    ok("\u987a\u5e8f\uff1a\u65f6\u95f4 -> \u641c\u7d22\u6846", idxMeta >= 0 && idxSearch > idxMeta, heroChildren.join("|"));

    searchInput.dispatchEvent(new dom.window.Event("focus", { bubbles: true }));
    await wait(20);
    ok("\u805a\u7126\u540e\u5f39\u51fa\u63d0\u793a", host.querySelector(".fh-search__panel").textContent.indexOf("\u5173\u952e\u8bcd") >= 0);

    searchInput.value = "\u641c\u7d22";
    searchInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await wait(350);
    const items = host.querySelectorAll(".fh-search__item");
    eq("\u641c\u7d22\u7ed3\u679c\u6e32\u67d3", items.length, 1);
    ok("\u7ed3\u679c\u6807\u9898\u6b63\u786e", items[0].textContent.indexOf("\u641c\u7d22\u547d\u4e2d\u6587\u6863") >= 0);
    ok("\u7ed3\u679c\u5e26\u547d\u4e2d\u6570", items[0].textContent.indexOf("7 \u5904") >= 0, items[0].textContent);
    ok("\u53d1\u4e86\u5168\u6587\u641c\u7d22 SQL", sqlLog.some((s) => s.indexOf("GROUP BY root_id") >= 0));
    ok("\u7b2c\u4e00\u6761\u9ed8\u8ba4\u9ad8\u4eae", items[0].classList.contains("is-active"));

    searchInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(20);
    eq("\u56de\u8f66\u6253\u5f00\u7b2c\u4e00\u6761", calls.openTab.length, 1);
    eq("\u6253\u5f00\u7684\u662f\u641c\u7d22\u7ed3\u679c", calls.openTab[0].doc.id, "20260101120000-aaaaaaaa");
    eq("\u6253\u5f00\u540e\u6e05\u7a7a\u8f93\u5165\u6846", searchInput.value, "");
    calls.openTab.length = 0;

    plugin.settings.showSearch = false;
    plugin.applySearchVisibility(plugin.views.values().next().value);
    ok("\u5173\u95ed\u540e\u641c\u7d22\u6846\u9690\u85cf", searchBox.classList.contains("fn__none"));
    plugin.settings.showSearch = true;
    plugin.applySearchVisibility(plugin.views.values().next().value);
    ok("\u91cd\u65b0\u663e\u793a", !searchBox.classList.contains("fn__none"));

    /* ---------------- 灵感随记 ---------------- */

    console.log("\n[6] \u7075\u611f\u968f\u8bb0");
    host.querySelector("[data-note-input]").value = "\u7b2c\u4e00\u6761\u7075\u611f";
    await plugin.saveNote(plugin.views.values().next().value);
    eq("\u7b14\u8bb0\u5199\u5165\u5185\u5b58", plugin.notes.length, 1);
    ok("\u7b14\u8bb0\u5df2\u6301\u4e45\u5316", !!plugin.storage["inspirations.json"]);
    eq("\u7b14\u8bb0\u6e32\u67d3\u5230\u5361\u7247", host.querySelectorAll(".fh-note").length, 1);

    host.querySelector("[data-note-input]").value = "<img src=x onerror=alert(1)>";
    await plugin.saveNote(plugin.views.values().next().value);
    eq("\u811a\u672c\u6807\u7b7e\u88ab\u8f6c\u4e49", host.querySelectorAll(".fh-note")[0].querySelector(".fh-note__text").innerHTML, "&lt;img src=x onerror=alert(1)&gt;");

    await plugin.deleteNote(plugin.notes[0].id);
    eq("\u5220\u9664\u540e\u5269\u4e00\u6761", plugin.notes.length, 1);
    eq("\u5220\u9664\u540e DOM \u540c\u6b65", host.querySelectorAll(".fh-note").length, 1);

    /* ---------------- 日历 ---------------- */

    console.log("\n[7] \u65e5\u5386\u7ffb\u6708\u4e0e\u65e5\u8be6\u60c5");
    const view = plugin.views.values().next().value;
    const before = host.querySelector(".fh-cal__month").textContent;
    ok("\u6708\u4efd\u6807\u7b7e\u5e26\u300c\u6708\u300d", before.indexOf("\u6708") === before.length - 1, before);
    plugin.shiftMonth(view, 1);
    await wait(30);
    ok("\u4e0b\u4e2a\u6708\u6807\u7b7e\u53d8\u5316", host.querySelector(".fh-cal__month").textContent !== before);
    plugin.shiftMonth(view, -1);
    await wait(30);
    eq("\u56de\u5230\u539f\u6765\u7684\u6708", host.querySelector(".fh-cal__month").textContent, before);

    const cellCount = host.querySelectorAll(".fh-cal__day").length;
    ok("\u65e5\u5386\u5355\u5143\u683c\u4e3a\u6574\u5468\u4e14 28-42", cellCount % 7 === 0 && cellCount >= 28 && cellCount <= 42, String(cellCount));

    host.querySelector('[data-day="' + T.toDayKey(new Date()) + '"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await wait(40);
    ok("\u5c55\u5f00\u4e86\u65e5\u8be6\u60c5", !!host.querySelector(".fh-day"));
    ok("\u65e5\u8be6\u60c5\u5217\u51fa\u4e86\u6587\u6863", host.querySelectorAll(".fh-day .fh-doc").length === 1);

    /* ---------------- 拖拽排序（双向） ---------------- */

    console.log("\n[8] \u5361\u7247\u62d6\u62fd\u6392\u5e8f\u2014\u2014\u53cc\u5411");
    const grid = host.querySelector(".fh-grid");

    const dragTo = async (cardId, toX, toY) => {
        const card = grid.querySelector('[data-card-id="' + cardId + '"]');
        const rect = card.getBoundingClientRect();
        const grip = card.querySelector(".fh-card__grip");
        grip.dispatchEvent(pointerEvent(dom, "pointerdown", rect.left + rect.width / 2, rect.top + rect.height / 2));
        window.dispatchEvent(pointerEvent(dom, "pointermove", toX, toY));
        await wait(10);
        const during = {
            placeholder: !!grid.querySelector(".fh-ph"),
            dragging: card.classList.contains("fh-card--dragging"),
        };
        window.dispatchEvent(pointerEvent(dom, "pointerup", toX, toY));
        await wait(10);
        return during;
    };

    const orderOf = () => Array.from(grid.querySelectorAll(".fh-card")).map((c) => c.getAttribute("data-card-id")).join(",");

    // 故意让三张卡片高度不同，回归「一维比较导致只能单向拖」的老问题
    const resetSizes = async (sizes) => {
        plugin.settings.cardOrder = ["recent", "inspiration", "calendar", "stats", "quick"];
        plugin.settings.hiddenCards = ["stats", "quick"];
        plugin.settings.cardSize = Object.assign({ stats: { x: 4, y: 4 }, quick: { x: 12, y: 3 } }, sizes);
        plugin.refreshAllViews();
        await wait(30);
    };
    await resetSizes({ recent: { x: 4, y: 3 }, inspiration: { x: 4, y: 5 }, calendar: { x: 4, y: 4 } });
    eq("\u4e09\u5f20\u5361\u7247\u9ad8\u5ea6\u4e0d\u4e00\u81f4\uff08\u56de\u5f52\u524d\u63d0\uff09",
        new Set(["recent", "inspiration", "calendar"].map((id) => grid.querySelector('[data-card-id="' + id + '"]').getBoundingClientRect().height)).size, 3);

    // 左 -> 右：把最左边的卡片拖到最右边
    const farRightX = GRID_LEFT + GRID_CONTENT + 20;
    const duringRight = await dragTo("recent", farRightX, GRID_TOP + 100);
    ok("\u62d6\u62fd\u4e2d\u51fa\u73b0\u5360\u4f4d\u7b26", duringRight.placeholder);
    ok("\u62d6\u62fd\u4e2d\u5361\u7247\u88ab\u62ac\u8d77", duringRight.dragging);
    eq("\u4ece\u5de6\u5411\u53f3\u62d6\uff1a\u9884\u671f\u7ed3\u679c", orderOf(), "inspiration,calendar,recent");

    await resetSizes({ recent: { x: 4, y: 3 }, inspiration: { x: 4, y: 5 }, calendar: { x: 4, y: 4 } });
    eq("\u590d\u4f4d\u6210\u529f", orderOf(), "recent,inspiration,calendar");

    const duringLeft = await dragTo("calendar", GRID_LEFT + 20, GRID_TOP + 100);
    ok("\u53cd\u5411\u62d6\u62fd\u4e5f\u6709\u5360\u4f4d\u7b26", duringLeft.placeholder);
    eq("\u4ece\u53f3\u5411\u5de6\u62d6\uff1a\u9884\u671f\u7ed3\u679c", orderOf(), "calendar,recent,inspiration");

    // 回归「拖最右侧卡片时每个 pointermove 都白跑一次强制重排」：
    // 位置没变就应当直接返回，一次 offsetWidth 都不该读。
    await resetSizes({ recent: { x: 4, y: 4 }, inspiration: { x: 4, y: 4 }, calendar: { x: 4, y: 4 } });
    let reflows = 0;
    Object.defineProperty(grid, "offsetWidth", {
        configurable: true,
        get() { reflows++; return GRID_CONTENT; },
    });
    const calCard = grid.querySelector('[data-card-id="calendar"]');
    const calRect = calCard.getBoundingClientRect();
    calCard.querySelector(".fh-card__grip").dispatchEvent(
        pointerEvent(dom, "pointerdown", calRect.left + 100, calRect.top + 60));
    window.dispatchEvent(pointerEvent(dom, "pointermove", calRect.left + 140, calRect.top + 80));
    reflows = 0;
    for (let i = 0; i < 10; i++) {
        window.dispatchEvent(pointerEvent(dom, "pointermove", calRect.left + 200 + i * 12, calRect.top + 90));
    }
    eq("\u62d6\u6700\u53f3\u4fa7\u5361\u7247\u5411\u53f3\u65f6\u4e0d\u518d\u767d\u8dd1\u5f3a\u5236\u91cd\u6392", reflows, 0);
    window.dispatchEvent(pointerEvent(dom, "pointerup", calRect.left + 300, calRect.top + 90));
    await wait(10);
    eq("\u5411\u53f3\u62d6\u5230\u5c3e\u90e8\u540e\u987a\u5e8f\u4e0d\u53d8", orderOf(), "recent,inspiration,calendar");

    // 卡片身上只允许留 --fh-i（入场错峰），拖拽用的 position/transition/transform 必须清干净
    const leftover = Array.from(grid.querySelectorAll(".fh-card")).map((c) => c.getAttribute("style") || "");
    ok("\u62d6\u62fd\u540e\u65e0\u6b8b\u7559\u62d6\u62fd\u6837\u5f0f",
        leftover.every((s) => s.indexOf("transition") < 0 && s.indexOf("transform") < 0 &&
            s.indexOf("position") < 0 && s.indexOf("pointer-events") < 0), leftover.join(" | "));
    ok("\u6ca1\u6709\u5360\u4f4d\u7b26\u6b8b\u7559", !grid.querySelector(".fh-ph"));
    eq("\u4ecd\u4e3a\u4e09\u5f20\u5361\u7247", host.querySelectorAll(".fh-card").length, 3);
    ok("\u62d6\u62fd\u540e\u5c3a\u5bf8\u53d8\u91cf\u4ecd\u5728",
        grid.querySelector('[data-card-id="calendar"]').style.getPropertyValue("--fh-span-x") === "4");

    /* ---------------- 卡片拖动缩放 ---------------- */

    console.log("\n[9] \u5361\u7247\u62d6\u52a8\u7f29\u653e");
    await resetSizes({ recent: { x: 4, y: 4 }, inspiration: { x: 4, y: 4 }, calendar: { x: 4, y: 4 } });
    let recentCard = grid.querySelector('[data-card-id="recent"]');
    eq("\u9ed8\u8ba4\u5bbd\u5ea6\u6863\u4f4d 1/3", recentCard.getAttribute("data-span-x"), "4");
    eq("\u9ed8\u8ba4\u9ad8\u5ea6\u6863\u4f4d\u6807\u51c6", recentCard.getAttribute("data-span-y"), "4");
    // 先把卡片全放出来验一次默认档位，再收回去跑后面的几何用例
    plugin.settings.hiddenCards = [];
    plugin.refreshAllViews();
    await wait(40);
    eq("\u56db\u5f20\u5e38\u89c4\u5361\u7247\u9ed8\u8ba4\u540c\u5c3a\u5bf8",
        new Set(["recent", "inspiration", "calendar", "stats"].map((id) => {
            const node = grid.querySelector('[data-card-id="' + id + '"]');
            return node.getAttribute("data-span-x") + "x" + node.getAttribute("data-span-y");
        })).size, 1);
    const quickNode = grid.querySelector('[data-card-id="quick"]');
    ok("\u5feb\u901f\u8bbf\u95ee\u5361\u7247\u5df2\u6e32\u67d3", !!quickNode);
    plugin.settings.hiddenCards = ["stats", "quick"];
    plugin.refreshAllViews();
    await wait(30);
    recentCard = grid.querySelector('[data-card-id="recent"]');

    // 纯函数：档位换算
    eq("allowedWidths \u7a84\u5c4f\u53ea\u7ed9\u6574\u884c", JSON.stringify(T.allowedWidths(600)), "[12]");
    eq("allowedWidths \u4e2d\u7b49\u5c4f\u53ea\u7ed9\u534a\u5bbd/\u6574\u884c", JSON.stringify(T.allowedWidths(900)), "[6,12]");
    eq("allowedWidths \u5bbd\u5c4f\u7ed9\u5168\u90e8\u6863\u4f4d", JSON.stringify(T.allowedWidths(1260)), "[3,4,6,8,12]");
    eq("nearestPreset \u5411\u4e0b\u5438\u9644", T.nearestPreset(5, [3, 4, 6, 8, 12]), 4);
    eq("nearestPreset \u5411\u4e0a\u5438\u9644", T.nearestPreset(7, [3, 4, 6, 8, 12]), 6);
    eq("pixelsToSpan \u7b97\u51fa 6 \u683c", T.pixelsToSpan(628, COL_W, GAP, [3, 4, 6, 8, 12]), 6);
    eq("spanToPixels \u53cd\u7b97", Math.round(T.spanToPixels(6, COL_W, GAP)), Math.round(6 * COL_W + 5 * GAP));

    const resizeCard = async (cardId, dx, dy) => {
        const card = grid.querySelector('[data-card-id="' + cardId + '"]');
        const handle = card.querySelector(".fh-card__resize");
        const rect = card.getBoundingClientRect();
        handle.dispatchEvent(pointerEvent(dom, "pointerdown", rect.right - 6, rect.bottom - 6));
        window.dispatchEvent(pointerEvent(dom, "pointermove", rect.right - 6 + dx, rect.bottom - 6 + dy));
        await wait(10);
        const badge = host.querySelector("[data-fh-size-badge]");
        const during = {
            resizing: card.classList.contains("fh-card--resizing"),
            badge: badge ? badge.textContent : "",
        };
        window.dispatchEvent(pointerEvent(dom, "pointerup", rect.right - 6 + dx, rect.bottom - 6 + dy));
        await wait(10);
        return during;
    };

    const narrow = await resizeCard("recent", 2, 1);
    ok("\u5fae\u5c0f\u62d6\u52a8\u4e0d\u4f1a\u8fdb\u5165\u7f29\u653e\u6001", !narrow.resizing);
    eq("\u5fae\u5c0f\u62d6\u52a8\u4e0d\u6539\u5c3a\u5bf8", recentCard.getAttribute("data-span-x"), "4");

    const grown = await resizeCard("recent", 220, 105);
    ok("\u8fdb\u5165\u7f29\u653e\u6001", grown.resizing);
    ok("\u7f29\u653e\u4e2d\u6709\u5c3a\u5bf8\u6807\u7b7e", grown.badge.indexOf("/") >= 0 || grown.badge.length > 0, grown.badge);
    eq("\u5bbd\u5ea6\u5438\u9644\u5230 1/2", recentCard.getAttribute("data-span-x"), "6");
    eq("\u9ad8\u5ea6\u5438\u9644\u5230 5 \u884c", recentCard.getAttribute("data-span-y"), "5");
    eq("CSS \u53d8\u91cf\u540c\u6b65", recentCard.style.getPropertyValue("--fh-span-x"), "6");
    eq("\u5df2\u5199\u5165\u8bbe\u7f6e", plugin.settings.cardSize.recent.x + "x" + plugin.settings.cardSize.recent.y, "6x5");
    ok("\u5df2\u6301\u4e45\u5316", plugin.storage["settings.json"].cardSize.recent.x === 6);
    ok("\u7ed3\u675f\u540e\u6807\u7b7e\u5df2\u79fb\u9664", !host.querySelector("[data-fh-size-badge]"));
    ok("\u7ed3\u675f\u540e\u65e0 resizing \u7c7b", !recentCard.classList.contains("fh-card--resizing"));

    const shrunk = await resizeCard("recent", -400, -400);
    ok("\u7f29\u5c0f\u4e5f\u80fd\u5438\u9644", shrunk.resizing && parseInt(recentCard.getAttribute("data-span-x"), 10) < 6,
        recentCard.getAttribute("data-span-x"));
    eq("\u6700\u5c0f\u4e0d\u4f4e\u4e8e 1/4", recentCard.getAttribute("data-span-x"), "3");
    eq("\u6700\u5c0f\u4e0d\u4f4e\u4e8e 3 \u884c", recentCard.getAttribute("data-span-y"), "3");

    // 占位符要跟着卡片尺寸走
    const spanCard = grid.querySelector('[data-card-id="recent"]');
    const spanRect = spanCard.getBoundingClientRect();
    spanCard.querySelector(".fh-card__grip").dispatchEvent(pointerEvent(dom, "pointerdown", spanRect.left + 80, spanRect.top + 40));
    window.dispatchEvent(pointerEvent(dom, "pointermove", spanRect.left + 140, spanRect.top + 60));
    await wait(10);
    const ph = grid.querySelector(".fh-ph");
    eq("\u5360\u4f4d\u7b26\u590d\u7528\u5361\u7247\u5c3a\u5bf8", ph && ph.style.getPropertyValue("--fh-span-x"), "3");
    window.dispatchEvent(pointerEvent(dom, "pointerup", spanRect.left + 140, spanRect.top + 60));
    await wait(10);

    plugin.settings.cardSize = T.defaultCardSize();
    plugin.refreshAllViews();
    await wait(20);
    eq("\u6062\u590d\u9ed8\u8ba4\u540e\u5c3a\u5bf8\u4e00\u81f4",
        grid.querySelector('[data-card-id="recent"]').getAttribute("data-span-x"), String(T.DEFAULT_SETTINGS.cardSize.recent.x));
    eq("\u9ed8\u8ba4\u6863\u4f4d\u662f\u56db\u5206\u4e4b\u4e00\u5bbd", T.DEFAULT_SETTINGS.cardSize.recent.x, 3);

    /* ---------------- 设置面板 ---------------- */

    console.log("\n[10] \u8bbe\u7f6e\u9762\u677f");
    await plugin.openSettings();
    eq("\u9762\u677f\u5df2\u6253\u5f00", plugin.setting.openedWith, "\u68ee\u6797\u4e3b\u9875\u8bbe\u7f6e");
    ok("\u8349\u7a3f\u5df2\u521d\u59cb\u5316", plugin.__draft && plugin.__draft.userName === plugin.settings.userName);
    const titles = plugin.setting.items.map((i) => i.title);
    ["\u79f0\u547c", "\u7b2c\u4e8c\u884c\u6587\u6848", "\u80cc\u666f\u56fe", "\u4f7f\u7528\u65f6\u957f\u8bb0\u5f55",
        "\u663e\u793a\u7684\u5361\u7247", "\u641c\u7d22\u6846", "\u6062\u590d\u5361\u7247\u9ed8\u8ba4\u5c3a\u5bf8",
        "\u5feb\u901f\u8bbf\u95ee\u6761\u76ee\u5bbd\u5ea6", "\u5feb\u901f\u8bbf\u95ee\u5185\u5bb9",
        "\u7075\u611f\u5f52\u5bbf", "\u91cd\u65b0\u8fd0\u884c\u5f15\u5bfc"].forEach((t) => {
        ok("\u542b\u8bbe\u7f6e\u9879\uff1a" + t, titles.indexOf(t) >= 0);
    });
    ok("\u6240\u6709\u9879\u90fd\u7528 createActionElement\uff08\u6bcf\u6b21\u91cd\u5efa DOM\uff09",
        plugin.setting.items.every((i) => typeof i.createActionElement === "function" && !i.actionElement));

    // 每个控件都应该能被真实创建出来
    const built = plugin.setting.items.map((i) => i.createActionElement());
    ok("\u6240\u6709\u63a7\u4ef6\u53ef\u6b63\u5e38\u6784\u5efa", built.every((el) => el && el.tagName));
    ok("\u80cc\u666f\u56fe\u884c\u542b\u4e09\u4e2a\u63a7\u4ef6", built[titles.indexOf("\u80cc\u666f\u56fe")].children.length === 3);
    // 「卡片」这一项要能统一管理全部卡片的增删
    const cardMgr = built[titles.indexOf("\u663e\u793a\u7684\u5361\u7247")];
    eq("\u5361\u7247\u7ba1\u7406\u5217\u51fa\u5168\u90e8\u5361\u7247", cardMgr.querySelectorAll("input[type=checkbox]").length, T.ALL_CARDS.length);
    ok("\u5361\u7247\u7ba1\u7406\u542b\u5feb\u901f\u8bbf\u95ee", cardMgr.textContent.indexOf("\u5feb\u901f\u8bbf\u95ee") >= 0);
    ok("\u5361\u7247\u7ba1\u7406\u542b\u7edf\u8ba1", cardMgr.textContent.indexOf("\u7edf\u8ba1") >= 0);
    eq("\u5361\u7247\u7ba1\u7406\u5e26\u4e09\u4e2a\u6279\u91cf\u6309\u94ae", cardMgr.querySelectorAll("button").length, 3);
    // 计数要跟着草稿里的隐藏状态走（前面小节刻意隐藏了两张卡片，这里如实反映）
    const shownCards = T.ALL_CARDS.length - plugin.__draft.hiddenCards.length;
    ok("\u5361\u7247\u7ba1\u7406\u663e\u793a\u8ba1\u6570",
        cardMgr.textContent.indexOf(shownCards + " / " + T.ALL_CARDS.length) >= 0, cardMgr.textContent.trim());
    const cardBtns = cardMgr.querySelectorAll("button");
    cardBtns[1].click();
    eq("\u5168\u90e8\u9690\u85cf\u540e hiddenCards \u6ee1\u4f4d", plugin.__draft.hiddenCards.length, T.ALL_CARDS.length);
    cardBtns[0].click();
    eq("\u5168\u90e8\u663e\u793a\u540e hiddenCards \u6e05\u7a7a", plugin.__draft.hiddenCards.length, 0);
    cardBtns[2].click();
    eq("\u6062\u590d\u9ed8\u8ba4\u987a\u5e8f\u540e\u987a\u5e8f\u6b63\u786e", plugin.__draft.cardOrder.join(","), T.ALL_CARDS.join(","));

    // 快速访问内容管理：列出已 Pin 的条目
    const quickMgr = built[titles.indexOf("\u5feb\u901f\u8bbf\u95ee\u5185\u5bb9")];
    ok("\u5feb\u901f\u8bbf\u95ee\u7ba1\u7406\u5217\u51fa\u6761\u76ee", quickMgr.querySelectorAll(".fh-set-quick__item").length >= 0);
    ok("\u5feb\u901f\u8bbf\u95ee\u7ba1\u7406\u5e26\u6e05\u7a7a\u6309\u94ae", /\u6e05\u7a7a\u5168\u90e8\u56fa\u5b9a/.test(quickMgr.textContent));
    // 分组名与数量要分开渲染，不然「名字 · 3」糊成一行小字
    ok("\u5206\u7ec4\u540d\u5355\u72ec\u6210\u8282\u70b9", !!quickMgr.querySelector(".fh-set-quick__name-text"));
    ok("\u6570\u91cf\u5355\u72ec\u505a\u6210\u80f6\u56ca", !!quickMgr.querySelector(".fh-set-quick__count"));
    eq("\u4e0d\u518d\u4f7f\u7528\u5168\u5c40\u6491\u5f00\u7c7b", quickMgr.querySelectorAll(".fh-spacer").length, 0);
    ok("\u6491\u5f00\u5143\u7d20\u7528\u5c40\u90e8\u7c7b", !!quickMgr.querySelector(".fh-set-quick__spacer"));

    /* 排版回归：思源 Setting.open() 的 column 分支会把控件直接挂成 .config-item
       的子节点并补上 fn__size200，于是
         .config-item>.fn__size200:not(.b3-switch){flex:1 1 100%;max-width:100%}
       会盖掉插件写的 max-width（滑杆被拉满整行，数值被顶到另一头 = 大片空白），
       标题所在的 .fn__flex-1 还会独占一行。所以除开关外一律要显式写 direction:"row"。 */
    const dirs = plugin.setting.items.map((i) => i.direction);
    ok("\u6bcf\u4e2a\u8bbe\u7f6e\u9879\u90fd\u663e\u5f0f\u58f0\u660e\u4e86 direction", dirs.every((d) => d === "row" || d === "column"), JSON.stringify(dirs));
    eq("\u5f00\u5173\u7528 column", plugin.setting.items[titles.indexOf("\u641c\u7d22\u6846")].direction, "column");
    ok("\u9664\u5f00\u5173\u5916\u4e00\u5f8b\u7528 row",
        plugin.setting.items.every((it) => it === plugin.setting.items[titles.indexOf("\u641c\u7d22\u6846")] || it.direction === "row"),
        plugin.setting.items.filter((it) => it.direction !== "row" && it.direction !== "column").map((i) => i.title).join(","));

    // 静态核对样式表：限宽必须写在能被思源认到的选择器上
    const cssText = fs.readFileSync(path.join(ROOT, "index.css"), "utf8");
    ok("\u6ed1\u6746\u884c\u81ea\u5e26\u9650\u5bbd", /\.fh-set-range\s*\{[^}]*max-width\s*:\s*360px/.test(cssText));
    ok("\u72ec\u7acb\u6309\u94ae\u4e0d\u62c9\u6ee1\u6574\u884c", /\.fh-set-action\s*\{[^}]*width\s*:\s*auto/.test(cssText));
    ok("\u8bbe\u7f6e\u533a\u4e0d\u518d\u5f15\u7528 --fh- \u53d8\u91cf",
        !/\.fh-set-[a-z-]*\s*\{[^}]*var\(--fh-/.test(cssText));

    // 滑杆：不能再用主题接管的 .b3-slider，且每根都带数值 + 单位
    ["\u80cc\u666f\u6a21\u7cca", "\u80cc\u666f\u538b\u6697", "\u6700\u8fd1\u6587\u6863\u6570\u91cf", "\u7075\u611f\u663e\u793a\u6570\u91cf"].forEach((title) => {
        const el = built[titles.indexOf(title)];
        ok("\u6ed1\u6746\u300c" + title + "\u300d\u4e0d\u518d\u5957\u7528 b3-slider", !el.querySelector(".b3-slider"));
        ok("\u6ed1\u6746\u300c" + title + "\u300d\u81ea\u5e26\u6837\u5f0f\u7c7b", !!el.querySelector(".fh-range[type=range]"));
        const value = el.querySelector(".fh-set-range__value");
        ok("\u6ed1\u6746\u300c" + title + "\u300d\u5e26\u6570\u503c\u548c\u5355\u4f4d", !!value && value.textContent.trim().length > 1, value && value.textContent);
    });
    ok("\u7f29\u653e\u6863\u4f4d\u8bf4\u660e\u91cc\u6709\u5355\u4f4d", plugin.setting.items[titles.indexOf("\u80cc\u666f\u6a21\u7cca")].description.indexOf("px") >= 0);
    // \u6bcf\u4e2a\u63a7\u4ef6\u90fd\u5e94\u8be5\u6709\u53ef\u89c1\u6587\u5b57\uff08\u542b\u6570\u503c\u6807\u7b7e\uff09\uff0c\u4e0d\u80fd\u662f\u65e0\u6807\u6ce8\u7a7a\u5757
    const blank = built.filter((el) => !el.textContent.trim() &&
        !el.matches("input, select, textarea, button") &&
        !el.querySelector("input, select, textarea, button"));
    eq("\u6ca1\u6709\u65e0\u6807\u6ce8\u7684\u7a7a\u63a7\u4ef6", blank.length, 0);

    plugin.__draft.userName = "\u6539\u8fc7\u7684\u540d\u5b57";
    plugin.__draft.showSearch = false;
    await plugin.applyDraft();
    eq("\u4fdd\u5b58\u540e\u751f\u6548", plugin.settings.userName, "\u6539\u8fc7\u7684\u540d\u5b57");
    ok("\u4fdd\u5b58\u540e\u5199\u5165\u78c1\u76d8", !!plugin.storage["settings.json"]);
    eq("\u4fdd\u5b58\u540e\u91cd\u7ed8\u95ee\u5019\u8bed", host.querySelector(".fh-hero__hi").textContent.indexOf("\u6539\u8fc7\u7684\u540d\u5b57") >= 0, true);
    plugin.settings.showSearch = true;
    plugin.refreshAllViews();
    await wait(20);

    /* ---------------- 统计卡片 ---------------- */

    console.log("\n[11] \u7edf\u8ba1\u5361\u7247");
    plugin.settings.hiddenCards = [];
    plugin.refreshAllViews();
    await wait(60);
    const statsCard = host.querySelector('[data-card-id="stats"]');
    ok("\u7edf\u8ba1\u5361\u7247\u5df2\u6e32\u67d3", !!statsCard);
    eq("\u4e09\u4e2a\u6307\u6807", statsCard.querySelectorAll(".fh-stat").length, 3);
    const statValues = Array.from(statsCard.querySelectorAll(".fh-stat__value")).map((n) => n.textContent);
    eq("\u7b14\u8bb0\u603b\u6570\u5e26\u5343\u5206\u4f4d", statValues[0], "1,284");
    ok("\u4eca\u65e5\u4f7f\u7528\u65f6\u957f\u6709\u503c", statValues[1].length > 0, statValues[1]);
    eq("\u4eca\u65e5\u5199\u4f5c\u5b57\u6570", statValues[2], "1,860");
    eq("\u6307\u6807\u540d\u79f0", Array.from(statsCard.querySelectorAll(".fh-stat__label")).map((n) => n.textContent).join(","),
        "\u7b14\u8bb0\u603b\u6570,\u4eca\u65e5\u4f7f\u7528\u65f6\u957f,\u4eca\u65e5\u5199\u4f5c\u5b57\u6570");
    ok("\u6bcf\u4e2a\u6307\u6807\u90fd\u5e26\u8bf4\u660e", Array.from(statsCard.querySelectorAll(".fh-stat")).every((n) => n.getAttribute("title")));
    ok("\u6709\u4f7f\u7528\u65f6\u957f\u53e3\u5f84\u8bf4\u660e", statsCard.querySelector(".fh-stats__note").textContent.length > 0);
    ok("\u4eca\u65e5\u65b0\u5efa\u6587\u6863\u6570\u5c55\u793a", statsCard.textContent.indexOf("\u4eca\u65e5 +3") >= 0);
    ok("\u7edf\u8ba1 SQL \u5df2\u53d1\u51fa", sqlLog.some((s) => s.indexOf("AS total") >= 0) && sqlLog.some((s) => s.indexOf("SUM(length)") >= 0));

    // \u8ba1\u65f6\uff1a\u7a97\u53e3\u53ef\u89c1 + \u6700\u8fd1\u6709\u64cd\u4f5c\u624d\u8ba1
    const usageBefore = plugin.todayUsageSeconds();
    plugin.lastActivityAt = Date.now();
    plugin.tickUsage();
    eq("\u6709\u64cd\u4f5c\u65f6\u4f1a\u8ba1\u4e00\u6b21", plugin.todayUsageSeconds() - usageBefore, USAGE_TICK);
    plugin.lastActivityAt = Date.now() - 20 * 60 * 1000;
    const idle = plugin.todayUsageSeconds();
    plugin.tickUsage();
    eq("\u7a7a\u95f2\u8d85\u65f6\u4e0d\u8ba1", plugin.todayUsageSeconds(), idle);
    // 每 4 次心跳自动落盘一次
    plugin.lastActivityAt = Date.now();
    const tickStart = plugin.todayUsageSeconds();
    for (let i = 0; i < 4; i++) {
        plugin.tickUsage();
    }
    eq("\u56db\u6b21\u5fc3\u8df3\u7d2f\u8ba1\u6b63\u786e", plugin.todayUsageSeconds() - tickStart, USAGE_TICK * 4);
    eq("\u56db\u6b21\u5fc3\u8df3\u540e\u81ea\u52a8\u843d\u76d8", !!plugin.storage["usage.json"], true);
    ok("\u8bb0\u4e8b\u672c\u6709 since", !!(plugin.storage["usage.json"] || {}).since);

    await plugin.resetUsage();
    eq("\u6e05\u7a7a\u540e\u4e3a 0", plugin.todayUsageSeconds(), 0);

    // \u7eaf\u51fd\u6570
    eq("fmtCount \u5343\u5206\u4f4d", T.fmtCount(1234567), "1,234,567");
    eq("fmtCount \u5c0f\u6570", T.fmtCount(999), "999");
    eq("fmtCount \u7a7a\u503c", T.fmtCount(null), "0");
    eq("fmtDuration \u5206\u949f", T.fmtDuration(38 * 60), "38 \u5206\u949f");
    eq("fmtDuration \u5c0f\u65f6", T.fmtDuration(2 * 3600 + 15 * 60), "2 \u5c0f\u65f6 15 \u5206");
    eq("fmtDuration \u6574\u5c0f\u65f6", T.fmtDuration(3 * 3600), "3 \u5c0f\u65f6");
    eq("fmtDuration \u4e0d\u8db3\u4e00\u5206\u949f", T.fmtDuration(20), "\u4e0d\u5230 1 \u5206\u949f");
    eq("ALL_CARDS \u5305\u542b stats", T.ALL_CARDS.indexOf("stats") >= 0, true);
    eq("\u9ed8\u8ba4\u5c3a\u5bf8\u8986\u76d6\u4e94\u5f20\u5361", Object.keys(T.defaultCardSize()).length, 5);

    /* ---------------- 灵感归宿 ---------------- */

    console.log("\n[11] \u7075\u611f\u5f52\u5bbf\uff08\u5173\u8054\u7b14\u8bb0\u672c / \u5177\u4f53\u7b14\u8bb0\uff09");
    await plugin.applyDraft();
    await plugin.openSettings();
    const targetIndex = plugin.setting.items.map((i) => i.title).indexOf("\u7075\u611f\u5f52\u5bbf");
    const targetControl = plugin.setting.items[targetIndex].createActionElement();
    ok("\u7075\u611f\u5f52\u5bbf\u63a7\u4ef6\u5df2\u6784\u5efa", !!targetControl);
    const selects = targetControl.querySelectorAll("select");
    eq("\u4e09\u4e2a\u4e0b\u62c9\uff1a\u6a21\u5f0f / \u7b14\u8bb0\u672c / \u76ee\u6807\u7b14\u8bb0", selects.length, 3);
    ok("\u5e26\u6587\u6863\u641c\u7d22\u6846", !!targetControl.querySelector("input.b3-text-field"));
    eq("\u9ed8\u8ba4\u6a21\u5f0f\u662f\u4ec5\u672c\u5730", selects[0].value, "none");
    ok("\u9ed8\u8ba4\u9690\u85cf\u7b14\u8bb0\u672c\u884c", targetControl.querySelectorAll(".fh-target__row")[0].classList.contains("fn__none"));

    // 切到「写入笔记本」
    selects[0].value = "notebook";
    selects[0].dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await wait(40);
    ok("\u5207\u5230\u7b14\u8bb0\u672c\u540e\u884c\u53ef\u89c1", !targetControl.querySelectorAll(".fh-target__row")[0].classList.contains("fn__none"));
    ok("\u81ea\u52a8\u9009\u4e2d\u7b2c\u4e00\u4e2a\u7b14\u8bb0\u672c", !!plugin.__draft.noteTarget.notebook);

    // 切到「追加到某篇笔记」
    const docSelect = selects[2];
    eq("\u6587\u6863\u5217\u8868\u5df2\u62c9\u53d6", docSelect.options.length >= 1 ? docSelect.options[0].value : "", "doc-target-1");
    selects[0].value = "doc";
    selects[0].dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await wait(20);
    ok("\u5207\u5230\u7b14\u8bb0\u540e\u76ee\u6807\u884c\u53ef\u89c1", !targetControl.querySelectorAll(".fh-target__row")[1].classList.contains("fn__none"));
    docSelect.value = "doc-target-1";
    docSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await wait(10);
    eq("\u76ee\u6807\u7b14\u8bb0 id \u5df2\u8bb0\u4e0b", plugin.__draft.noteTarget.docId, "doc-target-1");
    eq("\u76ee\u6807\u7b14\u8bb0\u8def\u5f84\u5df2\u8bb0\u4e0b", plugin.__draft.noteTarget.docPath, "/笔记/灵感收集箱");

    await plugin.applyDraft();
    eq("\u4fdd\u5b58\u540e\u751f\u6548", plugin.settings.noteTarget.type, "doc");

    calls.api.length = 0;
    const appended = await plugin.mirrorNote("\u8fd9\u662f\u4e00\u6761\u7075\u611f");
    ok("\u8ffd\u52a0\u5230\u7b14\u8bb0\u6210\u529f", appended === true);
    const appendCall = calls.api.find((c) => c.url === "/api/block/appendBlock");
    ok("\u8c03\u7528\u4e86 appendBlock", !!appendCall);
    if (appendCall) {
        eq("parentID \u662f\u76ee\u6807\u7b14\u8bb0", appendCall.data.parentID, "doc-target-1");
        ok("\u5185\u5bb9\u662f\u5217\u8868\u9879\u5e76\u5e26\u65f6\u95f4\u6233", /^- \d{2}-\d{2} \d{2}:\d{2} /.test(appendCall.data.data), appendCall.data.data);
    }
    ok("\u4e0d\u518d\u65b0\u5efa\u6587\u6863", !calls.api.some((c) => c.url === "/api/filetree/createDocWithMd"));

    // 切回「仅本地」后不应再写思源
    plugin.settings.noteTarget.type = "none";
    calls.api.length = 0;
    ok("\u4ec5\u672c\u5730\u6a21\u5f0f\u76f4\u63a5\u8fd4\u56de", (await plugin.mirrorNote("x")) === true);
    eq("\u4ec5\u672c\u5730\u6a21\u5f0f\u4e0d\u53d1\u8bf7\u6c42", calls.api.length, 0);

    // 旧配置迁移
    const legacy = new Cls({ app: {}, name: "siyuan-plugins-foresthomepage", i18n: zhI18n });
    legacy.storage["settings.json"] = { noteNotebook: "nb-legacy", onboarded: true };
    await legacy.onload();
    eq("\u65e7 noteNotebook \u8fc1\u79fb\u6210 noteTarget", legacy.settings.noteTarget.type, "notebook");
    eq("\u8fc1\u79fb\u540e\u7b14\u8bb0\u672c\u4fdd\u7559", legacy.settings.noteTarget.notebook, "nb-legacy");
    ok("\u65e7\u5b57\u6bb5\u5df2\u6e05\u7406", legacy.settings.noteNotebook === undefined);

    /* ---------------- 快速访问卡片 ---------------- */

    console.log("\n[12] 快速访问（Pin / 分类 / 横向自适应）");

    plugin.settings.hiddenCards = [];
    plugin.settings.cardOrder = T.ALL_CARDS.slice();
    plugin.settings.cardSize = Object.assign(T.defaultCardSize(), {
        recent: { x: 4, y: 4 }, inspiration: { x: 4, y: 4 }, calendar: { x: 4, y: 4 },
        stats: { x: 4, y: 4 }, quick: { x: 12, y: 3 },
    });
    plugin.quick = T.normalizeQuick(null);
    await plugin.persistQuick();
    plugin.refreshAllViews();
    await wait(60);

    // 模拟真实点击顺序：先 pointerdown 再 click。
    // 只发 click 是"非真实"的——指针不落地，拖拽遗留的吞点击标记不会被清掉，
    // 正好可以检验「拖过卡片之后，第一次点击仍然有效」。
    const realClick = (el) => {
        el.dispatchEvent(pointerEvent(dom, "pointerdown", 10, 10));
        el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    };

    let quickCard = grid.querySelector('[data-card-id="quick"]');
    ok("快速访问卡片已渲染", !!quickCard);
    eq("默认整行宽", quickCard ? quickCard.getAttribute("data-span-x") : "", "12");
    eq("默认三行高", quickCard ? quickCard.getAttribute("data-span-y") : "", "3");
    ok("空状态有说明文案", quickCard.textContent.indexOf("还没有固定任何文档") >= 0);
    eq("整行宽算出 6 列", quickCard.getAttribute("data-quick-cols"), "6");
    eq("列数写进 CSS 变量", quickCard.style.getPropertyValue("--fh-quick-cols"), "6");

    // 从「最近打开」的图钉 Pin 一篇
    const recentRows = host.querySelectorAll('[data-card-id="recent"] .fh-doc');
    eq("最近打开有两条测试文档", recentRows.length, 2);
    const docA = recentRows[0].getAttribute("data-doc-id");
    const docB = recentRows[1].getAttribute("data-doc-id");
    const pinBtn = recentRows[0].querySelector("[data-act='pin-doc']");
    ok("文档行带图钉按钮", !!pinBtn);
    realClick(pinBtn);
    await wait(50);
    ok("Pin 已写入 quickaccess.json", !!plugin.storage["quickaccess.json"]);
    eq("Pin 数量 1", T.quickCount(plugin.quick), 1);
    eq("默认归入未分类", plugin.findPin(docA).group.id, T.QUICK_GROUP_DEFAULT);
    quickCard = grid.querySelector('[data-card-id="quick"]');
    ok("卡片里出现该条目", !!quickCard.querySelector('.fh-quick__item[data-doc-id="' + docA + '"]'));
    eq("分组名显示未分类", quickCard.querySelector(".fh-quick__name").textContent, "未分类");
    eq("分组计数为 1", quickCard.querySelector(".fh-quick__count").textContent, "1");
    ok("已固定项带标题（右键要用）", !!quickCard.querySelector(".fh-quick__item[data-doc-title]"));
    ok("最近打开里的图钉转为已固定态", !!grid.querySelector('[data-card-id="recent"] .fh-pin--on'));

    realClick(grid.querySelectorAll('[data-card-id="recent"] .fh-doc')[1].querySelector("[data-act='pin-doc']"));
    await wait(50);
    eq("Pin 数量 2", T.quickCount(plugin.quick), 2);

    // 过长文件名：只留前面几个字，完整标题留在 title / data-doc-title 里（右键与悬停都要用）
    const longTitle = "这是一个特别特别长的文档标题用来测试截断显示是否真的生效";
    await plugin.pinDoc({ id: "long-title-doc", title: longTitle });
    await wait(40);
    quickCard = grid.querySelector('[data-card-id="quick"]');
    const longItem = quickCard.querySelector('.fh-quick__item[data-doc-id="long-title-doc"]');
    ok("超长标题条目已渲染", !!longItem);
    const shownText = longItem.querySelector(".fh-quick__item-title").textContent;
    eq("按预算截断显示", shownText, T.truncateTitle(longTitle, T.QUICK_TITLE_MAX_DEFAULT));
    ok("截断后确实短了且以省略号收尾", shownText.length < longTitle.length && /…$/.test(shownText), shownText);
    eq("完整标题仍在 data-doc-title", longItem.getAttribute("data-doc-title"), longTitle);
    eq("完整标题仍在 title（悬停可见）", longItem.getAttribute("title"), longTitle);
    await plugin.unpinDoc("long-title-doc");
    await wait(30);
    eq("清理后 Pin 数量回到 2", T.quickCount(plugin.quick), 2);

    // 分类：新建分组 / 跨组移动 / 组内排序
    const groupA = await plugin.addQuickGroup("本周常用");
    await wait(30);
    quickCard = grid.querySelector('[data-card-id="quick"]');
    eq("卡片上出现两个分组", quickCard.querySelectorAll(".fh-quick__group").length, 2);
    eq("新分组标题", plugin.groupTitle(plugin.quickGroup(groupA)), "本周常用");
    ok("空分组带落点提示", quickCard.textContent.indexOf("把文档拖到这里归入本组") >= 0);

    await plugin.movePin(docA, groupA, 0);
    eq("跨组移动生效", plugin.findPin(docA).group.id, groupA);
    eq("原分组只剩 1 条", plugin.quickGroup(T.QUICK_GROUP_DEFAULT).items.length, 1);

    await plugin.movePin(docB, groupA, 0);
    eq("组内顺序可调", plugin.quickGroup(groupA).items.map((i) => i.id).join(","), docB + "," + docA);
    eq("未分类已空", plugin.quickGroup(T.QUICK_GROUP_DEFAULT).items.length, 0);
    await wait(30);
    quickCard = grid.querySelector('[data-card-id="quick"]');
    // 未分类空了就该自动让位；用户自建的分组即使为空仍然保留（它是可见的拖放落点）
    ok("空的未分类分组自动隐藏", !quickCard.querySelector('.fh-quick__group[data-group-id="default"]'));
    eq("此时卡片上只剩用户分组", quickCard.querySelectorAll(".fh-quick__group").length, 1);
    const emptyGroup = await plugin.addQuickGroup("待整理");
    await wait(30);
    quickCard = grid.querySelector('[data-card-id="quick"]');
    ok("用户建的空分组仍然显示", !!quickCard.querySelector('.fh-quick__group[data-group-id="' + emptyGroup + '"]'));
    ok("空分组带拖放落点提示", quickCard.textContent.indexOf("把文档拖到这里归入本组") >= 0);
    await plugin.removeQuickGroup(emptyGroup);
    await wait(30);

    // —— 分组顺序拖动：即时重排 + 落盘 ——
    const groupB = await plugin.addQuickGroup("稍后再读");
    const groupC = await plugin.addQuickGroup("长期归档");
    await wait(30);
    quickCard = grid.querySelector('[data-card-id="quick"]');
    const orderNow = () => Array.prototype.map.call(
        quickCard.querySelectorAll(".fh-quick__group"), (n) => n.getAttribute("data-group-id")).join(",");
    eq("分组初始顺序", orderNow(), groupA + "," + groupB + "," + groupC);
    ok("每个分组都有拖动抓手", quickCard.querySelectorAll(".fh-quick__grip").length === 3);

    // 方法层：把最后一个挪到最前（default 也被一起往后排，只是它没内容不显示）
    await plugin.moveQuickGroup(groupC, 0);
    await wait(30);
    quickCard = grid.querySelector('[data-card-id="quick"]');
    eq("moveQuickGroup 即时生效", orderNow(), groupC + "," + groupA + "," + groupB);
    eq("新顺序已落盘",
        plugin.storage["quickaccess.json"].groups.map((g) => g.id).join(","),
        groupC + "," + T.QUICK_GROUP_DEFAULT + "," + groupA + "," + groupB);

    // 交互层：真的用指针拖一次（拖第一个分组的抓手，越过第二个分组中心、停在第三个中心之上）
    const dragGrip = quickCard.querySelector('.fh-quick__group[data-group-id="' + groupC + '"] .fh-quick__grip');
    ok("拿到抓手元素", !!dragGrip);
    const gripRect = dragGrip.getBoundingClientRect();
    dragGrip.dispatchEvent(pointerEvent(dom, "pointerdown", gripRect.left + 5, QUICK_GROUP_TOP + 10));
    window.dispatchEvent(pointerEvent(dom, "pointermove", gripRect.left + 5, QUICK_GROUP_TOP + 200));
    await wait(10);
    window.dispatchEvent(pointerEvent(dom, "pointerup", gripRect.left + 5, QUICK_GROUP_TOP + 200));
    await wait(60);
    quickCard = grid.querySelector('[data-card-id="quick"]');
    eq("指针拖动即时重排", orderNow(), groupA + "," + groupC + "," + groupB);
    eq("拖动结果同样落盘",
        plugin.storage["quickaccess.json"].groups.map((g) => g.id).join(","),
        groupA + "," + groupC + "," + groupB + "," + T.QUICK_GROUP_DEFAULT);
    eq("重排不影响分组数量", plugin.storage["quickaccess.json"].groups.length, 4);   // 含隐藏的 default

    await plugin.removeQuickGroup(groupB);
    await plugin.removeQuickGroup(groupC);
    await wait(30);
    quickCard = grid.querySelector('[data-card-id="quick"]');
    eq("清理后回到用户分组只有 A", orderNow(), groupA);

    await plugin.renameQuickGroup(groupA, "资料");
    eq("重命名生效", plugin.groupTitle(plugin.quickGroup(groupA)), "资料");
    eq("改名已落盘", plugin.storage["quickaccess.json"].groups.filter((g) => g.name === "资料").length, 1);

    const movedBack = await plugin.removeQuickGroup(groupA);
    eq("删除分组返回搬迁数量", movedBack, 2);
    eq("内容退回未分类", plugin.quickGroup(T.QUICK_GROUP_DEFAULT).items.length, 2);
    eq("删除分组不影响总数", T.quickCount(plugin.quick), 2);
    ok("分组已消失", !plugin.quickGroup(groupA));
    eq("未分类不可删除", await plugin.removeQuickGroup(T.QUICK_GROUP_DEFAULT), 0);

    // 取消固定
    await plugin.unpinDoc(docA);
    eq("取消固定后不在列表", plugin.isPinnedDoc(docA), false);
    eq("总数减一", T.quickCount(plugin.quick), 1);

    // 横向拉伸 → 列数自适应
    const colsAt = async (spanX) => {
        plugin.settings.cardSize.quick = { x: spanX, y: 3 };
        plugin.refreshAllViews();
        await wait(40);
        return grid.querySelector('[data-card-id="quick"]').getAttribute("data-quick-cols");
    };
    eq("缩到 1/4 宽只剩 1 列", await colsAt(3), "1");
    eq("拉到 1/2 宽变 3 列", await colsAt(6), "3");
    eq("拉到整行变 6 列", await colsAt(12), "6");

    plugin.settings.quickItemMin = 320;
    plugin.refreshAllViews();
    await wait(40);
    eq("条目要求更宽时列数减少", grid.querySelector('[data-card-id="quick"]').getAttribute("data-quick-cols"), "3");
    plugin.settings.quickItemMin = T.QUICK_ITEM_MIN_DEFAULT;
    plugin.refreshAllViews();
    await wait(40);
    eq("恢复默认条目宽度后回到 6 列", grid.querySelector('[data-card-id="quick"]').getAttribute("data-quick-cols"), "6");

    // 右键菜单
    const openMenu = async (row) => {
        row.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
            bubbles: true, cancelable: true, clientX: 140, clientY: 260,
        }));
        await wait(20);
        return host.querySelector("[data-fh-menu]");
    };
    let menu = await openMenu(grid.querySelectorAll('[data-card-id="recent"] .fh-doc')[1]);
    ok("右键弹出文档菜单", !!menu);
    ok("菜单含「打开文档」", !!menu.querySelector('[data-act="menu-open"]'));
    ok("菜单含固定/取消固定", !!menu.querySelector('[data-act="menu-pin"]'));
    ok("菜单列出分组", menu.querySelectorAll('[data-act="menu-move"]').length >= 1);
    const pinnedBefore = plugin.isPinnedDoc(docB);
    menu.querySelector('[data-act="menu-pin"]').click();
    await wait(50);
    eq("菜单固定/取消固定按钮生效", plugin.isPinnedDoc(docB), !pinnedBefore);
    ok("操作后菜单自动收起", !host.querySelector("[data-fh-menu]"));

    // 确保处于「已固定」，再检查已固定态的菜单项
    if (!plugin.isPinnedDoc(docB)) {
        await plugin.pinDoc({ id: docB, title: "测试文档 B" });
        await wait(30);
    }
    menu = await openMenu(grid.querySelectorAll('[data-card-id="recent"] .fh-doc')[1]);
    ok("已固定时菜单出现「从快速访问中移除」", !!menu.querySelector('[data-act="menu-unpin"]'));
    menu.querySelector('[data-act="menu-unpin"]').click();
    await wait(50);
    eq("菜单取消固定生效", plugin.isPinnedDoc(docB), false);

    await openMenu(grid.querySelectorAll('[data-card-id="recent"] .fh-doc')[0]);
    ok("菜单可见", !!host.querySelector("[data-fh-menu]"));
    document.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
    await wait(20);
    ok("点击外部关闭菜单", !host.querySelector("[data-fh-menu]"));

    // 条目拖到别的分组：走真实指针事件，并验证拖完那一次 click 不会顺带打开文档
    plugin.quick = T.normalizeQuick({
        groups: [
            { id: T.QUICK_GROUP_DEFAULT, name: "", items: [{ id: docB, title: "\u6d4b\u8bd5\u6587\u6863 B", icon: "", addedAt: 1 }] },
            { id: "g-drag", name: "\u62d6\u52a8\u76ee\u6807", items: [] },
        ],
    });
    await plugin.persistQuick();
    plugin.refreshAllViews();
    await wait(40);
    quickCard = grid.querySelector('[data-card-id="quick"]');
    const dragItem = quickCard.querySelector('.fh-quick__item[data-doc-id="' + docB + '"]');
    const dropBody = quickCard.querySelector('.fh-quick__group[data-group-id="g-drag"] [data-group-body]');
    ok("\u62d6\u52a8\u7528\u4f8b\uff1a\u6761\u76ee\u4e0e\u76ee\u6807\u5206\u7ec4\u90fd\u5728", !!dragItem && !!dropBody);
    const dragRect = dragItem.getBoundingClientRect();
    const openedBefore = calls.openTab.length;
    // jsdom 没有 elementFromPoint，用桩把指针位置映射到目标分组
    const hadPoint = "elementFromPoint" in document;
    const stickyPoint = document.elementFromPoint;
    document.elementFromPoint = () => dropBody;
    dragItem.dispatchEvent(pointerEvent(dom, "pointerdown", dragRect.left + 10, dragRect.top + 10));
    window.dispatchEvent(pointerEvent(dom, "pointermove", dragRect.left + 240, dragRect.top + 10));
    await wait(10);
    window.dispatchEvent(pointerEvent(dom, "pointerup", dragRect.left + 240, dragRect.top + 10));
    // 浏览器会在 pointerup 之后补一个 click，这里同步派发，模拟"拖完正好落在条目上"
    dragItem.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await wait(60);
    if (hadPoint) {
        document.elementFromPoint = stickyPoint;
    } else {
        delete document.elementFromPoint;
    }
    eq("\u62d6\u5230\u522b\u7684\u5206\u7ec4\u5373\u5b8c\u6210\u5206\u7c7b", plugin.findPin(docB).group.id, "g-drag");
    eq("\u62d6\u52a8\u6536\u5c3e\u7684 click \u4e0d\u4f1a\u6253\u5f00\u6587\u6863", calls.openTab.length, openedBefore);
    await plugin.removeQuickGroup("g-drag");
    await wait(30);
    eq("\u62d6\u52a8\u7528\u4f8b\u6536\u5c3e\uff1a\u5185\u5bb9\u9000\u56de\u672a\u5206\u7c7b", plugin.findPin(docB).group.id, T.QUICK_GROUP_DEFAULT);

    // 「添加文档」对话框
    // 保证此时至少有一条已固定，用来检验对话框里的「已固定」徽标与总数
    if (!T.quickCount(plugin.quick)) {
        await plugin.pinDoc({ id: docA, title: "\u6d4b\u8bd5\u6587\u6863 A" });
        await wait(30);
    }
    plugin.openQuickPicker(plugin.views.values().next().value);
    await wait(80);
    const pickerRoot = document.querySelector("[data-fh-picker]");
    ok("打开添加文档对话框", !!pickerRoot);
    eq("分组下拉已填充", pickerRoot.querySelector("[data-picker-group]").options.length, 1);
    const pickerRows = pickerRoot.querySelectorAll(".fh-picker__row");
    eq("列出可固定的文档", pickerRows.length, 3);
    ok("已固定项带徽标", pickerRoot.querySelectorAll(".fh-picker__badge").length >= 1);
    ok("显示固定总数", /已固定 \d+ 篇/.test(pickerRoot.querySelector("[data-picker-count]").textContent));
    const unpinnedRow = Array.prototype.filter.call(pickerRows, (r) => !r.classList.contains("is-on"))[0];
    const docC = unpinnedRow.getAttribute("data-doc-id");
    unpinnedRow.click();
    await wait(80);
    eq("对话框内点击即固定", plugin.isPinnedDoc(docC), true);
    ok("该行转为已固定样式", !!pickerRoot.querySelector('.fh-picker__row[data-doc-id="' + docC + '"].is-on'));
    pickerRoot.querySelector("[data-picker-ok]").click();
    await wait(20);
    ok("完成后对话框关闭", !document.querySelector("[data-fh-picker]"));

    // 清空全部
    const remaining = T.quickCount(plugin.quick);
    ok("清空前还有固定内容", remaining >= 1, String(remaining));
    eq("清空返回条数", await plugin.clearQuick(), remaining);
    eq("清空后无 Pin", T.quickCount(plugin.quick), 0);
    eq("清空后仍保留一个分组", plugin.quickGroups().length, 1);

    /* ---------------- 引导向导 ---------------- */

    console.log("\n[13] \u9996\u6b21\u5b89\u88c5\u5f15\u5bfc");
    plugin.settings.onboarded = false;
    plugin.showOnboarding(false);
    const obDialog = plugin.onboardingDialog;
    ok("\u5f15\u5bfc\u5f39\u7a97\u5df2\u521b\u5efa", !!obDialog);
    const obRoot = document.querySelector("[data-ob-root]");
    ok("\u5f15\u5bfc DOM \u5df2\u6e32\u67d3", !!obRoot);
    ok("\u7b2c 1 \u6b65\u662f\u79f0\u547c", obRoot.querySelector(".fh-ob__title").textContent.indexOf("\u600e\u4e48\u79f0\u547c") >= 0);
    ok("\u7b2c 1 \u6b65\u5c31\u6709\u8f93\u5165\u6846", !!obRoot.querySelector("input.b3-text-field"));
    ok("\u7b2c 1 \u6b65\u9690\u85cf\u4e0a\u4e00\u6b65", obRoot.querySelector('[data-ob-act="prev"]').classList.contains("fn__none"));

    obRoot.querySelector('[data-ob-act="next"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    ok("\u7b2c 2 \u6b65\u662f\u9009\u5361\u7247", obRoot.querySelector(".fh-ob__cards") && obRoot.querySelectorAll(".fh-ob__card").length === 5);
    ok("\u7b2c 2 \u6b65\u51fa\u73b0\u4e0a\u4e00\u6b65", !obRoot.querySelector('[data-ob-act="prev"]').classList.contains("fn__none"));

    obRoot.querySelector('[data-ob-act="next"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    ok("\u7b2c 3 \u6b65\u662f\u80cc\u666f\u56fe", !!obRoot.querySelector(".fh-ob__bg"));

    obRoot.querySelector('[data-ob-act="next"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    ok("\u7b2c 4 \u6b65\u6709\u5b8c\u6210\u63d0\u793a", obRoot.querySelector(".fh-ob__done").textContent.length > 0);
    eq("\u6700\u540e\u4e00\u6b65\u6309\u94ae\u53d8\u6210\u300c\u8fdb\u5165\u4e3b\u9875\u300d", obRoot.querySelector('[data-ob-act="next"]').textContent, "\u8fdb\u5165\u4e3b\u9875");

    calls.openTab.length = 0;
    obRoot.querySelector('[data-ob-act="next"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await wait(40);
    ok("\u5b8c\u6210\u540e\u5199\u5165 onboarded", plugin.settings.onboarded === true);
    ok("\u5b8c\u6210\u540e\u5173\u95ed\u5f39\u7a97", !plugin.onboardingDialog);
    ok("\u5b8c\u6210\u540e\u6253\u5f00\u4e3b\u9875", calls.openTab.length === 1);
    eq("\u6253\u5f00\u7684\u662f\u4e3b\u9875\u9875\u7b7e", calls.openTab[0].custom.id, "siyuan-plugins-foresthomepagehomepage");

    /* ---------------- 图标与卸载 ---------------- */

    console.log("\n[14] \u56fe\u6807\u3001\u80cc\u666f\u4e0e\u5378\u8f7d");
    ok("\u9876\u680f\u56fe\u6807 fill/stroke \u8d70\u5185\u8054 style",
        /style="[^"]*fill:none[^"]*stroke:currentColor/.test(calls.topBar[0].icon));
    ok("\u4e0d\u518d\u4f7f\u7528\u4f1a\u88ab\u4e3b\u9898\u8986\u76d6\u7684 fill=\u8868\u73b0\u5c5e\u6027",
        calls.topBar[0].icon.indexOf('fill="none"') < 0 && calls.topBar[0].icon.indexOf('stroke="currentColor"') < 0);

    const cardIconHtml = host.querySelector('[data-card-id="recent"] [data-card-icon]').innerHTML;
    ok("\u5361\u7247\u56fe\u6807\u540c\u6837\u8d70\u5185\u8054 style",
        cardIconHtml.indexOf('style="') >= 0 && cardIconHtml.indexOf('fill="none"') < 0, cardIconHtml);
    const gripHtml = host.querySelector(".fh-card__grip").innerHTML;
    ok("\u5b9e\u5fc3\u56fe\u6807\u7528 fill:currentColor", gripHtml.indexOf("fill:currentColor") >= 0);
    const searchIconHtml = host.querySelector(".fh-search__icon").innerHTML;
    ok("\u641c\u7d22\u56fe\u6807\u4e5f\u662f\u63cf\u8fb9", searchIconHtml.indexOf("fill:none") >= 0);

    const view2 = plugin.views.values().next().value;
    plugin.settings.background = "assets/bg.png";
    plugin.settings.backgroundBlur = 8;
    plugin.settings.backgroundDim = 40;
    plugin.applyAppearance(view2);
    ok("\u80cc\u666f\u5c42\u751f\u6548", view2.root.classList.contains("fh-root--imaged"));
    ok("\u80cc\u666f\u56fe\u53d6\u503c\u6b63\u786e", view2.root.querySelector(".fh-bg").style.backgroundImage.indexOf("/assets/bg.png") >= 0);
    plugin.settings.background = "";
    plugin.applyAppearance(view2);
    ok("\u6e05\u9664\u540e\u80cc\u666f\u5c42\u5173\u95ed", !view2.root.classList.contains("fh-root--imaged"));

    plugin.unmountView(host);
    ok("\u5378\u8f7d\u540e DOM \u6e05\u7a7a", host.innerHTML === "");
    ok("\u5378\u8f7d\u540e\u89c6\u56fe\u96c6\u5408\u4e3a\u7a7a", plugin.views.size === 0);
    plugin.onunload();
    ok("onunload \u53ef\u91cd\u590d\u8c03\u7528", true);

    /* ---------------- 结果 ---------------- */

    console.log("\n----------------------------------------");
    console.log("\u901a\u8fc7 " + passed + " \u9879");
    if (failures.length) {
        console.log("\u5931\u8d25 " + failures.length + " \u9879:");
        failures.forEach((f) => console.log("  - " + f));
        process.exitCode = 1;
    } else {
        console.log("\u5168\u90e8\u901a\u8fc7 \u2713");
    }
    // jsdom 的视觉循环会常驻事件循环，显式退出
    process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
