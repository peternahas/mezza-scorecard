#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 * PUSH OPERATIONS LABOUR → data/push-labour-data.json
 * ═══════════════════════════════════════════════════════════════════
 *
 * Labour is the largest number missing from the scorecard. Without it
 * there is no prime cost, no sales-per-labour-hour, and no way to tell
 * a store that is genuinely busy from one that is simply overstaffed.
 * Everything else on the dashboard describes demand; this is the first
 * measure of how well demand was served.
 *
 * ── THE ENTITLEMENT IS NOW GRANTED ───────────────────────────────
 *
 * Until 2026-09-03 `/analytics/summary/labour-actuals` returned, for
 * every location:
 *
 *   {"status":"failed","message":"Insufficient permissions"}
 *
 * The token authenticated fine and COULD list companies, so it was a
 * per-endpoint entitlement on Push's side rather than a bad credential.
 * Christian at Push confirmed on 2026-09-03 that the department
 * endpoint is now on the Mezza token, giving Total Labour Cost and
 * Total Hours per company. Department was the right ask: the scorecard
 * needs location totals, and per-person payroll detail has no business
 * sitting in a dashboard.
 *
 * The permission-error handling below stays. Entitlements get revoked,
 * tokens get rotated, and the failure mode that matters is a zero
 * labour cost quietly showing every store at 0% labour and a perfect
 * prime cost. This script reports the error instead of writing zeros.
 *
 * ── TWO API QUIRKS THAT SHAPE THE CODE ───────────────────────────
 *
 * 1. Labour endpoints cap a date range at TWO DAYS per request. A
 *    28-day pull is therefore 14 calls per location, 8 locations, so
 *    the loop is chunked and paced rather than parallel.
 * 2. Charlottetown does not appear in this token's /companies list at
 *    all — it is on PEI and looks to sit on a separate Push account.
 *    It is listed as a known gap rather than silently absent, because
 *    a missing location in a labour report reads as a store with no
 *    labour cost.
 *
 * Required: PUSH_BEARER_TOKEN (GitHub repo secret). The token lives
 * only there — never in a file, never in this repo.
 */

import { writeFile, mkdir } from "node:fs/promises";

const { PUSH_BEARER_TOKEN, PUSH_DAYS, PUSH_PACE_MS } = process.env;
// Pace between calls. Overridable so the test suite is not 144 real
// waits long -- the tests stub the network, so there is nothing to be
// polite to.
const PACE_MS = Number.parseInt(PUSH_PACE_MS || "400", 10);
const BASE = "https://api.pushoperations.com/platform/api/v1";
const OUTPUT_PATH = "data/push-labour-data.json";
const DAYS = Number.parseInt(PUSH_DAYS || "35", 10);

// Confirmed against a live /companies call, 2026-07-02. Corp stores
// only, because Labour_Pct on the scorecard has always been a Corp
// measure -- a franchisee's labour is their own business, and putting
// it on a head-office dashboard is a different conversation.
const COMPANIES = {
  25556: "Lower Sackville",
  25558: "Herring Cove (Spryfield)",
  25554: "Halifax Shopping Centre",
  25557: "Scotia Square",
  25154: "Burnside",
  25633: "Clayton Park",
  27757: "Barrington",
  // Christian at Push added this on 2026-09-03. "Mezza - 690 University"
  // is 690 University Ave Unit 2, Charlottetown PE -- confirmed against
  // the store's own address, not matched by name.
  28602: "Charlottetown",
};
// Real Push companies that are not stores. Kept visible rather than
// dropped: overhead labour is a real cost, it just does not belong in
// a per-store labour percentage.
const OVERHEAD = { 25560: "Corporate", 25555: "Production Centre" };
// Franchisee locations on this token. Not pulled by default -- see above.
const FRANCHISEE = { 29923: "Mount Pearl" };

// Empty on purpose. Charlottetown was the only entry and it is now on
// the token as company 28602. Kept as a list rather than deleted,
// because the next store to open will sit here until Push adds it, and
// a missing location in a labour report reads as a store with no
// labour cost rather than as a store nobody wired up.
const KNOWN_GAPS = [];

function iso(d) { return d.toISOString().slice(0, 10); }

/* ── SHAPE, NOT VALUES ────────────────────────────────────────────
   The entitlement landing revealed that nobody had ever seen a real
   labour-actuals response -- the parser was written against the shape
   the docs implied, and the first live call threw "rows is not
   iterable". So the run records the response's STRUCTURE: keys, types,
   array lengths, and nothing else. No hours, no dollars, no names, no
   employee anything. Same rule as the Givex schema probe: enough to
   write a correct parser, and nothing that should not be in a repo. */
