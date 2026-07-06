#!/usr/bin/env node
/**
 * Pulls the four Mezza Scorecard tabs out of the Excel workbook via Microsoft Graph
 * and writes them to data/scorecard-data.json in this repo. Runs on a schedule via
 * the GitHub Action in .github/workflows/sync-scorecard-data.yml.
 *
 * Required environment variables (set as GitHub Actions repo secrets):
 *   AZURE_TENANT_ID   - Azure AD (Entra ID) tenant ID
 *   AZURE_CLIENT_ID   - App registration (client) ID
 *   AZURE_CLIENT_SECRET - App registration client secret
 *   GRAPH_SHARE_URL   - The SharePoint "share" link to the workbook (the same
 *                        link you'd copy from SharePoint's Share button), e.g.
 *       https://mezza1.sharepoint.com/:x:/s/Scorecard/IQCw6OxuMg3EQ47mjgVw-aZnAXDsAVuq4g6VLABjqCOgNas?e=uoKAQ1
 *
 * The script resolves that share link to a driveId/itemId via Graph's /shares
 * endpoint, then reads the workbook from there. That means it keeps working
 * even if the file gets renamed, and you never have to hand-build a Graph path.
 */

import { writeFile, mkdir } from "node:fs/promises";

const { AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, GRAPH_SHARE_URL } = process.env;

const SHEETS = ["Weekly_Summary", "Store_Data", "Reviews", "GBP_Performance"];
const OUTPUT_PATH = "data/scorecard-data.json";

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// Encodes a sharing URL into the Graph "shares" token format.
// See: https://learn.microsoft.com/en-us/graph/api/shares-get#encoding-sharing-urls
function encodeShareUrl(url) {
  const base64 = Buffer.from(url, "utf8").toString("base64");
  const base64url = base64.replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  return "u!" + base64url;
}

async function getAccessToken() {
  requireEnv("AZURE_TENANT_ID", AZURE_TENANT_ID);
  requireEnv("AZURE_CLIENT_ID", AZURE_CLIENT_ID);
  requireEnv("AZURE_CLIENT_SECRET", AZURE_CLIENT_SECRET);

  const url = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: AZURE_CLIENT_ID,
    client_secret: AZURE_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.access_token;
}

// Resolves the SharePoint share link to a stable {driveId, itemId} pair via Graph.
async function resolveDriveItem(token, shareUrl) {
  const shareId = encodeShareUrl(shareUrl);
  const res = await fetch(`https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to resolve share link: ${res.status} ${await res.text()}`);
  }
  const item = await res.json();
  return { driveId: item.parentReference.driveId, itemId: item.id, name: item.name };
}

async function readSheet(token, base, sheetName) {
  const url = `https://graph.microsoft.com/v1.0${base}/workbook/worksheets('${encodeURIComponent(
    sheetName
  )}')/usedRange(valuesOnly=true)`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to read sheet "${sheetName}": ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  const [headerRow, ...rows] = json.values || [];
  if (!headerRow) return [];

  return rows
    .filter((row) => row.some((cell) => cell !== "" && cell !== null))
    .map((row) => {
      const obj = {};
      headerRow.forEach((h, i) => {
        const v = row[i];
        obj[h] = v === "" ? null : v;
      });
      return obj;
    });
}

async function main() {
  requireEnv("GRAPH_SHARE_URL", GRAPH_SHARE_URL);
  const token = await getAccessToken();

  const { driveId, itemId, name } = await resolveDriveItem(token, GRAPH_SHARE_URL);
  console.log(`Resolved share link -> "${name}" (drive ${driveId}, item ${itemId})`);
  const base = `/drives/${driveId}/items/${itemId}`;

  const data = { generated_at: new Date().toISOString(), source: "excel-graph-sync" };
  for (const sheetName of SHEETS) {
    console.log(`Reading ${sheetName}...`);
    data[sheetName] = await readSheet(token, base, sheetName);
    console.log(`  -> ${data[sheetName].length} rows`);
  }

  await mkdir("data", { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
