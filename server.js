const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const PLANIT_FIELDS = ["name","uid","altid","area_name","area_id","start_date","address","description","location","link","last_scraped"];

function acresToHa(acres){ return acres * 0.404686; }
function sqmToHa(sqm){ return sqm / 10000; }

function parseCsvRows(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (ch !== "\r") field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v || "").trim().length > 0));
}

function rowsToObjects(rows) {
  const first = rows[0] || [];
  const looksLikeHeader = first.some(v => PLANIT_FIELDS.includes(String(v || "").trim()));
  if (looksLikeHeader) {
    const headers = first.map(v => String(v || "").trim());
    return rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] || ""])));
  }
  return rows.map(r => Object.fromEntries(PLANIT_FIELDS.map((h, i) => [h, r[i] || ""])));
}

function tokenize(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9\s/,-]/g, " ").split(/\s+/).filter(Boolean);
}

function scoreMatch(query, row) {
  const q = tokenize(query);
  const hay = `${row.address || ""} ${row.description || ""} ${row.uid || ""} ${row.altid || ""}`.toLowerCase();
  let score = 0;
  q.forEach(token => { if (hay.includes(token)) score += 1; });
  if ((row.area_name || "").toLowerCase() === "southwark") score += 2;
  return score;
}

function buildAssessment(input) {
  const areaHa =
    input.siteAreaUnit === "ha" ? Number(input.siteAreaValue || 0) :
    input.siteAreaUnit === "acres" ? acresToHa(Number(input.siteAreaValue || 0)) :
    sqmToHa(Number(input.siteAreaValue || 0));

  let lowDensity = 180, highDensity = 320, minHeight = 3, maxHeight = 5, buildCostPerSqm = 3000, gdvPerSqm = 8500;
  if (input.context === "town") { lowDensity = 240; highDensity = 420; minHeight = 4; maxHeight = 7; buildCostPerSqm = 3200; }
  if (input.context === "suburban") { lowDensity = 80; highDensity = 170; minHeight = 2; maxHeight = 4; }
  if (input.context === "growth") { lowDensity = 320; highDensity = 600; minHeight = 6; maxHeight = 12; buildCostPerSqm = 3400; }

  if (input.ptal === "high") { lowDensity *= 1.1; highDensity *= 1.1; maxHeight += 1; }
  if (input.ptal === "very-high") { lowDensity *= 1.18; highDensity *= 1.18; maxHeight += 1; }
  if (input.ptal === "low") { lowDensity *= 0.9; highDensity *= 0.9; }
  if (input.existingUse === "community" || input.communityUse) { lowDensity *= 0.92; highDensity *= 0.92; }
  if (input.existingUse === "industrial" || input.protectedEmployment) { lowDensity *= 0.9; highDensity *= 0.9; }
  if (input.heritage) { lowDensity *= 0.88; highDensity *= 0.88; maxHeight -= 1; }
  if (input.floodRisk) { lowDensity *= 0.95; highDensity *= 0.95; }
  if (input.tallBuildingZone) { highDensity *= 1.15; maxHeight += 3; }

  lowDensity = Math.round(lowDensity);
  highDensity = Math.round(highDensity);
  minHeight = Math.max(2, minHeight);
  maxHeight = Math.max(minHeight, maxHeight);

  const sweetSpotDensity = Math.round((lowDensity + highDensity) / 2);
  const lowHomes = Math.max(1, Math.floor(areaHa * lowDensity));
  const highHomes = Math.max(lowHomes, Math.floor(areaHa * highDensity));
  const targetHomes = Math.max(lowHomes, Math.round(areaHa * sweetSpotDensity));
  const parkingRatio = input.ptal === "very-high" ? 0 : input.ptal === "high" ? 0.1 : input.ptal === "medium" ? 0.35 : 0.75;
  const maxParking = Math.round(targetHomes * parkingRatio);
  const disabledBays = targetHomes >= 10 ? Math.max(1, Math.ceil(maxParking * 0.1)) : (maxParking > 0 ? 1 : 0);
  const privateAmenity = targetHomes * 5;
  const communalAmenity = targetHomes * 7;

  const avgUnitSize = input.context === "town" ? 62 : (input.existingUse === "community" || input.communityUse) ? 68 : 70;
  const saleableArea = Math.round(targetHomes * avgUnitSize);
  const grossArea = Math.round(saleableArea / 0.8);
  const buildCost = grossArea * buildCostPerSqm;
  const externalWorks = buildCost * 0.08;
  const fees = buildCost * 0.12;
  const contingency = buildCost * 0.05;
  const finance = (buildCost + externalWorks + fees) * 0.07;
  const marketing = (saleableArea * gdvPerSqm) * 0.03;
  const communityAllowance = (input.existingUse === "community" || input.communityUse) ? 1250000 : 0;
  const totalCost = buildCost + externalWorks + fees + contingency + finance + marketing + communityAllowance;
  const gdv = saleableArea * gdvPerSqm;
  const profit = gdv * 0.18;
  const rlv = gdv - totalCost - profit;

  return {
    areaHa, lowDensity, highDensity, sweetSpotDensity, lowHomes, highHomes, targetHomes,
    minHeight, maxHeight, maxParking, disabledBays, privateAmenity, communalAmenity,
    saleableArea, gdv, buildCost, rlv,
    headline: `A Southwark-focused first option to test is around ${minHeight}-${maxHeight} storeys at roughly ${sweetSpotDensity} units/ha, suggesting about ${targetHomes} homes.`,
    appraisalNote: "First-pass appraisal only. Excludes CIL, S106, abnormal costs, acquisition fees, tax, and affordable housing transfer adjustments."
  };
}

