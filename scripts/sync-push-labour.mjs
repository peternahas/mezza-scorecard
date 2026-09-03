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

const { PUSH_BEARER_TOKEN, PUSH_DAYS } = process.env;
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
};
// Real Push companies that are not stores. Kept visible rather than
// dropped: overhead labour is a real cost, it just does not belong in
// a per-store labour percentage.
const OVERHEAD = { 25560: "Corporate", 25555: "Production Centre" };
// Franchisee locations on this token. Not pulled by default -- see above.
const FRANCHISEE = { 29923: "Mount Pearl" };

const KNOWN_GAPS = [
  {
    location: "Charlottetown",
    reason:
      "Not on this token yet. Christian at Push offered to add it on 2026-09-03 once Mezza confirms the site is '690 University Ave' -- which it is (690 University Ave Unit 2, Charlottetown PE, opened Aug 2025). Once he does, it appears in /companies and this run reports its id under unmapped_companies; add one line to COMPANIES and it flows. Listed as a gap rather than silently absent, because a missing location in a labour report reads as a store with no labour cost.",
  },
];

function iso(d) { return d.toISOString().slice(0, 10); }

async function push(pathAndQuery) {
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${PUSH_BEARER_TOKEN}`, Accept: "application/json" },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
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

  for (const [companyId, location] of Object.entries(COMPANIES)) {
    for (const [from, to] of chunks) {
      try {
        const d = await push(
          `/analytics/summary/labour-actuals?company=${companyId}&start=${from}&end=${to}`
        );
        anySuccess = true;
        // The response shape carries totalHours/totalCosts plus a
        // per-department breakdown. Only the totals are kept: the
        // scorecard needs a location number, and per-employee payroll
        // detail has no business in a dashboard.
        const rows = Array.isArray(d) ? d : (d.data || d.results || [d]);
        for (const r of rows) {
          const date = r.date || r.day || r.businessDate || from;
          const key = `${location}|${date}`;
          const b = days[key] || (days[key] = { Location_Name: location, Date: date, Hours: 0, Cost: 0 });
          b.Hours += Number(r.totalHours ?? r.hours ?? 0);
          b.Cost += Number(r.totalCosts ?? r.cost ?? 0);
        }
      } catch (err) {
        errors.push({ company: companyId, location, from, to, error: err.message });
        // One entitlement failure means every call will fail the same
        // way. Bail out of this location rather than making 14 identical
        // requests against a payroll API.
        if (err.pushFailure) break;
      }
      await new Promise((r) => setTimeout(r, 120));
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
      : anySuccess ? null : "No labour rows returned and no permission error either — check the errors array.",
    companies_endpoint_error: companiesError,
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
