import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadBook, ROOT } from "../lib/book.mjs";

const OUT = ROOT + "/dist/ai-work-guide-offline.html";

// 内联进 <script> 的 JSON 必须转义 </script>，否则正文里任何含该串的内容会截断脚本标签。
const json = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

// 广告图缺失时退化成纯文字块，而不是留一个破图——离线版会被直接转发出去。
const TEXT_PLACEHOLDER =
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 624 312"><rect width="624" height="312" rx="16" fill="#e8f1ec"/><text x="312" y="160" font-size="30" text-anchor="middle" fill="#2f6f4e" font-family="PingFang SC,sans-serif">推广位待配图（2:1）</text></svg>`,
  ).toString("base64");

async function dataUri(src) {
  if (/^https?:\/\//.test(src) || src.startsWith("data:")) return src;
  const abs = ROOT + "/" + src.replace(/^\.\//, "");
  if (!existsSync(abs)) {
    console.log(`  广告图缺失，用文字占位：${src}`);
    return TEXT_PLACEHOLDER;
  }
  const buf = await readFile(abs);
  const ext = /\.(png|jpe?g|webp|gif|svg)$/i.exec(src)?.[1]?.toLowerCase() ?? "";
  const mime = { jpeg: "jpg", svg: "svg+xml" }[ext] || ext || "octet-stream";
  return `data:image/${mime};base64,${buf.toString("base64")}`;
}

const { corpus, chapters, problems } = await loadBook();
// 离线包是转出去的那一份：内嵌语料缺字段不会报错，只会静默少掉筛选和徽章，所以在这里当门禁拦下。
for (const c of corpus) {
  if (!c.title) throw new Error(`${c.file} 缺节标题（# N. 标题），中止构建`);
  if (!c.intro) console.log(`  ${c.file} 没有节引言，检索页这一节上方会空一行`);
  for (const e of c.entries) {
    if (!e.grade) throw new Error(`${c.file} 第 ${e.number} 条缺证据等级 A/B/C，中止构建`);
    if (!e.ratio) throw new Error(`${c.file} 第 ${e.number} 条算不出性价比档（成本标签缺维度？），中止构建`);
  }
}
const conf = JSON.parse(await readFile(ROOT + "/tools/site.json", "utf8"));
const adsFile = JSON.parse(await readFile(ROOT + "/tools/ads.json", "utf8"));
const site = { ...conf.site, longDocs: conf.longDocs ?? [], ads: adsFile.slots ?? [] };

site.commit = process.env.GIT_SHA ?? "local";
site.ads = await Promise.all(
  site.ads.map(async (a) => {
    const src = await dataUri(a.src);
    return { ...a, src, offlineHint: "离线版中的链接指向在线版" };
  }),
);
// 相对链接在离线文件里点不开，一律改写成站点绝对地址。
const absURL = (h) => (/^https?:\/\//.test(h) ? h : site.canonical.replace(/\/$/, "") + "/" + h.replace(/^\.\//, ""));
site.longDocs = site.longDocs.map((d) => ({ ...d, href: absURL(d.href) }));
site.ads = site.ads.map((a) => ({ ...a, href: absURL(a.href) }));

let html = await readFile(ROOT + "/index.html", "utf8");
const before = html;
html = html.replace(
  "</head>",
  `<script>window.__SITE__=${json(site)};window.__CORPUS__=${json(corpus)};</script>\n</head>`,
);
if (html === before) throw new Error("index.html 里找不到 </head>，构建中止");
if (!html.includes("window.__SITE__")) throw new Error("站点配置未注入，检查 </head> 替换是否生效");
if (!html.includes("typeof window.__CORPUS__")) throw new Error("index.html 缺内联语料入口（EMBED 判定行）");
html = html.replace(
  "<title>",
  `<meta name="generator" content="offline single-file build ${new Date().toISOString().slice(0, 10)} · ${site.commit}">\n<title>`,
);

await mkdir(ROOT + "/dist", { recursive: true });
await writeFile(OUT, html, "utf8");
console.log(`已生成 ${OUT}`);
console.log(`  ${corpus.length} 节 / ${corpus.reduce((n, c) => n + c.entries.length, 0)} 条内联，离线可直接双击打开`);
console.log(`  ${site.ads.length} 个广告槽（图已内联为 data URI）`);
if (problems.length) console.log(`  结构问题 ${problems.length} 条，跑 node tools/check-refs.mjs --check 查看`);