/* Push's labour response has never been seen from this side, so the
   collector is deliberately shape-agnostic: it walks the payload and
   picks up any object that carries a recognisable hours-or-cost field.
   That is more forgiving than a fixed path, and the alternative -- one
   assumed path -- is what threw "rows is not iterable" on the first
   live call. Once response_shape has been read from a real run this
   can be narrowed to the real path. */
const HOUR_KEYS = ["hours", "totalHours", "totalHrs", "actualHours", "total_hours"];
const COST_KEYS = ["costs", "totalCosts", "totalCost", "cost", "actualCost", "totalLabourCost", "totalLaborCost", "total_cost"];

function firstNumber(obj, keys) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (v === null || v === undefined || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function looksLikeLabourRow(o) {
  return o && typeof o === "object" && !Array.isArray(o) &&
    (firstNumber(o, HOUR_KEYS) !== null || firstNumber(o, COST_KEYS) !== null);
}

function collectRows(d, depth) {
  depth = depth || 0;
  if (depth > 6 || d === null || typeof d !== "object") return [];
  if (looksLikeLabourRow(d)) return [d];
  const out = [];
  const values = Array.isArray(d) ? d : Object.values(d);
  for (const v of values) out.push(...collectRows(v, depth + 1));
  return out;
}

/* ── THE REAL SHAPE, NOW THAT IT HAS BEEN SEEN ────────────────────
   A probe run against the live endpoint returned:

     data: { companyId, totalHours, totalCosts,
             labourActualByDate: [ {date, hours, costs,
                                    departmentId, departmentName} ] }

   Both levels carry hours and costs, and that mattered. The tolerant
   walker stopped at `data` -- because `data` itself looks like a labour
   row -- and never descended, so each 2-day request produced ONE row
   holding the 2-day TOTAL, filed under the first date. Every other
   calendar day was missing and every present day was roughly double.
   Burnside read 103 hours on a Thursday, which is wrong in a way that
   looks entirely plausible, which is the dangerous kind.

   So the per-date array is read explicitly, departments summed per
   date, and the top-level totals used only to CHECK that sum -- never
   as a row. The tolerant walker stays as a fallback for a shape change,
   but it is no longer the primary path. */
function extractLabour(payload) {
  const data = (payload && payload.data) || payload || {};
  const byDate = data.labourActualByDate || data.labourActualsByDate || data.byDate;
  if (Array.isArray(byDate)) {
    return {
      rows: byDate,
      totals: { hours: firstNumber(data, ["totalHours"]), cost: firstNumber(data, ["totalCosts"]) },
      path: "labourActualByDate",
    };
  }
  return { rows: collectRows(payload), totals: null, path: "fallback-walk" };
}

function shapeOf(v, depth) {
  depth = depth || 0;
  if (depth > 6) return "…";
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? [`array(${v.length})`, shapeOf(v[0], depth + 1)] : "array(0)";
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).slice(0, 40)) out[k] = shapeOf(v[k], depth + 1);
    return out;
  }
  return typeof v;
}


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 35-day window across 8 companies is ~144 calls, and Push rate
// limits: the first full run lost 95 of them to 429s. Retried with
// backoff, honouring Retry-After where Push sends it. A dropped call is
// a missing labour day, and a missing labour day reads as a store that
// paid nobody.
let rateLimitHits = 0;