function analyseCommittee(data) {
  const text = `${data.das || ""} ${data.decision || ""} ${data.minutes || ""}`.toLowerCase();
  const themes = [];
  const add = (cond, label) => { if (cond) themes.push(label); };
  add(/height|scale|massing|bulk|overdevelopment/.test(text), "Height / scale");
  add(/overlooking|privacy|daylight|sunlight|overshadow/.test(text), "Neighbour impact");
  add(/parking|traffic|access|servicing|highway/.test(text), "Parking / highways");
  add(/community|reprovision|hall|chaplaincy/.test(text), "Community use");
  add(/heritage|conservation|listed/.test(text), "Heritage");
  add(/design|character|townscape|materials/.test(text), "Design / townscape");
  add(/affordable|tenure|social rent|intermediate/.test(text), "Affordable housing");
  add(/amenity space|play space|private amenity|communal amenity/.test(text), "Amenity / play");

  let decisionRoute = "Unclear";
  if (/approved|grant planning permission|resolved to grant/.test(text)) decisionRoute = "Approved / granted";
  if (/refused|refuse planning permission|resolved to refuse/.test(text)) decisionRoute = "Refused";
  if (/defer|deferred/.test(text)) decisionRoute = "Deferred";

  const site = data.site || {};
  const relevance = [];
  const moves = [];
  if (themes.includes("Height / scale")) { relevance.push(`The comparable raised scale issues. Your live site currently tests at ${site.minHeight || "?"}-${site.maxHeight || "?"} storeys.`); moves.push("Test a stepped option and a reduced-height fallback."); }
  if (themes.includes("Neighbour impact")) { relevance.push("Neighbour impact was important, so overlooking and daylight will matter for your site."); moves.push("Prepare stronger privacy and daylight responses."); }
  if (themes.includes("Parking / highways")) { relevance.push(`Parking or highways mattered in the comparable. Your live site currently allows up to ${site.maxParking || "?"} spaces.`); moves.push("Lead with PTAL, cycle storage, access, and servicing strategy."); }
  if (themes.includes("Community use")) { relevance.push("Community-use issues appeared in the comparable, which matters if your scheme replaces or reshapes any social/community use."); moves.push("Consider reprovision or a stronger justification for any loss."); }
  if (themes.includes("Design / townscape")) { relevance.push("Design quality and local character appear material, so presentation will matter as much as density."); moves.push("Anchor the first option around a contextual design story, not just unit count."); }
  if (!relevance.length) { relevance.push("No strong themes were detected yet. Paste fuller extracts from the DAS, notice, or minutes."); moves.push("Add officer recommendation wording and decision wording."); }
  return { themes, decisionRoute, relevance, moves, youtubeUrl: data.youtubeUrl || "" };
}

app.get("/api/health", (req, res) => res.json({ ok: true }));
app.post("/api/assessment", (req, res) => res.json(buildAssessment(req.body || {})));
app.post("/api/committee-analyse", (req, res) => res.json(analyseCommittee(req.body || {})));

app.get("/api/planit-search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    const recent = String(req.query.recent || "3650");
    const params = new URLSearchParams({
      compress: "off",
      max_recs: "1500",
      pg_sz: "1500",
      recent,
      select: PLANIT_FIELDS.join(","),
      sort: "start_date.desc.nullslast,last_scraped.desc.nullslast"
    });
    const url = `https://www.planit.org.uk/api/applics/csv?${params.toString()}`;
    const response = await fetch(url, { headers: { "user-agent": "southwark-decision-engine-v2/2.0" } });
    if (!response.ok) return res.status(502).json({ error: `PlanIt fetch failed with ${response.status}`, items: [] });

    const csv = await response.text();
    const rows = parseCsvRows(csv);
    const objects = rowsToObjects(rows);
    const items = objects
      .filter(row => String(row.area_name || "").toLowerCase() === "southwark")
      .map(row => ({ ...row, score: scoreMatch(query, row) }))
      .filter(row => query ? row.score > 0 : true)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(row => ({
        uid: row.uid, altid: row.altid, address: row.address, description: row.description,
        start_date: row.start_date, area_name: row.area_name, link: row.link, score: row.score
      }));

    res.json({ source: "UK PlanIt API", query, count: items.length, items });
  } catch (error) {
    res.status(500).json({ error: String(error), items: [] });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
