import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ROOT = 仓库根。本文件在 tools/lib/ 下，故上溯两级。
export const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

export const COST_KEYS = ["钱", "时间", "毅力"];
export const COST_ENUMS = {
  钱: ["0", "少", "多"],
  时间: ["少", "中", "多"],
  毅力: ["否", "些", "是"],
  收益: ["大", "中", "小"],
  口径: ["时间", "钱", "职业", "自由"],
};

export const FIELD_ORDER = ["成本", "说人话", "收益", "证据等级", "来源", "备注"];

// 「这条有没核到的东西」在正文里有三种写法，只认「待核实」会把法律类条目的坦白漏掉、把数字算小。
export const TODO_RE = /待核实|未核到|未取到/;
// 争议必须显式标：条文名里就有「劳动争议调解仲裁法」，按「争议」两个字数会把法条标题全算成争议条目。
export const DISPUTE_RE = /【争议】/;

const TAG_RE = /^<!--\s*成本标签:\s*(.*?)\s*-->$/;
const ENTRY_RE = /^###\s+(\d+)\.\s+(.+)$/;
const FIELD_RE = /^-\s*\*\*(.+?)\*\*[:：]\s*(.*)$/;
const BARE_FIELD_RE = /^-\s*(成本|说人话|收益|证据等级|来源|备注)[:：]\s*(.*)$/;

/**
 * 节引言 = h1 之后第一段正文（可以是 blockquote，也可以是裸段落）。
 * 必须与 index.html 里的 pickIntro() 保持同一算法，否则在线版和离线单文件的引言会不一致。
 */
export function pickIntro(lines, h1Idx) {
  for (const raw of lines.slice(h1Idx + 1)) {
    const s = raw.trim();
    if (!s) continue;
    if (s.startsWith("#")) break;
    if (s.startsWith(">")) return s.replace(/^>\s*/, "").trim();
    if (s.startsWith("[") || s.startsWith("-") || s.startsWith("<!--")) continue;
    return s;
  }
  return "";
}

function parseTag(line) {
  const m = TAG_RE.exec(line.trim());
  if (!m) return null;
  const tags = {};
  const problems = [];
  for (const part of m[1].split(/\s+/).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      problems.push(`成本标签片段「${part}」缺少 =`);
      continue;
    }
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    // 适合= 是可选的多值维度（用 | 分隔），不参与性价比计算，也不进必填校验。
    if (key === "适合") {
      tags[key] = value.split("|").filter(Boolean);
      continue;
    }
    if (!COST_ENUMS[key]) {
      problems.push(`成本标签出现未知维度「${key}」，允许值：${Object.keys(COST_ENUMS).join("/")}`);
      continue;
    }
    if (!COST_ENUMS[key].includes(value)) {
      problems.push(
        `成本标签 ${key}=${value} 非法，允许值：${COST_ENUMS[key].join("|")}`,
      );
      continue;
    }
    tags[key] = value;
  }
  const missing = Object.keys(COST_ENUMS).filter((k) => !(k in tags));
  if (missing.length) problems.push(`成本标签缺维度：${missing.join("/")}`);
  return { tags, problems };
}

/** 性价比档：与 index.html 的 ratioOf() 必须保持一致，改一处要改两处。 */
export function ratioOf(tags) {
  if (!tags?.收益) return null;
  const zero = COST_KEYS.every((k) => {
    const v = tags[k];
    if (k === "钱") return v === "0";
    return v === "少" || v === "否";
  });
  const cheap = COST_KEYS.reduce((n, k) => (tags[k] === "中" || tags[k] === "些" ? n + 1 : n), 0);
  if (tags.收益 === "大" && zero) return "极高";
  if ((tags.收益 === "大" && cheap <= 1) || (tags.收益 === "中" && zero)) return "高";
  return "一般";
}

