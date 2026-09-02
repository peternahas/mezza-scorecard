#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 * HUBSPOT → data/hubspot-data.json
 * ═══════════════════════════════════════════════════════════════════
 *
 * Franchise-lead flow, for the growth half of the scorecard. Sales
 * tells you how the 22 stores traded; this tells you whether store 23
 * is coming.
 *
 * ── WHAT IS ACTUALLY IN THE CRM ──────────────────────────────────
 *
 * Checked live, 2026-09-02: **1,374 contacts and 10 deals.** Contacts
 * are arriving steadily and are mostly lifecycle stage "lead". The
 * deals are almost all from September 2025 and were last touched in
 * July 2026.
 *
 * So HubSpot is working as a lead-capture inbox and not as a pipeline.
 * That is worth knowing before anyone builds a "franchise pipeline
 * value" chart on top of it: the number would be real and completely
 * meaningless. This script therefore reports lead FLOW, which is
 * measured honestly, and reports the deal figures alongside a plain
 * statement of how thin they are.
 *
 * Whether the pipeline actually lives somewhere else, or franchise
 * enquiries simply are not being worked in HubSpot, is a question for
 * Doug and Alana rather than something to infer from an API.
 *
 * ── WHAT IT DOES NOT PULL, AND WHY ───────────────────────────────
 *
 * Campaign and marketing-email analytics need account-level
 * permissions this token does not have (CAMPAIGN and MARKETING_EMAIL
 * both report REQUIRES_ACCOUNT_MODIFICATION). Email open and click
 * performance is therefore out of scope until someone widens the
 * private app's scopes.
 *
 * No name, email, phone or address is written to the output. Lead flow
 * is a count, and a dashboard behind a shared login is not the place
 * for a contact list.
 *
 * Required: HUBSPOT_TOKEN — a private app token with crm.objects.
 * contacts.read and crm.objects.deals.read.
 */

import { writeFile, mkdir } from "node:fs/promises";

const { HUBSPOT_TOKEN, HUBSPOT_DAYS } = process.env;
const BASE = "https://api.hubapi.com";
const OUTPUT_PATH = "data/hubspot-data.json";
const DAYS = Number.parseInt(HUBSPOT_DAYS || "180", 10);

async function hs(path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 5) throw new Error(`${path} -> ${res.status} after ${attempt} retries`);
      await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt)));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
}

// HubSpot's search endpoint pages 100 at a time and caps a paged
// search at 10,000 records. Lead volume is nowhere near that, but the
// loop is bounded anyway rather than trusting it to stay that way.
async function searchAll(objectType, since, properties) {
  const out = [];
  let after;
  for (let page = 0; page < 60; page++) {
    const body = {
      filterGroups: [{ filters: [{ propertyName: "createdate", operator: "GTE", value: String(since) }] }],
      properties,
      limit: 100,
      sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
      ...(after ? { after } : {}),
    };
    const d = await hs(`/crm/v3/objects/${objectType}/search`, body);
    out.push(...(d.results || []));
    after = d.paging?.next?.after;
    if (!after) break;
  }
  return out;
}

function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }
function isoWeekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

async function main() {
  if (!HUBSPOT_TOKEN) throw new Error("Missing required environment variable: HUBSPOT_TOKEN");

  const since = Date.now() - DAYS * 86400000;

  const contacts = await searchAll("contacts", since, [
    "createdate", "lifecyclestage", "hs_lead_status", "hs_analytics_source",
  ]);
  console.log(`${contacts.length} contact(s) created in the last ${DAYS} days.`);

  let deals = [];
  let dealsError = null;
  try {
    deals = await searchAll("deals", since, [
      "createdate", "closedate", "dealstage", "pipeline", "amount", "dealtype",
    ]);
  } catch (err) {
    dealsError = err.message;
    console.warn(`[!] deals search failed: ${err.message}`);
  }
  console.log(`${deals.length} deal(s) created in the last ${DAYS} days.`);

  // Lead flow, by day and by week. No identifying detail: this is a
  // count of enquiries, not a contact list, and the dashboard sits
  // behind a shared login.
  const byDay = {}, byWeek = {}, byStage = {}, bySource = {}, byStatus = {};
  for (const c of contacts) {
    const created = c.properties?.createdate;
    if (!created) continue;
    const date = isoDate(new Date(created).getTime());
    byDay[date] = (byDay[date] || 0) + 1;
    const wk = isoWeekStart(date);
    byWeek[wk] = (byWeek[wk] || 0) + 1;
    const stage = c.properties?.lifecyclestage || "(none)";
    byStage[stage] = (byStage[stage] || 0) + 1;
    const src = c.properties?.hs_analytics_source || "(unknown)";
    bySource[src] = (bySource[src] || 0) + 1;
    const st = c.properties?.hs_lead_status || "(none)";
    byStatus[st] = (byStatus[st] || 0) + 1;
  }

  const dealStages = {};
  let dealValue = 0;
  for (const d of deals) {
    const st = d.properties?.dealstage || "(none)";
    dealStages[st] = (dealStages[st] || 0) + 1;
    dealValue += Number(d.properties?.amount || 0);
  }

  const weeks = Object.keys(byWeek).sort();
  const last4 = weeks.slice(-4).reduce((s, w) => s + byWeek[w], 0);
  const prev4 = weeks.slice(-8, -4).reduce((s, w) => s + byWeek[w], 0);

  const output = {
    generated_at: new Date().toISOString(),
    source: "hubspot",
    schema_version: 1,
    window_days: DAYS,
    contacts_total: contacts.length,
    deals_total: deals.length,
    deals_value: Math.round(dealValue * 100) / 100,
    deals_error: dealsError,
    // Stated in the data, so nobody builds a pipeline chart on ten
    // stale records without being told.
    pipeline_caveat:
      deals.length < 25
        ? `Only ${deals.length} deal(s) exist in this window against ${contacts.length} contacts. HubSpot is being used as a lead-capture inbox rather than a pipeline, so deal counts and values here are not a measure of franchise pipeline health. Lead flow below is measured honestly; the deal figures are not.`
        : null,
    leads_by_day: byDay,
    leads_by_week: byWeek,
    leads_last_4_weeks: last4,
    leads_prior_4_weeks: prev4,
    leads_trend_pct: prev4 ? Math.round(((last4 - prev4) / prev4) * 1000) / 10 : null,
    leads_by_lifecycle_stage: byStage,
    leads_by_source: bySource,
    leads_by_status: byStatus,
    deals_by_stage: dealStages,
    not_pulled: {
      campaigns:
        "CAMPAIGN and MARKETING_EMAIL both report REQUIRES_ACCOUNT_MODIFICATION on this token, so email and campaign performance is out of scope until the private app's scopes are widened.",
      contact_detail:
        "No name, email, phone or address is written here on purpose. Lead flow is a count; a dashboard behind a shared login is not the place for a contact list.",
    },
  };

  await mkdir("data", { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 1) + "\n", "utf8");
  console.log(
    `Wrote ${OUTPUT_PATH}: ${contacts.length} leads, ${weeks.length} weeks, ` +
    `last 4 weeks ${last4} vs prior 4 ${prev4}.`
  );
}

main().catch((err) => { console.error(err); process.exit(1); });
