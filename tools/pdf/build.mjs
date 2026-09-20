import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { loadBook, countStats, ROOT } from "../lib/book.mjs";

const OFFLINE = ROOT + "/dist/ai-work-guide-offline.html";
const PRINT_HTML = ROOT + "/dist/_print.html";
const OUT = ROOT + "/dist/ai-work-guide.pdf";

// CI 用 apt 装的 google-chrome，本地用 .app；两边都可用 CHROME_BIN 覆盖。
function chromeBin() {
  const cands = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "chromium",
  ].filter(Boolean);
  for (const c of cands) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {}
  }
  throw new Error("找不到 Chrome/Chromium，装一个或用 CHROME_BIN 指定路径");
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// PDF 是会被存进手机里的那一份：封面写清它是哪一天的版本，并把人指回在线版。
function cover(site, stats) {
  return `<header class="cover">
  <h2>${esc(site.name)}</h2>
  <p>${esc(site.tagline)}</p>
  <p>${esc(stats.lens)}</p>
  <p class="meta">本 PDF 生成于 ${stats.date} · 版本 ${esc(site.commit)} · ${stats.total} 条 / ${stats.chapters} 节 · 证据等级 ${esc(stats.grades)}，其中 ${stats.todo} 条标了「待核实」<br>
  正文每天都在改，这一份不会跟着更新；带筛选的最新版见 <b>${esc(site.canonical)}</b>，源码 <b>${esc(site.repo)}</b>（${esc(site.license)}）。</p>
</header>`;
}

const chrome = chromeBin();
if (!existsSync(OFFLINE)) throw new Error(`缺 ${OFFLINE}，先跑 node tools/offline/build.mjs`);

const conf = JSON.parse(await readFile(ROOT + "/tools/site.json", "utf8"));
const site = conf.site;
site.commit = process.env.GIT_SHA ?? "local";

const { corpus } = await loadBook();
const n = countStats(corpus);
const stats = {
  date: new Date().toISOString().slice(0, 10),
  total: n.entries,
  chapters: n.chapters,
  grades: `A ${n.A} / B ${n.B} / C ${n.C}`,
  todo: n.待核实,
  lens: "四种口径分开算，时间与金钱不互相换算：换时间精力 / 换钱与保障 / 换职业安全 / 换人身自由与法律安全。",
};

let html = await readFile(OFFLINE, "utf8");
// 折叠的 <details> 打印时不会展开，成本/收益/来源会整块从 PDF 里消失，所以必须注入 __PRINT__。
let out = html.replace("</head>", "<script>window.__PRINT__=true;</script>\n</head>");
if (out === html) throw new Error("离线 HTML 里找不到 </head>，构建中止");
const before = out;
out = out.replace("<main>", `<main>${cover(site, stats)}</main>`);
if (out === before) throw new Error("离线 HTML 里找不到 <main>，封面注入失败");

await mkdir(ROOT + "/dist", { recursive: true });
await writeFile(PRINT_HTML, out, "utf8");

execFileSync(chrome, [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--no-pdf-header-footer",
  "--run-all-compositor-stages-before-draw",
  "--virtual-time-budget=30000",
  `--print-to-pdf=${OUT}`,
  `file://${PRINT_HTML}`,
], { stdio: "ignore" });

if (!existsSync(OUT)) throw new Error("Chrome 未产出 PDF");
const buf = await readFile(OUT);
// 页树是分片的：/Type /Pages 会出现多次（每个中间节点带自己的 /Count），
// 取第一个会把 16 页报成 8 页。取最大值才是整本书的页数。
const counts = [...buf.toString("latin1").matchAll(/\/Count (\d+)/g)].map((m) => Number(m[1]));
const pages = counts.length ? Math.max(...counts) : 0;
if (buf.length < 30_000) throw new Error(`PDF 只有 ${buf.length} 字节，明显不是整本书，中止`);
if (pages < 1) throw new Error("PDF 里读不到页数，检查 Chrome 版本与打印参数");
await rm(PRINT_HTML, { force: true });

console.log(`已生成 ${OUT}`);
console.log(`  ${pages} 页 / ${(buf.length / 1024).toFixed(0)} KB · 语料 ${stats.total} 条（${stats.grades}，${stats.todo} 条待核实）`);
