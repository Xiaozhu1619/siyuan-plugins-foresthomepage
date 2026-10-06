/*!
 * 森林主页 / Forest Homepage
 * 思源笔记插件 —— 零构建纯 JS 实现
 *
 * 结构：
 *   1. 常量与工具函数
 *   2. 图标（内联 style，避免被主题的 svg{fill:currentColor} 覆盖）
 *   3. 卡片拖拽排序（按行/列定位，支持双向拖动 + FLIP 位移动画）
 *   4. ForestHomepage 插件类
 *      - 生命周期、主页挂载与渲染（三行问候语 / 搜索框 / 三张卡片）
 *      - 数据层（最近文档 / 灵感随记 / 日历活动 / 全文搜索）
 *      - 设置面板（含首次安装引导向导）
 */

const siyuan = require("siyuan");
const {
    Plugin,
    Setting,
    Dialog,
    showMessage,
    openTab,
    openMobileFileById,
    fetchSyncPost,
    getFrontend,
} = siyuan;

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const TAB_TYPE = "homepage";
const SETTINGS_FILE = "settings.json";
const NOTES_FILE = "inspirations.json";

const CARD_RECENT = "recent";
const CARD_INSPIRATION = "inspiration";
const CARD_CALENDAR = "calendar";
const CARD_STATS = "stats";
const CARD_QUICK = "quick";
const ALL_CARDS = [CARD_RECENT, CARD_INSPIRATION, CARD_CALENDAR, CARD_STATS, CARD_QUICK];

/* 快速访问：手动 Pin 的文档，按分组存放 */
const QUICK_FILE = "quickaccess.json";
const QUICK_GROUP_DEFAULT = "default";
const QUICK_ITEM_MIN_DEFAULT = 176;      // 单个条目的最小宽度（px），决定横向能排几列
const QUICK_ITEM_MIN_RANGE = [120, 320];
const QUICK_ITEM_GAP = 8;                // 条目之间的横向间距（与 CSS 里保持一致）
const QUICK_COLUMNS_MAX = 8;
/* 卡片内从卡片边缘到条目网格之间被吃掉的横向内边距合计：
   .fh-card__body 8+8 + .fh-quick 6+6 + .fh-quick__group 8+8 = 44。
   量不到网格实际宽度时（例如离线测试）用它反推，别再按 16 估算 —— 会高估 28px。 */
const QUICK_CONTENT_PADDING = 44;
/* 手机竖屏：内容净宽通常只有 300-360。这时不套用桌面那套"最小 176px"，
   而是只要每列还能留出 QUICK_NARROW_ITEM_MIN 就允许排两列，排不下就老实单列 ——
   屏小就按屏的大小自适应，不做与可用宽度无关的硬编码。 */
const QUICK_NARROW_WIDTH = 380;
const QUICK_NARROW_ITEM_MIN = 140;
/* 文件名过长时保留的字数（超出部分截断成 …），完整标题仍放在 title 属性里 */
const QUICK_TITLE_MAX_DEFAULT = 18;

/* 使用时长：思源不记录，由插件自己在本地按心跳累计 */
const USAGE_FILE = "usage.json";
const USAGE_TICK_MS = 30000;
const USAGE_IDLE_MS = 10 * 60 * 1000;   // 超过这个时长没有任何操作就停止计时
const USAGE_KEEP_DAYS = 90;

const WEEKDAY_FULL_ZH = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const WEEKDAY_FULL_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_FULL_EN = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

const FALLBACK_POEMS = [
    "今天从哪里开始？",
    "慢慢来，比较快。",
    "一次只做一件事。",
    "把想做的写下来，就有了形状。",
    "先坐下来，灵感会自己找路。",
    "今天也值得被认真对待。",
    "从一个句子开始。",
    "时间会记得你写下的字。",
    "不必着急，路会自己长出来。",
    "安静地做，做完再说。",
    "让重要的那件事先发生。",
    "现在，就是最好的时候。",
];

/* 卡片缩放：12 栅格 + 固定行高，宽高都吸附到预设档位，保证布局规整 */
const GRID_COLUMNS = 12;
const GRID_GAP_DEFAULT = 18;
const GRID_ROW_H_DEFAULT = 84;
const WIDTH_PRESETS = [3, 4, 6, 8, 12];   // 1/4 1/3 1/2 2/3 全宽
const HEIGHT_PRESETS = [3, 4, 5, 6];
const DEFAULT_SPAN = { x: 3, y: 4 };   // 1/4 宽：四张卡片正好铺满一行
/* 快速访问是"货架"型卡片：默认整行宽 + 三行高，横向越宽同屏展示的条目越多 */
const CARD_DEFAULT_SPAN = {
    quick: { x: 12, y: 3 },
};

function cardDefaultSpan(id) {
    const span = CARD_DEFAULT_SPAN[id] || DEFAULT_SPAN;
    return { x: span.x, y: span.y };
}

/** 卡片尺寸落盘结构：{ recent:{x,y}, inspiration:{x,y}, … } */
function defaultCardSize() {
    const out = {};
    ALL_CARDS.forEach(function (id) {
        out[id] = cardDefaultSpan(id);
    });
    return out;
}

function normalizeCardSize(raw) {
    const base = defaultCardSize();
    if (!raw || typeof raw !== "object") {
        return base;
    }
    ALL_CARDS.forEach(function (id) {
        const fallback = cardDefaultSpan(id);
        const item = raw[id];
        if (!item) {
            return;
        }
        base[id] = {
            x: nearestPreset(clampInt(item.x, 1, GRID_COLUMNS, fallback.x), WIDTH_PRESETS),
            y: nearestPreset(clampInt(item.y, 1, 12, fallback.y), HEIGHT_PRESETS),
        };
    });
    return base;
}

/* ---------------- 快速访问：分组数据 ---------------- */

/**
 * 归一化 Pin 列表。结构：
 *   { groups: [ { id, name, items: [ { id, title, icon, addedAt } ] } ] }
 * 规则：至少有一个分组；同一篇文档全局只 Pin 一次；丢弃缺 id/title 的坏数据。
 */
function normalizeQuick(raw) {
    const source = (raw && Array.isArray(raw.groups)) ? raw.groups : [];
    const seen = {};
    const groups = [];
    source.forEach(function (group) {
        if (!group || typeof group !== "object") {
            return;
        }
        const id = String(group.id || "").trim() || genId();
        if (groups.some((g) => g.id === id)) {
            return;
        }
        const items = [];
        (Array.isArray(group.items) ? group.items : []).forEach(function (item) {
            if (!item || !item.id || !item.title) {
                return;
            }
            const docId = String(item.id);
            if (seen[docId]) {
                return;
            }
            seen[docId] = true;
            items.push({
                id: docId,
                title: String(item.title),
                icon: String(item.icon || ""),
                addedAt: parseInt(item.addedAt, 10) || 0,
            });
        });
        groups.push({ id: id, name: String(group.name || ""), items: items });
    });
    if (!groups.length) {
        groups.push({ id: QUICK_GROUP_DEFAULT, name: "", items: [] });
    }
    if (!groups.some((g) => g.id === QUICK_GROUP_DEFAULT)) {
        groups.unshift({ id: QUICK_GROUP_DEFAULT, name: "", items: [] });
    }
    return { groups: groups };
}

/** Pin 总数 */
function quickCount(quick) {
    return normalizeQuick(quick).groups.reduce((sum, group) => sum + group.items.length, 0);
}

/**
 * 按条目容器「能用的净宽」算出排几列。
 * 这是"横向拉伸 / 屏幕变宽 → 内容自适应"的核心：高度档位不变，越宽列数越多。
 * 手机竖屏（净宽 < QUICK_NARROW_WIDTH）会把最小宽度放松一点，
 * 该单列就单列、排得下两列就两列，不做与屏幕比例无关的硬编码。
 */
function quickColumns(contentWidth, itemMin, gap) {
    const inner = Math.max(0, contentWidth);
    const g = gap > 0 ? gap : QUICK_ITEM_GAP;
    if (!inner) {
        return 1;
    }
    let min = clampInt(itemMin, QUICK_ITEM_MIN_RANGE[0], QUICK_ITEM_MIN_RANGE[1], QUICK_ITEM_MIN_DEFAULT);
    if (inner < QUICK_NARROW_WIDTH) {
        // 窄屏：先算"排两列时每列有多宽"，只要不低于下限就按两列的量来放最小宽度
        const half = Math.floor((inner + g) / 2) - g;
        min = Math.min(min, Math.max(QUICK_NARROW_ITEM_MIN, half));
    }
    return nearestPreset(clampInt(Math.floor((inner + g) / (min + g)), 1, QUICK_COLUMNS_MAX, 1),
        [1, 2, 3, 4, 5, 6, 7, 8]);
}

/**
 * 过长文件名截断：只留前面几个字符，其余用省略号收掉。
 * 完整标题仍然会写进 title 属性，鼠标悬停可看全。
 */
function truncateTitle(text, max) {
    const limit = clampInt(max, 4, 200, QUICK_TITLE_MAX_DEFAULT);
    const str = String(text == null ? "" : text);
    return str.length > limit ? str.slice(0, limit) + "…" : str;
}

/** 给定容器宽度，返回当前允许的宽度档位 */
function allowedWidths(gridWidth) {
    if (!gridWidth) {
        return WIDTH_PRESETS;
    }
    if (gridWidth < 740) {
        return [12];
    }
    if (gridWidth < 1000) {
        return [6, 12];
    }
    return WIDTH_PRESETS;
}

function nearestPreset(value, presets) {
    let best = presets[0];
    presets.forEach(function (preset) {
        if (Math.abs(preset - value) < Math.abs(best - value)) {
            best = preset;
        }
    });
    return best;
}

/** 读取网格的实际度量：内容宽 / 单列宽 / 单行高 / 间距 */
function gridMetrics(grid) {
    const rect = grid.getBoundingClientRect();
    let gap = GRID_GAP_DEFAULT;
    let rowH = GRID_ROW_H_DEFAULT;
    let padX = 0;
    try {
        const cs = window.getComputedStyle(grid);
        const g = parseFloat(cs.columnGap || cs.gap);
        const r = parseFloat(cs.gridAutoRows);
        const pl = parseFloat(cs.paddingLeft);
        const pr = parseFloat(cs.paddingRight);
        if (!isNaN(g) && g > 0) {
            gap = g;
        }
        if (!isNaN(r) && r > 0) {
            rowH = r;
        }
        padX = (isNaN(pl) ? 0 : pl) + (isNaN(pr) ? 0 : pr);
    } catch (err) {
        // 拿不到就用默认值
    }
    // getBoundingClientRect 含 padding，栅格实际可用的是内容宽
    const width = Math.max(0, (rect.width || grid.clientWidth || 0) - padX);
    const colW = width > 0 ? (width - gap * (GRID_COLUMNS - 1)) / GRID_COLUMNS : 0;
    return { width, gap, rowH, colW };
}

/** 把「n 格」换算成实际像素尺寸 */
function spanToPixels(span, unit, gap) {
    return span * unit + (span - 1) * gap;
}

/** 把像素尺寸换算回最接近的档位 */
function pixelsToSpan(pixels, unit, gap, presets) {
    if (!unit) {
        return presets[presets.length - 1];
    }
    const raw = Math.round((pixels + gap) / (unit + gap));
    return nearestPreset(clampInt(raw, 1, 24, 1), presets);
}

const DEFAULT_SETTINGS = {
    onboarded: false,
    // 启动思源时是否自动切到主页。默认关闭：插件升级不该改变用户原有的启动行为，
    // 也不该在用户还没看过引导时就抢走首屏。
    openOnLaunch: false,
    userName: "",            // 默认留空，由引导或设置面板填写
    suffixMode: "daily",       // daily = 每天从诗句池换一句，custom = 固定一句
    greetingSuffix: "",
    background: "",
    backgroundBlur: 0,
    backgroundDim: 28,
    showSearch: true,
    cardOrder: ALL_CARDS.slice(),
    hiddenCards: [],
    cardSize: defaultCardSize(),
    recentCount: 8,
    noteCount: 5,
    quickItemMin: QUICK_ITEM_MIN_DEFAULT,
    // 灵感的归宿：{ type: "none" | "notebook" | "doc", notebook, docId, docPath }
    noteTarget: { type: "none", notebook: "", docId: "", docPath: "" },
    weekStart: 1,
    dailyPath: "/日记/{yyyy}/{yyyy-MM-dd}",
};

const SEARCH_DEBOUNCE = 220;
const SEARCH_LIMIT = 12;

/**
 * 「打开思源时进入主页」等待多久再开。
 *
 * 为什么不是「立刻」：思源启动时有自己的一段收尾 —— 恢复完布局和上次的标签、
 * 触发插件的 onLayoutReady 之后，还会在 TIMEOUT_TRANSITION（300ms）后跑一次
 * 标签栏重算。等过这一下再切，主页就不会和思源的收尾动作抢焦点。
 *
 * 为什么不需要更久：思源是先 `pluginManager.setLayoutReady()` 再回调插件的
 * onLayoutReady，也就是说插件拿到 onLayoutReady 时，上次的标签早就恢复完了，
 * 不存在「抢在前头开标签、随后被恢复的标签盖掉」的问题。
 */
const LAUNCH_HOMEPAGE_DELAY = 300;


/* ------------------------------------------------------------------ *
 * 图标
 * 注意：fill / stroke 必须写在 style 里。写成 SVG 表现属性（fill="none"）时
 * 优先级低于样式表规则，会被思源主题的 svg 规则覆盖成实心黑块。
 * ------------------------------------------------------------------ */

const STROKE_ICON = 'fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;display:block';

const ICONS = {
    home: '<svg viewBox="0 0 24 24" style="width:16px;height:16px;' + STROKE_ICON + ';stroke-width:1.9"><path d="M3.2 10.6 12 3.4l8.8 7.2"/><path d="M5.6 9.6v10.6h12.8V9.6"/><path d="M9.8 20.2v-5.1h4.4v5.1"/></svg>',
    recent: '<svg viewBox="0 0 24 24" style="width:16px;height:16px;' + STROKE_ICON + ';stroke-width:1.8"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.1 1.9"/></svg>',
    spark: '<svg viewBox="0 0 24 24" style="width:16px;height:16px;' + STROKE_ICON + ';stroke-width:1.8"><path d="M12 3.6l1.9 5.1 5.1 1.9-5.1 1.9L12 17.6l-1.9-5.1L5 10.6l5.1-1.9z"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" style="width:16px;height:16px;' + STROKE_ICON + ';stroke-width:1.8"><rect x="3.4" y="5.2" width="17.2" height="15.4" rx="2.6"/><path d="M3.4 10h17.2M8.4 3.4v3.6M15.6 3.4v3.6"/></svg>',
    stats: '<svg viewBox="0 0 24 24" style="width:16px;height:16px;' + STROKE_ICON + ';stroke-width:1.9"><path d="M5 20V11.4M12 20V4.6M19 20v-6.4"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" style="width:15px;height:15px;' + STROKE_ICON + ';stroke-width:1.9"><path d="M20 11.4a8 8 0 1 0-2.5 6.2"/><path d="M20 4.8v6.6h-6.6"/></svg>',
    prev: '<svg viewBox="0 0 24 24" style="width:15px;height:15px;' + STROKE_ICON + ';stroke-width:2.1"><path d="M14.6 5.6 8 12l6.6 6.4"/></svg>',
    next: '<svg viewBox="0 0 24 24" style="width:15px;height:15px;' + STROKE_ICON + ';stroke-width:2.1"><path d="M9.4 5.6 16 12l-6.6 6.4"/></svg>',
    close: '<svg viewBox="0 0 24 24" style="width:16px;height:16px;' + STROKE_ICON + ';stroke-width:2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    search: '<svg viewBox="0 0 24 24" style="width:16px;height:16px;' + STROKE_ICON + ';stroke-width:1.9"><circle cx="10.8" cy="10.8" r="6.4"/><path d="M15.6 15.6 20.4 20.4"/></svg>',
    doc: '<svg viewBox="0 0 24 24" style="width:15px;height:15px;' + STROKE_ICON + ';stroke-width:1.7"><path d="M6 2.8h7.4L18 7.4v13.8H6z"/><path d="M13.2 2.8v4.8H18"/></svg>',
    trash: '<svg viewBox="0 0 24 24" style="width:14px;height:14px;' + STROKE_ICON + ';stroke-width:1.8"><path d="M4.6 6.8h14.8M9.4 6.8V4.6h5.2v2.2M6.6 6.8l.9 13h9l.9-13"/></svg>',
    grip: '<svg viewBox="0 0 24 24" style="width:14px;height:14px;display:block;fill:currentColor;stroke:none"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
    resize: '<svg viewBox="0 0 24 24" style="width:14px;height:14px;display:block;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round"><path d="M20.4 13.2 13.2 20.4M20.4 19.2l-1.2 1.2"/></svg>',
    check: '<svg viewBox="0 0 24 24" style="width:16px;height:16px;' + STROKE_ICON + ';stroke-width:2.2"><path d="M4.8 12.4 9.6 17.2 19.2 7.2"/></svg>',
    quick: '<svg viewBox="0 0 24 24" style="width:16px;height:16px;' + STROKE_ICON + ';stroke-width:1.8"><path d="M14.4 3.6 20.4 9.6l-3 1.2-2.4 2.4-1.2 3-6-6 3-1.2 2.4-2.4z"/><path d="M8.4 15.6 4.2 19.8"/></svg>',
    pin: '<svg viewBox="0 0 24 24" style="width:14px;height:14px;' + STROKE_ICON + ';stroke-width:1.8"><path d="M14.4 3.6 20.4 9.6l-3 1.2-2.4 2.4-1.2 3-6-6 3-1.2 2.4-2.4z"/><path d="M8.4 15.6 4.2 19.8"/></svg>',
    pinOn: '<svg viewBox="0 0 24 24" style="width:14px;height:14px;display:block;fill:currentColor;stroke:none"><path d="M15.1 3.1a.9.9 0 0 1 1.3 0l4.5 4.5a.9.9 0 0 1-.65 1.54l-2.3.23-2.4 2.4-.96 3.06a.9.9 0 0 1-1.48.36l-2.4-2.4-3.9 3.9a.9.9 0 0 1-1.27-1.27l3.9-3.9-2.4-2.4a.9.9 0 0 1 .36-1.48l3.06-.96 2.4-2.4.23-2.3a.9.9 0 0 1 .26-.6z"/></svg>',
    folder: '<svg viewBox="0 0 24 24" style="width:15px;height:15px;' + STROKE_ICON + ';stroke-width:1.8"><path d="M3.6 6.6a1.8 1.8 0 0 1 1.8-1.8h3.3l1.8 2.1h8.1a1.8 1.8 0 0 1 1.8 1.8v9.9a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" style="width:15px;height:15px;' + STROKE_ICON + ';stroke-width:2.1"><path d="M12 5.4v13.2M5.4 12h13.2"/></svg>',
    more: '<svg viewBox="0 0 24 24" style="width:15px;height:15px;display:block;fill:currentColor;stroke:none"><circle cx="5.6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.4" cy="12" r="1.6"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" style="width:14px;height:14px;' + STROKE_ICON + ';stroke-width:1.8"><path d="M16.4 4.2l3.4 3.4-9.6 9.6-4.2.8.8-4.2z"/><path d="M14.2 6.4l3.4 3.4"/></svg>',
    folderPlus: '<svg viewBox="0 0 24 24" style="width:15px;height:15px;' + STROKE_ICON + ';stroke-width:1.8"><path d="M3.6 6.6a1.8 1.8 0 0 1 1.8-1.8h3.3l1.8 2.1h8.1a1.8 1.8 0 0 1 1.8 1.8v9.9a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M12 11.4v5M9.5 13.9h5"/></svg>',
};

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

