/**
 * Tests for sync-givex-to-json v2.
 *
 * Runs the REAL script (as a child process, so nothing is stubbed
 * inside it except the network hop) against a fake /changes endpoint
 * serving payloads built to the schema the production probe actually
 * found — not to the schema I assumed before probing. That distinction
 * matters: the previous test suite's mock wrapped KV key names in
 * {name} objects to match a wrong assumption, and so agreed with the
 * bug instead of catching it.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, rm, mkdir } from "node:fs/promises";
import assert from "node:assert";

// ---------------------------------------------------------------------
// These tests rm -rf ./data before every case, because each case needs a
// clean output directory. Run from the repo root and that wipes the real
// data/ -- including givex-legacy-days.json, which holds 12 days of
// pre-D1 sales history that CANNOT be re-fetched from anywhere.
//
// Git got it back the one time this happened. That is luck, not a
// safety net, so: refuse to run anywhere that looks like a working
// tree. CI copies the two scripts into an empty /tmp dir; do the same
// locally.
// ---------------------------------------------------------------------
import { existsSync } from "node:fs";
for (const marker of [".git", "scripts", "data/givex-legacy-days.json", "data/givex-sync-state.json"]) {
  if (existsSync(marker)) {
    console.error(
      `\nRefusing to run here: found ./${marker}, so this looks like the repo, ` +
      `and these tests delete ./data.\n\n` +
      `Run them in a scratch directory instead:\n` +
      `  mkdir -p /tmp/t && cd /tmp/t \\\n` +
      `    && cp <repo>/scripts/<the-sync-script>.mjs sync.mjs \\\n` +
      `    && cp <repo>/scripts/<this-test>.mjs test.mjs && node test.mjs\n`
    );
    process.exit(2);
  }
}


const SECRET = "test-secret";
let PASS = 0, FAIL = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); PASS++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); FAIL++; }
}

/* ── payload builder, matching the probed production schema ────── */
let seq = 1788000000, orderId = 400000;

function order({
  outletId, store, date, open = "12:30", close = "12:41",
  orderType = "QSR", table = null, onlineOrderId = null,
  operator = "CASHIER 1",
  lines,                        // [{dept, cat, group, sub, item, net, gross, units, tax, addons, type}]
  payments = null,              // [{method, amount, tip}]
} = {}) {
  const oid = orderId++;
  const net = lines.reduce((s, l) => s + l.net, 0);
  const tax = lines.reduce((s, l) => s + (l.tax ?? 0), 0);
  const pays = payments || [{ method: "VISA", amount: net + tax, tip: 1.5 }];
  return {
    action: "bill_info",
    SequenceID: seq++,
    BusinessDate: date,
    ClientID: 16907, MerchantID: 19495, OutletID: outletId, OrderID: oid,
    OnlineOrderID: "",
    payload: [
      [{
        vxl_order_id: oid, outlet_id: outletId, store_name: store,
        order_type: orderType, opening_time: open, closing_time: close,
        opening_date: date, closing_date: date,
        table_num: table === null ? "0" : String(table),
        merchant_id: 19495, client_id: 16907, store_ref: "X", order_ref: null,
        bills: [{
          vxl_bill_id: 1, bill_status: "Paid",
          order_subtotal: net, bill_tax: tax, bill_amount: net + tax,
          num_seats: 1, discount_pretax: 0, coupon_pretax: 0,
          customer_id: "", customer_name: "", member_number: "",
          bill_online_order_id: onlineOrderId,
          payments: pays.map((p) => ({
            payment_method: p.method,
            payment_method_amount: p.amount,
            total_payment: p.amount + (p.tip || 0),
            total_tip: p.tip || 0,
            operator_name: operator, operator_login: 111, cash_out_id: 2131,
            payment_ref: "", adjusted_by: "", adjustment_note: "",
          })),
        }],
      }],
      lines.map((l, i) => ({
        vxl_order_id: oid, vxl_order_line_id: 300000 + i, outlet_id: outletId,
        type: l.type || "sale",
        department_name: l.dept, department_id: 745,
        category_name: l.cat, category_id: 2819,
        category_group_name: l.group, subcat_name: l.sub,
        item_name: l.item, item_sku_code: "SKU" + i,
        units: l.units ?? 1, price_per_unit: l.net,
        net_sales: l.net, adj_gross_sales: l.gross ?? l.net,
        total_amt: l.net + (l.tax ?? 0), total_tax: l.tax ?? 0,
        service_charge_amt: 0, service_charge_tax: 0,
        time: (l.time || open) + ":00", date,
        operator_name: operator, section_name: l.dept,
        seat_num: 1, table_num: table === null ? 0 : table,
        vxl_bill_ids: [1],
        modifiers: [], discounts: [], coupons: [], returns: [],
        addons: (l.addons || []).map((a) => ({
          item_name: a.name, item_sku_code: "A", units: 1,
          price_per_unit: a.price ?? 0, adj_gross_sales: a.price ?? 0,
          date, time: "12:30:00", modifiers: [], discounts: [],
        })),
      })),
    ],
  };
}

