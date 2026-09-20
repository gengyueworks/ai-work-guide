import { writeFile, mkdir } from "node:fs/promises";
import { loadBook, ROOT } from "./lib/book.mjs";

const args = new Set(process.argv.slice(2));
const MODE_CHECK = args.has("--check");
const MODE_SUSPECT = args.has("--suspect");

const TOKEN_RE = /第\s*(\d+)\s*节|第\s*(\d+)\s*条/g;
const ANCHOR_RE = /^[（(]([^）)]{1,26})[）)]/;
const CJK = /[一-鿿]/g;
const secOf = (file) => Number(file.replace(/^book\//, "").slice(0, 2));

function score(anchor, title) {
  const a = anchor.match(CJK)?.join("") ?? "";
  if (!a) return { kind: "weak", chars: "" };
  const norm = title.replace(/[^一-鿿]/g, "");
  if (norm.includes(a)) return { kind: "ok", chars: a };
  const chars = [...new Set(a)].filter((c) => norm.includes(c));
  const ratio = chars.length / new Set(a).size;
  if (ratio >= 0.7) return { kind: "weak", chars: chars.join("") };
  return { kind: "bad", chars: chars.join("") };
}

/**
 * 单遍扫描一个字段里的所有「第 X 节」「第 Y 条」。
 * 节号先进 pending，被下一个条号消费掉 —— 这样「第 6 节第 3 条」算一次引用，
 * 而不是拆成「一次节引用 + 一次裸条号」。
 * 「第 3 条（锚点）见第 8 节」这类先条后节的写法，节号回填给最近一条未定节的引用。
 */
function scanField(value, ownSec) {
  const refs = [];
  let pendingSec = null;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(value))) {
    const end = m.index + m[0].length;
    if (m[1] !== undefined) {
      const prev = refs[refs.length - 1];
      if (prev && !prev.bound && !prev.anchor) {
        prev.bound = true;
        prev.targetSec = Number(m[1]);
        prev.key = `${prev.targetSec}:${prev.targetNo}`;
        continue;
      }
      pendingSec = Number(m[1]);
      continue;
    }
    refs.push({
      targetSec: pendingSec ?? ownSec,
      targetNo: Number(m[2]),
      key: `${pendingSec ?? ownSec}:${Number(m[2])}`,
      anchor: null,
      bound: pendingSec !== null,
      context: value.slice(0, end).replace(/\s+/g, "").slice(-24),
    });
    pendingSec = null;
  }
  // 锚点必须紧跟在「第 Y 条」之后；按同一次扫描的顺序逐个回填。
  let i = 0;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(value)) && i < refs.length) {
    if (m[1] !== undefined) continue;
    const am = ANCHOR_RE.exec(value.slice(m.index + m[0].length));
    if (am) refs[i].anchor = am[1];
    i += 1;
  }
  return refs;
}

const { chapters, corpus, problems } = await loadBook();

const index = new Map();
const selfRef = new Map();
for (const c of corpus) {
  const sec = secOf(c.file);
  for (const e of c.entries) index.set(`${sec}:${e.number}`, e);
  selfRef.set(sec, c);
}

const refs = [];
const failures = [];
const suspects = [];

for (const ch of chapters) {
  const sec = secOf(ch.file);
  for (const e of ch.entries) {
    for (const [field, value] of Object.entries(e.raw)) {
      if (typeof value !== "string") continue;
      for (const r of scanField(value, sec)) {
        const target = index.get(r.key);
        r.fromFile = ch.file;
        r.fromEntry = e.number;
        r.field = field;
        r.resolved = target ? target.title : "（不存在）";
        refs.push(r);
        const where = `${ch.file} 第 ${e.number} 条 · ${field}`;
        if (!target) {
          r.kind = "bad";
          failures.push(`${where}：引用第 ${r.targetSec} 节第 ${r.targetNo} 条 —— 目标不存在`);
          continue;
        }
        if (!r.anchor) {
          r.kind = "bare";
          failures.push(`${where}：「${r.context}」是裸条号，必须带锚点（从目标标题里取词）`);
          continue;
        }
        const sc = score(r.anchor, target.title);
        r.kind = sc.kind;
        r.overlap = sc.chars;
        if (sc.kind === "bad") {
          failures.push(
            `${where}：锚点「${r.anchor}」与目标标题「${target.title}」对不上，疑似被顺延撞歪`,
          );
        } else if (sc.kind === "weak") {
          suspects.push(`${where}：锚点「${r.anchor}」与目标「${target.title}」仅部分重合（${sc.chars}）`);
        }
      }
    }
  }
}

void selfRef;

const lines = [
  "# 引用对照表",
  "",
  "由 `node tools/check-refs.mjs` 自动生成，**不要手改**。",
  "",
  "判据：条号没变而「实际指向」那列变了，就是被顺延撞歪的引用。",
  "裸条号一律判失败：`第 3 条` 必须写成 `第 3 条（借条和担保）`，括号里的词从目标标题里取。",
  "",
  "| 引用处 | 上下文摘录 | 引用写法 | 实际指向的条目 | 判定 |",
  "| --- | --- | --- | --- | --- |",
];
for (const r of refs) {
  const way = `第 ${r.targetSec} 节第 ${r.targetNo} 条（${r.anchor ?? "无锚点"}）`;
  lines.push(
    `| ${r.fromFile} 第 ${r.fromEntry} 条 · ${r.field} | ${r.context} | ${way} | ${String(r.resolved).replace(/\|/g, "/")} | ${r.kind} |`,
  );
}
if (!refs.length) lines.push("| — | — | 暂无交叉引用 | — | — |");

await mkdir(ROOT + "/docs", { recursive: true });
await writeFile(ROOT + "/docs/引用对照.md", lines.join("\n") + "\n", "utf8");

const all = [...problems, ...failures];
console.log(`引用 ${refs.length} 处；异常判定 ${failures.length} 处；疑似 ${suspects.length} 处；结构问题 ${problems.length} 条`);
console.log("docs/引用对照.md 已更新");
if (MODE_SUSPECT && suspects.length) console.log("\n疑似：\n" + suspects.map((s) => "  - " + s).join("\n"));
if (failures.length) console.log("\n引用异常：\n" + failures.map((p) => "  - " + p).join("\n"));
if (problems.length) console.log("\n结构问题：\n" + problems.map((p) => "  - " + p).join("\n"));
if (MODE_CHECK && all.length) {
  console.log("\n--check 未通过，退出码 1");
  process.exit(1);
}
if (!all.length) console.log("全部通过");