// 与 index.html 里的 URL_T / URL_G / unwrap / trimURL 逐字一致，改一处要改两处。
export const URL_T = /https?:\/\/[^\s<>()（）〔】「」『』《》“”‘’"'，。；：、！？]+/;
export const URL_G = new RegExp(URL_T.source, "g");
export const unwrap = (s) => (s || "").replace(/<((?:https?|ftp):\/\/[^<>\s]+)>/g, "$1");
export const trimURL = (u) => u.replace(/[.,;:]+$/, "");
const AUTOLINK_RE = /<(https?:\/\/[^<>\s]+)>/g;

/**
 * 出处链接是这本书唯一的信用凭证。正文一律写成 markdown 自动链接 <https://…>，
 * 浏览器端要先拆掉尖括号再按字符类切；只要切出来的和正文里的不是同一串，
 * 那条出处就点不开——多一个字符是吞了后缀，少一个是被截断。
 */
export function checkLinks(text, file) {
  const out = [];
  const hrefs = new Set([...unwrap(text).matchAll(URL_G)].map((m) => trimURL(m[0])));
  for (const m of text.matchAll(AUTOLINK_RE)) {
    const want = m[1];
    if (hrefs.has(want)) continue;
    const got = [...hrefs].find((h) => h.startsWith(want) || want.startsWith(h));
    out.push(`${file} 的出处链接在网页里点不开：正文是 ${want}，浏览器会切出 ${got ?? "（什么都没切出来）"}`);
  }
  for (const h of hrefs) {
    if (/[一-鿿]/.test(h)) out.push(`${file} 切出的链接里混进了中文，多半把正文吞进了 href：${h}`);
  }
  return out;
}

export function parseChapter(text, file) {
  const lines = text.split(/\r?\n/);
  const problems = checkLinks(text, file);
  const h1 = lines.find((l) => l.startsWith("# "));
  const title = h1 ? h1.slice(2).replace(/^\d+\.\s*/, "").trim() : "";
  const intro = pickIntro(lines, h1 ? lines.indexOf(h1) : -1);

  const entries = [];
  let cur = null;
  let lastField = null;

  const close = () => {
    if (cur) entries.push(cur);
    cur = null;
    lastField = null;
  };

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const em = ENTRY_RE.exec(line.trim());
    if (em) {
      close();
      cur = {
        number: Number(em[1]),
        title: em[2].trim(),
        file,
        line: i + 1,
        tags: null,
        raw: { _tagLines: [] },
      };
      return;
    }
    if (!cur) return;

    const tag = parseTag(line);
    if (tag) {
      if (cur.tags) {
        problems.push(`${file}:${i + 1} 第 ${cur.number} 条有第二行成本标签`);
      }
      cur.tags = tag.tags;
      problems.push(...tag.problems.map((p) => `${file}:${i + 1} 第 ${cur.number} 条：${p}`));
      return;
    }

    const fm = FIELD_RE.exec(line.trim()) || BARE_FIELD_RE.exec(line.trim());
    if (fm) {
      const key = fm[1];
      if (!FIELD_ORDER.includes(key)) {
        problems.push(`${file}:${i + 1} 第 ${cur.number} 条出现非标准字段「${key}」`);
        return;
      }
      lastField = key;
      cur.raw[key] = fm[2].trim();
      return;
    }

    if (lastField && line.trim() && !line.trim().startsWith("- ") && !line.trim().startsWith("[")) {
      cur.raw[lastField] = `${cur.raw[lastField] ?? ""}\n${line.trim()}`;
    }
  });
  close();

  entries.sort((a, b) => a.number - b.number);
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.number)) problems.push(`${file} 条号 ${e.number} 重复`);
    seen.add(e.number);
    if (!e.tags) problems.push(`${file}:${e.line} 第 ${e.number} 条缺成本标签行`);
    for (const f of FIELD_ORDER) {
      if (!e.raw[f]) problems.push(`${file}:${e.line} 第 ${e.number} 条缺字段「${f}」`);
    }
    if (e.raw["证据等级"] && !/^[ABC](?![A-Z])/.test(e.raw["证据等级"])) {
      problems.push(`${file}:${e.line} 第 ${e.number} 条证据等级应为 A/B/C，实为「${e.raw["证据等级"]}」`);
    }
  }
  const expected = entries.map((_, i) => i + 1);
  if (entries.some((e, i) => e.number !== expected[i])) {
    problems.push(`${file} 条号不连续，应为 1..${entries.length}`);
  }
  // 空章节会在检索页的目录里留下一个 0 条的空行，且通常是标题写错了格式（### N. 标题）导致的。
  if (!entries.length) {
    problems.push(`${file} 没有任何条目：标题行必须写成「### 1. 动词开头」，或删掉这一节`);
  }
  if (!title) {
    problems.push(`${file} 没有「# N. 节标题」这一行，检索页的节名会空`);
  }

  return { file, title, intro, entries, problems };
}

export async function listChapters() {
  const dir = ROOT + "/book";
  const names = (await readdir(dir))
    .filter((n) => /^\d{2}-.+\.md$/.test(n))
    .sort((a, b) => Number(a.slice(0, 2)) - Number(b.slice(0, 2)));
  return names;
}

export async function loadBook() {
  const names = await listChapters();
  const chapters = [];
  const problems = [];
  for (const name of names) {
    const file = "book/" + name;
    const text = await readFile(ROOT + "/" + file, "utf8");
    const ch = parseChapter(text, file);
    chapters.push(ch);
    problems.push(...ch.problems);
  }
  const corpus = chapters.map((ch) => ({
    file: ch.file,
    title: ch.title,
    intro: ch.intro,
    entries: ch.entries.map((e) => ({
      ...e,
      ratio: ratioOf(e.tags),
      // grade 必须和 index.html 的 parseMd() 同名同算法：离线版靠证据等级筛选和徽章。
      grade: (e.raw["证据等级"] || "").trim()[0] || "",
    })),
  }));
  return { chapters, corpus, problems };
}

export function countStats(corpus) {
  const all = corpus.flatMap((c) => c.entries);
  const s = {
    entries: all.length,
    chapters: corpus.length,
    A: 0,
    B: 0,
    C: 0,
    争议: 0,
    待核实: 0,
    极高: 0,
    高: 0,
    一般: 0,
    链接: 0,
  };
  for (const e of all) {
    const g = (e.raw["证据等级"] || "").trim()[0];
    if (g in s) s[g] += 1;
    const blob = Object.values(e.raw).join(" ");
    if (DISPUTE_RE.test(blob)) s.争议 += 1;
    if (TODO_RE.test(blob)) s.待核实 += 1;
    if (e.ratio) s[e.ratio] += 1;
    s.链接 += (blob.match(/https?:\/\/\S+/g) || []).length;
  }
  return s;
}

export function exists(rel) {
  return existsSync(ROOT + "/" + rel);
}