function esc(str) {
    return String(str == null ? "" : str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** SQL 字面量转义（内核的 /api/query/sql 接受裸 SQL） */
function sqlQuote(str) {
    return "'" + String(str == null ? "" : str).replace(/'/g, "''") + "'";
}

function pad2(n) {
    return n < 10 ? "0" + n : String(n);
}

function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (isNaN(n)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, n));
}

/**
 * 开关类设置的归一化。
 *
 * 设置面板存进去的永远是布尔值，这里主要是为了兜住两种情况：
 *   1) 老版本的 settings.json 里没有这个键 —— 落到 fallback（新开关一律 false，
 *      升级不会悄悄改变用户原有的行为）；
 *   2) 用户手改了 settings.json，写成 "true" / 1 / on 这类非布尔写法。
 */
function normalizeSwitch(value, fallback) {
    const dft = fallback === true;
    if (value === undefined || value === null || value === "") {
        return dft;
    }
    if (typeof value === "boolean") {
        return value;
    }
    if (value === 1 || value === 0) {
        return value === 1;
    }
    const text = String(value).trim().toLowerCase();
    if (text === "true" || text === "1" || text === "on" || text === "yes") {
        return true;
    }
    if (text === "false" || text === "0" || text === "off" || text === "no") {
        return false;
    }
    return dft;
}

function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function deepCopy(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeOrder(order) {
    const out = [];
    (Array.isArray(order) ? order : []).forEach(function (id) {
        if (ALL_CARDS.indexOf(id) >= 0 && out.indexOf(id) < 0) {
            out.push(id);
        }
    });
    ALL_CARDS.forEach(function (id) {
        if (out.indexOf(id) < 0) {
            out.push(id);
        }
    });
    return out;
}

function toBgUrl(value) {
    const v = String(value || "").trim();
    if (!v) {
        return "";
    }
    if (/^(https?:)?\/\//i.test(v) || /^data:/i.test(v)) {
        return v;
    }
    return "/" + v.replace(/^\.?\//, "");
}

function docIconText(icon) {
    if (!icon) {
        return "";
    }
    try {
        const code = parseInt(icon, 16);
        if (isNaN(code) || code < 0) {
            return "";
        }
        return String.fromCodePoint(code);
    } catch (err) {
        return "";
    }
}

function toDayKey(date) {
    return date.getFullYear() + pad2(date.getMonth() + 1) + pad2(date.getDate());
}

function fmtRelative(ts) {
    if (!ts) {
        return "";
    }
    const ms = ts > 1e12 ? ts : (ts > 1e9 ? ts * 1000 : 0);
    if (!ms) {
        return "";
    }
    const diff = Date.now() - ms;
    if (diff < 0) {
        return "";
    }
    const min = Math.floor(diff / 60000);
    if (min < 1) {
        return "刚刚";
    }
    if (min < 60) {
        return min + " 分钟前";
    }
    const hour = Math.floor(min / 60);
    const d = new Date(ms);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (hour < 24 &&
        d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) {
        return hour + " 小时前";
    }
    if (d.getFullYear() === yesterday.getFullYear() && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate()) {
        return "昨天";
    }
    if (d.getFullYear() === new Date().getFullYear()) {
        return pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    }
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function fmtClock(date) {
    return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
}

/** 千分位 */
function fmtCount(n) {
    const value = Number(n) || 0;
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 秒 → 「2 小时 15 分」 */
function fmtDuration(seconds, t) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    if (total < 60) {
        return (t ? t("durationUnderMinute", "不到 1 分钟") : "不到 1 分钟");
    }
    const minutes = Math.floor(total / 60);
    if (minutes < 60) {
        return (t ? t("durationMinutes", "{n} 分钟").split("{n}").join(String(minutes)) : minutes + " 分钟");
    }
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    const hourText = t ? t("durationHours", "{n} 小时").split("{n}").join(String(hours)) : hours + " 小时";
    return rest ? hourText + " " + rest + " 分" : hourText;
}

function expandPath(tpl, date) {
    const map = {
        "yyyy-MM-dd": date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate()),
        "yyyy": String(date.getFullYear()),
        "yy": String(date.getFullYear()).slice(2),
        "MM": pad2(date.getMonth() + 1),
        "dd": pad2(date.getDate()),
        "M": String(date.getMonth() + 1),
        "d": String(date.getDate()),
    };
    let out = String(tpl || "");
    ["yyyy-MM-dd", "yyyy", "yy", "MM", "dd", "M", "d"].forEach(function (key) {
        out = out.split("{" + key + "}").join(map[key]);
    });
    out = out.replace(/\/{2,}/g, "/");
    if (out.charAt(0) !== "/") {
        out = "/" + out;
    }
    return out.replace(/\/+$/, "") || "/";
}

/** 从 hpath（/笔记本/父文档/本文档）里取父级路径，用于搜索结果的副标题 */
function parentPathLabel(hpath, title) {
    let path = String(hpath || "");
    if (!path) {
        return "";
    }
    const segs = path.split("/").filter(function (s) {
        return s !== "";
    });
    if (segs.length && title && segs[segs.length - 1] === title) {
        segs.pop();
    }
    return segs.join(" / ");
}

async function api(url, data) {
    try {
        const res = await fetchSyncPost(url, data || {});
        if (res && typeof res === "object") {
            return res;
        }
        return { code: -1, msg: "empty response" };
    } catch (err) {
        return { code: -1, msg: String(err) };
    }
}

function prefersReducedMotion() {
    try {
        return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (err) {
        return false;
    }
}

/* ------------------------------------------------------------------ *
 * 卡片拖拽排序
 *
 * 关键点：网格里卡片高度不一致，不能用「指针 Y 是否小于目标卡片中心 Y」
 * 这种一维判断，否则矮卡片永远无法拖到高卡片右侧。
 * 正确做法是先按 rect.top 分行，再在行内按 X 定位插入点。
 * ------------------------------------------------------------------ */

const DRAG_THRESHOLD = 6;
const DRAG_EDGE = 64;
const DRAG_SPEED = 14;
const ROW_TOLERANCE = 14;

function attachSortable(grid, onDrop) {
    let state = null;
    let suppressClick = false;

    const removeListeners = function () {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
    };

    const isInteractive = function (target) {
        return !!target.closest("input, textarea, button, a, select, [contenteditable='true'], .fh-nodrag, .fh-card__resize, .fh-quick__item, .fh-quick__grip, .fh-quick__head, .fh-menu");
    };

    /**
     * 读取元素的「布局位置」，把正在进行的 FLIP 位移剥掉。
     * 直接用 getBoundingClientRect() 的话，过渡动画进行中拿到的是插值后的中间位置，
     * 连续 pointermove 会算出错误的位移量，表现为位移动画时有时无、看着像没触发。
     */
    const layoutRect = function (node) {
        const rect = node.getBoundingClientRect();
        let dx = 0;
        let dy = 0;
        try {
            const transform = window.getComputedStyle(node).transform;
            const matched = transform && transform !== "none" ? transform.match(/^matrix\(([^)]+)\)$/) : null;
            if (matched) {
                const parts = matched[1].split(",").map(parseFloat);
                dx = parts[4] || 0;
                dy = parts[5] || 0;
            }
        } catch (err) {
            // 忽略，按无位移处理
        }
        return { left: rect.left - dx, top: rect.top - dy };
    };

    const siblings = function () {
        return Array.prototype.filter.call(grid.children, function (node) {
            return node.classList.contains("fh-card") && node !== state.card;
        });
    };

    const beginDrag = function (event) {
        const card = state.card;
        const rect = card.getBoundingClientRect();
        const placeholder = document.createElement("div");
        placeholder.className = "fh-ph";
        // 占位符要和被拖的卡片占同样的栅格，否则布局会跳
        placeholder.style.setProperty("--fh-span-x", card.getAttribute("data-span-x") || String(cardDefaultSpan(card.getAttribute("data-card-id")).x));
        placeholder.style.setProperty("--fh-span-y", card.getAttribute("data-span-y") || String(cardDefaultSpan(card.getAttribute("data-card-id")).y));
        grid.insertBefore(placeholder, card);

        state.placeholder = placeholder;
        state.offX = state.startX - rect.left;
        state.offY = state.startY - rect.top;
        state.scroller = card.closest(".fh-inner");
        state.started = true;

        card.style.position = "fixed";
        card.style.left = rect.left + "px";
        card.style.top = rect.top + "px";
        card.style.width = rect.width + "px";
        card.style.height = rect.height + "px";
        card.style.margin = "0";
        card.style.zIndex = "99";
        card.style.pointerEvents = "none";
        card.classList.add("fh-card--dragging");
        grid.classList.add("fh-grid--sorting");
    };

    /** 先分行，再在行内按 X 决定插到哪张卡片之前 */
    const computeTarget = function (event) {
        const cards = siblings();
        if (!cards.length) {
            return { ref: null, before: false };
        }
        const rows = [];
        cards.forEach(function (node) {
            const rect = node.getBoundingClientRect();
            const last = rows[rows.length - 1];
            if (last && Math.abs(last.top - rect.top) < ROW_TOLERANCE) {
                last.items.push({ node: node, rect: rect });
                last.bottom = Math.max(last.bottom, rect.bottom);
            } else {
                rows.push({ top: rect.top, bottom: rect.bottom, items: [{ node: node, rect: rect }] });
            }
        });

        let row = null;
        for (let i = 0; i < rows.length; i++) {
            if (event.clientY >= rows[i].top - 10 && event.clientY <= rows[i].bottom + 10) {
                row = rows[i];
                break;
            }
        }
        if (!row) {
            let bestDist = Infinity;
            rows.forEach(function (item) {
                const d = event.clientY < item.top
                    ? item.top - event.clientY
                    : (event.clientY > item.bottom ? event.clientY - item.bottom : 0);
                if (d < bestDist) {
                    bestDist = d;
                    row = item;
                }
            });
        }

        for (let i = 0; i < row.items.length; i++) {
            const item = row.items[i];
            if (event.clientX < item.rect.left + item.rect.width / 2) {
                return { ref: item.node, before: true };
            }
        }
        return { ref: row.items[row.items.length - 1].node, before: false };
    };

    /**
     * 把占位符移到目标位置。ref 表示「插到 ref 之前」，ref 为 null 表示放到最后。
     * 只有位置真的会变才动 DOM 并跑 FLIP —— 否则每个 pointermove 都会白跑一次
     * FLIP 里的强制重排，把动画帧预算吃掉。
     */
    const movePlaceholder = function (target) {
        const ref = target.ref
            ? (target.before ? target.ref : target.ref.nextElementSibling)
            : null;
        // ref 就是占位符自己，或占位符已经紧贴在它前面 → 位置没变
        if (ref === state.placeholder || state.placeholder.nextElementSibling === ref) {
            return;
        }

        const animatable = siblings();
        const before = animatable.map(layoutRect);

        if (ref) {
            grid.insertBefore(state.placeholder, ref);
        } else {
            grid.appendChild(state.placeholder);
        }

        if (prefersReducedMotion()) {
            return;
        }

        const moved = [];
        animatable.forEach(function (node, i) {
            const after = layoutRect(node);
            const dx = before[i].left - after.left;
            const dy = before[i].top - after.top;
            if (dx || dy) {
                moved.push({ node: node, dx: dx, dy: dy });
            }
        });
        if (!moved.length) {
            return;
        }
        moved.forEach(function (item) {
            item.node.style.transition = "none";
            item.node.style.transform = "translate(" + item.dx + "px," + item.dy + "px)";
        });
        void grid.offsetWidth;
        moved.forEach(function (item) {
            item.node.style.transition = "transform .21s cubic-bezier(.2,.8,.3,1)";
            item.node.style.transform = "";
        });
    };

    const autoScroll = function (event) {
        const scroller = state.scroller;
        if (!scroller) {
            return;
        }
        const rect = scroller.getBoundingClientRect();
        if (event.clientY < rect.top + DRAG_EDGE) {
            scroller.scrollTop -= DRAG_SPEED;
        } else if (event.clientY > rect.bottom - DRAG_EDGE) {
            scroller.scrollTop += DRAG_SPEED;
        }
    };

    function onMove(event) {
        if (!state) {
            return;
        }
        if (!state.started) {
            if (Math.abs(event.clientX - state.startX) < DRAG_THRESHOLD &&
                Math.abs(event.clientY - state.startY) < DRAG_THRESHOLD) {
                return;
            }
            beginDrag(event);
        }
        if (event.cancelable) {
            event.preventDefault();
        }
        state.card.style.left = (event.clientX - state.offX) + "px";
        state.card.style.top = (event.clientY - state.offY) + "px";
        movePlaceholder(computeTarget(event));
        autoScroll(event);
    }

    function onUp() {
        if (!state) {
            return;
        }
        const finished = state.started;
        if (finished) {
            const card = state.card;
            state.placeholder.replaceWith(card);
            // 只清拖拽期间写上的属性，不能整个 removeAttribute("style")，
            // 否则会把卡片尺寸用的 --fh-span-x / --fh-span-y 一起抹掉
            ["position", "left", "top", "width", "height", "margin", "z-index",
                "pointer-events", "transition", "transform"].forEach(function (prop) {
                card.style.removeProperty(prop);
            });
            card.classList.remove("fh-card--dragging");
            grid.classList.remove("fh-grid--sorting");
            // 收尾：清掉 FLIP 留下的内联 transition / transform，
            // 只在确实写过的时候才碰 style，避免生成空的 style="" 属性
            Array.prototype.forEach.call(grid.querySelectorAll(".fh-card"), function (node) {
                if (node.style.transition) {
                    node.style.removeProperty("transition");
                }
                if (node.style.transform) {
                    node.style.removeProperty("transform");
                }
                if (node.getAttribute("style") === "") {
                    node.removeAttribute("style");
                }
            });
            suppressClick = true;
            onDrop(Array.prototype.filter.call(grid.children, function (node) {
                return node.classList.contains("fh-card");
            }).map(function (node) {
                return node.getAttribute("data-card-id");
            }));
        }
        removeListeners();
        state = null;
    }

    grid.addEventListener("pointerdown", function (event) {
        // 上一次拖拽留下的"吞掉点击"标记在这里失效：
        // 鼠标拖拽后浏览器一定会补一个 click（会被 consume），但触屏/触控笔拖拽后
        // 往往没有 click，标记就会一直挂着，把之后一次无关的点击也吃掉。
        suppressClick = false;
        if (event.pointerType === "mouse" && event.button !== 0) {
            return;
        }
        const card = event.target.closest(".fh-card");
        if (!card || !grid.contains(card)) {
            return;
        }
        if (isInteractive(event.target)) {
            return;
        }
        // 触屏/笔：只有按住抓手才能拖动，避免和页面滚动打架
        if (event.pointerType !== "mouse" && !event.target.closest(".fh-card__grip")) {
            return;
        }
        state = {
            card: card,
            startX: event.clientX,
            startY: event.clientY,
            started: false,
            placeholder: null,
            scroller: null,
        };
        window.addEventListener("pointermove", onMove, { passive: false });
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    });

    // 拖动结束的那一次 click 不应该触发卡片内的点击行为
    grid.addEventListener("click", function (event) {
        if (suppressClick) {
            suppressClick = false;
            event.stopPropagation();
            event.preventDefault();
        }
    }, true);
}

/* ------------------------------------------------------------------ *
 * 卡片拖动缩放
 *
 * 尺寸不是无极的：宽度吸附到 12 栅格的预设档位（1/4 1/3 1/2 2/3 全宽），
 * 高度吸附到固定行高档位（3-6 行）。这样无论怎么拖，卡片之间永远对齐。
 * ------------------------------------------------------------------ */

function attachResizable(grid, options) {
    let state = null;

    const removeListeners = function () {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
    };

    const applySpan = function (span) {
        state.card.setAttribute("data-span-x", String(span.x));
        state.card.setAttribute("data-span-y", String(span.y));
        state.card.style.setProperty("--fh-span-x", String(span.x));
        state.card.style.setProperty("--fh-span-y", String(span.y));
    };

    const showBadge = function (event) {
        const root = grid.closest(".fh-root");
        if (!root || !options.label) {
            return;
        }
        let badge = root.querySelector("[data-fh-size-badge]");
        if (!badge) {
            badge = document.createElement("div");
            badge.className = "fh-size-badge";
            badge.setAttribute("data-fh-size-badge", "1");
            root.appendChild(badge);
        }
        badge.textContent = options.label(state.span);
        badge.style.left = (event.clientX + 16) + "px";
        badge.style.top = (event.clientY + 16) + "px";
        badge.classList.add("fh-size-badge--on");
    };

    const hideBadge = function () {
        const root = grid.closest(".fh-root");
        const badge = root ? root.querySelector("[data-fh-size-badge]") : null;
        if (badge) {
            badge.remove();
        }
    };

    function onMove(event) {
        if (!state) {
            return;
        }
        if (!state.started) {
            if (Math.abs(event.clientX - state.startX) < 3 && Math.abs(event.clientY - state.startY) < 3) {
                return;
            }
            state.started = true;
            state.card.classList.add("fh-card--resizing");
            grid.classList.add("fh-grid--resizing");
            state.span = { x: state.startSpan.x, y: state.startSpan.y };
        }
        if (event.cancelable) {
            event.preventDefault();
        }

        const metrics = state.metrics;
        const widths = allowedWidths(metrics.width);
        const nextX = pixelsToSpan(state.startW + (event.clientX - state.startX), metrics.colW, metrics.gap, widths);
        const nextY = pixelsToSpan(state.startH + (event.clientY - state.startY), metrics.rowH, metrics.gap, HEIGHT_PRESETS);

        if (nextX !== state.span.x || nextY !== state.span.y) {
            state.span = { x: nextX, y: nextY };
            applySpan(state.span);
            // 吸附脉冲：让"跳到下一档"这件事看得见
            state.card.classList.remove("fh-card--snap");
            void state.card.offsetWidth;
            state.card.classList.add("fh-card--snap");
        }
        showBadge(event);
    }

    function onUp() {
        if (!state) {
            return;
        }
        const finished = state.started;
        const cardId = state.card.getAttribute("data-card-id");
        const span = state.span;
        const card = state.card;
        removeListeners();
        hideBadge();
        card.classList.remove("fh-card--resizing", "fh-card--snap");
        grid.classList.remove("fh-grid--resizing");
        state = null;
        if (finished && options.onChange) {
            options.onChange(cardId, span);
        }
    }

    grid.addEventListener("pointerdown", function (event) {
        const handle = event.target.closest(".fh-card__resize");
        if (!handle) {
            return;
        }
        if (event.pointerType === "mouse" && event.button !== 0) {
            return;
        }
        const card = handle.closest(".fh-card");
        if (!card) {
            return;
        }
        event.preventDefault();
        const rect = card.getBoundingClientRect();
        state = {
            card: card,
            startX: event.clientX,
            startY: event.clientY,
            startW: rect.width,
            startH: rect.height,
            metrics: gridMetrics(grid),
            startSpan: {
                x: parseInt(card.getAttribute("data-span-x"), 10) || cardDefaultSpan(card.getAttribute("data-card-id")).x,
                y: parseInt(card.getAttribute("data-span-y"), 10) || cardDefaultSpan(card.getAttribute("data-card-id")).y,
            },
            span: null,
            started: false,
        };
        window.addEventListener("pointermove", onMove, { passive: false });
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    });
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */

class ForestHomepage extends Plugin {

    /* ---------------- 生命周期 ---------------- */

    async onload() {
        this.isMobile = ["mobile", "browser-mobile"].indexOf(getFrontend()) >= 0;
        this.isReadonly = Boolean(window.siyuan && (window.siyuan.config.readonly || window.siyuan.isPublish));
        this.views = new Set();
        this.overlayEl = null;
        this.notebooks = [];
        this.__draft = null;
        this.searchTimer = null;
        this.__launchTimer = null;
        this.__launchHandled = false;

        const saved = await this.loadData(SETTINGS_FILE);
        this.settings = deepCopy(DEFAULT_SETTINGS);
        Object.assign(this.settings, saved || {});
        this.settings.cardOrder = normalizeOrder(this.settings.cardOrder);
        this.settings.hiddenCards = Array.isArray(this.settings.hiddenCards)
            ? this.settings.hiddenCards.filter((id) => ALL_CARDS.indexOf(id) >= 0)
            : [];
        this.settings.recentCount = clampInt(this.settings.recentCount, 3, 30, 8);
        this.settings.noteCount = clampInt(this.settings.noteCount, 3, 30, 5);
        this.settings.quickItemMin = clampInt(this.settings.quickItemMin,
            QUICK_ITEM_MIN_RANGE[0], QUICK_ITEM_MIN_RANGE[1], QUICK_ITEM_MIN_DEFAULT);
        this.settings.cardSize = normalizeCardSize(this.settings.cardSize);
        this.settings.openOnLaunch = normalizeSwitch(this.settings.openOnLaunch, DEFAULT_SETTINGS.openOnLaunch);

        // 0.2.x 用的是 noteNotebook，迁移到更通用的 noteTarget
        if (saved && saved.noteNotebook && !(saved.noteTarget && saved.noteTarget.type && saved.noteTarget.type !== "none")) {
            this.settings.noteTarget = { type: "notebook", notebook: saved.noteNotebook, docId: "", docPath: "" };
        }
        delete this.settings.noteNotebook;
        const target = this.settings.noteTarget || {};
        this.settings.noteTarget = {
            type: ["none", "notebook", "doc"].indexOf(target.type) >= 0 ? target.type : "none",
            notebook: String(target.notebook || ""),
            docId: String(target.docId || ""),
            docPath: String(target.docPath || ""),
        };

        const noteData = await this.loadData(NOTES_FILE);
        this.notes = (noteData && Array.isArray(noteData.items)) ? noteData.items : [];

        // 快速访问：手动 Pin 的文档，按分组保存
        this.quick = normalizeQuick(await this.loadData(QUICK_FILE));
        this.quickMenuEl = null;

        // 使用时长账本（思源没有这个数据，只能自己累计）
        const usageData = await this.loadData(USAGE_FILE);
        this.usage = (usageData && usageData.days && typeof usageData.days === "object")
            ? { since: String(usageData.since || ""), days: usageData.days }
            : { since: "", days: {} };
        this.usageDirty = false;
        this.startUsageTracking();

        // 必须在 onload 里就把 Setting 实例挂上，否则插件列表里的「设置」按钮点不动
        this.initSetting();

        this.addCommand({
            langKey: "openHomepage",
            hotkey: "",
            callback: () => {
                this.openHomepage();
            },
        });
        this.addCommand({
            langKey: "focusSearch",
            hotkey: "",
            callback: () => {
                this.openHomepage();
                window.setTimeout(() => this.focusSearch(), 260);
            },
        });

        const plugin = this;
        this.addTab({
            type: TAB_TYPE,
            init() {
                plugin.mountView(this.element, { kind: "tab" });
            },
            destroy() {
                plugin.unmountView(this.element);
            },
        });
    }

    onLayoutReady() {
        const plugin = this;
        this.addTopBar({
            icon: ICONS.home,
            title: this.t("returnHome", "返回主页"),
            position: "left",
            callback: () => {
                this.openHomepage();
            },
            contextMenu: (menu) => {
                menu.addItem({
                    icon: "iconSettings",
                    label: plugin.t("menuSettings", "主页设置"),
                    click: () => plugin.openSettings(),
                });
                menu.addItem({
                    icon: "iconSparkles",
                    label: plugin.t("menuOnboarding", "重新运行引导"),
                    click: () => plugin.showOnboarding(true),
                });
            },
        });

        this.refreshNotebooks();

        // 首次安装：自动进入引导
        if (!this.settings.onboarded) {
            window.setTimeout(() => {
                if (!this.settings.onboarded) {
                    this.showOnboarding(false);
                }
            }, 700);
        }

        // 启动即进主页：开关开着才排队，且只在本次启动里跑一次
        if (this.settings.openOnLaunch) {
            this.scheduleLaunchHomepage();
        }
    }

    onunload() {
        this.stopUsageTracking();
        this.closeDocMenu();
        if (this.__launchTimer) {
            window.clearTimeout(this.__launchTimer);
            this.__launchTimer = null;
        }
        this.views.forEach((view) => {
            this.stopClock(view);
            this.teardownSearch(view);
            this.teardownDocMenu(view);
        });
        this.views.clear();
        if (this.searchTimer) {
            window.clearTimeout(this.searchTimer);
            this.searchTimer = null;
        }
        if (this.overlayEl) {
            this.overlayEl.remove();
            this.overlayEl = null;
        }
        if (this.onboardingDialog) {
            try {
                this.onboardingDialog.destroy();
            } catch (err) {
                // 忽略
            }
            this.onboardingDialog = null;
        }
    }

    /* ---------------- 文案 ---------------- */

    t(key, fallback) {
        const value = this.i18n ? this.i18n[key] : "";
        if (value === undefined || value === null || value === "") {
            return fallback === undefined ? key : fallback;
        }
        return String(value);
    }

    tList(key, fallback) {
        const value = this.i18n ? this.i18n[key] : null;
        if (Array.isArray(value) && value.length) {
            return value.slice();
        }
        return (fallback || []).slice();
    }

    /** 用中文字符集判断是否为中文界面，够用且不依赖内部字段 */
    get isZh() {
        return !(this.i18n && this.i18n.weekdays && String(this.i18n.weekdays).indexOf("Mon") >= 0);
    }

    /* ---------------- 打开主页 ---------------- */

    /**
     * 设置项「打开思源时进入主页」。
     *
     * 生效时机：下次启动思源时。设置面板是「确定后保存」的草稿式面板，开关本身
     * 属于启动行为 —— 本次启动的时刻早就过去了，所以切换开关不会当场打开或关闭
     * 主页标签，只影响下一次启动。
     *
     * 时序：思源启动时先把 config.uiLayout 里的布局与上次的标签恢复好，再调用
     * pluginManager.setLayoutReady() —— 插件的 onLayoutReady 正是被它触发的。
     * 所以在这里开标签不会被恢复流程盖掉，只需让过思源自己那次 300ms 的标签栏
     * 重算（见 LAUNCH_HOMEPAGE_DELAY）。
     *
     * 已经打开着主页标签（含被思源恢复出来的那个）时，openTab 会直接切过去，
     * 不会重复开第二个 —— 复用的是同一个 custom.id。
     */
    scheduleLaunchHomepage() {
        if (this.__launchHandled) {
            return;      // 一次启动只排一次队
        }
        this.__launchHandled = true;
        this.__launchTimer = window.setTimeout(() => {
            this.__launchTimer = null;
            // 排队期间用户在设置里把开关关掉了，就不要再开
            if (!this.settings.openOnLaunch) {
                return;
            }
            // 首次安装：引导自带「进入主页」收尾，别去抢它的位置
            if (!this.settings.onboarded) {
                return;
            }
            // 手机端主页是整屏浮层，启动就被盖住一层没法用，只做桌面端
            if (this.isMobile) {
                return;
            }
            // 只读 / 发布模式不主动开标签
            if (this.isReadonly) {
                return;
            }
            this.openHomepage();
        }, LAUNCH_HOMEPAGE_DELAY);
    }

    openHomepage() {
        if (this.isMobile) {
            this.openOverlay();
            return;
        }
        const tab = openTab({
            app: this.app,
            custom: {
                id: this.name + TAB_TYPE,
                title: this.t("tabTitle", "主页"),
                icon: "",
                data: {},
            },
        });
        if (!tab) {
            this.openOverlay();
        }
    }

    focusSearch() {
        const view = this.views.values().next().value;
        if (!view || !view.el.isConnected) {
            return;
        }
        const input = view.root.querySelector("[data-fh-search-input]");
        if (input) {
            input.focus();
            input.select();
        }
    }

    openOverlay() {
        if (this.overlayEl && document.contains(this.overlayEl)) {
            return;
        }
        const overlay = document.createElement("div");
        overlay.className = "fh-overlay";
        const box = document.createElement("div");
        box.className = "fh-overlay__box";
        overlay.appendChild(box);
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                this.closeOverlay();
            }
        });
        document.body.appendChild(overlay);
        this.overlayEl = overlay;
        this.mountView(box, { kind: "overlay" });
    }

    closeOverlay() {
        if (!this.overlayEl) {
            return;
        }
        const box = this.overlayEl.querySelector(".fh-overlay__box");
        if (box) {
            this.unmountView(box);
        }
        this.overlayEl.remove();
        this.overlayEl = null;
    }

    /* ---------------- 视图挂载 ---------------- */

    mountView(container, options) {
        if (!container) {
            return;
        }
        if (container.__fhView) {
            this.refreshView(container.__fhView);
            return;
        }
        container.classList.add("fh-host");
        container.innerHTML = "";

        const now = new Date();
        const view = {
            el: container,
            kind: (options && options.kind) || "tab",
            root: null,
            grid: null,
            timer: null,
            docClickHandler: null,
            searchFocused: false,
            state: {
                year: now.getFullYear(),
                month: now.getMonth(),
                selectedDay: null,
                activity: {},
                dayDocs: null,
                dayLoading: false,
                recent: null,
                stats: null,
                search: null,
                searchQuery: "",
                searchLoading: false,
                searchIndex: -1,
                poemKey: "",
                menuDoc: null,
            },
        };
        container.__fhView = view;

        const root = document.createElement("div");
        root.className = "fh-root";
        root.innerHTML =
            '<div class="fh-bg" data-fh-bg></div>' +
            '<div class="fh-veil"></div>' +
            '<div class="fh-inner">' +
            '  <header class="fh-hero">' +
            '    <h1 class="fh-hero__hi" data-fh-hi></h1>' +
            '    <p class="fh-hero__line" data-fh-line></p>' +
            '    <div class="fh-hero__meta" data-fh-meta></div>' +
            '    <div class="fh-search" data-fh-search>' +
            '      <span class="fh-search__icon">' + ICONS.search + "</span>" +
            '      <input class="fh-search__input" data-fh-search-input type="text" spellcheck="false" autocomplete="off">' +
            '      <button class="fh-search__clear" data-act="search-clear" tabindex="-1">' + ICONS.close + "</button>" +
            '      <div class="fh-search__panel" data-fh-search-panel></div>' +
            "    </div>" +
            (view.kind === "overlay"
                ? '    <button class="fh-hero__close" data-act="close-home" title="' + esc(this.t("closeHome", "关闭主页")) + '">' + ICONS.close + "</button>"
                : "") +
            "  </header>" +
            '  <div class="fh-grid" data-fh-grid></div>' +
            "</div>";
        container.appendChild(root);
        view.root = root;
        view.grid = root.querySelector("[data-fh-grid]");

        this.applyAppearance(view);
        this.refreshView(view);
        this.setupSearch(view);
        this.bindView(view);

        attachSortable(view.grid, (order) => {
            this.settings.cardOrder = normalizeOrder(order);
            this.persistSettings();
        });

        attachResizable(view.grid, {
            label: (span) => this.sizeLabel(span),
            onChange: (cardId, span) => {
                this.setCardSpan(cardId, span);
                // 宽档位变了，快速访问的列数要跟着重算
                this.applyQuickLayout(view);
            },
        });

        this.observeResize(view);
        this.views.add(view);

        // 入场动画只在首次挂载时播一次，后续刷新不再触发
        if (!prefersReducedMotion()) {
            root.classList.add("fh-root--enter");
            window.setTimeout(() => {
                if (root.isConnected) {
                    root.classList.remove("fh-root--enter");
                }
            }, 1400);
        }
    }

    unmountView(container) {
        if (!container || !container.__fhView) {
            return;
        }
        const view = container.__fhView;
        this.stopClock(view);
        this.teardownSearch(view);
        this.teardownDocMenu(view);
        this.unobserveResize(view);
        this.views.delete(view);
        delete container.__fhView;
        container.innerHTML = "";
        container.classList.remove("fh-host");
    }

    buildCards(view) {
        const hidden = this.settings.hiddenCards || [];
        view.grid.innerHTML = "";
        let index = 0;
        // 用 normalizeOrder 兜底：设置里漏了新卡片也能正确渲染
        normalizeOrder(this.settings.cardOrder).forEach((cardId) => {
            if (hidden.indexOf(cardId) >= 0) {
                return;
            }
            const section = document.createElement("section");
            section.className = "fh-card";
            section.setAttribute("data-card-id", cardId);
            // 入场动画的错峰延迟
            section.style.setProperty("--fh-i", String(index));
            index++;
            section.innerHTML =
                '<div class="fh-card__head">' +
                '  <span class="fh-card__grip" title="' + esc(this.t("dragToSort", "拖动排序")) + '">' + ICONS.grip + "</span>" +
                '  <span class="fh-card__icon" data-card-icon></span>' +
                '  <span class="fh-card__title" data-card-title></span>' +
                '  <span class="fh-card__spacer"></span>' +
                '  <span class="fh-card__tools" data-card-tools></span>' +
                "</div>" +
                '<div class="fh-card__body" data-card-body></div>' +
                '<span class="fh-card__resize" title="' + esc(this.t("resizeHint", "拖动缩放")) + '">' + ICONS.resize + "</span>";
            view.grid.appendChild(section);
        });
    }

    /** 把保存的尺寸换算成当前容器宽度下可用的档位，写到卡片的 CSS 变量上 */
    applyCardSizes(view) {
        const metrics = gridMetrics(view.grid);
        const widths = allowedWidths(metrics.width);
        const sizes = this.settings.cardSize || defaultCardSize();
        this.settings.cardOrder.forEach((cardId) => {
            const card = view.grid.querySelector('[data-card-id="' + cardId + '"]');
            if (!card) {
                return;
            }
            const saved = sizes[cardId] || cardDefaultSpan(cardId);
            const span = {
                x: nearestPreset(clampInt(saved.x, 1, GRID_COLUMNS, cardDefaultSpan(cardId).x), widths),
                y: nearestPreset(clampInt(saved.y, 1, 12, cardDefaultSpan(cardId).y), HEIGHT_PRESETS),
            };
            card.setAttribute("data-span-x", String(span.x));
            card.setAttribute("data-span-y", String(span.y));
            card.style.setProperty("--fh-span-x", String(span.x));
            card.style.setProperty("--fh-span-y", String(span.y));
        });
    }

    /** 保存一档缩放结果 */
    setCardSpan(cardId, span) {
        if (!cardId || !span) {
            return;
        }
        if (!this.settings.cardSize) {
            this.settings.cardSize = defaultCardSize();
        }
        this.settings.cardSize[cardId] = {
            x: nearestPreset(clampInt(span.x, 1, GRID_COLUMNS, cardDefaultSpan(cardId).x), WIDTH_PRESETS),
            y: nearestPreset(clampInt(span.y, 1, 12, cardDefaultSpan(cardId).y), HEIGHT_PRESETS),
        };
        this.persistSettings();
    }

    /** 容器宽度变化时重新换算可用档位（窄屏只允许半宽/全宽） */
    observeResize(view) {
        const apply = () => {
            if (!view.el.isConnected) {
                return;
            }
            const width = Math.round(gridMetrics(view.grid).width);
            if (width === view.lastGridWidth) {
                return;
            }
            view.lastGridWidth = width;
            this.applyCardSizes(view);
            this.applyQuickLayout(view);
        };
        if (typeof ResizeObserver !== "undefined") {
            view.resizeObserver = new ResizeObserver(apply);
            view.resizeObserver.observe(view.grid);
        } else {
            view.onWindowResize = apply;
            window.addEventListener("resize", view.onWindowResize);
        }
    }

    unobserveResize(view) {
        if (view.resizeObserver) {
            view.resizeObserver.disconnect();
            view.resizeObserver = null;
        }
        if (view.onWindowResize) {
            window.removeEventListener("resize", view.onWindowResize);
            view.onWindowResize = null;
        }
    }

    /** 缩放过程中显示在光标旁的小标签 */
    sizeLabel(span) {
        const widthKey = { 3: ["sizeQuarter", "1/4"], 4: ["sizeThird", "1/3"], 6: ["sizeHalf", "1/2"], 8: ["sizeTwoThirds", "2/3"], 12: ["sizeFull", "全宽"] };
        const heightKey = { 3: ["sizeLow", "矮"], 4: ["sizeNormal", "标准"], 5: ["sizeTall", "高"], 6: ["sizeExtraTall", "超高"] };
        const w = widthKey[span.x] || ["sizeThird", "1/3"];
        const h = heightKey[span.y] || ["sizeNormal", "标准"];
        return this.t(w[0], w[1]) + " · " + this.t(h[0], h[1]);
    }

    /* ---------------- 外观 ---------------- */

    applyAppearance(view) {
        const s = this.settings;
        const root = view.root;
        const bg = toBgUrl(s.background);
        const bgEl = root.querySelector("[data-fh-bg]");
        if (bg) {
            bgEl.style.backgroundImage = 'url("' + bg.replace(/"/g, '\\"') + '")';
            bgEl.style.filter = s.backgroundBlur > 0 ? "blur(" + s.backgroundBlur + "px)" : "none";
            root.classList.add("fh-root--imaged");
        } else {
            bgEl.style.backgroundImage = "";
            bgEl.style.filter = "none";
            root.classList.remove("fh-root--imaged");
        }
        root.style.setProperty("--fh-dim", String(clampInt(s.backgroundDim, 0, 85, 28) / 100));
    }

    /* ---------------- 渲染刷新 ---------------- */

    refreshView(view) {
        this.applyAppearance(view);
        this.buildCards(view);
        this.renderHero(view);
        this.startClock(view);
        const hidden = this.settings.hiddenCards || [];
        this.settings.cardOrder.forEach((cardId) => {
            if (hidden.indexOf(cardId) >= 0) {
                return;
            }
            this.renderCardMeta(view, cardId);
        });
        this.loadRecent(view);
        this.loadCalendar(view);
        this.renderNotesCard(view);
        this.loadStats(view);
        this.renderQuickCard(view);
        this.applySearchVisibility(view);
        this.applyCardSizes(view);
        this.applyQuickLayout(view);
    }

    renderHero(view) {
        const root = view.root;
        const now = new Date();
        const hi = root.querySelector("[data-fh-hi]");
        const line = root.querySelector("[data-fh-line]");
        const meta = root.querySelector("[data-fh-meta]");

        if (hi) {
            hi.textContent = this.currentGreeting(now);
        }
        if (line) {
            const poem = this.currentPoem();
            if (line.textContent !== poem) {
                line.textContent = poem;
                if (!prefersReducedMotion() && view.state.poemKey) {
                    line.classList.remove("fh-hero__line--in");
                    void line.offsetWidth;
                    line.classList.add("fh-hero__line--in");
                }
            }
            view.state.poemKey = poem;
        }
        if (meta) {
            meta.textContent = this.formatDateLine(now);
        }
    }

    currentGreeting(date) {
        const name = String(this.settings.userName || "").trim();
        const greet = this.greetingFor(date);
        return name ? greet + "，" + name : greet;
    }

    currentPoem() {
        const custom = String(this.settings.greetingSuffix || "").trim();
        if (this.settings.suffixMode === "custom") {
            return custom || this.t("defaultSuffix", "今天从哪里开始？");
        }
        const pool = this.tList("poems", FALLBACK_POEMS);
        if (custom) {
            pool.unshift(custom);
        }
        if (!pool.length) {
            return this.t("defaultSuffix", "今天从哪里开始？");
        }
        // 按天取，保证同一天内反复打开主页不会跳来跳去
        const day = Math.floor(Date.now() / 86400000);
        return pool[((day % pool.length) + pool.length) % pool.length];
    }

    greetingFor(date) {
        const hour = date.getHours();
        if (hour < 5) {
            return this.t("greetingDawn", "夜深了");
        }
        if (hour < 9) {
            return this.t("greetingMorning", "早上好");
        }
        if (hour < 12) {
            return this.t("greetingForenoon", "上午好");
        }
        if (hour < 14) {
            return this.t("greetingNoon", "中午好");
        }
        if (hour < 18) {
            return this.t("greetingAfternoon", "下午好");
        }
        if (hour < 23) {
            return this.t("greetingEvening", "晚上好");
        }
        return this.t("greetingDawn", "夜深了");
    }

    formatDateLine(date) {
        const weekdays = this.isZh ? WEEKDAY_FULL_ZH : WEEKDAY_FULL_EN;
        const monthText = this.isZh ? String(date.getMonth() + 1) : MONTH_FULL_EN[date.getMonth()];
        return this.t("dateFmt", "{y}年{m}月{d}日 {w} · {t}")
            .split("{y}").join(String(date.getFullYear()))
            .split("{m}").join(String(monthText))
            .split("{d}").join(String(date.getDate()))
            .split("{w}").join(weekdays[date.getDay()])
            .split("{t}").join(fmtClock(date));
    }

    startClock(view) {
        this.stopClock(view);
        view.timer = window.setInterval(() => {
            if (!view.el.isConnected) {
                this.stopClock(view);
                return;
            }
            const now = new Date();
            const meta = view.root.querySelector("[data-fh-meta]");
            if (meta) {
                meta.textContent = this.formatDateLine(now);
            }
            const hi = view.root.querySelector("[data-fh-hi]");
            if (hi) {
                const text = this.currentGreeting(now);
                if (hi.textContent !== text) {
                    hi.textContent = text;
                }
            }
        }, 20000);
    }

    stopClock(view) {
        if (view && view.timer) {
            window.clearInterval(view.timer);
            view.timer = null;
        }
    }

    cardEl(view, cardId) {
        return view.grid.querySelector('[data-card-id="' + cardId + '"]');
    }

    /* ---------------- 卡片：标题与工具条 ---------------- */

    renderCardMeta(view, cardId) {
        const card = this.cardEl(view, cardId);
        if (!card) {
            return;
        }
        const titleEl = card.querySelector("[data-card-title]");
        const iconEl = card.querySelector("[data-card-icon]");
        const toolsEl = card.querySelector("[data-card-tools]");
        if (cardId === CARD_RECENT) {
            iconEl.innerHTML = ICONS.recent;
            titleEl.textContent = this.t("cardRecent", "最近打开");
            toolsEl.innerHTML = '<button class="fh-iconbtn" data-act="refresh-recent" title="' +
                esc(this.t("refresh", "刷新")) + '">' + ICONS.refresh + "</button>";
        } else if (cardId === CARD_INSPIRATION) {
            iconEl.innerHTML = ICONS.spark;
            titleEl.textContent = this.t("cardInspiration", "灵感随记");
            toolsEl.innerHTML = "";
        } else if (cardId === CARD_CALENDAR) {
            iconEl.innerHTML = ICONS.calendar;
            titleEl.textContent = this.t("cardCalendar", "日历");
            toolsEl.innerHTML =
                '<button class="fh-iconbtn" data-act="cal-prev" title="' + esc(this.t("prevMonth", "上个月")) + '">' + ICONS.prev + "</button>" +
                '<button class="fh-iconbtn fh-iconbtn--text" data-act="cal-today">' + esc(this.t("today", "今天")) + "</button>" +
                '<button class="fh-iconbtn" data-act="cal-next" title="' + esc(this.t("nextMonth", "下个月")) + '">' + ICONS.next + "</button>";
        } else if (cardId === CARD_STATS) {
            iconEl.innerHTML = ICONS.stats;
            titleEl.textContent = this.t("cardStats", "统计");
            toolsEl.innerHTML = '<button class="fh-iconbtn" data-act="refresh-stats" title="' +
                esc(this.t("refresh", "刷新")) + '">' + ICONS.refresh + "</button>";
        } else if (cardId === CARD_QUICK) {
            iconEl.innerHTML = ICONS.quick;
            titleEl.textContent = this.t("cardQuick", "快速访问");
            toolsEl.innerHTML =
                '<button class="fh-iconbtn" data-act="quick-group-add" title="' +
                esc(this.t("quickGroupAdd", "新建分组")) + '">' + ICONS.folderPlus + "</button>" +
                '<button class="fh-iconbtn fh-iconbtn--text" data-act="quick-add" title="' +
                esc(this.t("quickAdd", "添加文档")) + '">' + ICONS.plus + esc(this.t("quickAddShort", "添加")) + "</button>";
        }
    }

    getRecentCount() {
        return clampInt(this.settings.recentCount, 3, 30, 8);
    }

    getNoteCount() {
        return clampInt(this.settings.noteCount, 3, 30, 5);
    }

    /* ---------------- 搜索 ---------------- */

    applySearchVisibility(view) {
        const box = view.root.querySelector("[data-fh-search]");
        if (!box) {
            return;
        }
        const visible = this.settings.showSearch !== false;
        box.classList.toggle("fn__none", !visible);
        const input = box.querySelector("[data-fh-search-input]");
        if (input) {
            input.placeholder = this.t("searchPlaceholder", "搜索文档与内容…");
        }
    }

    setupSearch(view) {
        const input = view.root.querySelector("[data-fh-search-input]");
        if (!input) {
            return;
        }
        view.searchFocused = false;

        view.onSearchInput = () => {
            const value = input.value;
            const box = view.root.querySelector("[data-fh-search]");
            box.classList.toggle("fh-search--filled", Boolean(value));
            view.state.searchIndex = -1;
            if (this.searchTimer) {
                window.clearTimeout(this.searchTimer);
            }
            if (!value.trim()) {
                view.state.search = null;
                view.state.searchQuery = "";
                view.state.searchLoading = false;
                this.renderSearchPanel(view);
                return;
            }
            view.state.searchLoading = true;
            this.renderSearchPanel(view);
            this.searchTimer = window.setTimeout(() => {
                this.runSearch(view, value);
            }, SEARCH_DEBOUNCE);
        };

        view.onSearchFocus = () => {
            view.searchFocused = true;
            this.renderSearchPanel(view);
        };

        view.onSearchKeydown = (event) => {
            const list = view.state.search || [];
            if (event.key === "ArrowDown" && list.length) {
                event.preventDefault();
                view.state.searchIndex = (view.state.searchIndex + 1) % list.length;
                this.renderSearchPanel(view);
            } else if (event.key === "ArrowUp" && list.length) {
                event.preventDefault();
                view.state.searchIndex = (view.state.searchIndex - 1 + list.length) % list.length;
                this.renderSearchPanel(view);
            } else if (event.key === "Enter") {
                event.preventDefault();
                const idx = view.state.searchIndex >= 0 ? view.state.searchIndex : 0;
                const target = list[idx];
                if (target) {
                    this.clearSearch(view);
                    this.openDoc(target.id);
                }
            } else if (event.key === "Escape") {
                event.preventDefault();
                this.clearSearch(view);
                input.blur();
            }
        };

        input.addEventListener("input", view.onSearchInput);
        input.addEventListener("focus", view.onSearchFocus);
        input.addEventListener("keydown", view.onSearchKeydown);

        // 点击搜索框以外的地方收起结果面板
        view.docClickHandler = (event) => {
            if (!view.root.isConnected) {
                return;
            }
            const box = view.root.querySelector("[data-fh-search]");
            if (box && !box.contains(event.target)) {
                view.searchFocused = false;
                this.renderSearchPanel(view);
            }
        };
        document.addEventListener("mousedown", view.docClickHandler, true);

        this.renderSearchPanel(view);
    }

    teardownSearch(view) {
        const input = view.root ? view.root.querySelector("[data-fh-search-input]") : null;
        if (input) {
            input.removeEventListener("input", view.onSearchInput);
            input.removeEventListener("focus", view.onSearchFocus);
            input.removeEventListener("keydown", view.onSearchKeydown);
        }
        if (view.docClickHandler) {
            document.removeEventListener("mousedown", view.docClickHandler, true);
            view.docClickHandler = null;
        }
        if (this.searchTimer) {
            window.clearTimeout(this.searchTimer);
            this.searchTimer = null;
        }
    }

    clearSearch(view) {
        const input = view.root.querySelector("[data-fh-search-input]");
        if (input) {
            input.value = "";
        }
        const box = view.root.querySelector("[data-fh-search]");
        if (box) {
            box.classList.remove("fh-search--filled");
        }
        view.state.search = null;
        view.state.searchQuery = "";
        view.state.searchLoading = false;
        view.state.searchIndex = -1;
        this.renderSearchPanel(view);
    }

    async runSearch(view, rawQuery) {
        const query = String(rawQuery || "").trim();
        if (!query) {
            return;
        }
        if (view.state.searchQuery === query && view.state.search) {
            return;
        }
        const like = sqlQuote("%" + query + "%");

        const titleRes = await api("/api/query/sql", {
            stmt: "SELECT id, content AS title, hpath FROM blocks WHERE type = 'd' " +
                "AND (content LIKE " + like + " OR hpath LIKE " + like + ") " +
                "ORDER BY updated DESC LIMIT " + SEARCH_LIMIT,
        });
        const hitRes = await api("/api/query/sql", {
            stmt: "SELECT root_id AS id, COUNT(*) AS n FROM blocks WHERE type != 'd' " +
                "AND content LIKE " + like + " GROUP BY root_id ORDER BY n DESC LIMIT " + (SEARCH_LIMIT * 3),
        });

        if (!view.el.isConnected || (view.root.querySelector("[data-fh-search-input]") || {}).value !== rawQuery) {
            return;
        }

        const map = new Map();
        const pushDoc = (id, title, hpath, hits, titleHit) => {
            if (!id || map.has(id)) {
                const exist = map.get(id);
                if (exist) {
                    exist.hits = Math.max(exist.hits, hits || 0);
                    exist.titleHit = exist.titleHit || titleHit;
                }
                return;
            }
            map.set(id, {
                id: id,
                title: title || "",
                sub: parentPathLabel(hpath, title),
                hits: hits || 0,
                titleHit: Boolean(titleHit),
            });
        };

        if (titleRes.code === 0 && Array.isArray(titleRes.data)) {
            titleRes.data.forEach((row) => {
                pushDoc(row.id, row.title, row.hpath, 0, true);
            });
        }
        const orphanIds = [];
        if (hitRes.code === 0 && Array.isArray(hitRes.data)) {
            hitRes.data.forEach((row) => {
                if (!map.has(row.id)) {
                    pushDoc(row.id, "", "", Number(row.n) || 0, false);
                    orphanIds.push(sqlQuote(row.id));
                } else {
                    map.get(row.id).hits = Number(row.n) || 0;
                }
            });
        }
        if (orphanIds.length) {
            const docRes = await api("/api/query/sql", {
                stmt: "SELECT id, content AS title, hpath FROM blocks WHERE id IN (" + orphanIds.join(",") + ")",
            });
            if (docRes.code === 0 && Array.isArray(docRes.data)) {
                docRes.data.forEach((row) => {
                    const item = map.get(row.id);
                    if (item) {
                        item.title = row.title;
                        item.sub = parentPathLabel(row.hpath, row.title);
                    }
                });
            }
        }

        const list = Array.from(map.values())
            .filter((item) => item.title)
            .sort((a, b) => {
                if (a.titleHit !== b.titleHit) {
                    return a.titleHit ? -1 : 1;
                }
                return b.hits - a.hits;
            })
            .slice(0, SEARCH_LIMIT);

        view.state.search = list;
        view.state.searchQuery = query;
        view.state.searchLoading = false;
        view.state.searchIndex = list.length ? 0 : -1;
        this.renderSearchPanel(view);
    }

    renderSearchPanel(view) {
        const panel = view.root.querySelector("[data-fh-search-panel]");
        const box = view.root.querySelector("[data-fh-search]");
        const input = view.root.querySelector("[data-fh-search-input]");
        if (!panel || !box || !input) {
            return;
        }
        const value = input.value.trim();
        const shouldOpen = view.searchFocused || Boolean(view.state.search);

        if (!shouldOpen && !value) {
            panel.innerHTML = "";
            panel.classList.remove("fh-search__panel--open");
            return;
        }

        let html = "";
        if (!value) {
            html = '<div class="fh-search__hint">' + esc(this.t("searchHint", "输入关键词，搜索文档标题与正文")) + "</div>";
        } else if (view.state.searchLoading && !view.state.search) {
            html = '<div class="fh-search__hint">' + esc(this.t("searchLoading", "搜索中…")) + "</div>";
        } else if (view.state.search && view.state.search.length) {
            html = view.state.search.map((item, index) => {
                const hits = item.hits > 0
                    ? '<span class="fh-search__hits">' + esc(this.t("searchHits", "{n} 处").split("{n}").join(String(item.hits))) + "</span>"
                    : "";
                return '<a class="fh-search__item' + (index === view.state.searchIndex ? " is-active" : "") +
                    '" data-doc-id="' + esc(item.id) + '" data-doc-title="' + esc(item.title) + '">' +
                    '<span class="fh-search__item-icon">' + ICONS.doc + "</span>" +
                    '<span class="fh-search__item-main">' +
                    '  <span class="fh-search__item-title">' + esc(item.title) + "</span>" +
                    (item.sub ? '<span class="fh-search__item-sub">' + esc(item.sub) + "</span>" : "") +
                    "</span>" +
                    hits +
                    this.pinButtonHTML(item) +
                    "</a>";
            }).join("");
        } else if (view.state.search) {
            html = '<div class="fh-search__hint">' + esc(this.t("searchEmpty", "没有找到匹配的内容")) + "</div>";
        }

        panel.innerHTML = html;
        panel.classList.toggle("fh-search__panel--open", Boolean(html));
    }

    /* ---------------- 卡片：最近打开 ---------------- */

    /** 图钉按钮（已固定时用实心图标） */
    pinButtonHTML(doc, pinned) {
        const on = pinned === undefined ? this.isPinnedDoc(doc.id) : pinned;
        return '<button class="fh-iconbtn fh-iconbtn--tiny fh-pin' + (on ? " fh-pin--on" : "") +
            '" data-act="pin-doc" data-doc-id="' + esc(doc.id) +
            '" data-doc-title="' + esc(doc.title) + '" data-doc-icon="' + esc(doc.icon || "") +
            '" title="' + esc(on ? this.t("quickUnpin", "取消固定") : this.t("quickPin", "固定到快速访问")) + '">' +
            (on ? ICONS.pinOn : ICONS.pin) + "</button>";
    }

    /** 统一的文档行：图标 + 标题 + 自定义尾部 + 图钉 */
    docRowHTML(doc, opts) {
        const o = opts || {};
        const icon = docIconText(doc.icon);
        return '<a class="' + (o.cls || "fh-doc") + '" data-doc-id="' + esc(doc.id) +
            '" data-doc-title="' + esc(doc.title) + '" data-doc-icon="' + esc(doc.icon || "") + '">' +
            '<span class="' + (o.iconCls || "fh-doc__icon") + '">' + (icon ? esc(icon) : ICONS.doc) + "</span>" +
            '<span class="' + (o.titleCls || "fh-doc__title") + '">' + esc(doc.title) + "</span>" +
            (o.rest || "") +
            this.pinButtonHTML(doc) +
            "</a>";
    }

    async loadRecent(view) {
        view.state.recent = null;
        this.renderRecentCard(view);
        const list = await this.fetchRecentDocs(this.getRecentCount());
        if (!view.el.isConnected) {
            return;
        }
        view.state.recent = list;
        this.renderRecentCard(view);
    }

    renderRecentCard(view) {
        const card = this.cardEl(view, CARD_RECENT);
        if (!card) {
            return;
        }
        const body = card.querySelector("[data-card-body]");
        const list = view.state.recent;
        if (list === null) {
            body.innerHTML = this.skeletonHTML(4);
            return;
        }
        if (!list.length) {
            body.innerHTML = this.emptyHTML(this.t("emptyRecent", "还没有最近打开的文档"), this.t("emptyRecentTip", "打开一篇文档后，这里会自动出现记录"));
            return;
        }
        const html = list.map((doc) => {
            const time = fmtRelative(doc.viewedAt);
            return this.docRowHTML(doc, {
                rest: time ? '<span class="fh-doc__time">' + esc(time) + "</span>" : "",
            });
        }).join("");
        body.innerHTML = '<div class="fh-list">' + html + "</div>";
    }

    async fetchRecentDocs(limit) {
        const normalize = (raw) => {
            const out = [];
            (raw || []).forEach((item) => {
                const id = item && (item.rootID || item.id);
                const title = item && (item.title || item.name || item.content);
                if (!id || !title) {
                    return;
                }
                out.push({
                    id: id,
                    title: title,
                    icon: item.icon || "",
                    viewedAt: item.viewedAt || item.openAt || item.closedAt || 0,
                });
            });
            return out.slice(0, limit);
        };

        let res = await api("/api/storage/getRecentDocs", { sortBy: "viewedAt" });
        if (res.code !== 0 || !Array.isArray(res.data) || !res.data.length) {
            const retry = await api("/api/storage/getRecentDocs", {});
            if (retry.code === 0 && Array.isArray(retry.data) && retry.data.length) {
                res = retry;
            }
        }
        let list = (res.code === 0 && Array.isArray(res.data)) ? normalize(res.data) : [];
        if (list.length) {
            return list;
        }
        const sql = await api("/api/query/sql", {
            stmt: "SELECT id, content AS title, updated FROM blocks WHERE type = 'd' ORDER BY updated DESC LIMIT " + limit,
        });
        if (sql.code === 0 && Array.isArray(sql.data)) {
            list = sql.data.filter((row) => row && row.id && row.title).map((row) => ({
                id: row.id,
                title: row.title,
                icon: "",
                viewedAt: 0,
            }));
        }
        return list.slice(0, limit);
    }

    openDoc(id) {
        if (!id) {
            return;
        }
        if (this.isMobile) {
            // 移动端 openTab 是空实现，必须走移动端专用入口
            this.closeOverlay();
            if (typeof openMobileFileById === "function") {
                openMobileFileById(this.app, id);
            }
            return;
        }
        openTab({
            app: this.app,
            doc: { id: id },
        });
    }

    /* ---------------- 卡片：灵感随记 ---------------- */

    renderNotesCard(view) {
        const card = this.cardEl(view, CARD_INSPIRATION);
        if (!card) {
            return;
        }
        const body = card.querySelector("[data-card-body]");
        const notes = this.notes.slice(0, this.getNoteCount());
        let html =
            '<div class="fh-compose">' +
            '  <textarea class="fh-compose__input" data-note-input rows="3" placeholder="' +
            esc(this.t("notePlaceholder", "记下此刻的想法…")) + '"></textarea>' +
            '  <div class="fh-compose__foot">' +
            '    <span class="fh-compose__hint">⌘ / Ctrl + Enter</span>' +
            '    <button class="fh-btn fh-btn--primary" data-act="save-note">' +
            esc(this.t("noteSave", "记录")) + "</button>" +
            "  </div>" +
            "</div>";

        if (!notes.length) {
            html += this.emptyHTML(this.t("noteEmpty", "还没有灵感碎片"), this.t("noteEmptyTip", "在上面输入框写下第一条想法吧"));
        } else {
            html += '<div class="fh-notes">' + notes.map((note) => {
                const d = new Date(note.ts || Date.now());
                const stamp = pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + fmtClock(d);
                return '<div class="fh-note" data-note-id="' + esc(note.id) + '">' +
                    '<div class="fh-note__text">' + esc(note.text) + "</div>" +
                    '<div class="fh-note__foot">' +
                    '  <span class="fh-note__time">' + esc(stamp) + "</span>" +
                    '  <button class="fh-note__del" data-act="del-note" title="' + esc(this.t("noteDelete", "删除")) + '">' + ICONS.trash + "</button>" +
                    "</div>" +
                    "</div>";
            }).join("") + "</div>";
        }
        body.innerHTML = html;
    }

    async saveNote(view) {
        const input = view.root.querySelector("[data-note-input]");
        if (!input) {
            return;
        }
        const text = String(input.value || "").trim();
        if (!text) {
            input.focus();
            return;
        }
        const note = { id: genId(), text: text, ts: Date.now() };
        this.notes.unshift(note);
        if (this.notes.length > 800) {
            this.notes = this.notes.slice(0, 800);
        }
        await this.persistNotes();
        input.value = "";
        this.views.forEach((other) => {
            if (!other.el.isConnected) {
                return;
            }
            this.renderNotesCard(other);
            if (other === view && !prefersReducedMotion()) {
                const first = other.grid.querySelector('[data-card-id="' + CARD_INSPIRATION + '"] .fh-note');
                if (first) {
                    first.classList.add("fh-note--new");
                    window.setTimeout(() => first.classList.remove("fh-note--new"), 900);
                }
            }
        });
        const target = this.settings.noteTarget || {};
        if (target.type && target.type !== "none") {
            this.mirrorNote(text).then((ok) => {
                if (!ok) {
                    showMessage(this.t("noteMirrorFailed", "已保存到本地，但写入思源笔记本失败"));
                }
            });
        }
    }

    async deleteNote(noteId) {
        const index = this.notes.findIndex((item) => item.id === noteId);
        if (index < 0) {
            return;
        }
        this.notes.splice(index, 1);
        await this.persistNotes();
        this.views.forEach((view) => {
            if (view.el.isConnected) {
                this.renderNotesCard(view);
            }
        });
    }

    async persistNotes() {
        try {
            await this.saveData(NOTES_FILE, { items: this.notes });
        } catch (err) {
            // 只读或发布模式下写入会被拒绝，忽略即可
        }
    }

    /**
     * 按设置把灵感写进思源：
     *   doc      → 追加成一条列表项到指定笔记末尾
     *   notebook → 在该笔记本下新建一篇文档
     *   none     → 只留在插件本地
     */
    async mirrorNote(text) {
        const target = this.settings.noteTarget || {};
        if (!target.type || target.type === "none" || !target.notebook) {
            return true;
        }
        const now = new Date();
        const stamp = pad2(now.getMonth() + 1) + "-" + pad2(now.getDate()) + " " + fmtClock(now);

        if (target.type === "doc" && target.docId) {
            const res = await api("/api/block/appendBlock", {
                dataType: "markdown",
                data: "- " + stamp + " " + text.replace(/\s*\n+\s*/g, " "),
                parentID: target.docId,
            });
            return res.code === 0;
        }

        const title = now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate()) +
            " " + pad2(now.getHours()) + "." + pad2(now.getMinutes()) + "." + pad2(now.getSeconds());
        const parent = "/" + this.t("noteMirrorTitle", "灵感").replace(/\//g, "／");
        const res = await api("/api/filetree/createDocWithMd", {
            notebook: target.notebook,
            path: parent + "/" + title,
            markdown: text,
        });
        return res.code === 0;
    }

    /* ---------------- 卡片：日历 ---------------- */

    async loadCalendar(view) {
        const key = view.state.year + "-" + view.state.month;
        view.state.activityKey = key;
        const map = await this.fetchMonthActivity(view.state.year, view.state.month);
        if (!view.el.isConnected || view.state.activityKey !== key) {
            return;
        }
        view.state.activity = map;
        this.renderCalendarCard(view);
    }

    async fetchMonthActivity(year, month) {
        const prefix = year + pad2(month + 1);
        const res = await api("/api/query/sql", {
            stmt: "SELECT substr(created, 1, 8) AS d, COUNT(*) AS c FROM blocks " +
                "WHERE type = 'd' AND created LIKE '" + prefix + "%' GROUP BY d",
        });
        const map = {};
        if (res.code === 0 && Array.isArray(res.data)) {
            res.data.forEach((row) => {
                if (row && row.d) {
                    map[String(row.d)] = Number(row.c) || 0;
                }
            });
        }
        return map;
    }

    renderCalendarCard(view) {
        const card = this.cardEl(view, CARD_CALENDAR);
        if (!card) {
            return;
        }
        const body = card.querySelector("[data-card-body]");
        const state = view.state;
        const year = state.year;
        const month = state.month;

        const monthLabel = this.t("monthLabel", "{y} 年 {m} 月")
            .split("{y}").join(String(year))
            .split("{m}").join(this.isZh ? String(month + 1) : MONTH_FULL_EN[month]);

        const weekdays = String(this.t("weekdays", "日,一,二,三,四,五,六")).split(",");
        const weekStart = this.settings.weekStart ? 1 : 0;
        const weekHtml = [];
        for (let i = 0; i < 7; i++) {
            weekHtml.push('<span class="fh-cal__dow">' + esc(weekdays[(i + weekStart) % 7] || "") + "</span>");
        }

        const first = new Date(year, month, 1);
        const lead = (first.getDay() - weekStart + 7) % 7;
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const todayKey = toDayKey(new Date());

        // 只渲染实际需要的行数，5 行的月份不留空行
        const rowCount = Math.ceil((lead + daysInMonth) / 7);
        const cellCount = rowCount * 7;

        const cells = [];
        for (let i = 0; i < cellCount; i++) {
            const offset = i - lead;
            const date = new Date(year, month, offset);
            const key = toDayKey(date);
            const other = offset < 0 || offset >= daysInMonth;
            const classes = ["fh-cal__day"];
            if (other) {
                classes.push("fh-cal__day--other");
            }
            if (key === todayKey) {
                classes.push("fh-cal__day--today");
            }
            if (state.selectedDay === key) {
                classes.push("fh-cal__day--selected");
            }
            const count = state.activity[key] || 0;
            let inner = '<span class="fh-cal__num">' + date.getDate() + "</span>";
            if (count > 0) {
                inner += '<i class="fh-cal__dot" title="' + esc(this.t("docCount", "{n} 篇").split("{n}").join(String(count))) + '"></i>';
            }
            cells.push('<button class="' + classes.join(" ") + '" data-day="' + key + '">' + inner + "</button>");
        }

        let html =
            '<div class="fh-cal__month">' + esc(monthLabel) + "</div>" +
            '<div class="fh-cal__week">' + weekHtml.join("") + "</div>" +
            '<div class="fh-cal__grid">' + cells.join("") + "</div>";

        if (state.selectedDay) {
            html += this.renderDayDetail(view);
        }
        body.innerHTML = html;
    }

    renderDayDetail(view) {
        const state = view.state;
        const key = state.selectedDay;
        const month = parseInt(key.slice(4, 6), 10);
        const day = parseInt(key.slice(6, 8), 10);
        const title = this.t("dayDocs", "{m} 月 {d} 日的记录")
            .split("{m}").join(String(month))
            .split("{d}").join(String(day));

        let html = '<div class="fh-day">' +
            '<div class="fh-day__head"><span>' + esc(title) + "</span>" +
            '<button class="fh-iconbtn" data-act="day-close">' + ICONS.close + "</button></div>";

        if (state.dayLoading) {
            html += this.skeletonHTML(2);
        } else if (state.dayDocs && state.dayDocs.length) {
            html += '<div class="fh-list">' + state.dayDocs.map((doc) => {
                return this.docRowHTML(doc);
            }).join("") + "</div>";
        } else {
            html += '<div class="fh-day__empty">' + esc(this.t("noDocsThatDay", "这天还没有记录")) +
                '<button class="fh-btn fh-btn--ghost" data-act="day-create">' +
                esc(this.t("createDailyNote", "新建日记")) + "</button></div>";
        }
        html += "</div>";
        return html;
    }

    async selectDay(view, dayKey) {
        const state = view.state;
        if (state.selectedDay === dayKey) {
            state.selectedDay = null;
            state.dayDocs = null;
            this.renderCalendarCard(view);
            return;
        }
        state.selectedDay = dayKey;
        state.dayDocs = null;
        state.dayLoading = true;
        this.renderCalendarCard(view);

        const res = await api("/api/query/sql", {
            stmt: "SELECT id, content AS title FROM blocks WHERE type = 'd' AND " +
                "(created LIKE '" + dayKey + "%' OR ial LIKE '%custom-dailynote-" + dayKey + "%') " +
                "ORDER BY created DESC LIMIT 30",
        });
        if (!view.el.isConnected || state.selectedDay !== dayKey) {
            return;
        }
        state.dayLoading = false;
        state.dayDocs = (res.code === 0 && Array.isArray(res.data))
            ? res.data.filter((row) => row && row.id && row.title)
            : [];
        this.renderCalendarCard(view);
    }

    async createDailyNote(view, dayKey) {
        let notebook = (this.settings.noteTarget || {}).notebook;
        if (!notebook) {
            const list = await this.fetchNotebooks();
            if (list.length) {
                notebook = list[0].id;
            }
        }
        if (!notebook) {
            showMessage(this.t("loadFailed", "数据加载失败"));
            return;
        }
        const date = new Date(
            parseInt(dayKey.slice(0, 4), 10),
            parseInt(dayKey.slice(4, 6), 10) - 1,
            parseInt(dayKey.slice(6, 8), 10)
        );
        const path = expandPath(this.settings.dailyPath || DEFAULT_SETTINGS.dailyPath, date);
        const res = await api("/api/filetree/createDocWithMd", {
            notebook: notebook,
            path: path,
            markdown: "",
        });
        if (res.code !== 0 || !res.data) {
            showMessage(this.t("loadFailed", "数据加载失败") + (res.msg ? "：" + res.msg : ""));
            return;
        }
        const id = String(res.data);
        const attrs = {};
        attrs["custom-dailynote-" + dayKey] = dayKey;
        await api("/api/attr/setBlockAttrs", { id: id, attrs: attrs });
        showMessage(this.t("dailyNoteCreated", "日记已创建"));
        this.loadCalendar(view);
        this.openDoc(id);
    }

    async fetchNotebooks() {
        const res = await api("/api/notebook/lsNotebooks", {});
        if (res.code === 0 && res.data && Array.isArray(res.data.notebooks)) {
            this.notebooks = res.data.notebooks.filter((item) => item && !item.closed);
            return this.notebooks;
        }
        return this.notebooks || [];
    }

    /** 拉取笔记本列表（同一时刻只发一次请求） */
    refreshNotebooks() {
        if (this.notebooksPromise) {
            return this.notebooksPromise;
        }
        const plugin = this;
        this.notebooksPromise = this.fetchNotebooks()
            .catch(() => plugin.notebooks || [])
            .then((list) => {
                plugin.notebooksPromise = null;
                return list;
            });
        return this.notebooksPromise;
    }

    /* ---------------- 使用时长（本地累计） ---------------- */

    startUsageTracking() {
        const plugin = this;
        this.lastActivityAt = Date.now();
        this.lastActivityWrite = Date.now();
        this.usageTicks = 0;

        this.activityTouch = function () {
            const now = Date.now();
            if (now - plugin.lastActivityWrite < 2000) {
                return;
            }
            plugin.lastActivityWrite = now;
            plugin.lastActivityAt = now;
        };
        ["pointerdown", "pointermove", "keydown", "wheel", "scroll"].forEach(function (type) {
            document.addEventListener(type, plugin.activityTouch, { passive: true, capture: true });
        });

        this.usageTimer = window.setInterval(function () {
            plugin.tickUsage();
        }, USAGE_TICK_MS);

        this.visibilityHandler = function () {
            if (document.hidden) {
                plugin.flushUsage();
            }
        };
        document.addEventListener("visibilitychange", this.visibilityHandler);
    }

    stopUsageTracking() {
        if (this.activityTouch) {
            ["pointerdown", "pointermove", "keydown", "wheel", "scroll"].forEach((type) => {
                document.removeEventListener(type, this.activityTouch, { capture: true });
            });
            this.activityTouch = null;
        }
        if (this.usageTimer) {
            window.clearInterval(this.usageTimer);
            this.usageTimer = null;
        }
        if (this.visibilityHandler) {
            document.removeEventListener("visibilitychange", this.visibilityHandler);
            this.visibilityHandler = null;
        }
        this.flushUsage();
    }

    /** 窗口可见 + 最近有操作，才算在"用" */
    tickUsage() {
        if (document.hidden) {
            return;
        }
        if (Date.now() - (this.lastActivityAt || 0) > USAGE_IDLE_MS) {
            return;
        }
        const key = toDayKey(new Date());
        if (!this.usage.since) {
            this.usage.since = key;
        }
        this.usage.days[key] = (this.usage.days[key] || 0) + Math.round(USAGE_TICK_MS / 1000);
        this.usageDirty = true;
        this.usageTicks += 1;
        if (this.usageTicks % 4 === 0) {
            this.flushUsage();
        }
    }

    flushUsage() {
        if (!this.usageDirty) {
            return;
        }
        this.usageDirty = false;
        const keys = Object.keys(this.usage.days).sort();
        if (keys.length > USAGE_KEEP_DAYS) {
            keys.slice(0, keys.length - USAGE_KEEP_DAYS).forEach((key) => {
                delete this.usage.days[key];
            });
        }
        this.saveData(USAGE_FILE, this.usage).catch(() => {});
    }

    todayUsageSeconds() {
        return Math.round((this.usage.days || {})[toDayKey(new Date())] || 0);
    }

    async resetUsage() {
        this.usage = { since: "", days: {} };
        this.usageDirty = true;
        this.flushUsage();
    }

    /* ---------------- 卡片：统计 ---------------- */

    async loadStats(view) {
        view.state.stats = null;
        this.renderStatsCard(view);
        const stats = await this.fetchStats();
        if (!view.el.isConnected) {
            return;
        }
        view.state.stats = stats;
        this.renderStatsCard(view);
    }

    async fetchStats() {
        const today = toDayKey(new Date());
        const [docRes, wordRes] = await Promise.all([
            api("/api/query/sql", {
                stmt: "SELECT COUNT(*) AS total, " +
                    "(SELECT COUNT(*) FROM blocks WHERE type = 'd' AND created LIKE '" + today + "%') AS today " +
                    "FROM blocks WHERE type = 'd'",
            }),
            api("/api/query/sql", {
                stmt: "SELECT SUM(length) AS n FROM blocks WHERE type != 'd' AND updated LIKE '" + today + "%'",
            }),
        ]);

        const pick = (res, key) => (res.code === 0 && Array.isArray(res.data) && res.data[0])
            ? (Number(res.data[0][key]) || 0)
            : 0;
        const unavailable = docRes.code !== 0 && wordRes.code !== 0;

        return {
            available: !unavailable,
            docs: pick(docRes, "total"),
            todayDocs: pick(docRes, "today"),
            words: pick(wordRes, "n"),
            seconds: this.todayUsageSeconds(),
            since: this.usage.since || "",
        };
    }

    renderStatsCard(view) {
        const card = this.cardEl(view, CARD_STATS);
        if (!card) {
            return;
        }
        const body = card.querySelector("[data-card-body]");
        const stats = view.state.stats;
        if (stats === null) {
            body.innerHTML = this.skeletonHTML(3);
            return;
        }
        if (!stats.available) {
            body.innerHTML = this.emptyHTML(this.t("statUnavailable", "统计信息不可用"),
                this.t("statUnavailableTip", "思源内核的 SQL 接口没有响应"));
            return;
        }

        const todayText = stats.todayDocs > 0
            ? this.t("statTodayDocs", "今日 +{n}").split("{n}").join(String(stats.todayDocs))
            : "";

        const metric = (value, label, tip, extra) =>
            '<div class="fh-stat" title="' + esc(tip) + '">' +
            '  <span class="fh-stat__value">' + esc(value) + "</span>" +
            '  <span class="fh-stat__label">' + esc(label) + "</span>" +
            (extra ? '  <span class="fh-stat__extra">' + esc(extra) + "</span>" : "") +
            "</div>";

        let html = '<div class="fh-stats">' +
            metric(fmtCount(stats.docs), this.t("statDocs", "笔记总数"),
                this.t("statDocsTip", "整个工作空间的文档数量"), todayText) +
            metric(fmtDuration(stats.seconds, (key, fb) => this.t(key, fb)), this.t("statDuration", "今日使用时长"),
                this.t("statDurationTip", "思源本身不记录使用时长，由插件在本地按心跳累计：窗口可见且有操作时才计时")) +
            metric(fmtCount(stats.words), this.t("statWords", "今日写作字数"),
                this.t("statWordsTip", "按内容块统计：今天新建或改动过的块，其当前字数合计")) +
            "</div>";

        html += '<div class="fh-stats__note">' + esc(stats.since
            ? this.t("statSince", "使用时长自 {date} 起本地累计").split("{date}").join(this.formatSince(stats.since))
            : this.t("statSinceToday", "使用时长从今天开始由本地累计")) + "</div>";

        body.innerHTML = html;
    }

    formatSince(dayKey) {
        if (!dayKey || dayKey.length !== 8) {
            return dayKey || "";
        }
        return dayKey.slice(0, 4) + "-" + dayKey.slice(4, 6) + "-" + dayKey.slice(6, 8);
    }

    /* ---------------- 卡片：快速访问（数据层） ---------------- */

    persistQuick() {
        try {
            return this.saveData(QUICK_FILE, this.quick);
        } catch (err) {
            return Promise.resolve();
        }
    }

    quickGroups() {
        if (!this.quick || !Array.isArray(this.quick.groups) || !this.quick.groups.length) {
            this.quick = normalizeQuick(this.quick);
        }
        return this.quick.groups;
    }

    quickGroup(groupId) {
        const hit = this.quickGroups().filter((group) => group.id === groupId);
        return hit.length ? hit[0] : null;
    }

    groupTitle(group) {
        if (!group) {
            return "";
        }
        if (group.name) {
            return group.name;
        }
        return group.id === QUICK_GROUP_DEFAULT
            ? this.t("quickGroupDefault", "未分类")
            : this.t("quickGroupUnnamed", "未命名分组");
    }

    /** 供下拉框 / 上下文菜单使用的分组选项 */
    groupChoices() {
        return this.quickGroups().map((group) => ({
            id: group.id,
            name: this.groupTitle(group),
        }));
    }

    /** 某文档当前的 Pin 记录：{ group, index, item } */
    findPin(docId) {
        if (!docId) {
            return null;
        }
        const groups = this.quickGroups();
        for (let i = 0; i < groups.length; i++) {
            for (let j = 0; j < groups[i].items.length; j++) {
                if (groups[i].items[j].id === docId) {
                    return { group: groups[i], index: j, item: groups[i].items[j] };
                }
            }
        }
        return null;
    }

    isPinnedDoc(docId) {
        return Boolean(this.findPin(docId));
    }

    /** Pin 一篇文档（已在别的分组时相当于移过去） */
    async pinDoc(doc, groupId) {
        if (!doc || !doc.id || !doc.title) {
            return false;
        }
        const groups = this.quickGroups();
        const target = this.quickGroup(groupId || QUICK_GROUP_DEFAULT) || groups[0];
        const existing = this.findPin(doc.id);
        if (existing) {
            if (existing.group.id === target.id) {
                return false;
            }
            existing.group.items.splice(existing.index, 1);
            target.items.push(existing.item);
            await this.persistQuick();
            this.refreshAllViews();
            return true;
        }
        target.items.push({
            id: String(doc.id),
            title: String(doc.title),
            icon: String(doc.icon || ""),
            addedAt: Date.now(),
        });
        await this.persistQuick();
        this.refreshAllViews();
        return true;
    }

    async unpinDoc(docId) {
        const found = this.findPin(docId);
        if (!found) {
            return false;
        }
        found.group.items.splice(found.index, 1);
        await this.persistQuick();
        this.refreshAllViews();
        return true;
    }

    async togglePin(doc, groupId) {
        if (this.isPinnedDoc(doc && doc.id)) {
            const ok = await this.unpinDoc(doc.id);
            if (ok) {
                showMessage(this.t("quickUnpinned", "已取消固定"));
            }
            return ok;
        }
        const ok = await this.pinDoc(doc, groupId);
        if (ok) {
            showMessage(this.t("quickPinned", "已固定到快速访问"));
        }
        return ok;
    }

    /**
     * 把 Pin 移到指定分组的位置 index 上（同组内即为重新排序）。
     * index 的口径：把自己摘出去之后、目标分组里的插入位置。
     */
    async movePin(docId, groupId, index) {
        const found = this.findPin(docId);
        const target = this.quickGroup(groupId);
        if (!found || !target) {
            return false;
        }
        const item = found.item;
        found.group.items.splice(found.index, 1);
        const at = Math.max(0, Math.min(clampInt(index, 0, target.items.length, target.items.length), target.items.length));
        target.items.splice(at, 0, item);
        await this.persistQuick();
        this.refreshAllViews();
        return true;
    }

    async addQuickGroup(name) {
        const groups = this.quickGroups();
        const id = "g" + genId();
        groups.push({ id: id, name: String(name || "").trim(), items: [] });
        await this.persistQuick();
        this.refreshAllViews();
        return id;
    }

    async renameQuickGroup(groupId, name) {
        const group = this.quickGroup(groupId);
        if (!group) {
            return false;
        }
        group.name = String(name || "").trim();
        await this.persistQuick();
        this.refreshAllViews();
        return true;
    }

    /** 删除分组：里面的文档退回「未分类」，不会丢失 Pin */
    async removeQuickGroup(groupId) {
        if (groupId === QUICK_GROUP_DEFAULT) {
            return 0;
        }
        const groups = this.quickGroups();
        const index = groups.findIndex((group) => group.id === groupId);
        if (index < 0) {
            return 0;
        }
        const moved = groups[index].items.slice();
        groups.splice(index, 1);
        const fallback = this.quickGroup(QUICK_GROUP_DEFAULT) || groups[0];
        moved.forEach((item) => fallback.items.push(item));
        await this.persistQuick();
        this.refreshAllViews();
        return moved.length;
    }

    /** 把某个分组挪到 index 位置（分组顺序即卡片上的展示顺序） */
    async moveQuickGroup(groupId, index) {
        const groups = this.quickGroups();
        const from = groups.findIndex((group) => group.id === groupId);
        if (from < 0) {
            return false;
        }
        const at = clampInt(index, 0, groups.length - 1, groups.length - 1);
        if (at === from) {
            return false;
        }
        const moved = groups.splice(from, 1)[0];
        groups.splice(at, 0, moved);
        await this.persistQuick();
        this.refreshAllViews();
        return true;
    }

    /**
     * 按给定的 id 顺序重排分组并落盘（拖拽收尾直接拿 DOM 顺序来调用）。
     * 不在列表里的分组按原相对顺序追加在后面，避免误删。
     */
    async reorderQuickGroups(orderedIds) {
        const groups = this.quickGroups();
        const ids = Array.isArray(orderedIds) ? orderedIds : [];
        const next = [];
        ids.forEach((id) => {
            const hit = groups.filter((group) => group.id === id)[0];
            if (hit && next.indexOf(hit) < 0) {
                next.push(hit);
            }
        });
        groups.forEach((group) => {
            if (next.indexOf(group) < 0) {
                next.push(group);
            }
        });
        const changed = next.some((group, i) => groups[i] !== group);
        if (!changed) {
            return false;
        }
        this.quick.groups = next;
        await this.persistQuick();
        this.refreshAllViews();
        return true;
    }

    async clearQuick() {
        const count = quickCount(this.quick);
        this.quick = normalizeQuick(null);
        await this.persistQuick();
        this.refreshAllViews();
        return count;
    }

    /* ---------------- 卡片：快速访问（渲染层） ---------------- */

    quickItemHTML(item) {
        const icon = docIconText(item.icon);
        const full = String(item.title || "");
        // 截断只影响显示，data-doc-title / title 里始终是完整标题
        const shown = truncateTitle(full, QUICK_TITLE_MAX_DEFAULT);
        return '<div class="fh-quick__item" data-doc-id="' + esc(item.id) + '" data-doc-title="' + esc(full) +
            '" data-doc-icon="' + esc(item.icon) + '" title="' + esc(full) + '">' +
            '<span class="fh-quick__item-icon">' + (icon ? esc(icon) : ICONS.doc) + "</span>" +
            '<span class="fh-quick__item-title">' + esc(shown) + "</span>" +
            '<span class="fh-quick__item-tools">' +
            '<button class="fh-iconbtn fh-iconbtn--tiny" data-act="quick-menu" title="' +
            esc(this.t("quickMore", "更多操作")) + '">' + ICONS.more + "</button>" +
            '<button class="fh-iconbtn fh-iconbtn--tiny" data-act="quick-unpin" title="' +
            esc(this.t("quickUnpin", "取消固定")) + '">' + ICONS.close + "</button>" +
            "</span>" +
            "</div>";
    }

    renderQuickCard(view) {
        const card = this.cardEl(view, CARD_QUICK);
        if (!card) {
            return;
        }
        const body = card.querySelector("[data-card-body]");
        const groups = this.quickGroups();
        if (!quickCount(this.quick)) {
            body.innerHTML = this.emptyHTML(this.t("quickEmpty", "还没有固定任何文档"),
                this.t("quickEmptyTip", "点卡片右上角的「＋」挑一篇文档固定，或在「最近打开」里点图钉"));
            return;
        }
        let html = '<div class="fh-quick">';
        groups.forEach((group) => {
            const isDefault = group.id === QUICK_GROUP_DEFAULT;
            // 「未分类」空的就不占位置了（它只是个兜底分组，没内容时露出来只会占地方）；
            // 用户自己建的分组即使为空也保留，因为它是可见的拖放落点。
            if (isDefault && !group.items.length) {
                return;
            }
            const name = this.groupTitle(group);
            const items = group.items.map((item) => this.quickItemHTML(item)).join("");
            html += '<section class="fh-quick__group" data-group-id="' + esc(group.id) + '">' +
                '<header class="fh-quick__head">' +
                '<span class="fh-quick__grip" title="' + esc(this.t("quickGroupDrag", "拖动调整分组顺序")) + '">' +
                ICONS.grip + "</span>" +
                '<span class="fh-quick__badge">' + ICONS.folder + "</span>" +
                '<span class="fh-quick__name">' + esc(name) + "</span>" +
                '<span class="fh-quick__count">' + group.items.length + "</span>" +
                '<span class="fh-quick__spacer"></span>' +
                '<span class="fh-quick__tools">' +
                '<button class="fh-iconbtn fh-iconbtn--tiny" data-act="quick-group-rename" data-group-id="' +
                esc(group.id) + '" title="' + esc(this.t("quickGroupRename", "重命名分组")) + '">' + ICONS.pencil + "</button>" +
                (isDefault ? "" : '<button class="fh-iconbtn fh-iconbtn--tiny" data-act="quick-group-del" data-group-id="' +
                    esc(group.id) + '" title="' + esc(this.t("quickGroupDelete", "删除分组")) + '">' + ICONS.trash + "</button>") +
                "</span>" +
                "</header>" +
                '<div class="fh-quick__items" data-group-body data-group-id="' + esc(group.id) + '">' +
                items +
                (items ? "" : '<div class="fh-quick__drop">' + esc(this.t("quickDropHere", "把文档拖到这里归入本组")) + "</div>") +
                "</div>" +
                "</section>";
        });
        body.innerHTML = html + "</div>";
    }

    /**
     * 横向拉伸 / 屏幕变化时的自适应：越宽列数越多，手机竖屏则单列或两列。
     * 优先量条目网格的真实宽度（各机型的边距都不一样，量出来最准）；
     * 量不到（离线测试里 jsdom 没有布局）才按卡片宽度减去内边距反推。
     */
    applyQuickLayout(view) {
        const card = this.cardEl(view, CARD_QUICK);
        if (!card) {
            return 0;
        }
        let contentWidth = 0;
        const sample = card.querySelector(".fh-quick__items");
        if (sample) {
            const rect = sample.getBoundingClientRect();
            contentWidth = rect.width || sample.clientWidth || 0;
        }
        if (!contentWidth) {
            const cardRect = card.getBoundingClientRect();
            const cardWidth = cardRect.width || card.clientWidth || 0;
            contentWidth = Math.max(0, cardWidth - QUICK_CONTENT_PADDING);
        }
        const cols = quickColumns(contentWidth, this.settings.quickItemMin, QUICK_ITEM_GAP);
        card.style.setProperty("--fh-quick-cols", String(cols));
        card.setAttribute("data-quick-cols", String(cols));
        return cols;
    }

    /* ---------------- 卡片：快速访问（交互层） ---------------- */

    /** 从文档行上取回 Pin 所需的元信息 */
    docMetaFrom(el) {
        if (!el) {
            return null;
        }
        const id = el.getAttribute("data-doc-id");
        if (!id) {
            return null;
        }
        let title = el.getAttribute("data-doc-title") || "";
        if (!title) {
            const titleEl = el.querySelector(".fh-doc__title, .fh-quick__item-title, .fh-search__item-title");
            title = titleEl ? titleEl.textContent : "";
        }
        return { id: id, title: title, icon: el.getAttribute("data-doc-icon") || "" };
    }

    /** 文档右键菜单：打开 / 固定 / 归入分组 */
    showDocMenu(view, doc, x, y) {
        this.closeDocMenu();
        if (!doc || !doc.id) {
            return;
        }
        const pinned = this.isPinnedDoc(doc.id);
        const menu = document.createElement("div");
        menu.className = "fh-menu";
        menu.setAttribute("data-fh-menu", "");
        const row = (act, icon, text, extra) =>
            '<button class="fh-menu__item' + (act === "menu-unpin" ? " fh-menu__item--danger" : "") +
            '" data-act="' + act + '"' + (extra || "") + ">" + icon + "<span>" + esc(text) + "</span></button>";

        let html = row("menu-open", ICONS.doc, this.t("menuOpen", "打开文档")) +
            row("menu-pin", pinned ? ICONS.pinOn : ICONS.pin,
                pinned ? this.t("quickUnpin", "取消固定") : this.t("quickPin", "固定到快速访问"));
        html += '<div class="fh-menu__sep"></div>' +
            '<div class="fh-menu__label">' + esc(this.t("menuMoveTo", "归入分组")) + "</div>";
        this.groupChoices().forEach((choice) => {
            html += row("menu-move", ICONS.folder, choice.name, ' data-group-id="' + esc(choice.id) + '"');
        });
        html += row("menu-group-new", ICONS.folderPlus, this.t("quickGroupAdd", "新建分组…"));
        if (pinned) {
            html += '<div class="fh-menu__sep"></div>' +
                row("menu-unpin", ICONS.trash, this.t("quickRemove", "从快速访问中移除"));
        }
        menu.innerHTML = html;

        view.state.menuDoc = doc;
        view.root.appendChild(menu);
        const rect = menu.getBoundingClientRect();
        const maxX = (window.innerWidth || 1280) - (rect.width || 200) - 8;
        const maxY = (window.innerHeight || 800) - (rect.height || 200) - 8;
        menu.style.left = Math.max(8, Math.min(x, maxX)) + "px";
        menu.style.top = Math.max(8, Math.min(y, maxY)) + "px";
        view.menuEl = menu;
        this.quickMenuEl = menu;

        view.menuOutside = (event) => {
            if (menu.contains(event.target)) {
                return;
            }
            this.closeDocMenu();
        };
        view.menuScroll = () => this.closeDocMenu();
        view.menuKey = (event) => {
            if (event.key === "Escape") {
                this.closeDocMenu();
            }
        };
        document.addEventListener("mousedown", view.menuOutside, true);
        document.addEventListener("keydown", view.menuKey, true);
        view.root.addEventListener("scroll", view.menuScroll, true);
    }

    closeDocMenu() {
        this.views.forEach((view) => this.teardownDocMenu(view));
        this.quickMenuEl = null;
    }

    teardownDocMenu(view) {
        if (!view) {
            return;
        }
        if (view.menuEl && view.menuEl.parentNode) {
            view.menuEl.parentNode.removeChild(view.menuEl);
        }
        view.menuEl = null;
        if (view.state) {
            view.state.menuDoc = null;
        }
        if (view.menuOutside) {
            document.removeEventListener("mousedown", view.menuOutside, true);
            view.menuOutside = null;
        }
        if (view.menuKey) {
            document.removeEventListener("keydown", view.menuKey, true);
            view.menuKey = null;
        }
        if (view.menuScroll && view.root) {
            view.root.removeEventListener("scroll", view.menuScroll, true);
            view.menuScroll = null;
        }
    }

    /** 新建 / 重命名分组；onCreated 用于「新建分组并把某篇文档放进去」 */
    promptQuickGroup(view, groupId, onCreated) {
        const plugin = this;
        const group = groupId ? this.quickGroup(groupId) : null;
        const renaming = Boolean(group);
        const dialog = new Dialog({
            title: renaming ? plugin.t("quickGroupRename", "重命名分组") : plugin.t("quickGroupAdd", "新建分组"),
            width: "420px",
            content: '<div class="b3-dialog__content fh-prompt" data-fh-prompt>' +
                '<input class="b3-text-field fn__block" data-prompt-input placeholder="' +
                esc(plugin.t("quickGroupNamePlaceholder", "分组名称，例如：本周常用的几篇")) + '">' +
                '<div class="fh-prompt__tip">' + esc(plugin.t("quickGroupTip", "分组只是给 Pin 的文档分类，不会改动思源里的笔记本结构")) + "</div>" +
                '<div class="fh-prompt__foot">' +
                '<button class="b3-button b3-button--cancel" data-prompt-cancel>' + esc(plugin.t("cancel", "取消")) + "</button>" +
                '<button class="b3-button b3-button--text" data-prompt-ok>' + esc(plugin.t("confirm", "确定")) + "</button>" +
                "</div></div>",
        });
        const root = dialog.element.querySelector("[data-fh-prompt]");
        const input = root.querySelector("[data-prompt-input]");
        if (group) {
            input.value = group.name || "";
        }
        const done = async (save) => {
            const value = input.value.trim();
            if (save && value) {
                if (renaming) {
                    await plugin.renameQuickGroup(groupId, value);
                } else {
                    const id = await plugin.addQuickGroup(value);
                    if (onCreated) {
                        await onCreated(id);
                    }
                }
                showMessage(plugin.t(renaming ? "quickGroupRenamed" : "quickGroupAdded",
                    renaming ? "分组已重命名" : "分组已创建"));
            }
            dialog.destroy();
        };
        root.querySelector("[data-prompt-cancel]").addEventListener("click", () => done(false));
        root.querySelector("[data-prompt-ok]").addEventListener("click", () => done(true));
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                done(true);
            }
        });
        window.setTimeout(() => input.focus(), 60);
    }

    /** 删除分组（里面的 Pin 会退回未分类，不会消失） */
    confirmRemoveGroup(groupId) {
        const plugin = this;
        const group = this.quickGroup(groupId);
        if (!group) {
            return;
        }
        const dialog = new Dialog({
            title: plugin.t("quickGroupDelete", "删除分组"),
            width: "440px",
            content: '<div class="b3-dialog__content fh-prompt" data-fh-prompt>' +
                '<div class="fh-prompt__text">' +
                esc(plugin.t("quickGroupDeleteConfirm", "删除分组「{name}」？"))
                    .split("{name}").join(plugin.groupTitle(group)) + "</div>" +
                '<div class="fh-prompt__tip">' + esc(plugin.t("quickGroupDeleteTip", "组里的文档会退回「未分类」，不会取消固定")) + "</div>" +
                '<div class="fh-prompt__foot">' +
                '<button class="b3-button b3-button--cancel" data-prompt-cancel>' + esc(plugin.t("cancel", "取消")) + "</button>" +
                '<button class="b3-button b3-button--text" data-prompt-ok>' + esc(plugin.t("confirmDelete", "删除")) + "</button>" +
                "</div></div>",
        });
        const root = dialog.element.querySelector("[data-fh-prompt]");
        root.querySelector("[data-prompt-cancel]").addEventListener("click", () => dialog.destroy());
        root.querySelector("[data-prompt-ok]").addEventListener("click", async () => {
            const moved = await plugin.removeQuickGroup(groupId);
            dialog.destroy();
            showMessage(plugin.t("quickGroupDeleted", "分组已删除，{n} 条固定内容已移到未分类")
                .split("{n}").join(String(moved)));
        });
    }

    /** 检索文档（给「添加文档」对话框用） */
    async searchDocs(keyword, limit) {
        const kw = String(keyword || "").trim().replace(/[%_]/g, "");
        const max = limit || 20;
        let stmt = "SELECT id, content AS title, hpath, ial FROM blocks WHERE type = 'd'";
        if (kw) {
            stmt += " AND (content LIKE " + sqlQuote("%" + kw + "%") + " OR hpath LIKE " + sqlQuote("%" + kw + "%") + ")";
        }
        stmt += " ORDER BY updated DESC LIMIT " + max;
        const res = await api("/api/query/sql", { stmt });
        if (res.code !== 0 || !Array.isArray(res.data)) {
            return null;
        }
        return res.data.filter((row) => row && row.id && row.title).map((row) => {
            let icon = "";
            const match = /icon="([0-9a-fA-F]+)"/.exec(String(row.ial || ""));
            if (match) {
                icon = match[1];
            }
            return {
                id: row.id,
                title: row.title,
                icon: icon,
                sub: parentPathLabel(row.hpath, row.title),
            };
        });
    }

    /** 「添加文档」对话框：搜索 + 直接 Pin，可先选归入哪个分组 */
    openQuickPicker(view) {
        const plugin = this;
        let groupId = QUICK_GROUP_DEFAULT;
        let rows = [];
        let timer = null;

        const content = '<div class="b3-dialog__content fh-picker" data-fh-picker>' +
            '<div class="fh-picker__bar">' +
            '  <input class="b3-text-field fn__flex-1" data-picker-input placeholder="' +
            esc(plugin.t("quickSearchPlaceholder", "搜索文档标题或路径…")) + '">' +
            '  <select class="b3-select" data-picker-group></select>' +
            "</div>" +
            '<div class="fh-picker__list" data-picker-list></div>' +
            '<div class="fh-picker__foot">' +
            '<span class="fh-picker__count" data-picker-count></span>' +
            '<button class="b3-button b3-button--cancel" data-picker-newgroup>' +
            esc(plugin.t("quickGroupAdd", "新建分组")) + "</button>" +
            '<button class="b3-button b3-button--text" data-picker-ok>' + esc(plugin.t("done", "完成")) + "</button>" +
            "</div></div>";

        const dialog = new Dialog({
            title: plugin.t("quickAddTitle", "固定文档到快速访问"),
            width: "600px",
            height: "560px",
            content: content,
        });
        const root = dialog.element.querySelector("[data-fh-picker]");
        const input = root.querySelector("[data-picker-input]");
        const groupSelect = root.querySelector("[data-picker-group]");
        const list = root.querySelector("[data-picker-list]");
        const countEl = root.querySelector("[data-picker-count]");

        const fillGroups = () => {
            const choices = plugin.groupChoices();
            if (!plugin.quickGroup(groupId)) {
                groupId = choices.length ? choices[0].id : QUICK_GROUP_DEFAULT;
            }
            groupSelect.innerHTML = choices.map((choice) =>
                '<option value="' + esc(choice.id) + '">' + esc(choice.name) + "</option>").join("");
            groupSelect.value = groupId;
        };

        const badge = (text) => '<span class="fh-picker__badge">' + esc(text) + "</span>";

        const renderList = () => {
            if (rows === null) {
                list.innerHTML = '<div class="fh-picker__hint">' + esc(plugin.t("searchLoading", "搜索中…")) + "</div>";
                return;
            }
            if (!rows.length) {
                list.innerHTML = '<div class="fh-picker__hint">' + esc(plugin.t("quickNoDoc", "没有找到匹配的文档")) + "</div>";
                return;
            }
            list.innerHTML = rows.map((doc) => {
                const on = plugin.isPinnedDoc(doc.id);
                const icon = docIconText(doc.icon);
                return '<div class="fh-picker__row' + (on ? " is-on" : "") + '" data-doc-id="' + esc(doc.id) +
                    '" data-doc-title="' + esc(doc.title) + '" data-doc-icon="' + esc(doc.icon) + '">' +
                    '<span class="fh-picker__icon">' + (icon ? esc(icon) : ICONS.doc) + "</span>" +
                    '<span class="fh-picker__main">' +
                    '  <span class="fh-picker__title">' + esc(doc.title) + "</span>" +
                    (doc.sub ? '<span class="fh-picker__sub">' + esc(doc.sub) + "</span>" : "") +
                    "</span>" +
                    (on ? badge(plugin.t("quickPinnedBadge", "已固定")) : "") +
                    '<button class="fh-iconbtn fh-iconbtn--tiny" data-act="picker-toggle">' +
                    (on ? ICONS.pinOn : ICONS.pin) + "</button>" +
                    "</div>";
            }).join("");
            const total = quickCount(plugin.quick);
            countEl.textContent = plugin.t("quickTotal", "已固定 {n} 篇").split("{n}").join(String(total));
        };

        const load = async (keyword) => {
            rows = null;
            renderList();
            const list1 = await plugin.searchDocs(keyword, 30);
            if (!dialog.element || !document.contains(dialog.element)) {
                return;
            }
            rows = list1 || [];
            renderList();
        };

        fillGroups();
        load("");

        input.addEventListener("input", () => {
            if (timer) {
                window.clearTimeout(timer);
            }
            timer = window.setTimeout(() => load(input.value), SEARCH_DEBOUNCE);
        });
        groupSelect.addEventListener("change", () => {
            groupId = groupSelect.value;
        });
        list.addEventListener("click", async (event) => {
            const target = event.target.closest("[data-act='picker-toggle'], [data-doc-id]");
            const row = event.target.closest("[data-doc-id]");
            if (!row) {
                return;
            }
            const doc = plugin.docMetaFrom(row);
            if (!doc) {
                return;
            }
            await plugin.togglePin(doc, groupId);
            fillGroups();
            renderList();
            if (!target || !target.getAttribute) {
                return;
            }
        });
        root.querySelector("[data-picker-newgroup]").addEventListener("click", () => {
            plugin.promptQuickGroup(view, null);
            window.setTimeout(fillGroups, 400);
        });
        root.querySelector("[data-picker-ok]").addEventListener("click", () => dialog.destroy());
        dialog.destroyCallback = () => {
            if (timer) {
                window.clearTimeout(timer);
            }
        };
        window.setTimeout(() => input.focus(), 80);
    }

    /**
     * 条目在分组之间拖动：横向拖到别的分组即完成分类。
     * 只在快速访问卡片内部生效，且通过 .fh-nodrag 让卡片排序不接管这次手势。
     */
    bindQuickDrag(view) {
        const plugin = this;
        const grid = view.grid;
        let state = null;
        // 拖动结束后浏览器会补一个 click；不拦掉的话，落在同一条目上的点击会顺带把文档打开
        let swallowClick = false;

        const itemsIn = (body) =>
            Array.prototype.filter.call(body.children, (node) => node.classList.contains("fh-quick__item"));

        const clearDropMark = () => {
            view.root.querySelectorAll(".fh-quick__group--over").forEach((node) => {
                node.classList.remove("fh-quick__group--over");
            });
            const ph = view.root.querySelector(".fh-quick__ph");
            if (ph && ph.parentNode) {
                ph.parentNode.removeChild(ph);
            }
        };

        const onMove = (event) => {
            if (!state) {
                return;
            }
            if (!state.started) {
                if (Math.abs(event.clientX - state.startX) < 5 && Math.abs(event.clientY - state.startY) < 5) {
                    return;
                }
                state.started = true;
                state.el.classList.add("fh-quick__item--dragging");
                view.root.classList.add("fh-quick--dragging");
            }
            event.preventDefault();

            const under = document.elementFromPoint(event.clientX, event.clientY);
            const body = under && under.closest ? under.closest(".fh-quick__items") : null;
            if (!body) {
                return;
            }
            const groupEl = body.closest(".fh-quick__group");
            if (!groupEl) {
                return;
            }
            if (state.body !== body) {
                clearDropMark();
                state.body = body;
            }
            view.root.querySelectorAll(".fh-quick__group--over").forEach((node) => {
                node.classList.toggle("fh-quick__group--over", node === groupEl);
            });

            const siblings = itemsIn(body).filter((node) => node !== state.el);
            let ref = null;
            for (let i = 0; i < siblings.length; i++) {
                const rect = siblings[i].getBoundingClientRect();
                const sameRow = event.clientY >= rect.top && event.clientY <= rect.bottom;
                if (sameRow ? event.clientX < rect.left + rect.width / 2 : event.clientY < rect.top) {
                    ref = siblings[i];
                    break;
                }
            }
            const ph = view.root.querySelector(".fh-quick__ph") || document.createElement("div");
            ph.className = "fh-quick__ph";
            if (ref) {
                if (ph.nextElementSibling !== ref || ph.parentNode !== body) {
                    body.insertBefore(ph, ref);
                }
            } else if (ph.parentNode !== body || ph.nextElementSibling) {
                body.appendChild(ph);
            }
            state.groupId = body.getAttribute("data-group-id");
        };

        const onUp = async () => {
            if (!state) {
                return;
            }
            const finished = state.started;
            const el = state.el;
            const body = state.body;
            const groupId = state.groupId;
            const ph = view.root.querySelector(".fh-quick__ph");
            let index = null;
            if (finished && body && groupId) {
                // 占位符位置换算成「把自己摘出去之后」的插入序号
                const items = itemsIn(body).filter((node) => node !== el);
                if (ph && ph.parentNode === body) {
                    index = 0;
                    let node = body.firstElementChild;
                    while (node) {
                        if (node === ph) {
                            break;
                        }
                        if (node.classList && node.classList.contains("fh-quick__item") && node !== el) {
                            index++;
                        }
                        node = node.nextElementSibling;
                    }
                } else {
                    index = items.length;
                }
            }
            removeListeners();
            view.root.classList.remove("fh-quick--dragging");
            el.classList.remove("fh-quick__item--dragging");
            clearDropMark();
            state = null;
            if (index === null) {
                return;
            }
            swallowClick = true;
            await plugin.movePin(el.getAttribute("data-doc-id"), groupId, index);
        };

        const removeListeners = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
        };

        grid.addEventListener("pointerdown", (event) => {
            // 上一次拖拽留下的「吞掉点击」标记在一次新的手势开始时失效：
            // 鼠标拖拽后浏览器一定补一个 click，但触屏拖拽后往往没有，
            // 标记会一直挂着，把之后一次无关的点击也吃掉。
            swallowClick = false;
            const item = event.target.closest ? event.target.closest(".fh-quick__item") : null;
            if (!item) {
                return;
            }
            if (event.target.closest("button, a, input, select")) {
                return;
            }
            if (event.pointerType === "mouse" && event.button !== 0) {
                return;
            }
            state = {
                el: item,
                startX: event.clientX,
                startY: event.clientY,
                started: false,
                body: null,
                groupId: null,
            };
            window.addEventListener("pointermove", onMove, { passive: false });
            window.addEventListener("pointerup", onUp);
            window.addEventListener("pointercancel", onUp);
        });

        // 拖动收尾的那一次 click 只应该结束拖拽，不应该顺带打开文档
        grid.addEventListener("click", (event) => {
            if (swallowClick) {
                swallowClick = false;
                event.stopPropagation();
                event.preventDefault();
            }
        }, true);
    }

    /**
     * 分组顺序拖动：抓住组头左侧的抓手上下拖，DOM 即时重排，松手落盘。
     * 分组是纵向堆叠的，所以只比 Y 轴中点即可（这里不存在卡片网格那种多列不等高的问题）。
     */
    bindQuickGroupDrag(view) {
        const plugin = this;
        let state = null;
        let swallowClick = false;

        const sectionsIn = (wrap) =>
            Array.prototype.filter.call(wrap.children, (node) => node.classList.contains("fh-quick__group"));

        const onMove = (event) => {
            if (!state) {
                return;
            }
            if (!state.started) {
                if (Math.abs(event.clientX - state.startX) < 4 && Math.abs(event.clientY - state.startY) < 4) {
                    return;
                }
                state.started = true;
                state.el.classList.add("fh-quick__group--dragging");
                view.root.classList.add("fh-quick--sorting");
            }
            event.preventDefault();
            const others = sectionsIn(state.wrap).filter((node) => node !== state.el);
            let ref = null;
            for (let i = 0; i < others.length; i++) {
                const rect = others[i].getBoundingClientRect();
                if (event.clientY < rect.top + rect.height / 2) {
                    ref = others[i];
                    break;
                }
            }
            if (ref) {
                if (state.el.nextElementSibling !== ref) {
                    state.wrap.insertBefore(state.el, ref);
                }
            } else if (state.wrap.lastElementChild !== state.el) {
                state.wrap.appendChild(state.el);
            }
        };

        const onUp = async () => {
            if (!state) {
                return;
            }
            const finished = state.started;
            const el = state.el;
            removeListeners();
            el.classList.remove("fh-quick__group--dragging");
            view.root.classList.remove("fh-quick--sorting");
            state = null;
            if (!finished) {
                return;
            }
            swallowClick = true;
            const wrap = view.root.querySelector(".fh-quick");
            if (!wrap) {
                return;
            }
            // 直接以拖完之后的 DOM 顺序为准落盘
            await plugin.reorderQuickGroups(
                sectionsIn(wrap).map((node) => node.getAttribute("data-group-id")));
        };

        const removeListeners = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
        };

        view.grid.addEventListener("pointerdown", (event) => {
            swallowClick = false;
            const grip = event.target.closest ? event.target.closest(".fh-quick__grip") : null;
            if (!grip) {
                return;
            }
            if (event.target.closest("button, a, input, select")) {
                return;
            }
            if (event.pointerType === "mouse" && event.button !== 0) {
                return;
            }
            const el = grip.closest(".fh-quick__group");
            const wrap = el && el.parentNode;
            if (!el || !wrap || !wrap.classList.contains("fh-quick")) {
                return;
            }
            // 只有一个分组时没有顺序可调，别白记一次「重排」
            if (sectionsIn(wrap).length < 2) {
                return;
            }
            state = { el: el, wrap: wrap, startX: event.clientX, startY: event.clientY, started: false };
            window.addEventListener("pointermove", onMove, { passive: false });
            window.addEventListener("pointerup", onUp);
            window.addEventListener("pointercancel", onUp);
        });

        view.grid.addEventListener("click", (event) => {
            if (swallowClick) {
                swallowClick = false;
                event.stopPropagation();
                event.preventDefault();
            }
        }, true);
    }

    /* ---------------- 通用片段 ---------------- */

    skeletonHTML(rows) {
        let html = '<div class="fh-skeleton">';
        for (let i = 0; i < rows; i++) {
            html += "<span></span>";
        }
        return html + "</div>";
    }

    emptyHTML(title, tip) {
        return '<div class="fh-empty"><div class="fh-empty__title">' + esc(title) + "</div>" +
            (tip ? '<div class="fh-empty__tip">' + esc(tip) + "</div>" : "") + "</div>";
    }

    /* ---------------- 事件绑定 ---------------- */

    bindView(view) {
        const root = view.root;

        root.addEventListener("click", (event) => {
            const button = event.target.closest("[data-act]");
            if (button) {
                const act = button.getAttribute("data-act");
                if (act === "refresh-recent") {
                    button.classList.add("fh-iconbtn--spin");
                    this.loadRecent(view).then(() => {
                        button.classList.remove("fh-iconbtn--spin");
                    });
                } else if (act === "refresh-stats") {
                    button.classList.add("fh-iconbtn--spin");
                    this.loadStats(view).then(() => {
                        button.classList.remove("fh-iconbtn--spin");
                    });
                } else if (act === "cal-prev") {
                    this.shiftMonth(view, -1);
                } else if (act === "cal-next") {
                    this.shiftMonth(view, 1);
                } else if (act === "cal-today") {
                    const now = new Date();
                    view.state.year = now.getFullYear();
                    view.state.month = now.getMonth();
                    view.state.selectedDay = null;
                    view.state.dayDocs = null;
                    this.renderCalendarCard(view);
                    this.loadCalendar(view);
                } else if (act === "save-note") {
                    this.saveNote(view);
                } else if (act === "del-note") {
                    const noteEl = event.target.closest("[data-note-id]");
                    if (noteEl) {
                        this.deleteNote(noteEl.getAttribute("data-note-id"));
                    }
                } else if (act === "day-close") {
                    view.state.selectedDay = null;
                    view.state.dayDocs = null;
                    this.renderCalendarCard(view);
                } else if (act === "day-create") {
                    this.createDailyNote(view, view.state.selectedDay);
                } else if (act === "close-home") {
                    this.closeOverlay();
                } else if (act === "search-clear") {
                    this.clearSearch(view);
                    const input = root.querySelector("[data-fh-search-input]");
                    if (input) {
                        input.focus();
                    }
                } else if (act === "quick-add") {
                    this.openQuickPicker(view);
                } else if (act === "quick-group-add") {
                    this.closeDocMenu();
                    this.promptQuickGroup(view, null);
                } else if (act === "quick-group-rename") {
                    this.promptQuickGroup(view, button.getAttribute("data-group-id"));
                } else if (act === "quick-group-del") {
                    this.confirmRemoveGroup(button.getAttribute("data-group-id"));
                } else if (act === "quick-unpin") {
                    const host = event.target.closest("[data-doc-id]");
                    const doc = this.docMetaFrom(host);
                    if (doc) {
                        this.unpinDoc(doc.id).then(() => {
                            showMessage(this.t("quickUnpinned", "已取消固定"));
                        });
                    }
                } else if (act === "quick-menu") {
                    const host = event.target.closest("[data-doc-id]");
                    const rect = button.getBoundingClientRect();
                    this.showDocMenu(view, this.docMetaFrom(host), rect.left, rect.bottom + 4);
                } else if (act === "pin-doc") {
                    this.togglePin(this.docMetaFrom(button));
                } else if (act === "menu-open") {
                    const doc = view.state.menuDoc;
                    this.closeDocMenu();
                    if (doc) {
                        this.openDoc(doc.id);
                    }
                } else if (act === "menu-pin") {
                    const doc = view.state.menuDoc;
                    this.closeDocMenu();
                    this.togglePin(doc);
                } else if (act === "menu-move") {
                    const doc = view.state.menuDoc;
                    const groupId = button.getAttribute("data-group-id");
                    this.closeDocMenu();
                    if (doc) {
                        this.pinDoc(doc, groupId).then(() => {
                            showMessage(this.t("quickMoved", "已归入「{name}」")
                                .split("{name}").join(this.groupTitle(this.quickGroup(groupId))));
                        });
                    }
                } else if (act === "menu-group-new") {
                    const doc = view.state.menuDoc;
                    this.closeDocMenu();
                    if (doc) {
                        // 新建分组后把这篇文章直接放进去
                        this.promptQuickGroup(view, null, (id) => this.pinDoc(doc, id));
                    }
                } else if (act === "menu-unpin") {
                    const doc = view.state.menuDoc;
                    this.closeDocMenu();
                    if (doc) {
                        this.unpinDoc(doc.id).then(() => {
                            showMessage(this.t("quickUnpinned", "已取消固定"));
                        });
                    }
                }
                return;
            }

            const docEl = event.target.closest("[data-doc-id]");
            if (docEl) {
                event.preventDefault();
                if (root.querySelector("[data-fh-search]") &&
                    root.querySelector("[data-fh-search]").contains(docEl)) {
                    this.clearSearch(view);
                }
                this.openDoc(docEl.getAttribute("data-doc-id"));
                return;
            }

            const dayEl = event.target.closest("[data-day]");
            if (dayEl) {
                const key = dayEl.getAttribute("data-day");
                const year = parseInt(key.slice(0, 4), 10);
                const month = parseInt(key.slice(4, 6), 10) - 1;
                if (year !== view.state.year || month !== view.state.month) {
                    view.state.year = year;
                    view.state.month = month;
                    view.state.selectedDay = key;
                    view.state.dayDocs = null;
                    this.renderCalendarCard(view);
                    this.loadCalendar(view);
                    this.selectDay(view, key);
                    return;
                }
                this.selectDay(view, key);
            }
        });

        root.addEventListener("keydown", (event) => {
            const target = event.target;
            if (target && target.hasAttribute && target.hasAttribute("data-note-input")) {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    this.saveNote(view);
                }
                return;
            }
            if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === "k") {
                event.preventDefault();
                const input = root.querySelector("[data-fh-search-input]");
                if (input && this.settings.showSearch !== false) {
                    input.focus();
                    input.select();
                }
            }
        });

        // 右键任意文档行 → 固定 / 归入分组（这是最顺手的 Pin 入口）
        root.addEventListener("contextmenu", (event) => {
            const docEl = event.target.closest ? event.target.closest("[data-doc-id]") : null;
            if (!docEl) {
                return;
            }
            const doc = this.docMetaFrom(docEl);
            if (!doc) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            this.showDocMenu(view, doc, event.clientX, event.clientY);
        });

        this.bindQuickDrag(view);
        this.bindQuickGroupDrag(view);
    }

    shiftMonth(view, delta) {
        const date = new Date(view.state.year, view.state.month + delta, 1);
        view.state.year = date.getFullYear();
        view.state.month = date.getMonth();
        view.state.selectedDay = null;
        view.state.dayDocs = null;
        this.renderCalendarCard(view);
        this.loadCalendar(view);
    }

    /* ---------------- 设置 ---------------- */

    async persistSettings() {
        try {
            await this.saveData(SETTINGS_FILE, this.settings);
        } catch (err) {
            // 只读模式忽略
        }
    }

    refreshAllViews() {
        this.views.forEach((view) => {
            if (view.el.isConnected) {
                this.refreshView(view);
            }
        });
    }

    /**
     * 在 onload 里构建并挂上 Setting 实例。
     * 所有控件都走 createActionElement —— Setting.open() 每次都会重新调用它，
     * 因此每次打开设置面板拿到的都是绑定当前草稿的新 DOM。
     */
    initSetting() {
        const plugin = this;
        const setting = new Setting({
            confirmCallback: () => {
                plugin.applyDraft();
            },
        });

        /**
         * 加一个设置项。
         *
         * direction 默认 "row"，这是这份设置面板排版的关键：
         * 思源的 column 分支会把控件直接挂成 `.config-item` 的子节点，并给它加上
         * `fn__flex-center` / `fn__size200`，于是
         *   1) `.config-item>.fn__size200:not(.b3-switch){flex:1 1 100%;max-width:100%}`
         *      会盖掉插件自己写的 max-width —— 滑杆被拉满整行，数值被推到屏幕另一头，
         *      看起来就是"一行里大片空白"；
         *   2) 标题所在的 `.fn__flex-1{flex:1}` 会独占整行，右边留一条长长的空白。
         * row 分支则把控件放进标题下方的 `.fn__block` 里，宽度完全由插件 CSS 说了算。
         * 只有开关（b3-switch）适合 column：标题在左、开关在右，是思源的原生长相。
         */
        const add = (title, description, build, direction) => {
            setting.addItem({
                title: title,
                description: description,
                createActionElement: build,
                direction: direction || "row",
            });
        };

        const draft = () => plugin.__draft || plugin.settings;

        // —— 启动行为 ——
        // 放在面板最顶上：「一启动就进主页」是决定用户每天第一眼看到什么的选择，
        // 该在第一屏就能改到，而不是埋在「其他」里。
        add(
            this.t("setOpenOnLaunch", "打开思源时进入主页"),
            this.t("setOpenOnLaunchDesc", "开启后，下次启动思源自动切到主页；主页标签已经打开时直接切过去，不会重复新建。手机端、只读模式与首次引导期间不生效"),
            () => this.buildSwitch(draft().openOnLaunch === true, (checked) => {
                draft().openOnLaunch = checked;
            }),
            "column"   // 开关留在标题右侧，与「搜索框」同一套长相
        );

        // —— 问候语 ——
        add(
            this.t("setUserName", "称呼"),
            this.t("setUserNameDesc", "问候语第一行里使用的名字"),
            () => {
                const input = document.createElement("input");
                input.className = "b3-text-field fn__block";
                input.value = draft().userName || "";
                input.placeholder = this.t("setUserNamePlaceholder", "例如：小明");
                input.addEventListener("input", () => {
                    draft().userName = input.value;
                });
                return input;
            }
        );

        add(
            this.t("setSuffixMode", "第二行文案"),
            this.t("setSuffixModeDesc", "问候语第二行显示什么"),
            () => {
                const select = document.createElement("select");
                select.className = "b3-select";
                [
                    ["daily", this.t("setSuffixModeDaily", "每天换一句（内置诗句）")],
                    ["custom", this.t("setSuffixModeCustom", "一直用下面这句")],
                ].forEach((entry) => {
                    const option = document.createElement("option");
                    option.value = entry[0];
                    option.textContent = entry[1];
                    select.appendChild(option);
                });
                select.value = draft().suffixMode === "custom" ? "custom" : "daily";
                select.addEventListener("change", () => {
                    draft().suffixMode = select.value;
                });
                return select;
            }
        );

        add(
            this.t("setCustomLine", "自定义句子"),
            this.t("setCustomLineDesc", "选择「一直用下面这句」时生效；选「每天换一句」时会把它加进诗句池一起轮换"),
            () => {
                const input = document.createElement("input");
                input.className = "b3-text-field fn__block";
                input.value = draft().greetingSuffix || "";
                input.placeholder = this.t("setCustomLinePlaceholder", "今天从哪里开始？");
                input.addEventListener("input", () => {
                    draft().greetingSuffix = input.value;
                });
                return input;
            }
        );

        // —— 外观 ——
        add(
            this.t("setBackground", "背景图"),
            this.t("setBackgroundDesc", "支持思源资源路径（assets/xxx.png）或图片直链（https://…）。留空则使用主题背景色"),
            () => {
                const row = document.createElement("div");
                row.className = "fh-set-row fn__block";
                const input = document.createElement("input");
                input.className = "b3-text-field fn__flex-1";
                input.value = draft().background || "";
                input.placeholder = this.t("setBackgroundPlaceholder", "留空使用主题背景");
                input.addEventListener("input", () => {
                    draft().background = input.value;
                });
                const upload = document.createElement("button");
                upload.className = "b3-button b3-button--outline";
                upload.textContent = this.t("setUpload", "选择图片");
                upload.addEventListener("click", () => {
                    const picker = document.createElement("input");
                    picker.type = "file";
                    picker.accept = "image/*";
                    picker.addEventListener("change", async () => {
                        const file = picker.files && picker.files[0];
                        if (!file) {
                            return;
                        }
                        upload.disabled = true;
                        const path = await plugin.uploadAsset(file);
                        upload.disabled = false;
                        if (path) {
                            input.value = path;
                            draft().background = path;
                            showMessage(plugin.t("setUploadOk", "图片已上传"));
                        } else {
                            showMessage(plugin.t("setUploadFail", "图片上传失败"));
                        }
                    });
                    picker.click();
                });
                const clear = document.createElement("button");
                clear.className = "b3-button b3-button--outline";
                clear.textContent = this.t("setClear", "清除");
                clear.addEventListener("click", () => {
                    input.value = "";
                    draft().background = "";
                });
                row.appendChild(input);
                row.appendChild(upload);
                row.appendChild(clear);
                return row;
            }
        );

        add(this.t("setBlur", "背景模糊"), this.t("setBlurDesc", "单位 px，0 表示不模糊"), () => this.buildRange(
            0, 40, 1, draft().backgroundBlur, this.t("unitPx", "px"), (value) => {
                draft().backgroundBlur = value;
            }
        ));

        add(this.t("setDim", "背景压暗"), this.t("setDimDesc", "百分比 0-80，背景图较亮时调高让文字更清晰"), () => this.buildRange(
            0, 80, 1, draft().backgroundDim, this.t("unitPercent", "%"), (value) => {
                draft().backgroundDim = value;
            }
        ));

        // —— 卡片 ——
        add(
            this.t("setUsageReset", "使用时长记录"),
            this.t("setUsageResetDesc", "使用时长由插件在本地累计（思源不记录）。清空后统计卡片里的「今日使用时长」会从零开始"),
            () => {
                const button = document.createElement("button");
                button.className = "b3-button b3-button--outline fh-set-action";
                button.textContent = this.t("setUsageResetBtn", "清空记录");
                button.addEventListener("click", () => {
                    plugin.resetUsage();
                    plugin.refreshAllViews();
                    showMessage(plugin.t("setUsageResetDone", "使用时长记录已清空"));
                });
                return button;
            }
        );

        add(
            this.t("setCards", "显示的卡片"),
            this.t("setCardsDesc", "主页上的卡片管理：取消勾选即从主页移除，重新勾选即可加回来。顺序直接在主页上拖动调整"),
            () => this.buildCardManager()
        );

        add(
            this.t("setSearch", "搜索框"),
            this.t("setSearchDesc", "在问候语下方显示搜索框，可快速搜索文档标题与正文"),
            () => this.buildSwitch(draft().showSearch !== false, (checked) => {
                draft().showSearch = checked;
            }),
            "column"   // 开关留在标题右侧，用思源原生的那一套
        );

        add(
            this.t("setCardSizeReset", "恢复卡片默认尺寸"),
            this.t("setCardSizeResetDesc", "所有卡片回到默认尺寸（最近打开 / 灵感随记 / 日历 / 统计为 1/4 宽，快速访问为整行宽）"),
            () => {
                const button = document.createElement("button");
                button.className = "b3-button b3-button--outline fh-set-action";
                button.textContent = this.t("setCardSizeResetBtn", "恢复默认尺寸");
                button.addEventListener("click", () => {
                    plugin.settings.cardSize = defaultCardSize();
                    plugin.__draft.cardSize = defaultCardSize();
                    plugin.persistSettings();
                    plugin.refreshAllViews();
                    showMessage(plugin.t("setCardSizeResetDone", "卡片尺寸已恢复默认"));
                });
                return button;
            }
        );

        add(this.t("setRecentCount", "最近文档数量"), this.t("setRecentCountDesc", "「最近打开」卡片显示的条数（3 - 30）"), () => this.buildRange(
            3, 30, 1, draft().recentCount, this.t("unitItems", "条"), (value) => {
                draft().recentCount = value;
            }
        ));

        add(this.t("setNoteCount", "灵感显示数量"), this.t("setNoteCountDesc", "「灵感随记」卡片最多显示的条数（3 - 30）"), () => this.buildRange(
            3, 30, 1, draft().noteCount, this.t("unitItems", "条"), (value) => {
                draft().noteCount = value;
            }
        ));

        // —— 快速访问 ——
        add(this.t("setQuickItemMin", "快速访问条目宽度"), this.t("setQuickItemMinDesc",
            "单个条目所需的最小宽度。快速访问卡片横向拉宽后，会按这个宽度自动多排几列"), () => this.buildRange(
            QUICK_ITEM_MIN_RANGE[0], QUICK_ITEM_MIN_RANGE[1], 4,
            draft().quickItemMin, this.t("unitPx", "px"), (value) => {
                draft().quickItemMin = value;
            }
        ));

        add(
            this.t("setQuickManage", "快速访问内容"),
            this.t("setQuickManageDesc", "已固定的文档与分组。移除只影响快速访问，不会删除思源里的文档"),
            () => this.buildQuickManager()
        );

        // —— 数据 ——
        add(
            this.t("setNoteTarget", "灵感归宿"),
            this.t("setNoteTargetDesc", "新记录的灵感写到哪里。可以只留在本地、写进某个笔记本，或追加到某一篇笔记里"),
            () => this.buildNoteTargetControl()
        );

        add(
            this.t("setWeekStart", "每周起始"),
            this.t("setWeekStartDesc", "日历第一列是星期几"),
            () => {
                const select = document.createElement("select");
                select.className = "b3-select";
                [
                    ["1", this.t("setWeekStartMon", "星期一")],
                    ["0", this.t("setWeekStartSun", "星期日")],
                ].forEach((entry) => {
                    const option = document.createElement("option");
                    option.value = entry[0];
                    option.textContent = entry[1];
                    select.appendChild(option);
                });
                select.value = draft().weekStart ? "1" : "0";
                select.addEventListener("change", () => {
                    draft().weekStart = select.value === "1" ? 1 : 0;
                });
                return select;
            }
        );

        add(
            this.t("setDailyPath", "日记路径模板"),
            this.t("setDailyPathDesc", "点击日历空白日期时新建日记的路径。可用 {yyyy} {MM} {dd} {yyyy-MM-dd} 占位符"),
            () => {
                const input = document.createElement("input");
                input.className = "b3-text-field fn__block";
                input.value = draft().dailyPath || DEFAULT_SETTINGS.dailyPath;
                input.placeholder = DEFAULT_SETTINGS.dailyPath;
                input.addEventListener("input", () => {
                    draft().dailyPath = input.value;
                });
                return input;
            }
        );

        // —— 其他 ——
        add(
            this.t("setRerunOnboarding", "重新运行引导"),
            this.t("setRerunOnboardingDesc", "再次打开首次安装时的设置向导"),
            () => {
                const button = document.createElement("button");
                button.className = "b3-button b3-button--outline fh-set-action";
                button.textContent = this.t("setRerunOnboardingBtn", "运行引导");
                button.addEventListener("click", () => {
                    if (setting.dialog) {
                        setting.dialog.destroy();
                    }
                    window.setTimeout(() => plugin.showOnboarding(true), 120);
                });
                return button;
            }
        );

        add(
            this.t("setReset", "恢复默认设置"),
            this.t("setResetDesc", "把所有设置恢复为初始值（不会删除已记录的灵感）"),
            () => {
                const button = document.createElement("button");
                button.className = "b3-button b3-button--outline fh-set-action";
                button.textContent = this.t("setResetBtn", "恢复默认");
                button.addEventListener("click", async () => {
                    const fresh = deepCopy(DEFAULT_SETTINGS);
                    fresh.onboarded = true;
                    plugin.settings = fresh;
                    plugin.__draft = deepCopy(fresh);
                    await plugin.persistSettings();
                    plugin.refreshAllViews();
                    showMessage(plugin.t("setResetDone", "已恢复默认设置"));
                    if (setting.dialog) {
                        setting.dialog.destroy();
                    }
                    window.setTimeout(() => plugin.openSettings(), 120);
                });
                return button;
            }
        );

        // 拦截 open：每次打开都重置草稿，并关掉可能还开着的旧面板
        const rawOpen = setting.open.bind(setting);
        setting.open = (name) => {
            if (setting.dialog && setting.dialog.element && document.contains(setting.dialog.element)) {
                try {
                    setting.dialog.destroy();
                } catch (err) {
                    // 忽略
                }
            }
            plugin.__draft = deepCopy(plugin.settings);
            plugin.__draft.hiddenCards = (plugin.settings.hiddenCards || []).slice();
            plugin.__draft.cardOrder = normalizeOrder(plugin.settings.cardOrder);
            plugin.__draft.cardSize = normalizeCardSize(plugin.settings.cardSize);
            plugin.__draft.noteTarget = Object.assign({ type: "none", notebook: "", docId: "", docPath: "" }, plugin.settings.noteTarget || {});
            plugin.refreshNotebooks();
            rawOpen(name || plugin.t("settingsTitle", "森林主页设置"));
        };

        this.setting = setting;
    }

    async openSettings() {
        if (!this.setting) {
            this.initSetting();
        }
        // 先把笔记本缓存准备好，目标笔记下拉才有数据
        await this.refreshNotebooks();
        this.setting.open(this.t("settingsTitle", "森林主页设置"));
    }

    async applyDraft() {
        const draft = this.__draft || {};
        const next = deepCopy(DEFAULT_SETTINGS);
        Object.assign(next, draft);
        next.onboarded = true;
        next.cardOrder = normalizeOrder(draft.cardOrder);
        next.hiddenCards = (draft.hiddenCards || []).filter((id) => ALL_CARDS.indexOf(id) >= 0);
        next.recentCount = clampInt(draft.recentCount, 3, 30, 8);
        next.noteCount = clampInt(draft.noteCount, 3, 30, 5);
        next.quickItemMin = clampInt(draft.quickItemMin,
            QUICK_ITEM_MIN_RANGE[0], QUICK_ITEM_MIN_RANGE[1], QUICK_ITEM_MIN_DEFAULT);
        next.cardSize = normalizeCardSize(draft.cardSize);
        next.openOnLaunch = normalizeSwitch(draft.openOnLaunch, DEFAULT_SETTINGS.openOnLaunch);
        next.showSearch = draft.showSearch !== false;
        const t = draft.noteTarget || {};
        next.noteTarget = {
            type: ["none", "notebook", "doc"].indexOf(t.type) >= 0 ? t.type : "none",
            notebook: String(t.notebook || ""),
            docId: String(t.docId || ""),
            docPath: String(t.docPath || ""),
        };
        this.settings = next;
        await this.persistSettings();
        this.refreshAllViews();
        showMessage(this.t("settingsSaved", "设置已保存"));
    }

    /**
     * 开关行：思源原生的 `<input class="b3-switch">` + direction:"column"。
     * column 分支下标题在左、开关在右，是思源自己的开关长相；也不要给它加
     * fn__size200，否则会被 `.config-item>.fn__size200` 那条规则撑成整行。
     * 「搜索框」与「打开思源时进入主页」共用这一个构件，保证两处长得一模一样。
     */
    buildSwitch(checked, onChange) {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.className = "b3-switch";
        box.checked = checked === true;
        box.addEventListener("change", () => {
            onChange(box.checked);
        });
        return box;
    }

    /**
     * 滑杆行：自带可见的轨道与滑块 + 带单位的数值标签。
     * 刻意不用思源的 .b3-slider —— 那套样式由主题接管（Asri 主题会把滑块改成
     * 白色圆点 + 极淡轨道，在浅色下几乎看不见，整行就变成"一条没有标注的空长条"）。
     * 这里连轨道颜色都自己定，任何主题下都长一样。
     */
    buildRange(min, max, step, value, unit, onChange) {
        const row = document.createElement("div");
        row.className = "fh-set-range fn__block";
        const slider = document.createElement("input");
        slider.type = "range";
        slider.className = "fh-range fn__flex-1";
        slider.min = String(min);
        slider.max = String(max);
        slider.step = String(step);
        slider.value = String(clampInt(value, min, max, min));
        const label = document.createElement("span");
        label.className = "fh-set-range__value";
        const paint = () => {
            label.textContent = unit ? (slider.value + " " + unit).trim() : slider.value;
        };
        paint();
        slider.addEventListener("input", () => {
            paint();
            onChange(parseInt(slider.value, 10));
        });
        row.appendChild(slider);
        row.appendChild(label);
        return row;
    }

    /**
     * 卡片清单的唯一来源：设置面板与首次安装引导都读它，
     * 以后新增卡片只要加进 ALL_CARDS，两处会同时出现。
     */
    cardListMeta() {
        const map = {};
        map[CARD_RECENT] = [this.t("cardRecent", "最近打开"), ICONS.recent];
        map[CARD_INSPIRATION] = [this.t("cardInspiration", "灵感随记"), ICONS.spark];
        map[CARD_CALENDAR] = [this.t("cardCalendar", "日历"), ICONS.calendar];
        map[CARD_STATS] = [this.t("cardStats", "统计"), ICONS.stats];
        map[CARD_QUICK] = [this.t("cardQuick", "快速访问"), ICONS.quick];
        return ALL_CARDS.map((id) => ({
            id: id,
            title: (map[id] || [id, ICONS.doc])[0],
            icon: (map[id] || [id, ICONS.doc])[1],
        }));
    }

    /** 设置里的「显示的卡片」：勾选即显示，外加全显 / 全隐 / 恢复默认顺序 */
    buildCardManager() {
        const plugin = this;
        const draft = () => plugin.__draft;
        const wrap = document.createElement("div");
        wrap.className = "fh-set-cards fn__block";

        const list = document.createElement("div");
        list.className = "fh-set-cards__list";

        const isHidden = (id) => draft().hiddenCards.indexOf(id) >= 0;
        const toggle = (id, show) => {
            const hidden = draft().hiddenCards;
            const index = hidden.indexOf(id);
            if (show && index >= 0) {
                hidden.splice(index, 1);
            } else if (!show && index < 0) {
                hidden.push(id);
            }
        };

        plugin.cardListMeta().forEach((card) => {
            const label = document.createElement("label");
            label.className = "fh-set-card";
            const box = document.createElement("input");
            box.type = "checkbox";
            box.className = "b3-switch";
            box.checked = !isHidden(card.id);
            const icon = document.createElement("span");
            icon.className = "fh-set-card__icon";
            icon.innerHTML = card.icon;
            const text = document.createElement("span");
            text.className = "fh-set-card__text";
            text.textContent = card.title;
            box.addEventListener("change", () => {
                toggle(card.id, box.checked);
                paintCount();
            });
            label.appendChild(box);
            label.appendChild(icon);
            label.appendChild(text);
            list.appendChild(label);
        });

        const count = document.createElement("div");
        count.className = "fh-set-cards__count";
        const paintCount = () => {
            const hidden = draft().hiddenCards.length;
            const shown = ALL_CARDS.length - hidden;
            count.textContent = plugin.t("setCardsCount", "主页上会显示 {n} / {total} 张卡片")
                .split("{n}").join(String(shown))
                .split("{total}").join(String(ALL_CARDS.length));
        };
        paintCount();

        const makeButton = (act, label) => {
            const button = document.createElement("button");
            button.className = "b3-button b3-button--outline fh-set-cards__btn";
            button.textContent = label;
            button.addEventListener("click", () => {
                if (act === "all") {
                    draft().hiddenCards = [];
                } else if (act === "none") {
                    draft().hiddenCards = ALL_CARDS.slice();
                } else {
                    draft().cardOrder = ALL_CARDS.slice();
                }
                list.querySelectorAll("input").forEach((box, i) => {
                    box.checked = !isHidden(ALL_CARDS[i]);
                });
                paintCount();
                showMessage(plugin.t(
                    act === "all" ? "setCardsAllDone" : (act === "none" ? "setCardsNoneDone" : "setCardsOrderDone"),
                    act === "all" ? "已显示全部卡片" : (act === "none" ? "已隐藏全部卡片" : "卡片顺序已恢复默认")));
            });
            return button;
        };

        const foot = document.createElement("div");
        foot.className = "fh-set-cards__foot";
        foot.appendChild(makeButton("all", plugin.t("setCardsAll", "全部显示")));
        foot.appendChild(makeButton("none", plugin.t("setCardsNone", "全部隐藏")));
        foot.appendChild(makeButton("order", plugin.t("setCardsOrder", "恢复默认顺序")));

        wrap.appendChild(list);
        wrap.appendChild(count);
        wrap.appendChild(foot);
        return wrap;
    }

    /** 设置里的「快速访问管理」：分组 + 条目一览，可移除 */
    buildQuickManager() {
        const plugin = this;
        const wrap = document.createElement("div");
        wrap.className = "fh-set-quick fn__block";
        const list = document.createElement("div");
        list.className = "fh-set-quick__list";

        const paint = () => {
            list.innerHTML = "";
            const groups = plugin.quickGroups();
            groups.forEach((group) => {
                const section = document.createElement("div");
                section.className = "fh-set-quick__group";
                const head = document.createElement("div");
                head.className = "fh-set-quick__head";
                const name = document.createElement("span");
                name.className = "fh-set-quick__name";
                name.innerHTML = ICONS.folder;
                const nameText = document.createElement("span");
                nameText.className = "fh-set-quick__name-text";
                nameText.textContent = plugin.groupTitle(group);
                name.appendChild(nameText);
                // 数量单独做成小胶囊，不要和分组名挤成「名字 · 3」一行
                const countChip = document.createElement("span");
                countChip.className = "fh-set-quick__count";
                countChip.textContent = String(group.items.length);
                const spacer = document.createElement("span");
                spacer.className = "fh-set-quick__spacer";
                head.appendChild(name);
                head.appendChild(countChip);
                head.appendChild(spacer);
                if (group.id !== QUICK_GROUP_DEFAULT) {
                    const del = document.createElement("button");
                    del.className = "b3-button b3-button--outline fh-set-quick__del";
                    del.textContent = plugin.t("quickGroupDelete", "删除分组");
                    del.addEventListener("click", async () => {
                        await plugin.removeQuickGroup(group.id);
                        paint();
                    });
                    head.appendChild(del);
                }
                section.appendChild(head);

                if (!group.items.length) {
                    const empty = document.createElement("div");
                    empty.className = "fh-set-quick__empty";
                    empty.textContent = plugin.t("quickGroupEmpty", "这个分组还没有内容");
                    section.appendChild(empty);
                } else {
                    group.items.forEach((item) => {
                        const row = document.createElement("div");
                        row.className = "fh-set-quick__item";
                        const icon = document.createElement("span");
                        icon.className = "fh-set-quick__icon";
                        const emoji = docIconText(item.icon);
                        icon.textContent = emoji || "";
                        if (!emoji) {
                            icon.innerHTML = ICONS.doc;
                        }
                        const text = document.createElement("span");
                        text.className = "fh-set-quick__title";
                        text.textContent = item.title;
                        const del = document.createElement("button");
                        del.className = "fh-iconbtn fh-iconbtn--tiny";
                        del.title = plugin.t("quickRemove", "从快速访问中移除");
                        del.innerHTML = ICONS.close;
                        del.addEventListener("click", async () => {
                            await plugin.unpinDoc(item.id);
                            paint();
                        });
                        row.appendChild(icon);
                        row.appendChild(text);
                        row.appendChild(del);
                        section.appendChild(row);
                    });
                }
                list.appendChild(section);
            });

            if (!list.children.length) {
                const empty = document.createElement("div");
                empty.className = "fh-set-quick__empty";
                empty.textContent = plugin.t("quickEmpty", "还没有固定任何文档");
                list.appendChild(empty);
            }
        };

        const foot = document.createElement("div");
        foot.className = "fh-set-quick__foot";
        const addGroup = document.createElement("button");
        addGroup.className = "b3-button b3-button--outline";
        addGroup.textContent = plugin.t("quickGroupAdd", "新建分组");
        addGroup.addEventListener("click", () => {
            plugin.promptQuickGroup(null, null);
            window.setTimeout(paint, 400);
        });
        const clear = document.createElement("button");
        clear.className = "b3-button b3-button--outline";
        clear.textContent = plugin.t("quickClearAll", "清空全部固定");
        clear.addEventListener("click", async () => {
            const n = await plugin.clearQuick();
            paint();
            showMessage(plugin.t("quickCleared", "已清空 {n} 条固定内容").split("{n}").join(String(n)));
        });
        foot.appendChild(addGroup);
        foot.appendChild(clear);

        paint();
        wrap.appendChild(list);
        wrap.appendChild(foot);
        return wrap;
    }

    /**
     * 「灵感归宿」控件：模式 + 笔记本 + 目标笔记三级联动。
     * 每次打开设置面板都会重建一次，所以内部状态全部从 __draft 读。
     */
    buildNoteTargetControl() {
        const plugin = this;
        const draft = () => plugin.__draft;
        const target = () => draft().noteTarget;

        const wrap = document.createElement("div");
        wrap.className = "fh-target fn__block";

        const typeSelect = document.createElement("select");
        typeSelect.className = "b3-select";
        [
            ["none", plugin.t("noteTargetNone", "仅保存在插件本地")],
            ["notebook", plugin.t("noteTargetNotebook", "写入某个笔记本")],
            ["doc", plugin.t("noteTargetDoc", "追加到某一篇笔记")],
        ].forEach((entry) => {
            const option = document.createElement("option");
            option.value = entry[0];
            option.textContent = entry[1];
            typeSelect.appendChild(option);
        });
        typeSelect.value = target().type || "none";

        const nbRow = document.createElement("div");
        nbRow.className = "fh-target__row";
        const nbCaption = document.createElement("span");
        nbCaption.className = "fh-target__label";
        nbCaption.textContent = plugin.t("noteTargetNotebookLabel", "笔记本");
        const nbSelect = document.createElement("select");
        nbSelect.className = "b3-select fn__flex-1";
        nbRow.appendChild(nbCaption);
        nbRow.appendChild(nbSelect);

        const docRow = document.createElement("div");
        docRow.className = "fh-target__row fh-target__row--stack";
        const docCaption = document.createElement("span");
        docCaption.className = "fh-target__label";
        docCaption.textContent = plugin.t("noteTargetDocLabel", "目标笔记");
        const docSearch = document.createElement("input");
        docSearch.className = "b3-text-field fn__flex-1";
        docSearch.placeholder = plugin.t("noteTargetDocSearch", "搜索文档标题…");
        const docSelect = document.createElement("select");
        docSelect.className = "b3-select fn__flex-1";
        docRow.appendChild(docCaption);
        docRow.appendChild(docSearch);
        docRow.appendChild(docSelect);

        const hint = document.createElement("div");
        hint.className = "fh-target__hint";

        wrap.appendChild(typeSelect);
        wrap.appendChild(nbRow);
        wrap.appendChild(docRow);
        wrap.appendChild(hint);

        const fillNotebooks = (list) => {
            nbSelect.innerHTML = "";
            (list || []).forEach((notebook) => {
                const option = document.createElement("option");
                option.value = notebook.id;
                option.textContent = notebook.name;
                nbSelect.appendChild(option);
            });
            if (!(list || []).length) {
                const option = document.createElement("option");
                option.value = "";
                option.textContent = plugin.t("noteTargetNoNotebook", "没有可用的笔记本");
                nbSelect.appendChild(option);
            }
            if (target().notebook && !list.some((n) => n.id === target().notebook)) {
                const option = document.createElement("option");
                option.value = target().notebook;
                option.textContent = target().notebook;
                nbSelect.appendChild(option);
            }
            nbSelect.value = target().notebook || "";
        };

        const fillDocs = (list) => {
            docSelect.innerHTML = "";
            const docs = list || [];
            const keep = target().docId;
            const hasKeep = keep && docs.some((d) => d.id === keep);
            if (!docs.length && !keep) {
                const option = document.createElement("option");
                option.value = "";
                option.textContent = plugin.t("noteTargetNoDoc", "没有找到文档");
                docSelect.appendChild(option);
            }
            if (keep && !hasKeep) {
                const option = document.createElement("option");
                option.value = keep;
                option.textContent = target().docPath || keep;
                docSelect.appendChild(option);
            }
            docs.forEach((doc) => {
                const option = document.createElement("option");
                option.value = doc.id;
                option.textContent = doc.title;
                option.setAttribute("data-path", doc.hpath || doc.title || "");
                docSelect.appendChild(option);
            });
            docSelect.value = keep || "";
        };

        const loadDocs = async (notebookId, keyword) => {
            if (!notebookId) {
                fillDocs([]);
                return;
            }
            const kw = String(keyword || "").trim();
            let stmt = "SELECT id, content AS title, hpath FROM blocks WHERE type = 'd' AND box = " + sqlQuote(notebookId);
            if (kw) {
                stmt += " AND content LIKE " + sqlQuote("%" + kw + "%");
            }
            stmt += " ORDER BY updated DESC LIMIT 200";
            const res = await api("/api/query/sql", { stmt });
            fillDocs(res.code === 0 && Array.isArray(res.data)
                ? res.data.filter((row) => row && row.id && row.title)
                : []);
        };

        const syncVisibility = () => {
            const type = target().type;
            nbRow.classList.toggle("fn__none", type === "none");
            docRow.classList.toggle("fn__none", type !== "doc");
            if (type === "doc") {
                hint.textContent = plugin.t("noteTargetHintDoc", "每条灵感会以列表项的形式追加到该笔记末尾");
            } else if (type === "notebook") {
                hint.textContent = plugin.t("noteTargetHintNotebook", "每条灵感会在该笔记本下新建一篇独立文档");
            } else {
                hint.textContent = plugin.t("noteTargetHintNone", "灵感只保存在插件私有存储里，随思源云同步");
            }
        };

        let searchTimer = null;
        typeSelect.addEventListener("change", () => {
            target().type = typeSelect.value;
            if (target().type !== "none" && !target().notebook && plugin.notebooks.length) {
                target().notebook = plugin.notebooks[0].id;
                nbSelect.value = target().notebook;
                loadDocs(target().notebook, "");
            }
            syncVisibility();
        });
        nbSelect.addEventListener("change", () => {
            target().notebook = nbSelect.value;
            target().docId = "";
            target().docPath = "";
            docSearch.value = "";
            loadDocs(target().notebook, "");
        });
        docSearch.addEventListener("input", () => {
            if (searchTimer) {
                window.clearTimeout(searchTimer);
            }
            searchTimer = window.setTimeout(() => {
                loadDocs(target().notebook, docSearch.value);
            }, 260);
        });
        docSelect.addEventListener("change", () => {
            target().docId = docSelect.value;
            const option = docSelect.selectedOptions && docSelect.selectedOptions[0];
            target().docPath = option ? (option.getAttribute("data-path") || option.textContent || "") : "";
        });

        fillNotebooks(plugin.notebooks || []);
        if (!plugin.notebooks || !plugin.notebooks.length) {
            plugin.refreshNotebooks().then((list) => {
                if (wrap.isConnected) {
                    fillNotebooks(list || []);
                }
            });
        }
        loadDocs(target().notebook, "");
        syncVisibility();
        return wrap;
    }

    /* ---------------- 首次安装引导 ---------------- */

    showOnboarding(force) {
        if (this.onboardingDialog) {
            return;
        }
        const plugin = this;
        const draft = deepCopy(this.settings);
        draft.hiddenCards = (this.settings.hiddenCards || []).slice();
        let step = 0;

        const dialog = new Dialog({
            title: this.t("obTitle", "欢迎使用森林主页"),
            width: this.isMobile ? "92vw" : "560px",
            content:
                '<div class="fh-ob" data-ob-root>' +
                '  <div class="fh-ob__body" data-ob-body></div>' +
                '  <div class="fh-ob__foot">' +
                '    <span class="fh-ob__step" data-ob-step></span>' +
                '    <span class="fn__flex-1"></span>' +
                '    <button class="b3-button b3-button--cancel" data-ob-act="skip"></button>' +
                '    <button class="b3-button b3-button--outline" data-ob-act="prev"></button>' +
                '    <button class="b3-button b3-button--text" data-ob-act="next"></button>' +
                "  </div>" +
                "</div>",
            destroyCallback: () => {
                plugin.onboardingDialog = null;
                if (force) {
                    return;
                }
                // 用户直接关掉窗口也算看过引导，避免每次启动都弹
                if (!plugin.settings.onboarded) {
                    plugin.settings.onboarded = true;
                    plugin.persistSettings();
                }
            },
        });
        this.onboardingDialog = dialog;

        const root = dialog.element.querySelector("[data-ob-root]");
        const body = root.querySelector("[data-ob-body]");
        const stepLabel = root.querySelector("[data-ob-step]");
        const btnPrev = root.querySelector('[data-ob-act="prev"]');
        const btnNext = root.querySelector('[data-ob-act="next"]');
        const btnSkip = root.querySelector('[data-ob-act="skip"]');

        const steps = [
            {
                title: this.t("obNameLabel", "怎么称呼你？"),
                desc: this.t("obNameDesc", "这个名字会出现在主页的问候语里。") + " " + this.t("obIntro", ""),
                render() {
                    const input = document.createElement("input");
                    input.className = "b3-text-field fn__block";
                    input.value = draft.userName || "";
                    input.placeholder = plugin.t("obNamePlaceholder", "例如：小明");
                    input.addEventListener("input", () => {
                        draft.userName = input.value;
                    });
                    setTimeout(() => input.focus(), 60);
                    return input;
                },
            },
            {
                title: this.t("obCardsTitle", "挑几张卡片"),
                desc: this.t("obCardsDesc", "勾选你想在主页看到的卡片，装好之后可以直接在主页上拖动排序。"),
                render() {
                    const wrap = document.createElement("div");
                    wrap.className = "fh-ob__cards";
                    // 与设置面板同源，新增卡片会自动出现在这里
                    plugin.cardListMeta().forEach((card) => {
                        const id = card.id;
                        const label = document.createElement("label");
                        label.className = "fh-ob__card";
                        const box = document.createElement("input");
                        box.type = "checkbox";
                        box.className = "b3-switch";
                        box.checked = draft.hiddenCards.indexOf(id) < 0;
                        box.addEventListener("change", () => {
                            const index = draft.hiddenCards.indexOf(id);
                            if (box.checked && index >= 0) {
                                draft.hiddenCards.splice(index, 1);
                            } else if (!box.checked && index < 0) {
                                draft.hiddenCards.push(id);
                            }
                        });
                        const icon = document.createElement("span");
                        icon.className = "fh-ob__card-icon";
                        icon.innerHTML = card.icon;
                        const text = document.createElement("span");
                        text.className = "fh-ob__card-text";
                        text.textContent = card.title;
                        label.appendChild(box);
                        label.appendChild(icon);
                        label.appendChild(text);
                        wrap.appendChild(label);
                    });
                    return wrap;
                },
            },
            {
                title: this.t("obBgTitle", "换个背景"),
                desc: this.t("obBgDesc", "可选。留空就使用思源主题的底色。"),
                render() {
                    const row = document.createElement("div");
                    row.className = "fh-ob__bg";
                    const input = document.createElement("input");
                    input.className = "b3-text-field fn__flex-1";
                    input.value = draft.background || "";
                    input.placeholder = plugin.t("setBackgroundPlaceholder", "留空使用主题背景");
                    input.addEventListener("input", () => {
                        draft.background = input.value;
                    });
                    const upload = document.createElement("button");
                    upload.className = "b3-button b3-button--outline";
                    upload.textContent = plugin.t("setUpload", "选择图片");
                    upload.addEventListener("click", () => {
                        const picker = document.createElement("input");
                        picker.type = "file";
                        picker.accept = "image/*";
                        picker.addEventListener("change", async () => {
                            const file = picker.files && picker.files[0];
                            if (!file) {
                                return;
                            }
                            upload.disabled = true;
                            const path = await plugin.uploadAsset(file);
                            upload.disabled = false;
                            if (path) {
                                input.value = path;
                                draft.background = path;
                            } else {
                                showMessage(plugin.t("setUploadFail", "图片上传失败"));
                            }
                        });
                        picker.click();
                    });
                    row.appendChild(input);
                    row.appendChild(upload);
                    return row;
                },
            },
            {
                title: this.t("obDoneTitle", "准备就绪"),
                desc: this.t("obDoneDesc", "所有设置都能在「设置 → 插件 → 森林主页 → 设置」里随时修改。"),
                render() {
                    const box = document.createElement("div");
                    box.className = "fh-ob__done";
                    box.innerHTML = '<span class="fh-ob__check">' + ICONS.check + "</span>" +
                        '<span>' + esc(draft.userName ? plugin.currentGreetingPreview(draft) : "") + "</span>";
                    return box;
                },
            },
        ];

        const paint = () => {
            const current = steps[step];
            body.innerHTML = "";
            const title = document.createElement("div");
            title.className = "fh-ob__title";
            title.textContent = current.title;
            const desc = document.createElement("div");
            desc.className = "fh-ob__desc";
            desc.textContent = current.desc;
            body.appendChild(title);
            body.appendChild(desc);
            const holder = document.createElement("div");
            holder.className = "fh-ob__control";
            holder.appendChild(current.render());
            body.appendChild(holder);

            stepLabel.textContent = plugin.t("obStepOf", "第 {n} 步 / 共 {m} 步")
                .split("{n}").join(String(step + 1))
                .split("{m}").join(String(steps.length));
            btnPrev.classList.toggle("fn__none", step === 0);
            btnSkip.classList.toggle("fn__none", step === steps.length - 1);
            btnNext.textContent = step === steps.length - 1
                ? plugin.t("obDone", "进入主页")
                : plugin.t("obNext", "下一步");
            btnPrev.textContent = plugin.t("obPrev", "上一步");
            btnSkip.textContent = plugin.t("obSkip", "跳过");
        };

        const finish = () => {
            plugin.__draft = deepCopy(draft);
            plugin.__draft.onboarded = true;
            plugin.applyDraft().then(() => {
                if (dialog.element && document.contains(dialog.element)) {
                    dialog.destroy();
                }
                plugin.openHomepage();
            });
        };

        root.addEventListener("click", (event) => {
            const button = event.target.closest("[data-ob-act]");
            if (!button) {
                return;
            }
            const act = button.getAttribute("data-ob-act");
            if (act === "prev" && step > 0) {
                step--;
                paint();
            } else if (act === "next") {
                if (step === steps.length - 1) {
                    finish();
                } else {
                    step++;
                    paint();
                }
            } else if (act === "skip") {
                finish();
            }
        });

        paint();
    }

    /** 引导最后一步的问候语预览 */
    currentGreetingPreview(draft) {
        const name = String(draft.userName || "").trim();
        const greet = this.greetingFor(new Date());
        return name ? greet + "，" + name : greet;
    }

    /* ---------------- 其他 ---------------- */

    /** 上传背景图到思源 assets 目录，返回 assets/xxx.png */
    async uploadAsset(file) {
        try {
            const form = new FormData();
            form.append("assetsDirPath", "/assets/");
            form.append("file[]", file, file.name || "background.png");
            const res = await fetch("/api/asset/upload", { method: "POST", body: form });
            const json = await res.json();
            if (json && json.code === 0 && json.data) {
                if (json.data.succMap) {
                    const keys = Object.keys(json.data.succMap);
                    if (keys.length) {
                        return json.data.succMap[keys[0]];
                    }
                }
                if (Array.isArray(json.data.succFiles) && json.data.succFiles.length) {
                    return json.data.succFiles[0].path;
                }
            }
            return "";
        } catch (err) {
            return "";
        }
    }
}

