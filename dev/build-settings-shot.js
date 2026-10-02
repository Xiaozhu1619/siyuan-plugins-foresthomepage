/**
 * 开发辅助：把插件的设置面板渲染成一份静态 HTML，用于在真实主题 CSS 下核对排版。
 *
 * 复刻了思源 app/src/plugin/Setting.ts 里 Setting.open() 的 DOM 结构，
 * 再叠加真实的 base.css 与当前主题的 theme.css，出来的就是用户实际看到的画面。
 *
 * 运行：
 *   NODE_PATH=<node workspace>/node_modules node dev/build-settings-shot.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = __dirname;
const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const myCss = fs.readFileSync(path.join(ROOT, "index.css"), "utf8");
const zhI18n = JSON.parse(fs.readFileSync(path.join(ROOT, "i18n", "zh_CN.json"), "utf8"));

// 本机思源的安装目录与正在用的主题，都可以用环境变量覆盖：
//   SIYUAN_STAGE=<思源 stage 目录>  SIYUAN_THEME=<主题 theme.css>
// 主题一定要一起内联 —— 第三方主题会重写 .b3-* 组件，只看 base.css 会判断错。
// 默认值只是示例位置；给不到就只内联 base.css，脚本仍能跑。
const SIYUAN_STAGE = process.env.SIYUAN_STAGE ||
    "C:/Program Files/WindowsApps/89C2A984.SiYuan_3.8.6.0_x64__1qfd3tsw4ngc2/app/resources/stage";
const THEME_CSS = process.env.SIYUAN_THEME || "";

function readIfExists(p) {
    try {
        return fs.readFileSync(p, "utf8");
    } catch (err) {
        return "";
    }
}

function findBaseCss() {
    const dir = path.join(SIYUAN_STAGE, "build", "desktop");
    try {
        const hit = fs.readdirSync(dir).find((name) => name.startsWith("base.") && name.endsWith(".css"));
        return hit ? path.join(dir, hit) : "";
    } catch (err) {
        return "";
    }
}

/** 与思源 Setting.open() 完全一致的 DOM 生成逻辑 */
function replicateSiYuanOpen(contentElement, items) {
    items.forEach((item) => {
        let html = "";
        let actionElement = item.actionElement;
        if (!item.actionElement && item.createActionElement) {
            actionElement = item.createActionElement();
        }
        const tagName = actionElement && actionElement.classList.contains("b3-switch") ? "label" : "div";
        if (typeof item.direction === "undefined") {
            item.direction = (!actionElement || "TEXTAREA" === actionElement.tagName) ? "row" : "column";
        }
        const titleBlock = '<div class="config-name">' + item.title + "</div>" +
            (item.description ? '<div class="b3-label__text">' + item.description + "</div>" : "");
        if (item.direction === "row") {
            html = "<" + tagName + ' class="b3-label config-item">' +
                '<div class="fn__block">' + titleBlock + '<div class="fn__hr"></div></div>' +
                "</" + tagName + ">";
        } else {
            html = "<" + tagName + ' class="fn__flex b3-label config-item">' +
                '<div class="fn__flex-1">' + titleBlock + "</div>" +
                '<span class="fn__space' + (actionElement ? "" : " fn__none") + '"></span>' +
                "</" + tagName + ">";
        }
        contentElement.insertAdjacentHTML("beforeend", html);
        if (actionElement) {
            if (item.direction === "row") {
                contentElement.lastElementChild.lastElementChild.insertAdjacentElement("beforeend", actionElement);
                actionElement.classList.add("fn__block");
            } else {
                actionElement.classList.remove("fn__block");
                actionElement.classList.add("fn__flex-center");
                if (!actionElement.classList.contains("b3-switch")) {
                    actionElement.classList.add("fn__size200");
                }
                contentElement.lastElementChild.insertAdjacentElement("beforeend", actionElement);
            }
        }
    });
}

class SettingStub {
    constructor(options) {
        this.options = options || {};
        this.items = [];
        this.dialog = null;
    }
    addItem(item) {
        this.items.push(item);
    }
    open() {}
}

