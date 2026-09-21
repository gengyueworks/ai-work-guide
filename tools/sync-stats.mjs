import { readFile, writeFile } from "node:fs/promises";
import { loadBook, countStats, ROOT } from "./lib/book.mjs";

const CHECK = process.argv.includes("--check");
const { corpus, problems } = await loadBook();
const s = countStats(corpus);

await writeFile(ROOT + "/tools/stats.json", JSON.stringify(s, null, 2) + "\n", "utf8");

const badges = `[![共 ${s.entries} 条](https://img.shields.io/badge/条目-${s.entries}-2f6f4e)](book/) [![逐字核到原文 ${s.A} 条](https://img.shields.io/badge/逐字核到原文-${s.A}-2f6f4e)](README.md) [![性价比极高 ${s.极高} 条](https://img.shields.io/badge/性价比极高-${s.极高}-2f6f4e)](README.md)`;
const toc = corpus
  .map((c) => {
    const no = Number(c.file.slice(5, 7));
    return `| ${no} | [${c.title}](book/${encodeURIComponent(c.file.replace("book/", ""))}) | ${c.entries.length} | ${c.entries.filter((e) => e.grade === "A").length} |`;
  })
  .join("\n");

const readme = await readFile(ROOT + "/README.md", "utf8");
const out = readme
  .replace(/<!-- BADGES:START -->[\s\S]*?<!-- BADGES:END -->/, `<!-- BADGES:START -->\n${badges}\n<!-- BADGES:END -->`)
  .replace(/<!-- STATS:START -->[\s\S]*?<!-- STATS:END -->/, `<!-- STATS:START -->\n全书 ${s.entries} 条：出处能逐字点开原文的 ${s.A} 条，有出处但强度不到 A 的 ${s.B} 条，作者自己判断、给不出出处的 ${s.C} 条；${s.争议} 条标注争议、${s.待核实} 条写明有未核实事项。性价比极高 ${s.极高} 条、高 ${s.高} 条、一般 ${s.一般} 条。外部链接 ${s.链接} 个。\n<!-- STATS:END -->`)
  .replace(/<!-- TOC:START -->[\s\S]*?<!-- TOC:END -->/, `<!-- TOC:START -->\n| # | 节 | 条目 | 能点开原文的 |\n| --- | --- | --- | --- |\n${toc}\n<!-- TOC:END -->`);

if (CHECK) {
  const diffs = [];
  if (readme !== out) diffs.push("README.md 的徽章/统计/目录与 book/ 不一致，请跑 node tools/sync-stats.mjs");
  if (problems.length) diffs.push(...problems);
  if (diffs.length) {
    console.log("--check 未通过：\n" + diffs.map((d) => "  - " + d).join("\n"));
    process.exit(1);
  }
  console.log(`sync-stats --check 通过：${s.entries} 条 / ${s.chapters} 节`);
  process.exit(0);
}

if (readme !== out) {
  await writeFile(ROOT + "/README.md", out, "utf8");
  console.log("README.md 已回写：BADGES / STATS / TOC");
} else {
  console.log("README.md 无需改动");
}
await writeFile(ROOT + "/tools/stats.json", JSON.stringify(s, null, 2) + "\n", "utf8");
console.log(JSON.stringify(s));
if (problems.length) {
  console.log("\n结构问题：\n" + problems.map((p) => "  - " + p).join("\n"));
  console.log("（提示：跑 node tools/check-refs.mjs --check 会让 CI 在这里失败）");
}