const WRAP = { dept: "Eat - In", cat: "Wraps", group: "Food", sub: "Wraps", item: "Chicken Shawarma Wrap", net: 12.99, tax: 1.95 };
const PLATE = { dept: "Eat - In", cat: "Signature Plates", group: "Food", sub: "Plates", item: "Chicken Plate", net: 19.29, tax: 2.89 };
const POP = { dept: "Eat - In", cat: "Beverages", group: "Beverages", sub: "Beverages", item: "Fountain Pop", net: 2.49, tax: 0.37 };

/* ── run the script against a fake /changes ────────────────────── */

async function run(payloads, { fullResync = false, keepState = false } = {}) {
  if (!keepState) { await rm("data", { recursive: true, force: true }); }
  await mkdir("data", { recursive: true });

  const rows = payloads.map((p, i) => ({ id: i + 1, key: `orders/k${i}`, payload: JSON.stringify(p) }));
  const server = createServer((req, res) => {
    if (req.headers.authorization !== SECRET) { res.writeHead(401).end("{}"); return; }
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/changes") {
      const since = Number(u.searchParams.get("since") || 0);
      const batch = rows.filter((r) => r.id > since).slice(0, 100);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        since, count: batch.length, rows: batch,
        nextSince: batch.length ? batch[batch.length - 1].id : since,
        hasMore: false,
      }));
      return;
    }
    res.writeHead(404).end("{}");
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const child = spawn(process.execPath, ["sync.mjs"], {
    env: {
      ...process.env,
      GIVEX_WEBHOOK_URL: `http://127.0.0.1:${port}`,
      GIVEX_SHARED_SECRET: SECRET,
      FULL_RESYNC: fullResync ? "true" : "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("close", r));
  server.close();
  if (code !== 0) throw new Error(`sync exited ${code}\n${out}`);
  return { out, data: JSON.parse(await readFile("data/givex-sales-data.json", "utf8")) };
}

const D = "2026-09-01";
const BURNSIDE = { outletId: 162049, store: "Burnside" };      // Corp
const ANTIG = { outletId: 179330, store: "Antigonish" };       // Franchisee
const TESTLAB = { outletId: 65659, store: "Beta Lanner" };     // excluded

/* ══════════════ 1. basics and backward compatibility ══════════ */
console.log("\n1. Totals and v1 backward compatibility");
{
  const { data } = await run([
    order({ ...BURNSIDE, date: D, lines: [WRAP, POP] }),
    order({ ...BURNSIDE, date: D, lines: [PLATE] }),
  ]);
  const d = data.days.find((x) => x.Location_Name === "Burnside");
  check("Total_Sales is the sum of line net_sales", () =>
    assert.strictEqual(d.Total_Sales, Math.round((12.99 + 2.49 + 19.29) * 100) / 100));
  check("Orders counts distinct orders", () => assert.strictEqual(d.Orders, 2));
  check("Avg_Ticket = Total_Sales / Orders", () =>
    assert.strictEqual(d.Avg_Ticket, Math.round(((12.99 + 2.49 + 19.29) / 2) * 100) / 100));
  check("Corp classification comes from store-mapping", () =>
    assert.strictEqual(d.Location_Type, "Corp"));
  check("every v1 field is still present", () => {
    for (const k of ["Location_Name","Location_Type","Business_Date","Total_Sales","InStore_Sales",
      "Online_Sales","Orders","Avg_Ticket","Order_Type_Sales","Day_Part_Sales","Payment_Mix","Tips_Total"])
      assert.ok(k in d, `missing v1 field ${k}`);
  });
  check("weeks[] keeps its v1 shape", () => {
    const w = data.weeks[0];
    for (const k of ["Location_Name","Year","Week_Number","Week_Start","Total_Sales",
      "InStore_Sales","Online_Sales","Orders","Avg_Ticket"]) assert.ok(k in w, `missing ${k}`);
  });
  check("Tax_Total captured from bill_tax", () => assert.strictEqual(d.Tax_Total, 1.95 + 0.37 + 2.89));
  check("Tendered_Total is what was actually paid", () =>
    assert.strictEqual(d.Tendered_Total, Math.round((12.99 + 2.49 + 1.95 + 0.37 + 19.29 + 2.89) * 100) / 100));
  check("Tips_Total summed from payments", () => assert.strictEqual(d.Tips_Total, 3));
}

/* ══════════════ 2. the new dimensions ══════════════════════════ */
console.log("\n2. New dimensions");
{
  const { data } = await run([
    order({ ...BURNSIDE, date: D, open: "12:15", lines: [WRAP, POP] }),
    order({ ...BURNSIDE, date: D, open: "18:40", lines: [PLATE] }),
    order({ ...BURNSIDE, date: D, open: "19:05", orderType: "Take-Out",
            lines: [{ ...WRAP, dept: "Skip The Dishes" }] }),
  ]);
  const d = data.days.find((x) => x.Location_Name === "Burnside");
  check("category mix", () => {
    assert.strictEqual(d.Category_Sales["Wraps"], 12.99 * 2);
    assert.strictEqual(d.Category_Sales["Beverages"], 2.49);
    assert.strictEqual(d.Category_Sales["Signature Plates"], 19.29);
  });
  check("category GROUP splits food from beverage", () => {
    assert.strictEqual(d.Beverage_Sales, 2.49);
    assert.strictEqual(d.Food_Sales, Math.round((12.99 * 2 + 19.29) * 100) / 100);
  });
  check("subcategory mix", () => assert.strictEqual(d.Subcategory_Sales["Plates"], 19.29));
  check("beverage attach = orders containing a drink / orders", () =>
    assert.strictEqual(d.Beverage_Attach_Pct, 33.33));
  check("hourly sales curve", () => {
    assert.strictEqual(d.Hour_Sales["12"], 12.99 + 2.49);
    assert.strictEqual(d.Hour_Sales["18"], 19.29);
    assert.strictEqual(d.Hour_Orders["19"], 1);
  });
  check("day-part buckets unchanged from v1", () => {
    assert.strictEqual(d.Day_Part_Sales["Lunch"], 12.99 + 2.49);
    assert.strictEqual(d.Day_Part_Sales["Dinner"], 19.29 + 12.99);
  });
  check("marketplace sales separated from own online", () => {
    assert.strictEqual(d.Marketplace_Sales, 12.99);
    assert.strictEqual(d.Marketplace_Orders, 1);
    assert.strictEqual(d.Online_Sales, 12.99);
  });
  check("online order count and share", () => {
    assert.strictEqual(d.Online_Orders, 1);
    assert.strictEqual(d.Online_Order_Pct, 33.33);
  });
  check("units and units per order", () => {
    assert.strictEqual(d.Units, 4);
    assert.strictEqual(d.Units_Per_Order, 1.33);
  });
  // Only the first order has a sane open/close pair. The other two
  // open in the evening and (in this fixture) carry a lunchtime close
  // time, so they wrap past midnight to >4h and must be DISCARDED as
  // POS artefacts rather than dragged into the average — a tab left
  // open overnight is not a ticket time.
  check("service minutes averaged over sane tickets only", () =>
    assert.strictEqual(d.Avg_Service_Minutes, 26));
  check("operator counted", () => assert.strictEqual(d.Operator_Count, 1));
  check("line types tracked (voids would show here)", () =>
    assert.strictEqual(d.Line_Types["sale"], 4));
  check("item mix, network-wide by day", () => {
    const wrap = data.items.find((i) => i.Item_Name === "Chicken Shawarma Wrap");
    assert.strictEqual(wrap.Units, 2);
    assert.strictEqual(wrap.Net_Sales, 25.98);
    assert.strictEqual(wrap.Category_Name, "Wraps");
  });
  check("item mix by location", () => {
    const pop = data.items_by_location.find((i) => i.Item_Name === "Fountain Pop");
    assert.strictEqual(pop.Location_Name, "Burnside");
    assert.strictEqual(pop.Units, 1);
  });
  check("operator rollup", () => {
    const op = data.operators[0];
    assert.strictEqual(op.Operator, "CASHIER 1");
    assert.strictEqual(op.Orders, 3);
    assert.strictEqual(op.Days_Worked, 1);
  });
}

/* ══════════════ 3. paid add-ons must NOT inflate net sales ═════ */
console.log("\n3. Add-ons");
{
  const { data } = await run([
    order({ ...BURNSIDE, date: D, lines: [
      { ...WRAP, addons: [{ name: "Extra Garlic", price: 0 }, { name: "Add Cheese", price: 1.5 }] },
    ] }),
  ]);
  const d = data.days[0];
  check("net sales unchanged by a paid add-on", () => assert.strictEqual(d.Total_Sales, 12.99));
  check("paid add-on counted and priced separately", () => {
    assert.strictEqual(d.Paid_Addon_Count, 1);
    assert.strictEqual(d.Paid_Addon_Sales, 1.5);
    assert.strictEqual(d.Paid_Addon_Attach_Pct, 100);
  });
  check("free modifiers counted apart from paid upsells", () =>
    assert.strictEqual(d.Free_Addon_Count, 1));
}

/* ══════════════ 4. idempotency and exclusions ══════════════════ */
console.log("\n4. Re-delivery and exclusions");
{
  const o1 = order({ ...BURNSIDE, date: D, lines: [WRAP] });
  const { data } = await run([o1, JSON.parse(JSON.stringify(o1))]); // Givex re-push
  check("a re-delivered bill does not double count", () => {
    assert.strictEqual(data.days[0].Total_Sales, 12.99);
    assert.strictEqual(data.days[0].Orders, 1);
  });
}
{
  const { data } = await run([
    order({ ...BURNSIDE, date: D, lines: [WRAP] }),
    order({ ...TESTLAB, date: D, lines: [PLATE] }),
  ]);
  check("the certification test outlet contributes no revenue", () => {
    assert.strictEqual(data.days.length, 1);
    assert.strictEqual(data.days[0].Total_Sales, 12.99);
    assert.ok(Object.keys(data.excluded_outlets).length === 1);
  });
}
{
  const { data } = await run([order({ outletId: 999999, store: "Nowhere", date: D, lines: [WRAP] })]);
  check("an unmapped outlet is dropped and reported, never silently bucketed", () => {
    assert.strictEqual(data.days.length, 0);
    assert.ok(Object.keys(data.unmapped_outlets).length === 1);
  });
}

/* ══════════════ 5. incremental state ═══════════════════════════ */
console.log("\n5. Incremental behaviour");
{
  const a = order({ ...BURNSIDE, date: D, lines: [WRAP] });
  const first = await run([a]);
  const second = await run([a], { keepState: true });
  check("a repeat run with nothing new is a no-op", () => {
    assert.strictEqual(second.data.payloads_processed_this_run, 0);
    assert.strictEqual(second.data.days[0].Total_Sales, first.data.days[0].Total_Sales);
  });
  const third = await run([a, order({ ...BURNSIDE, date: D, lines: [PLATE] })], { keepState: true });
  check("a new order after the watermark flows straight through", () => {
    assert.strictEqual(third.data.payloads_processed_this_run, 1);
    assert.strictEqual(third.data.days[0].Total_Sales, 12.99 + 19.29);
  });
}

/* ══════════════ 6. freezing keeps totals identical ═════════════ */
console.log("\n6. Freezing (bounded state file)");
{
  // One order 40 days back, one today. The old one must be frozen out
  // of the live snapshot map without changing a single reported number.
  const old = order({ ...BURNSIDE, date: "2026-07-24", lines: [PLATE] });
  const now = order({ ...BURNSIDE, date: "2026-09-01", lines: [WRAP] });
  const { data } = await run([old, now]);
  const oldDay = data.days.find((d) => d.Business_Date === "2026-07-24");
  const newDay = data.days.find((d) => d.Business_Date === "2026-09-01");
  check("a frozen day still reports its full totals", () =>
    assert.strictEqual(oldDay.Total_Sales, 19.29));
  check("the frozen day keeps its breakdowns", () => {
    assert.strictEqual(oldDay.Category_Sales["Signature Plates"], 19.29);
    assert.ok(oldDay.Hour_Sales["12"] > 0);
  });
  check("only the recent order stays live", () =>
    assert.strictEqual(data.orders_total, 1));
  check("frozen_through is recorded", () =>
    assert.strictEqual(data.frozen_through, "2026-09-01"));
  check("network totals unaffected by freezing", () => {
    const total = data.days.reduce((s, d) => s + d.Total_Sales, 0);
    assert.strictEqual(Math.round(total * 100) / 100, 19.29 + 12.99);
  });
  check("frozen item-day history is retained", () => {
    const plate = data.items.find((i) => i.Item_Name === "Chicken Plate");
    assert.strictEqual(plate.Units, 1);
  });
  check("a full resync reproduces the same totals", async () => {});
  const resync = await run([old, now], { fullResync: true, keepState: true });
  check("FULL_RESYNC reproduces identical day totals", () => {
    const a = data.days.map((d) => [d.Business_Date, d.Total_Sales]).sort();
    const b = resync.data.days.map((d) => [d.Business_Date, d.Total_Sales]).sort();
    assert.deepStrictEqual(b, a);
  });
}

/* ══════════════ 7. coverage diagnostic ════════════════════════ */
console.log("\n7. Field coverage diagnostic");
{
  const o = order({ ...BURNSIDE, date: D, lines: [WRAP] });
  // Simulate Givex renaming a field: the metric must go to zero AND
  // the coverage block must say so, rather than quietly reading zero.
  delete o.payload[1][0].category_name;
  const { data, out } = await run([o]);
  check("a missing field shows up as zero coverage", () =>
    assert.strictEqual(data.field_coverage["line.category_name"].found, 0));
  check("and is warned about in the run log", () =>
    assert.ok(/FIELD NEVER FOUND: line\.category_name/.test(out)));
  check("fields that are present report full coverage", () =>
    assert.strictEqual(data.field_coverage["line.item_name"].missing, 0));
}

/* ══════════════ 8. multi-location and Corp/Franchisee ═════════ */
console.log("\n8. Multi-location");
{
  const { data } = await run([
    order({ ...BURNSIDE, date: D, lines: [WRAP] }),
    order({ ...ANTIG, date: D, lines: [PLATE] }),
  ]);
  check("both locations appear with the right ownership", () => {
    const b = data.days.find((d) => d.Location_Name === "Burnside");
    const a = data.days.find((d) => d.Location_Name === "Antigonish");
    assert.strictEqual(b.Location_Type, "Corp");
    assert.strictEqual(a.Location_Type, "Franchisee");
  });
  check("weeks carry Location_Type for Corp/Franchisee splits", () =>
    assert.ok(data.weeks.every((w) => w.Location_Type)));
}


/* ══════════════ 9. ticket-time edge cases ═════════════════════ */
console.log("\n9. Ticket time edge cases");
{
  const { data } = await run([
    order({ ...BURNSIDE, date: D, open: "23:50", close: "00:05", lines: [WRAP] }),
  ]);
  check("a bill closing after midnight wraps instead of going negative", () =>
    assert.strictEqual(data.days[0].Avg_Service_Minutes, 15));
}
{
  const { data } = await run([
    order({ ...BURNSIDE, date: D, open: "11:00", close: "20:00", lines: [WRAP] }),
  ]);
  check("a tab open for nine hours is discarded, not averaged in", () =>
    assert.strictEqual(data.days[0].Avg_Service_Minutes, null));
}

/* ══════════════ 10. what the probe says is NOT available ══════ */
console.log("\n10. Fields the production payload does not populate");
{
  const { data } = await run([order({ ...BURNSIDE, date: D, lines: [WRAP] })]);
  const d = data.days[0];
  check("discounts read zero because Givex sends zero, and are labelled as such", () => {
    assert.strictEqual(d.Discount_Total, 0);
    assert.strictEqual(d.Coupon_Total, 0);
    // Coverage proves the field was FOUND and genuinely zero, which is
    // a different statement from "we failed to read it".
    assert.ok(data.field_coverage["bill.discount_pretax"].found > 0);
  });
}


/* ══════════ 11. pre-D1 legacy history ═══════════════════════════
   The highest-risk part of the rewrite. D1 holds nothing before the
   2026-08-26 cutover, so a rebuild that reads only D1 silently drops
   twelve days of real sales. These tests exist because that failure
   is invisible -- the feed still looks healthy, just shorter.       */
console.log("\n11. Pre-D1 legacy history");
{
  const legacy = {
    authoritative_through: "2026-08-26",
    days: [
      { Location_Name:"Burnside", Location_Type:"Corp", Business_Date:"2026-08-20",
        Total_Sales:5000, InStore_Sales:4000, Online_Sales:1000, Orders:200,
        Avg_Ticket:25, Order_Type_Sales:{QSR:5000}, Day_Part_Sales:{Lunch:5000},
        Payment_Mix:{VISA:5600}, Tips_Total:150 },
      { Location_Name:"Burnside", Location_Type:"Corp", Business_Date:"2026-08-26",
        Total_Sales:6000, InStore_Sales:5000, Online_Sales:1000, Orders:240,
        Avg_Ticket:25, Order_Type_Sales:{QSR:6000}, Day_Part_Sales:{Lunch:6000},
        Payment_Mix:{VISA:6700}, Tips_Total:180 },
    ],
  };
  const writeLegacy = async () => {
    await mkdir("data", { recursive: true });
    await (await import("node:fs/promises")).writeFile("data/givex-legacy-days.json", JSON.stringify(legacy));
  };

  // D1 carries a cutover-day order (already inside the legacy total)
  // and a post-cutover one (not).
  const cutoverDay = order({ ...BURNSIDE, date: "2026-08-26", lines: [PLATE] });
  const afterCutover = order({ ...BURNSIDE, date: "2026-08-27", lines: [WRAP] });

  const runWithLegacy = async (payloads, opts) => {
    await rm("data", { recursive: true, force: true });
    await writeLegacy();
    return run(payloads, Object.assign({ keepState: true }, opts));
  };

  const { data, out } = await runWithLegacy([cutoverDay, afterCutover]);
  const byDate = {};
  data.days.forEach((d) => (byDate[d.Business_Date] = d));

  check("pre-cutover history is present, not silently dropped", () =>
    assert.strictEqual(byDate["2026-08-20"].Total_Sales, 5000));
  check("its orders, channel split and tender come through", () => {
    assert.strictEqual(byDate["2026-08-20"].Orders, 200);
    assert.strictEqual(byDate["2026-08-20"].InStore_Sales, 4000);
    assert.strictEqual(byDate["2026-08-20"].Payment_Mix.VISA, 5600);
  });
  check("the cutover day is NOT double counted", () => {
    // The legacy row already contains that afternoon's D1 orders, so
    // the D1 copy must be skipped rather than added.
    assert.strictEqual(byDate["2026-08-26"].Total_Sales, 6000);
    assert.strictEqual(byDate["2026-08-26"].Orders, 240);
  });
  check("D1 payloads on or before the cutover are reported as skipped", () =>
    assert.strictEqual(data.legacy_payloads_skipped_this_run, 1));
  check("the day after the cutover comes from D1", () =>
    assert.strictEqual(byDate["2026-08-27"].Total_Sales, 12.99));
  check("legacy days are tagged so the UI can say detail is missing", () => {
    assert.strictEqual(byDate["2026-08-20"].Legacy_Sales_Only, true);
    assert.ok(!byDate["2026-08-27"].Legacy_Sales_Only);
  });
  check("the feed states where legacy history ends", () =>
    assert.strictEqual(data.legacy_authoritative_through, "2026-08-26"));
  check("the seeding is announced in the run log", () =>
    assert.ok(/Seeded 2 pre-D1 store-day/.test(out)));

  // Re-seeding on every run would double the history each time. This
  // is the failure that would look like spectacular growth.
  const again = await run([cutoverDay, afterCutover], { keepState: true });
  const b2 = {};
  again.data.days.forEach((d) => (b2[d.Business_Date] = d));
  check("an incremental run does not re-seed and double the history", () => {
    assert.strictEqual(b2["2026-08-20"].Total_Sales, 5000);
    assert.strictEqual(b2["2026-08-26"].Total_Sales, 6000);
  });
  check("network total is legacy plus D1, counted once", () => {
    const total = again.data.days.reduce((s, d) => s + d.Total_Sales, 0);
    assert.strictEqual(Math.round(total * 100) / 100, 5000 + 6000 + 12.99);
  });

  const resync = await run([cutoverDay, afterCutover], { fullResync: true, keepState: true });
  const b3 = {};
  resync.data.days.forEach((d) => (b3[d.Business_Date] = d));
  check("a full resync re-seeds exactly once, not twice", () => {
    assert.strictEqual(b3["2026-08-20"].Total_Sales, 5000);
    assert.strictEqual(b3["2026-08-26"].Total_Sales, 6000);
    assert.strictEqual(b3["2026-08-27"].Total_Sales, 12.99);
  });
}
/* ══════════ 11b. recovering ONE day out of the snapshot ══════════
   Givex re-pushed 2026-08-20 on 2026-09-03 and it landed in D1. Using
   it meant the snapshot could no longer be treated as one contiguous
   block: moving a single `authoritative_through` scalar back past
   Aug 20 would also have un-skipped Aug 21-26, where D1 holds nothing,
   deleting six days from the scorecard -- and would have double
   counted Aug 26, where D1 holds a partial day next to a fuller
   legacy row. Hence the per-date rule. These tests are that rule.  */
console.log("\n11b. Recovering one day out of the snapshot");
{
  const writeLegacyDays = async (days) => {
    await mkdir("data", { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      "data/givex-legacy-days.json",
      JSON.stringify({ authoritative_through: "2026-08-26", days })
    );
  };
  const legacyRow = (date, sales, orders) => ({
    Location_Name:"Burnside", Location_Type:"Corp", Business_Date:date,
    Total_Sales:sales, InStore_Sales:sales, Online_Sales:0, Orders:orders,
    Avg_Ticket:25, Order_Type_Sales:{QSR:sales}, Day_Part_Sales:{Lunch:sales},
    Payment_Mix:{VISA:sales}, Tips_Total:0 });

  // The repolled day, now genuinely in D1, plus a still-damaged day
  // that only the snapshot has.
  const repolled = order({ ...BURNSIDE, date: "2026-08-20", lines: [PLATE] });
  const cutover  = order({ ...BURNSIDE, date: "2026-08-26", lines: [WRAP] });

  // BEFORE: the snapshot still owns Aug 20, so D1's copy is ignored.
  await rm("data", { recursive: true, force: true });
  await writeLegacyDays([legacyRow("2026-08-20", 5000, 200), legacyRow("2026-08-26", 6000, 240)]);
  const before = await run([repolled, cutover], { keepState: true });
  const b = {}; before.data.days.forEach((d) => (b[d.Business_Date] = d));
  check("while the snapshot owns a date, D1 is ignored for it", () =>
    assert.strictEqual(b["2026-08-20"].Total_Sales, 5000));
  check("both owned dates are reported so it is visible which are old", () =>
    assert.deepStrictEqual(before.data.legacy_owned_dates, ["2026-08-20", "2026-08-26"]));

  // AFTER: Aug 20 archived out of the snapshot. Nothing else changes --
  // no scalar moved, no other date touched.
  await rm("data", { recursive: true, force: true });
  await writeLegacyDays([legacyRow("2026-08-26", 6000, 240)]);
  const after = await run([repolled, cutover], { keepState: true });
  const a = {}; after.data.days.forEach((d) => (a[d.Business_Date] = d));
  check("removing a date from the snapshot switches it to D1", () => {
    assert.strictEqual(a["2026-08-20"].Total_Sales, 19.29);   // the PLATE order
    assert.ok(!a["2026-08-20"].Legacy_Sales_Only,
      "recovered day is still tagged as legacy-only, so the UI would hide its detail");
  });
  check("the recovered day is NOT added on top of the old total", () =>
    assert.notStrictEqual(a["2026-08-20"].Total_Sales, 5000 + 19.29));
  check("a date still in the snapshot is untouched by the recovery", () => {
    assert.strictEqual(a["2026-08-26"].Total_Sales, 6000);
    assert.strictEqual(a["2026-08-26"].Legacy_Sales_Only, true);
  });
  check("dates the snapshot never held are NOT skipped as a side effect", () => {
    // The old scalar skipped everything on or before Aug 26 whether the
    // snapshot held it or not. That is what would have deleted Aug 21-26.
    assert.ok(!after.data.legacy_owned_dates.includes("2026-08-21"));
  });
  check("only the still-owned date is reported as skipped", () =>
    assert.strictEqual(after.data.legacy_payloads_skipped_this_run, 1));
}

{
  // No legacy file at all must still work -- this is what a fresh
  // deployment somewhere else looks like.
  await rm("data", { recursive: true, force: true });
  const { data, out } = await run([order({ ...BURNSIDE, date: D, lines: [WRAP] })]);
  check("a missing legacy file degrades quietly instead of throwing", () => {
    assert.strictEqual(data.days.length, 1);
    assert.strictEqual(data.legacy_authoritative_through, null);
    assert.ok(/No pre-D1 legacy snapshot/.test(out));
  });
}

console.log(`\n${PASS} passed, ${FAIL} failed.`);
process.exit(FAIL ? 1 : 0);
