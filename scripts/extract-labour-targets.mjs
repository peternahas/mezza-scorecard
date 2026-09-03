#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 * PULL BUDGETED LABOUR TARGETS OUT OF THE CONSOLIDATED DASHBOARD
 * ═══════════════════════════════════════════════════════════════════
 *
 * Ashley maintains the budget in the Consolidated dashboard
 * (consolidated.mezzascorecard.com). Every location's P&L is embedded
 * in that page as TB_STORES, keyed by corporate entity, and each
 * carries a "Labour %" row with fy25/fy26 actuals and an fy27 budget.
 * STORE_NAMES in the same page maps entity -> Mezza store name.
 *
 * So the targets already exist and are already owned by the right
 * person. Copying them by hand once would have been quicker; doing it
 * every time the budget changes is how they go stale and start lying.
 * This is the refresh.
 *
 *   node scripts/extract-labour-targets.mjs <path-to consolidated/index.html>
 *   node scripts/extract-labour-targets.mjs <path> --write
 *
 * Without --write it prints and changes nothing. With --write it
 * updates the `targets` block of scripts/labour-targets.json and
 * leaves every comment and the network fallback alone.
 *
 * It refuses rather than guesses: if the page's shape has changed and
 * either TB_STORES or STORE_NAMES cannot be read, it says so and exits
 * non-zero. A silently empty target set would put every store back on
 * the Corp average without anyone noticing.
 * ═══════════════════════════════════════════════════════════════════
 */
import { readFile, writeFile } from "node:fs/promises";

const [srcPath, ...rest] = process.argv.slice(2);
const write = rest.includes("--write");
const OUT = "scripts/labour-targets.json";

if (!srcPath) {
  console.error("Usage: node scripts/extract-labour-targets.mjs <consolidated/index.html> [--write]");
  process.exit(2);
}

const html = await readFile(srcPath, "utf8");

// STORE_NAMES: entity -> Mezza store name (single-quoted object literal)
const namesMatch = html.match(/const STORE_NAMES\s*=\s*\{([\s\S]*?)\};/);
if (!namesMatch) {
  console.error("Could not find STORE_NAMES in that file. The Consolidated page's shape has changed — read it before trusting anything here.");
  process.exit(1);
}
const names = {};
for (const m of namesMatch[1].matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)) names[m[1]] = m[2];

// TB_STORES: a JSON object literal. Brace-match rather than regex it.
const at = html.indexOf("const TB_STORES=");
if (at < 0) {
  console.error("Could not find TB_STORES in that file. The Consolidated page's shape has changed.");
  process.exit(1);
}
let i = html.indexOf("{", at), depth = 0, end = -1;
for (let j = i; j < html.length; j++) {
  if (html[j] === "{") depth++;
  else if (html[j] === "}" && --depth === 0) { end = j; break; }
}
if (end < 0) { console.error("TB_STORES is not brace-balanced — refusing to guess."); process.exit(1); }
const tb = JSON.parse(html.slice(i, end + 1));

const targets = {}, reference = {}, problems = [];
for (const [entity, rows] of Object.entries(tb)) {
  const store = names[entity];
  if (!store) { problems.push(`${entity}: no STORE_NAMES mapping, skipped rather than guessed at`); continue; }
  const row = rows.find((r) => r && r.desc === "Labour %");
  if (!row) { problems.push(`${store}: no "Labour %" row`); continue; }
  if (typeof row.fy27 !== "number" || !(row.fy27 > 0)) { problems.push(`${store}: fy27 is ${row.fy27}`); continue; }
  // The FY27 monthly figures are flat, so annual == monthly. Say so if
  // that ever stops being true rather than quietly averaging.
  const m = row.fy27_m || [];
  const distinct = new Set(m.map((v) => Math.round(v * 10000)));
  if (distinct.size > 1) problems.push(`${store}: fy27 varies by month (${m.slice(0, 4).join(", ")}...) — the annual figure is being used`);
  targets[store] = Math.round(row.fy27 * 1000) / 10;
  reference[store] = typeof row.fy26 === "number" ? Math.round(row.fy26 * 100) : null;
}

if (!Object.keys(targets).length) {
  console.error("No targets could be read. Refusing to write an empty set — that would put every store back on the Corp average silently.");
  process.exit(1);
}

console.log(`${Object.keys(targets).length} target(s) read from ${srcPath}:\n`);
for (const k of Object.keys(targets).sort()) {
  console.log(`  ${k.padEnd(28)} FY27 ${String(targets[k]).padStart(5)}%   (FY26 actual ${reference[k]}%)`);
}
if (problems.length) { console.log("\nWorth a look:"); problems.forEach((p) => console.log("  - " + p)); }

if (!write) { console.log("\nNothing written. Re-run with --write to update " + OUT + "."); process.exit(0); }

const cur = JSON.parse(await readFile(OUT, "utf8"));
cur.targets = Object.fromEntries(Object.keys(targets).sort().map((k) => [k, targets[k]]));
cur._fy26_actual_for_reference = reference;
cur._source = `consolidated.mezzascorecard.com, FY27 budget, read ${new Date().toISOString().slice(0, 10)}`;
await writeFile(OUT, JSON.stringify(cur, null, 1) + "\n", "utf8");
console.log(`\nWrote ${OUT}.`);