/* 纯函数测试接缝（离线回归测试用，运行时不依赖） */
ForestHomepage.__test = {
    esc: esc,
    pad2: pad2,
    clampInt: clampInt,
    normalizeSwitch: normalizeSwitch,
    sqlQuote: sqlQuote,
    normalizeOrder: normalizeOrder,
    toBgUrl: toBgUrl,
    expandPath: expandPath,
    toDayKey: toDayKey,
    fmtRelative: fmtRelative,
    docIconText: docIconText,
    parentPathLabel: parentPathLabel,
    fmtCount: fmtCount,
    fmtDuration: fmtDuration,
    defaultCardSize: defaultCardSize,
    normalizeCardSize: normalizeCardSize,
    cardDefaultSpan: cardDefaultSpan,
    normalizeQuick: normalizeQuick,
    quickCount: quickCount,
    quickColumns: quickColumns,
    truncateTitle: truncateTitle,
    QUICK_GROUP_DEFAULT: QUICK_GROUP_DEFAULT,
    QUICK_ITEM_MIN_DEFAULT: QUICK_ITEM_MIN_DEFAULT,
    QUICK_CONTENT_PADDING: QUICK_CONTENT_PADDING,
    QUICK_NARROW_WIDTH: QUICK_NARROW_WIDTH,
    QUICK_NARROW_ITEM_MIN: QUICK_NARROW_ITEM_MIN,
    QUICK_TITLE_MAX_DEFAULT: QUICK_TITLE_MAX_DEFAULT,
    allowedWidths: allowedWidths,
    nearestPreset: nearestPreset,
    pixelsToSpan: pixelsToSpan,
    spanToPixels: spanToPixels,
    WIDTH_PRESETS: WIDTH_PRESETS,
    HEIGHT_PRESETS: HEIGHT_PRESETS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    LAUNCH_HOMEPAGE_DELAY: LAUNCH_HOMEPAGE_DELAY,
    ALL_CARDS: ALL_CARDS,
    FALLBACK_POEMS: FALLBACK_POEMS,
};

module.exports = ForestHomepage;
