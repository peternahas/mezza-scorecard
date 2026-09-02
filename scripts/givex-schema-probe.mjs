#!/usr/bin/env node
/**
 * GIVEX PAYLOAD SCHEMA PROBE — diagnostic, not part of the data pipeline.
 *
 * Why this exists: the sales sync reads fields out of Givex's webhook
 * payload BY NAME. A wrong name fails silently — it yields a zero, and
 * a zero on a dashboard reads as a real business fact rather than a
 * bug. So before the pipeline starts reading a field, we confirm
 * against real stored payloads that the field is actually there.
 *
 * PRIVACY: this emits KEYS AND TYPES ONLY. Values are emitted for a
 * short whitelist of classification fields (department, order type,
 * payment method, category names) because those are the enumerations
 * the pipeline has to classify against. Customer names, member
 * numbers, staff names, dollar amounts and card data are never
 * emitted — not sampled, not truncated, not hashed. Absent.
 *
 * Output: data/givex-schema-probe.json
 */

import { writeFile, mkdir } from "node:fs/promises";

const base = (process.env.GIVEX_WEBHOOK_URL || "").replace(/\/$/, "");
const auth = { Authorization: process.env.GIVEX_SHARED_SECRET || "" };
if (!base || !auth.Authorization) {
  console.error("GIVEX_WEBHOOK_URL and GIVEX_SHARED_SECRET are both required.");
  process.exit(1);
}

async function get(q) {
  const r = await fetch(base + q, { headers: auth });
  if (!r.ok) throw new Error(`${q} -> ${r.status} ${await r.text()}`);
  return r.json();
}

// Walk forward to the end of the table and keep only the LAST batch.
// The newest payloads are what the pipeline will actually be reading;
// the oldest rows are certification-era test orders whose shape is not
// representative of production.
let since = 0;
let last = [];
for (;;) {
  const d = await get(`/changes?since=${since}&limit=100`);
  if (d.rows.length) last = d.rows;
  since = d.nextSince;
  if (!d.hasMore) break;
}
console.log(`Newest batch: ${last.length} payload(s); highest D1 row id ${since}`);

const WHITELIST = new Set([
  "department_name", "order_type", "payment_method",
  "category_name", "category_group_name", "subcat_name",
  "action", "device_type", "order_status", "revenue_center", "day_part",
]);

// Union of keys across every object seen at each path, so an optional
// field that appears on only some orders is not missed just because
// the first sample happened not to have it.
const shape = {};
const values = {};

function walk(v, path, depth) {
  if (depth > 6) return;
  if (Array.isArray(v)) {
    for (const e of v.slice(0, 50)) walk(e, path + "[]", depth + 1);
    return;
  }
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) {
      const p = path ? `${path}.${k}` : k;
      const t = Array.isArray(v[k]) ? "array" : v[k] === null ? "null" : typeof v[k];
      const rec = shape[p] || (shape[p] = { seen: 0, types: {}, nonEmpty: 0 });
      rec.seen++;
      rec.types[t] = (rec.types[t] || 0) + 1;
      if (v[k] !== null && v[k] !== "" && !(Array.isArray(v[k]) && !v[k].length)) rec.nonEmpty++;
      if (WHITELIST.has(k) && (typeof v[k] === "string" || typeof v[k] === "number")) {
        (values[k] || (values[k] = new Set())).add(String(v[k]));
      }
      walk(v[k], p, depth + 1);
    }
  }
}

for (const row of last) {
  try { walk(JSON.parse(row.payload), "", 0); } catch { /* skip unparseable */ }
}

const out = {
  probed_at: new Date().toISOString(),
  payloads_sampled: last.length,
  highest_d1_row_id: since,
  note:
    "Keys, types and how often each path was non-empty. Values are listed ONLY for " +
    "classification fields (department, order type, payment method, category, day part). " +
    "No customer, member, staff, amount or card data is emitted.",
  fields: Object.fromEntries(
    Object.entries(shape)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, { seen: v.seen, non_empty: v.nonEmpty, types: v.types }])
  ),
  classification_values: Object.fromEntries(
    Object.entries(values).map(([k, s]) => [k, [...s].sort()])
  ),
};

await mkdir("data", { recursive: true });
await writeFile("data/givex-schema-probe.json", JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`Wrote data/givex-schema-probe.json — ${Object.keys(out.fields).length} distinct field paths.`);