async function push(pathAndQuery, attempt) {
  attempt = attempt || 0;
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${PUSH_BEARER_TOKEN}`, Accept: "application/json" },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (res.status === 429 && attempt < 5) {
    rateLimitHits += 1;
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(30000, 1500 * Math.pow(2, attempt));
    console.log(`    [429] backing off ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1})`);
    await sleep(waitMs);
    return push(pathAndQuery, attempt + 1);
  }
  if (!res.ok) throw new Error(`${pathAndQuery} -> ${res.status} ${text.slice(0, 300)}`);
  // Push answers HTTP 200 with {"status":"failed"} for an entitlement
  // problem. Treating 200 as success is how the earlier attempt looked
  // like it worked -- the same trap Givex sets with its result codes.
  if (body && body.status === "failed") {
    const err = new Error(`${pathAndQuery} -> 200 but status=failed: ${body.message || "(no message)"}`);
    err.pushFailure = body.message || "failed";
    throw err;
  }
  return body;
}

// The labour endpoints cap a range at two days, so a month is a lot of
// small calls. Chunked, sequential, and paced -- hammering a payroll
// API is a good way to lose the entitlement we are waiting on.
function twoDayChunks(start, end) {
  const out = [];
  let cur = new Date(start);
  while (cur <= end) {
    const chunkEnd = new Date(Math.min(end.getTime(), cur.getTime() + 1 * 86400000));
    out.push([iso(cur), iso(chunkEnd)]);
    cur = new Date(chunkEnd.getTime() + 86400000);
  }
  return out;
}

async function main() {
  if (!PUSH_BEARER_TOKEN) throw new Error("Missing required environment variable: PUSH_BEARER_TOKEN");

  const end = new Date();
  const start = new Date(end.getTime() - DAYS * 86400000);
  const chunks = twoDayChunks(start, end);

  // Prove the token works before concluding anything about the labour
  // endpoint. If /companies also fails it is a credential problem; if
  // only labour-actuals fails it is the entitlement.
  let companies = null;
  let companiesError = null;
  let companiesSeen = [];
  let unmappedCompanies = [];
  try {
    companies = await push(`/companies?include=organization,location`);
    const rows = Array.isArray(companies) ? companies : (companies?.data || []);
    console.log(`Token authenticates. /companies returned ${rows.length} company record(s).`);
    // Record every company the token can see, and which of them this
    // script has no home for. Push adds locations to the token over
    // time -- Charlottetown is being added now -- and the id is not
    // knowable until it appears. Reporting it means the next run tells
    // us the id instead of the location staying silently absent, and
    // means no name has to be guessed at.
    companiesSeen = rows.map((r) => ({ id: r.id ?? r.companyId ?? null, name: r.name ?? r.companyName ?? "" }));
    const accountedFor = new Set(
      [...Object.keys(COMPANIES), ...Object.keys(OVERHEAD), ...Object.keys(FRANCHISEE)].map(String)
    );
    unmappedCompanies = companiesSeen.filter((c) => !accountedFor.has(String(c.id)));
    if (unmappedCompanies.length) {
      console.log(
        `[i] ${unmappedCompanies.length} company/companies on this token are not in COMPANIES, OVERHEAD or FRANCHISEE: ` +
        unmappedCompanies.map((c) => `${c.id} "${c.name}"`).join(", ") +
        ". Their labour is NOT pulled until one line is added -- deliberately, because matching a payroll company to a store by name is how one store's labour lands against another."
      );
    }
  } catch (err) {
    companiesError = err.message;
    console.warn(`[!] /companies failed: ${err.message}`);
  }

  const days = {};        // "Location|Date" -> accumulator
  const errors = [];
  let anySuccess = false;
  let responseShape = null;
  let fallbackWalkUsed = 0;
  const totalsMismatches = [];

  for (const [companyId, location] of Object.entries(COMPANIES)) {
    for (const [from, to] of chunks) {
      try {
        const d = await push(
          `/analytics/summary/labour-actuals?company=${companyId}&start=${from}&end=${to}`
        );
        // Record the shape of the first response only -- one is enough
        // to write a parser against, and 126 copies of it is noise.
        if (!responseShape) responseShape = shapeOf(d);

        // Only the totals are kept: the scorecard needs a location
        // number, and per-employee payroll detail has no business in a
        // dashboard.
        //
        // A 200 is NOT success. The previous version set anySuccess
        // here, before parsing, so the file reported status "ok" with
        // zero location-days and 126 errors -- precisely the "looks
        // like it worked" failure this script exists to prevent.
        // anySuccess now means rows were actually read.
        const { rows, totals, path } = extractLabour(d);
        if (path === "fallback-walk") fallbackWalkUsed += 1;
        if (!rows.length) {
          errors.push({ company: companyId, location, from, to,
            error: "200 OK but no labour rows could be read from the response. See response_shape in this file." });
        }

        let chunkHours = 0, chunkCost = 0;
        for (const r of rows) {
          const date = String(r.date || r.day || r.businessDate || r.businessDay || r.workDate || from).slice(0, 10);
          const hours = firstNumber(r, HOUR_KEYS);
          const cost  = firstNumber(r, COST_KEYS);
          if (hours === null && cost === null) continue;   // not a labour row
          anySuccess = true;
          chunkHours += hours || 0;
          chunkCost += cost || 0;
          const key = `${location}|${date}`;
          const b = days[key] || (days[key] = { Location_Name: location, Date: date, Hours: 0, Cost: 0 });
          // Departments are summed into one location-day figure. Push
          // returns departmentId/departmentName per row; neither is
          // carried into the output, because a per-department payroll
          // breakdown is not what a scorecard is for.
          b.Hours += hours || 0;
          b.Cost += cost || 0;
        }

        // Push sends the range totals alongside the per-date rows, so
        // the sum can be checked against the source rather than trusted.
        // This is the guard that would have caught the double-count: a
        // 2-day total filed as one day still sums correctly per chunk,
        // but it is cheap insurance against the next shape change.
        if (totals && totals.hours !== null) {
          const drift = Math.abs(chunkHours - totals.hours);
          if (drift > 0.05 + Math.abs(totals.hours) * 0.001) {
            totalsMismatches.push({ company: companyId, location, from, to,
              summed_hours: Math.round(chunkHours * 100) / 100,
              push_total_hours: totals.hours });
          }
        }
      } catch (err) {
        errors.push({ company: companyId, location, from, to, error: err.message });
        // One entitlement failure means every call will fail the same
        // way. Bail out of this location rather than making 14 identical
        // requests against a payroll API.
        if (err.pushFailure) break;
      }
      // Paced, not parallel. 120ms cost 95 of 144 calls to 429s on the
      // first real run; a payroll API is not the place to find the
      // limit by hitting it.
      await sleep(PACE_MS);
    }
  }

  const permissionBlocked =
    !anySuccess && errors.some((e) => /Insufficient permissions|status=failed/i.test(e.error));

  const output = {
    generated_at: new Date().toISOString(),
    source: "push-operations",
    schema_version: 1,
    window_days: DAYS,
    // The single most important field in this file. A consumer must be
    // able to tell "labour is zero" from "we could not read labour",
    // because the first is impossible and the second is a Tuesday.
    status: permissionBlocked ? "blocked_insufficient_permissions"
          : anySuccess ? "ok"
          : "failed",
    status_detail: permissionBlocked
      ? "Push returns HTTP 200 with status=failed / 'Insufficient permissions' on /analytics/summary/labour-actuals. The token authenticates and can list companies, so this is a per-endpoint entitlement on Push's side, not a bad credential. Christian at Push enabled the department endpoint on 2026-09-03, so if this is showing again the entitlement has been lost or the token has been rotated -- go back to Christian rather than changing this code."
      : anySuccess ? null
      : "The labour endpoint answered but no hours or cost could be read out of the response. This is a parsing problem at our end, not a permission one — read response_shape in this file and narrow collectRows() to the real path.",
    companies_endpoint_error: companiesError,
    // Structure of the first labour response: keys, types, array
    // lengths. No hours, no dollars, no names. This is how the parser
    // gets narrowed from "walk the payload" to the real path.
    response_shape: responseShape,
    // Sum-vs-Push's-own-total checks. Non-empty means the per-date rows
    // do not add up to the range total Push reports, which is a parsing
    // problem and not a rounding one.
    totals_mismatches: totalsMismatches.slice(0, 20),
    totals_mismatch_count: totalsMismatches.length,
    // Non-zero means the documented per-date array was absent and the
    // tolerant walker was used instead -- worth knowing before trusting
    // the numbers.
    fallback_walk_used: fallbackWalkUsed,
    rate_limit_retries: rateLimitHits,
    companies_seen: companiesSeen,
    // Companies on the token with no home in this script. Not pulled,
    // and not guessed at by name.
    unmapped_companies: unmappedCompanies,
    days: Object.values(days).sort((a, b) =>
      a.Location_Name.localeCompare(b.Location_Name) || a.Date.localeCompare(b.Date)),
    mapped_locations: COMPANIES,
    overhead_companies: OVERHEAD,
    franchisee_companies_not_pulled: FRANCHISEE,
    known_gaps: KNOWN_GAPS,
    errors: errors.slice(0, 50),
    error_count: errors.length,
  };

  await mkdir("data", { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 1) + "\n", "utf8");
  console.log(`Wrote ${OUTPUT_PATH}: status=${output.status}, ${output.days.length} location-day(s), ${errors.length} error(s).`);

  if (permissionBlocked) {
    console.warn("\n" + output.status_detail);
    // Deliberately exit 0. The file is written and correct -- it
    // truthfully records that labour is unavailable. Failing the
    // workflow every day for a known external blocker just trains
    // everyone to ignore a red X.
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
