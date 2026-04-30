/**
 * Latvian Bar Association annex HTML generators — P3.1, P3.2, P2.
 *
 * Sourced against advokatura.lv templates (Instrukcija NILLTPFN-SL):
 *   P3.1 — 2022-02 "Sankciju izpētes veidlapa (fiziska persona)"
 *   P3.2 — 2022-02 "Sankciju izpētes veidlapa (juridiska persona)"
 *   P2   — 2025-02-11 "Klienta risku novērtējuma veidlapa"
 *
 * Every form is labelled SAGATAVE — the advocate must review, complete, and
 * (for P3.x) collect the client's signature before filing. Client-signed
 * blocks stay blank. Pre-filled rows are highlighted so the reviewer can
 * audit at a glance what Klirs asserted vs. what still needs manual work.
 *
 * Layout strategy (2026-04-24): field-blocks are rendered as HTML tables
 * (`field-table`) rather than flex divs. Tables are the one layout primitive
 * html-to-docx preserves faithfully, so the DOCX export reproduces the
 * label/value column structure instead of collapsing everything to a
 * linear stack of paragraphs.
 */

import type { Screening, ScreeningCheck } from "@/lib/types";
import type { RiskResult, RiskLevel } from "@/lib/risk-score";
import {
  escapeHtml,
  lvDate,
  coverHtml,
  sharedStyles,
  signatureBlockHtml,
  footerChainHtml,
} from "./shared";

export interface AnnexBuildContext {
  screening: Screening;
  checks: ScreeningCheck[];
  risk: RiskResult;
  reviewer: string; // "Atbildīgā persona" / signer name
}

interface FieldRow {
  label: string;                        // HTML allowed (muted sub-labels)
  value: string;                        // HTML allowed (inline emphasis / muted)
  tint?: "prefilled" | "empty";         // yellow tint or italic grey
}

// Section-title bar rendered as a single-cell table so html-to-docx
// honors the grey background via <w:shd>.
function renderSectionTitle(title: string): string {
  return `
    <table class="section-title" style="width: 100%; border-collapse: collapse; margin: 10pt 0 0 0;">
      <tbody>
        <tr>
          <td style="background-color: #e2e8f0; padding: 5pt 8pt; font-weight: 700; font-size: 10pt; letter-spacing: 0.3pt;">${escapeHtml(title)}</td>
        </tr>
      </tbody>
    </table>
  `;
}

// Declaration-box rendered as a single-cell table with bordered grey bg.
// `html` is inline content (may contain <br/>, <strong>, etc.).
function renderDeclaration(html: string): string {
  return `
    <table class="declaration" style="width: 100%; border-collapse: collapse; margin: 10pt 0;">
      <tbody>
        <tr>
          <td style="background-color: #f8fafc; border: 1pt solid #0f172a; padding: 8pt 10pt; font-size: 9.5pt; line-height: 1.5; color: #0f172a;">${html}</td>
        </tr>
      </tbody>
    </table>
  `;
}

// Base inline styles for td cells. html-to-docx reads inline style
// only (NOT CSS classes) for background-color + width, so we inline
// them here. PDF still inherits .field-table class-based styling for
// consistency; inline overrides are a no-op in the browser render.
const LABEL_TD_STYLE =
  "width: 140pt; background-color: #f1f5f9; padding: 5pt 8pt; vertical-align: top; color: #334155; font-weight: 600; font-size: 9.5pt; border: 1pt solid #cbd5e1;";
const VAL_BASE_STYLE =
  "padding: 5pt 8pt; vertical-align: top; color: #0f172a; font-size: 9.5pt; border: 1pt solid #cbd5e1;";
const VAL_PREFILLED_EXTRA = " background-color: #fef9c3;";
const VAL_EMPTY_EXTRA = " color: #94a3b8; font-style: italic;";

