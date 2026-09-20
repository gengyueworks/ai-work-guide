import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { listChapters, loadBook, ROOT } from "../lib/book.mjs";

const SRC_MD = ROOT + "/dist/_epub.md";
const OUT = ROOT + "/dist/ai-work-guide.epub";

// pandoc 会把 HTML 注释原样带进 xhtml；成本标签是机读元数据，epub 用不上，剔干净免得读者看到源码里有私货。
const DROP_LINE = /^\s*(\[?←\s*回总目录|<!--\s*成本标签)/;

function pandocBin() {
  for (const c of [process.env.PANDOC_BIN, "pandoc"].filter(Boolean)) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {}
  }
  throw new Error("找不到 pandoc，装一个（apt install pandoc / brew install pandoc）或用 PANDOC_BIN 指定");
}

const pandoc = pandocBin();
const conf = JSON.parse(await readFile(ROOT + "/tools/site.json", "utf8"));
const site = conf.site;
const names = await listChapters();
const { corpus, problems } = await loadBook();
if (problems.length) throw new Error(`正文有 ${problems.length} 条结构问题，先跑 node tools/check-refs.mjs --check：\n  ${problems.join("\n  ")}`);

const parts = [];
for (const name of names) {
  const raw = await readFile(ROOT + "/book/" + name, "utf8");
  parts.push(raw.split(/\r?\n/).filter((l) => !DROP_LINE.test(l)).join("\n").trim());
}
if (parts.some((p) => p.includes("成本标签"))) throw new Error("成本标签没被剔干净，epub 会把机读元数据带进正文，中止");
// 篇首放一节导读：epub 打开的第一屏必须说清「不用全做」和四种口径，否则读者会以为又一份待办清单。
const head = `# 导读\n\n${site.tagline}\n\n四种口径分开算，时间与金钱不互相换算：换时间精力 / 换钱与保障 / 换职业安全 / 换人身自由与法律安全。每条的「说人话」栏不含该条收益栏之外的事实。\n\n本 epub 生成于 ${new Date().toISOString().slice(0, 10)}，共 ${corpus.reduce((n, c) => n + c.entries.length, 0)} 条 / ${corpus.length} 节。正文每天都在改，带筛选的最新版与逐条出处见 <${site.canonical}>，源码 <${site.repo}>（${site.license}）。\n`;

await mkdir(ROOT + "/dist", { recursive: true });
await writeFile(SRC_MD, head + "\n\n" + parts.join("\n\n---\n\n") + "\n", "utf8");

execFileSync(pandoc, [
  SRC_MD, "-o", OUT,
  "-f", "markdown+east_asian_line_breaks",
  "--toc", "--toc-depth=1", "--epub-chapter-level=1",
  "-M", `title=${site.name}`,
  "-M", "lang=zh-CN",
  "-M", `description=${site.tagline}`,
  "-M", "copyright=Unlicense — public domain",
], { stdio: "ignore" });

const buf = await readFile(OUT).catch(() => {
  throw new Error("pandoc 未产出 epub");
});
if (buf.slice(0, 2).toString() !== "PK") throw new Error("产出的不是 zip（epub 容器），pandoc 可能报错");
const listing = buf.toString("latin1");
// zip 里每个文件名在本地头和中央目录各出现一次，去重后才等于真实章节数。
const chapters = new Set((listing.match(/EPUB\/text\/ch\d+\.xhtml/g) || [])).size;
const total = corpus.reduce((n, c) => n + c.entries.length, 0);
if (chapters < corpus.length + 1) {
  throw new Error(`epub 只切出 ${chapters} 章，正文有 ${corpus.length} 节 + 导读：章节标题格式可能不是「# N. 标题」`);
}
if (buf.length < 10_000) throw new Error(`epub 只有 ${buf.length} 字节，明显不含正文，中止`);
await rm(SRC_MD, { force: true });

console.log(`已生成 ${OUT}`);
console.log(`  ${chapters} 章 / ${total} 条 / ${(buf.length / 1024).toFixed(0)} KB，可直接 Send to Kindle`);