async function main() {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
    global.window = dom.window;
    global.document = dom.window.document;
    global.navigator = dom.window.navigator;

    const stub = {
        Plugin: class {
            constructor(o) {
                this.app = o.app;
                this.name = o.name;
                this.i18n = o.i18n || {};
                this.storage = {};
            }
            async loadData(n) { return this.storage[n]; }
            async saveData(n, o) { this.storage[n] = o; }
            addCommand() {}
            addTopBar() {}
            addTab() {}
        },
        Setting: SettingStub,
        Dialog: class {
            constructor(o) { this.options = o; this.element = document.createElement("div"); }
            destroy() {}
        },
        showMessage: () => {},
        openTab: () => ({}),
        getFrontend: () => "desktop",
        fetchSyncPost: async (url) => {
            if (url === "/api/notebook/lsNotebooks") {
                return { code: 0, data: { notebooks: [{ id: "nb-1", name: "我的笔记", closed: false }] } };
            }
            if (url === "/api/query/sql") {
                return { code: 0, data: [{ id: "d1", title: "示例文档", hpath: "/我的笔记/示例文档" }] };
            }
            return { code: 0, data: null };
        },
    };

    const moduleObj = { exports: {} };
    const requireStub = (key) => (key === "siyuan" ? stub : require(key));
    new Function("require", "module", "exports", "window", "document", src)(
        requireStub, moduleObj, {}, dom.window, dom.window.document
    );
    const Cls = moduleObj.exports.default || moduleObj.exports;

    const plugin = new Cls({ app: {}, name: "siyuan-plugins-foresthomepage", i18n: zhI18n });
    await plugin.onload();
    plugin.notebooks = [{ id: "nb-1", name: "我的笔记" }];

    // 模拟思源打开设置面板
    plugin.__draft = JSON.parse(JSON.stringify(plugin.settings));
    const setting = plugin.setting;
    const contentElement = document.createElement("div");
    contentElement.className = "b3-dialog__content";
    replicateSiYuanOpen(contentElement, setting.items);

    const baseCss = readIfExists(findBaseCss());
    const themeCss = readIfExists(THEME_CSS);
    const themeMode = process.env.THEME_MODE || "light";

    const html = `<!doctype html>
<html lang="zh_CN" data-theme-mode="${themeMode}" class="b3-theme-${themeMode}">
<head>
<meta charset="utf-8">
<title>设置面板实拍</title>
<style>${baseCss}</style>
<style>${themeCss}</style>
<style>${myCss}</style>
<style>
  html, body { height: 100%; margin: 0; }
  body { background: var(--b3-theme-background); padding: 24px 0; }
  /* 思源的插件设置弹窗：桌面端宽 768px，内容区 padding 16/24，Asri 主题改成 12/18。
     这里按 768px 居中还原，否则整屏宽看会误判「留白」 */
  .b3-dialog__body {
    width: 768px; max-width: calc(100vw - 32px); margin: 0 auto;
    height: calc(100% - 48px); display: flex; flex-direction: column;
    border: 1px solid var(--b3-border-color); border-radius: 8px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, .12); overflow: hidden;
  }
  .shot-note { padding: 8px 18px; font-size: 12px; color: var(--b3-theme-on-surface); }
</style>
</head>
<body>
<div class="b3-dialog__body">
  <div class="b3-dialog__header" style="padding:16px 18px;font-size:16px;font-weight:600;">森林主页设置</div>
  ${contentElement.outerHTML}
</div>
</body>
</html>`;

    const file = path.join(OUT, "settings-shot.html");
    fs.writeFileSync(file, html, "utf8");
    console.log("已生成", file);
    console.log("base.css:", baseCss ? "已内联 " + baseCss.length + " 字符" : "未找到！");
    console.log("theme.css:", themeCss ? "已内联 " + themeCss.length + " 字符" : "未找到！");
    console.log("设置项数量:", setting.items.length);
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