function renderFieldTable(rows: FieldRow[]): string {
  return `
    <table class="field-table" style="width: 100%; border-collapse: collapse; margin: 0 0 2pt 0;">
      <tbody>
        ${rows.map(r => {
          const valStyle = VAL_BASE_STYLE +
            (r.tint === "prefilled" ? VAL_PREFILLED_EXTRA : "") +
            (r.tint === "empty" ? VAL_EMPTY_EXTRA : "");
          return `
            <tr>
              <td class="label" style="${LABEL_TD_STYLE}">${r.label}</td>
              <td class="val${r.tint ? " " + r.tint : ""}" style="${valStyle}">${r.value}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

// EU/EEA ISO codes — for the single-line 2.2 jurisdiction auto-check.
// Intentionally narrow: the lawyer owns the final call; we just surface a hint.
const EU_EEA_CODES = new Set([
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE",
  "IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE",
  "IS","LI","NO",
]);

function looksLikeLvCountryForEu(jurisdiction: string): boolean {
  if (!jurisdiction) return false;
  const j = jurisdiction.trim().toUpperCase();
  if (j.length === 2 && EU_EEA_CODES.has(j)) return true;
  // Permissive: common LV/EN names → treat as LV/EE → EU.
  const map: Record<string, string> = {
    "LATVIJA": "LV", "LATVIA": "LV",
    "IGAUNIJA": "EE", "ESTONIA": "EE",
    "LIETUVA": "LT", "LITHUANIA": "LT",
    "POLIJA": "PL", "POLAND": "PL",
    "VĀCIJA": "DE", "GERMANY": "DE",
    "FRANCIJA": "FR", "FRANCE": "FR",
  };
  const matched = map[j];
  return matched ? EU_EEA_CODES.has(matched) : false;
}

function sanctionsHasHit(checks: ScreeningCheck[]): boolean {
  return checks.some(c => c.category === "sanctions" && c.status === "hit");
}

function sanctionsHasUncertain(checks: ScreeningCheck[]): boolean {
  return checks.some(c => c.category === "sanctions" && c.status === "uncertain");
}

function pepHasHit(checks: ScreeningCheck[]): boolean {
  return checks.some(c => c.category === "pep" && c.status === "hit");
}

function pepHasUncertain(checks: ScreeningCheck[]): boolean {
  return checks.some(c => c.category === "pep" && c.status === "uncertain");
}

function sanctionsHitSources(checks: ScreeningCheck[]): string[] {
  return [...new Set(
    checks.filter(c => c.category === "sanctions" && c.status === "hit")
      .map(c => c.database_name)
  )];
}

function pepHitSources(checks: ScreeningCheck[]): string[] {
  return [...new Set(
    checks.filter(c => c.category === "pep" && c.status === "hit")
      .map(c => c.database_name)
  )];
}

function riskLevelLv(level: RiskLevel): { lv: string; comment: string } {
  switch (level) {
    case "REJECT":
      return { lv: "augsts (atteikums)", comment: "Sankciju sakritība konstatēta — iesaka nesākt darījumu attiecības." };
    case "HIGH":
      return { lv: "augsts", comment: "Konstatētas aizdomīgas vai neskaidras pazīmes — nepieciešama padziļināta izpēte." };
    case "MEDIUM":
      return { lv: "vidējs", comment: "Daži nenoteikti rezultāti — nepieciešama manuāla rezultātu pārbaude." };
    case "LOW-MEDIUM":
      return { lv: "zems-vidējs", comment: "Nelabvēlīgā mediju izpētē atrasti nenoteikti rezultāti — nepieciešama papildu pārbaude." };
    case "LOW":
    default:
      return { lv: "zems", comment: "Visas sankciju un PEP pārbaudes atgriezušas apstiprinātu 'nav sakritību' rezultātu." };
  }
}

function kopsavilkumsText(ctx: AnnexBuildContext): string {
  const { screening, checks, risk } = ctx;
  const total = checks.length;
  const hit = checks.filter(c => c.status === "hit").length;
  const unc = checks.filter(c => c.status === "uncertain").length;
  const clear = checks.filter(c => c.status === "clear").length;
  const err = checks.filter(c => c.status === "error").length;
  const databases = new Set(checks.map(c => c.database_name));

  const parts: string[] = [];
  parts.push(`AML skrīnings: ${total} pārbaudes ${databases.size} datubāzēs.`);
  parts.push(`Rezultāti: ${clear} apstiprināti 'nav sakritību', ${hit} sakritība(-es), ${unc} pārbaudei, ${err} kļūda(-as).`);
  const rl = riskLevelLv(risk.level);
  parts.push(`Aprēķinātais riska līmenis: ${rl.lv} (skrīnings punktu skala: ${risk.score}).`);
  if (risk.incomplete) {
    parts.push("Uzmanību: skrīnings nepabeigts — daļa datubāzu neatbildēja.");
  }
  parts.push(`Pierādījumu ķēde (ekrānuzņēmumi + avotu URL) pievienota skrīninga pilnajam PDF eksportam (ID: ${screening.id.slice(0, 8)}).`);
  return parts.join(" ");
}

// =====================================================================
// P3.1 — Sankciju izpētes veidlapa (fiziska persona)
// =====================================================================
export function buildAnnexP31Html(ctx: AnnexBuildContext): string {
  const { screening, reviewer } = ctx;
  const generatedAt = new Date().toISOString();
  const primaryName = screening.entity_name;

  const clientRows: FieldRow[] = [
    { label: "Vārds, uzvārds", value: escapeHtml(primaryName), tint: "prefilled" },
    { label: `Latvijas Republikas personas kods <span class="muted small">(ja ir)</span>`, value: "[aizpilda advokāts]", tint: "empty" },
    { label: "Dzimšanas datums", value: "[aizpilda advokāts]", tint: "empty" },
    {
      label: "Pilsonība / rezidences valsts",
      value: screening.jurisdiction ? escapeHtml(screening.jurisdiction) : "[aizpilda advokāts]",
      tint: screening.jurisdiction ? "prefilled" : "empty",
    },
    { label: "Pases / personas apliecības numurs", value: "[aizpilda advokāts]", tint: "empty" },
    { label: "Izdošanas datums", value: "[aizpilda advokāts]", tint: "empty" },
    { label: "Izdevējiestāde, izdevējvalsts", value: "[aizpilda advokāts]", tint: "empty" },
  ];

  const uboRows: FieldRow[] = [
    { label: "Patiesais labuma guvējs ir", value: `☒ Klients &nbsp;&nbsp; ☐ Cita persona <span class="muted small">(ja cita — aizpilda advokāts zemāk)</span>` },
    { label: "Vārds, uzvārds", value: escapeHtml(primaryName), tint: "prefilled" },
    { label: "Personas kods / Dzimšanas datums", value: "[aizpilda advokāts]", tint: "empty" },
    { label: "Valstspiederība", value: "[aizpilda advokāts]", tint: "empty" },
    {
      label: "Pastāvīgās dzīvesvietas valsts",
      value: screening.jurisdiction ? escapeHtml(screening.jurisdiction) : "[aizpilda advokāts]",
      tint: screening.jurisdiction ? "prefilled" : "empty",
    },
    { label: "Kontroles pamatojums", value: "Fiziska persona — klients pats ir PLG." },
    { label: `Publiski pieejama vietne <span class="muted small">(ja ir)</span>`, value: "[aizpilda advokāts]", tint: "empty" },
  ];

  return `<!DOCTYPE html>
<html lang="lv">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(primaryName)} — Pielikums Nr. 3.1 (SAGATAVE)</title>
  <style>${sharedStyles()}</style>
</head>
<body>
  ${coverHtml({
    annexCode: "Pielikums Nr. 3.1",
    annexTitleLv: "Sankciju izpētes veidlapa (fiziska persona)",
    annexTitleEn: "Sanctions research form (natural person)",
    screeningId: screening.id,
    entityName: primaryName,
    generatedAt,
    isDemo: screening.is_demo,
  })}

  ${renderSectionTitle("ZIŅAS PAR KLIENTU")}
  ${renderFieldTable(clientRows)}

  ${renderSectionTitle("ZIŅAS PAR KLIENTA PATIESO LABUMA GUVĒJU")}
  <p class="small muted" style="margin: 4pt 0;">Aizpilda attiecībā uz visiem patiesajiem labuma guvējiem. Fiziskai personai parasti pati persona ir savs patiesais labuma guvējs (☒ Klients).</p>
  ${renderFieldTable(uboRows)}

  ${renderDeclaration(`
    Parakstot šo anketu, klients apliecina, ka ne klients, ne klienta patiesais labuma guvējs (ja tāds ir) nav Apvienoto Nāciju Organizācijas, Eiropas Savienības, citas starptautiskas organizācijas, kuras dalībvalsts ir Latvija, Latvijas Republikas, Eiropas Savienības un Ziemeļatlantijas līguma organizācijas dalībvalsts noteikto sankciju subjekti.
    <br/><br/>
    Klients apliecina, ka ir tiesīgs parakstīt šo dokumentu.
    <br/><br/>
    Klients apliecina, ka visa šajā veidlapā sniegtā informācija ir pilnīga un patiesa. Klients apņemas nekavējoties, bet ne vēlāk kā 5 (piecu) dienu laikā no izmaiņu rašanās brīža, paziņot advokātam par jebkurām šajā veidlapā minēto datu izmaiņām.
  `)}

  ${signatureBlockHtml("")}

  <p class="small muted" style="margin-top: 14pt;">
    Advokāts (izpētes veicējs): <strong>${escapeHtml(reviewer || "[vārds, uzvārds]")}</strong>
  </p>

  ${footerChainHtml({ screeningId: screening.id, generatedAt })}
</body>
</html>`;
}

// =====================================================================
// P3.2 — Sankciju izpētes veidlapa (juridiska persona)
// =====================================================================
export function buildAnnexP32Html(ctx: AnnexBuildContext): string {
  const { screening, reviewer } = ctx;
  const generatedAt = new Date().toISOString();
  const primaryName = screening.entity_name;
  const regNo = screening.registration_number || "";
  const juridiskaForma = guessEntityForm(primaryName);

  const clientRows: FieldRow[] = [
    { label: "Nosaukums", value: escapeHtml(primaryName), tint: "prefilled" },
    {
      label: "Juridiskā forma",
      value: juridiskaForma
        ? `☒ ${escapeHtml(juridiskaForma)} &nbsp; ☐ cita`
        : "☐ SIA &nbsp; ☐ AS &nbsp; ☐ biedrība &nbsp; ☐ iestāde &nbsp; ☐ cita",
      tint: juridiskaForma ? "prefilled" : undefined,
    },
    {
      label: "Reģistrācijas Nr.",
      value: regNo ? escapeHtml(regNo) : "[aizpilda advokāts]",
      tint: regNo ? "prefilled" : "empty",
    },
    { label: "PVN Nr.", value: "[aizpilda advokāts]", tint: "empty" },
    { label: "Juridiskā adrese", value: "[aizpilda advokāts — skat. UR datubāzes rezultātu]", tint: "empty" },
    { label: `Faktiskā adrese <span class="muted small">(ja atšķiras)</span>`, value: "[aizpilda advokāts]", tint: "empty" },
    {
      label: "Rezidences valsts",
      value: screening.jurisdiction ? escapeHtml(screening.jurisdiction) : "[aizpilda advokāts]",
      tint: screening.jurisdiction ? "prefilled" : "empty",
    },
  ];

  const authorisedRows: FieldRow[] = [
    { label: "Vārds, uzvārds", value: "[aizpilda advokāts]", tint: "empty" },
    {
      label: "Pilnvarojuma pamats",
      value: `☐ valdes loceklis &nbsp; ☐ prokūrists &nbsp; ☐ iestādes vadītājs &nbsp; ☐ cits <span class="muted small">(norādīt)</span>`,
    },
    { label: "Personas kods / Dzimšanas datums", value: "[aizpilda advokāts]", tint: "empty" },
    { label: `Dokumenta ziņas <span class="muted small">(numurs, izdošanas datums, izdevējvalsts, izdevējiestāde)</span>`, value: "[aizpilda advokāts]", tint: "empty" },
  ];

  const persons = screening.persons || [];
  const ubosHtml = persons.length
    ? persons.map((p, i) => {
        const rows: FieldRow[] = [
          {
            label: `PLG ${i + 1} — vārds, uzvārds`,
            value: `${escapeHtml(p.name)}${p.aliases && p.aliases.length ? ` <span class="muted small">(pseidonīmi: ${p.aliases.map(escapeHtml).join(", ")})</span>` : ""}`,
            tint: "prefilled",
          },
          {
            label: "Loma",
            value: p.role ? escapeHtml(p.role) : "[aizpilda advokāts]",
            tint: p.role ? "prefilled" : "empty",
          },
          { label: "Personas kods / Dzimšanas datums", value: "[aizpilda advokāts]", tint: "empty" },
          { label: "Valstspiederība", value: "[aizpilda advokāts]", tint: "empty" },
          { label: "Pastāvīgās dzīvesvietas valsts", value: "[aizpilda advokāts]", tint: "empty" },
          { label: "Dokumenta ziņas (numurs, izdošanas datums, izdevējvalsts)", value: "[aizpilda advokāts]", tint: "empty" },
          { label: "Kontroles veids", value: "☐ Kontrolē __% daļu/akciju &nbsp; ☐ tieši &nbsp; ☐ netieši &nbsp; ☐ īsteno kontroli citā veidā", tint: "empty" },
        ];
        return renderFieldTable(rows);
      }).join("")
    : renderFieldTable([
        { label: "Dati", value: "Dati par patiesajiem labuma guvējiem nav ievadīti skrīninga veidlapā. Aizpilda advokāts.", tint: "empty" },
      ]);

  return `<!DOCTYPE html>
<html lang="lv">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(primaryName)} — Pielikums Nr. 3.2 (SAGATAVE)</title>
  <style>${sharedStyles()}</style>
</head>
<body>
  ${coverHtml({
    annexCode: "Pielikums Nr. 3.2",
    annexTitleLv: "Sankciju izpētes veidlapa (juridiska persona)",
    annexTitleEn: "Sanctions research form (legal entity)",
    screeningId: screening.id,
    entityName: primaryName,
    generatedAt,
    isDemo: screening.is_demo,
  })}

  ${renderSectionTitle("1.1. ZIŅAS PAR KLIENTU")}
  ${renderFieldTable(clientRows)}

  ${renderSectionTitle("1.2. ZIŅAS PAR KLIENTA PILNVAROTO PERSONU")}
  ${renderFieldTable(authorisedRows)}

  ${renderSectionTitle("ZIŅAS PAR KLIENTA PATIESAJIEM LABUMA GUVĒJIEM")}
  <p class="small muted" style="margin: 4pt 0;">Aizpilda attiecībā uz visiem patiesajiem labuma guvējiem. Dati priekšpildīti no skrīninga veidlapā norādītajām personām.</p>
  ${ubosHtml}

  ${renderDeclaration(`
    Parakstot šo anketu, klients apliecina, ka ne klients, ne klienta patiesais labuma guvējs nav Apvienoto Nāciju Organizācijas, Eiropas Savienības, citas starptautiskas organizācijas, kuras dalībvalsts ir Latvija, Latvijas Republikas, Eiropas Savienības un Ziemeļatlantijas līguma organizācijas dalībvalsts noteikto sankciju subjekti.
    <br/><br/>
    Klients apliecina, ka ir tiesīgs parakstīt šo dokumentu.
    <br/><br/>
    Klients apliecina, ka visa šajā veidlapā sniegtā informācija ir pilnīga un patiesa. Klients apņemas nekavējoties, bet ne vēlāk kā 5 (piecu) dienu laikā no izmaiņu rašanās brīža, paziņot advokātam par jebkurām šajā veidlapā minēto datu izmaiņām.
  `)}

  ${signatureBlockHtml("")}

  <p class="small muted" style="margin-top: 14pt;">
    Advokāts (izpētes veicējs): <strong>${escapeHtml(reviewer || "[vārds, uzvārds]")}</strong>
  </p>

  ${footerChainHtml({ screeningId: screening.id, generatedAt })}
</body>
</html>`;
}

function guessEntityForm(name: string): string {
  const up = name.toUpperCase();
  if (/\bSIA\b/.test(up) || up.startsWith("SIA ")) return "SIA";
  if (/\bAS\b/.test(up) || up.startsWith("AS ")) return "AS";
  if (/\bIK\b/.test(up)) return "IK";
  if (/\bBIEDRĪBA\b/.test(up)) return "biedrība";
  return "";
}

// =====================================================================
// P2 — Klienta risku novērtējuma veidlapa (2025-02-11 redakcija)
// =====================================================================

interface P2Row {
  nr: string;
  text: string;        // LV row text
  category: "Augsts" | "Risku paaugstinošs" | "Risku pazeminošs";
  prefill?: "yes" | "no"; // if Klirs can assert
  comment?: string;
}

interface P2Section {
  title: string;
  rows: P2Row[];
}

// Risk-table column widths in pt so html-to-docx honors them (percent
// widths get stripped by sanitizeHtmlForDocx to dodge a library bug).
const RISK_CELL_BASE = "padding: 4pt 6pt; border: 1pt solid #0f172a; vertical-align: top; font-size: 9.5pt;";
const RISK_COL_NR = `width: 36pt; text-align: center; ${RISK_CELL_BASE}`;
const RISK_COL_TEXT = RISK_CELL_BASE;
const RISK_COL_CATEGORY = `width: 72pt; white-space: nowrap; ${RISK_CELL_BASE}`;
const RISK_COL_VERDICT = `width: 56pt; text-align: center; white-space: nowrap; ${RISK_CELL_BASE}`;
const RISK_COL_COMMENT = `width: 140pt; ${RISK_CELL_BASE}`;
const RISK_ROW_PREFILLED_BG = "background-color: #fef9c3;";

function renderP2Row(r: P2Row): string {
  const isPrefilled = r.prefill !== undefined;
  const yesChecked = r.prefill === "yes";
  const noChecked = r.prefill === "no";
  const rowBg = isPrefilled ? ` ${RISK_ROW_PREFILLED_BG}` : "";
  return `
    <tr class="risk-row${isPrefilled ? " prefilled" : ""}">
      <td style="${RISK_COL_NR}${rowBg}">${escapeHtml(r.nr)}</td>
      <td style="${RISK_COL_TEXT}${rowBg}">${escapeHtml(r.text)}</td>
      <td style="${RISK_COL_CATEGORY}${rowBg}">${escapeHtml(r.category)}</td>
      <td style="${RISK_COL_VERDICT}${rowBg}">
        Jā ${yesChecked ? "☒" : "☐"} &nbsp; Nē ${noChecked ? "☒" : "☐"}
      </td>
      <td style="${RISK_COL_COMMENT}${rowBg}">
        ${r.comment ? `<span class="prefill-note" style="font-size: 8.5pt; color: #854d0e; font-style: italic;">${escapeHtml(r.comment)}</span>` : ""}
      </td>
    </tr>
  `;
}

function renderP2Section(s: P2Section): string {
  return `
    <tr><th colspan="5" style="background-color: #cbd5e1; text-align: left; font-size: 9.5pt; padding: 5pt 8pt; border: 1pt solid #0f172a;">${escapeHtml(s.title)}</th></tr>
    ${s.rows.map(renderP2Row).join("")}
  `;
}

export function buildAnnexP2Html(ctx: AnnexBuildContext): string {
  const { screening, checks, risk, reviewer } = ctx;
  const generatedAt = new Date().toISOString();
  const rl = riskLevelLv(risk.level);
  const kops = kopsavilkumsText(ctx);

  const sanHit = sanctionsHasHit(checks);
  const sanUnc = sanctionsHasUncertain(checks);
  const pepHit = pepHasHit(checks);
  const pepUnc = pepHasUncertain(checks);
  const sanSources = sanctionsHitSources(checks);
  const pepSources = pepHitSources(checks);
  const euJurisdiction = looksLikeLvCountryForEu(screening.jurisdiction);

  const section1Rows: P2Row[] = [
    {
      nr: "1.1.",
      text: "Klients ir politiski nozīmīga persona, politiski nozīmīgas personas ģimenes loceklis vai ar politiski nozīmīgu personu cieši saistīta persona.",
      category: "Augsts",
      prefill: pepHit ? "yes" : undefined,
      comment: pepHit
        ? `Skrīnings konstatēja PEP sakritību: ${pepSources.join(", ")}. Skat. pierādījumus skrīninga eksportā.`
        : (pepUnc ? "Skrīninga rezultāti PEP datubāzēs prasa manuālu pārbaudi." : undefined),
    },
    { nr: "1.2.", text: "Ir pamatotas aizdomas par klienta vai tā patiesā labuma guvēja iespējamo saistību ar NILL, TF vai proliferācijas finansēšanu.", category: "Augsts" },
    { nr: "1.3.", text: "Pret klientu ir uzsākts kriminālprocess un/vai klients ir notiesāts par NILL, TF vai proliferācijas finansēšanu.", category: "Augsts" },
    {
      nr: "1.4.",
      text: "Par klientu saņemtas ziņas no FID vai citas tiesībsargājošas institūcijas, vai pret klientu noteiktas Starptautiskās vai Nacionālās sankcijas (sankcijas.fid.gov.lv).",
      category: "Augsts",
      prefill: sanHit ? "yes" : undefined,
      comment: sanHit
        ? `Sankciju sakritība konstatēta: ${sanSources.join(", ")}. Skat. pierādījumus skrīninga eksportā.`
        : (sanUnc ? "Sankciju datubāžu rezultāti prasa manuālu pārbaudi — skat. ekrānuzņēmumus skrīninga eksportā." : "Sankciju datubāzēs (OFAC, UK, FID via Firmas.lv) sakritība nav konstatēta."),
    },
    { nr: "1.5.", text: "Klients mēģina izvairīties no informācijas sniegšanas vai mēģina slēpt savu saimniecisko darbību.", category: "Augsts" },
    { nr: "1.6.", text: "Klients ir čaulas veidojums.", category: "Augsts" },
    { nr: "1.6.¹", text: "Klients ir trešās valsts pilsonis, kas pieprasa vai ir saņēmis termiņuzturēšanās atļauju saistībā ar ieguldījumu Latvijā.", category: "Risku paaugstinošs" },
    { nr: "1.7.", text: "Klients ir Latvijas Republika, atvasināta publiska persona, tiešās/pastarpinātās pārvaldes iestāde vai valsts/pašvaldības kontrolēta kapitālsabiedrība.", category: "Risku pazeminošs" },
    { nr: "1.8.", text: "Klients ir komersants, kura akcijas ir iekļautas regulētā tirgū vienā vai vairākās dalībvalstīs.", category: "Risku pazeminošs" },
    { nr: "1.9.", text: "Klients ir juridisks veidojums, kas ir privāto aktīvu pārvaldīšanas sabiedrība (trasts).", category: "Risku paaugstinošs" },
    { nr: "1.10.", text: "Klients ir juridiska persona ar neraksturīgu/sarežģītu īpašnieku struktūru, uzrādītāja akcijām, vai citām augsta riska pazīmēm (skat. P2 veidlapas pilno tekstu).", category: "Risku paaugstinošs" },
    { nr: "1.11.", text: "Klients veic paaugstināta riska komercdarbību (azartspēles, inkasācija, nekustamais īpašums, dārgmetāli, ieroči, naudas pakalpojumi, u.c. — skat. P2 pilno tekstu).", category: "Risku paaugstinošs" },
  ];

  const section2Rows: P2Row[] = [
    {
      nr: "2.1.",
      text: "Klients vai tā PLG ir saistīts ar augsta riska rezidences/reģistrācijas valsti vai teritoriju (zemu nodokļu saraksts, sankcijām pakļautas valstis, FATF saraksts, ES augsta riska trešās valstis, augsta korupcija).",
      category: "Risku paaugstinošs",
      comment: screening.jurisdiction
        ? `Skrīningā norādītā jurisdikcija: ${screening.jurisdiction}. Advokāts pārbauda pret FATF, ES un OFAC sarakstiem.`
        : undefined,
    },
    {
      nr: "2.2.",
      text: "Klienta rezidences vai reģistrācijas valsts ir ES dalībvalsts vai valsts ar ekvivalentām AML prasībām, zemu korupciju un zemu noziedzības līmeni.",
      category: "Risku pazeminošs",
      prefill: euJurisdiction ? "yes" : undefined,
      comment: euJurisdiction
        ? `Jurisdikcija ${screening.jurisdiction} atpazīta kā ES/EEZ dalībvalsts.`
        : undefined,
    },
  ];

  const section3Rows: P2Row[] = [
    { nr: "3.1.", text: "Klients izmanto pakalpojumus, kas veicina anonimitāti vai ierobežo klienta izpētes iespējas (privātbaņķieris, jaunas tehnoloģijas, anonīmi kanāli).", category: "Risku paaugstinošs" },
  ];

  const section4Rows: P2Row[] = [
    { nr: "4.1.", text: "Klients nav piedalījies klātienes identifikācijā (izņemot gadījumus, kad veikta neklātienes identifikācija Likumā noteiktajā kārtībā).", category: "Augsts" },
    { nr: "4.2.", text: "Pakalpojumu sniegšana notiek, pamatojoties uz tehnoloģiskiem risinājumiem, kas ierobežo klienta izpēti.", category: "Risku paaugstinošs" },
    { nr: "4.4.", text: "Klients izmanto jaunus pakalpojumus, produktus vai to piegādes kanālus vai jaunas tehnoloģijas, kas nozarē nav raksturīgas.", category: "Risku paaugstinošs" },
  ];

  const sections: P2Section[] = [
    { title: "1. Klienta risks", rows: section1Rows },
    { title: "2. Valsts un ģeogrāfiskais risks", rows: section2Rows },
    { title: "3. Klienta izmantoto pakalpojumu un produktu risks", rows: section3Rows },
    { title: "4. Pakalpojumu un produktu piegādes kanālu risks", rows: section4Rows },
  ];

  const sectionsHtml = sections.map(renderP2Section).join("");

  const idRows: FieldRow[] = [
    { label: `Klients <span class="muted small">(nosaukums / vārds, uzvārds)</span>`, value: escapeHtml(screening.entity_name), tint: "prefilled" },
    {
      label: screening.entity_type === "company" ? "Reģistrācijas numurs" : "Personas kods / Dzimšanas datums",
      value: screening.registration_number ? escapeHtml(screening.registration_number) : "[aizpilda advokāts]",
      tint: screening.registration_number ? "prefilled" : "empty",
    },
    {
      label: "Rezidences / reģistrācijas valsts",
      value: screening.jurisdiction ? escapeHtml(screening.jurisdiction) : "[aizpilda advokāts]",
      tint: screening.jurisdiction ? "prefilled" : "empty",
    },
    { label: "Izpildāmais uzdevums", value: "[aizpilda advokāts — klienta darījums]", tint: "empty" },
    {
      label: "Atbildīgā persona",
      value: reviewer ? escapeHtml(reviewer) : "[vārds, uzvārds]",
      tint: reviewer ? "prefilled" : "empty",
    },
    {
      label: "Riska līmenis",
      value: `<strong>${escapeHtml(rl.lv)}</strong> <span class="muted small">(skrīninga aprēķins, advokāts pārskata)</span>`,
      tint: "prefilled",
    },
    {
      label: "Patiesā labuma guvēja ticamības pārbaude",
      value: "[aizpilda advokāts — augsta PLG ticamība / aizdomas par PLG ticamību / PLG ir klienta vadība]",
      tint: "empty",
    },
    { label: "Kopsavilkums par uzdevumu un riskiem", value: escapeHtml(kops), tint: "prefilled" },
  ];

  return `<!DOCTYPE html>
<html lang="lv">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(screening.entity_name)} — Pielikums Nr. 2 (SAGATAVE)</title>
  <style>${sharedStyles()}</style>
</head>
<body>
  ${coverHtml({
    annexCode: "Pielikums Nr. 2",
    annexTitleLv: "Klienta risku novērtējuma veidlapa",
    annexTitleEn: "Client risk assessment form",
    screeningId: screening.id,
    entityName: screening.entity_name,
    generatedAt,
    isDemo: screening.is_demo,
  })}

  <p class="small muted" style="margin: 4pt 0 10pt 0;">
    Redakcijā, kas apstiprināta ar Latvijas Zvērinātu advokātu padomes 2025.gada 11.februāra lēmumu Nr. 52 (protokols Nr. 2).
  </p>

  ${renderSectionTitle("KLIENTA IDENTIFIKĀCIJA")}
  ${renderFieldTable(idRows)}

  ${renderSectionTitle("RISKA KATEGORIJU NOVĒRTĒJUMS")}
  <p class="small muted" style="margin: 4pt 0;">
    Iezīmētās (dzeltenās) rindas ir automātiski aizpildītas no AML skrīninga datiem. Pārējās rindās advokāts ievada Jā/Nē manuāli pēc CDD/KYC pārbaudes.
  </p>
  <table style="width: 100%; border-collapse: collapse; margin-top: 4pt;">
    <thead>
      <tr>
        <th style="${RISK_COL_NR} background-color: #f1f5f9; border: 1pt solid #0f172a; padding: 5pt 7pt;">N.p.k.</th>
        <th style="background-color: #f1f5f9; border: 1pt solid #0f172a; padding: 5pt 7pt; text-align: left;">NILL, TF un proliferācijas finansēšanas risks</th>
        <th style="${RISK_COL_CATEGORY} background-color: #f1f5f9; border: 1pt solid #0f172a; padding: 5pt 7pt;">Riska kategorija</th>
        <th style="${RISK_COL_VERDICT} background-color: #f1f5f9; border: 1pt solid #0f172a; padding: 5pt 7pt;">Novērtējums</th>
        <th style="${RISK_COL_COMMENT} background-color: #f1f5f9; border: 1pt solid #0f172a; padding: 5pt 7pt; text-align: left;">Komentārs</th>
      </tr>
    </thead>
    <tbody>
      ${sectionsHtml}
    </tbody>
  </table>

  ${renderDeclaration(`
    <strong>Advokāta secinājums un piemērojamā izpētes pakāpe</strong>
    <br/>
    <span style="font-size: 9pt;">Pamatojoties uz iepriekšminēto riska novērtējumu un AML skrīninga rezultātiem (līmenis: <strong>${escapeHtml(rl.lv)}</strong>), advokāts piemēro:</span>
    <br/><br/>
    <span>☐ vienkāršota izpēte &nbsp; ☐ standarta izpēte &nbsp; ☐ padziļināta izpēte</span>
    <br/>
    <span style="font-size: 9pt; color: #475569;">${escapeHtml(rl.comment)}</span>
  `)}

  ${signatureBlockHtml(reviewer)}

  <p class="small muted" style="margin-top: 10pt;">
    Sagatavots AML skrīninga laikā: ${escapeHtml(lvDate(screening.completed_at || screening.created_at))}
  </p>

  ${footerChainHtml({ screeningId: screening.id, generatedAt })}
</body>
</html>`;
}
