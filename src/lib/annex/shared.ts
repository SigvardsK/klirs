/**
 * Shared helpers and HTML chrome for annex template generation.
 *
 * The three annexes (P3.1, P3.2, P2) share a cover strip, SAGATAVE banner,
 * page rules, and primitive escaping. Keeping them here lets each template
 * focus on its field structure.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export function lvDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

export const BLANK = '<span class="blank"></span>';
export const CHECKBOX_EMPTY = "☐";
export const CHECKBOX_CHECKED = "☒";

export function cb(checked: boolean): string {
  return checked ? CHECKBOX_CHECKED : CHECKBOX_EMPTY;
}

export interface CoverInfo {
  annexCode: string;        // e.g. "Pielikums Nr. 3.1"
  annexTitleLv: string;     // e.g. "Sankciju izpētes veidlapa (fiziska persona)"
  annexTitleEn: string;     // e.g. "Sanctions research form (natural person)"
  screeningId: string;
  entityName: string;
  generatedAt: string;      // ISO date
  isDemo: boolean;
}

export function coverHtml(info: CoverInfo): string {
  const date = new Date(info.generatedAt);
  const dateLv = `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}.${date.getFullYear()}`;
  // Each visual block is rendered as a single-cell <table> so html-to-docx
  // honors the inline background + border via <w:shd> + <w:tcBorders>.
  // The CSS class names stay for PDF parity (they still match .sagatave-*
  // etc. in sharedStyles()).
  return `
    <table class="sagatave-banner" style="width: 100%; border-collapse: collapse; margin: 0 0 10pt 0;">
      <tbody>
        <tr>
          <td class="sagatave-cell" style="background-color: #fef3c7; border: 1pt solid #f59e0b; border-left: 4pt solid #f59e0b; padding: 8pt 10pt;">
            <div style="font-weight: 700; font-size: 11pt; color: #92400e; letter-spacing: 1pt; margin-bottom: 2pt;">SAGATAVE</div>
            <div style="color: #78350f; font-size: 9pt; line-height: 1.35;">Šī veidlapa ir automātiski sagatavota no AML skrīninga datiem. Advokāts to pārskata, papildina un apstiprina pirms iesniegšanas.</div>
            ${info.isDemo ? `<div style="margin-top: 5pt; padding: 3pt 6pt; background-color: #fee2e2; color: #991b1b; font-weight: 700; font-size: 9pt; letter-spacing: 0.5pt; text-align: center;">PARAUGS — NAV IZMANTOJAMS KĀ JURIDISKS DOKUMENTS</div>` : ""}
          </td>
        </tr>
      </tbody>
    </table>
    <table class="annex-header" style="width: 100%; border-collapse: collapse; margin: 2pt 0 8pt 0;">
      <tbody>
        <tr>
          <td style="border-top: 2pt solid #0f172a; border-bottom: 2pt solid #0f172a; padding: 8pt 0; text-align: center;">
            <div style="font-size: 9.5pt; color: #475569; letter-spacing: 0.5pt;">${escapeHtml(info.annexCode)}</div>
            <h1 style="font-size: 14pt; margin: 4pt 0 2pt 0; font-weight: 700; color: #0f172a;">${escapeHtml(info.annexTitleLv)}</h1>
            <div style="font-size: 9.5pt; color: #475569; font-style: italic;">${escapeHtml(info.annexTitleEn)}</div>
          </td>
        </tr>
      </tbody>
    </table>
    <p style="font-size: 8.5pt; color: #64748b; margin: 0 0 14pt 0;">
      Sagatavots: ${dateLv} &nbsp;·&nbsp; Skrīninga ID: <code>${escapeHtml(info.screeningId.slice(0, 8))}</code>
    </p>
  `;
}

export function sharedStyles(): string {
  return `
    @page { size: A4; margin: 18mm 16mm 20mm 16mm; }
    * { box-sizing: border-box; }
    html, body {
      font-family: "Times New Roman", Times, Georgia, serif;
      color: #0f172a;
      background: #ffffff;
      margin: 0;
      padding: 0;
      font-size: 10.5pt;
      line-height: 1.4;
    }
    code, .mono { font-family: "Courier New", monospace; }
    h1, h2, h3, h4 { margin: 0; font-weight: 700; color: #0f172a; }
    p { margin: 0 0 6pt 0; }
    a { color: #1d4ed8; text-decoration: underline; word-break: break-all; }
    table { border-collapse: collapse; width: 100%; }
    td, th { vertical-align: top; padding: 5pt 7pt; border: 1px solid #0f172a; }
    th { background: #f1f5f9; font-weight: 700; text-align: left; }
    .muted { color: #475569; }
    .small { font-size: 9pt; }
    .kv { display: flex; gap: 8pt; margin: 2pt 0; align-items: baseline; }
    .kv .k { color: #475569; min-width: 120pt; font-size: 9.5pt; }
    .kv .v { color: #0f172a; font-weight: 500; }
    .blank {
      display: inline-block;
      min-width: 160pt;
      border-bottom: 1px solid #64748b;
      height: 1.1em;
      vertical-align: bottom;
    }
    .sagatave-banner {
      background: #fef3c7;
      border: 1px solid #f59e0b;
      border-left: 4px solid #f59e0b;
      padding: 8pt 10pt;
      margin: 0 0 10pt 0;
      border-radius: 3pt;
    }
    .sagatave-label {
      font-weight: 700;
      font-size: 11pt;
      color: #92400e;
      letter-spacing: 1pt;
      margin-bottom: 2pt;
    }
    .sagatave-note { color: #78350f; font-size: 9pt; line-height: 1.35; }
    .sagatave-demo {
      margin-top: 5pt;
      padding: 3pt 6pt;
      background: #fee2e2;
      color: #991b1b;
      border-radius: 2pt;
      font-weight: 700;
      font-size: 9pt;
      letter-spacing: 0.5pt;
      text-align: center;
    }
    .annex-header {
      border-top: 2px solid #0f172a;
      border-bottom: 2px solid #0f172a;
      padding: 8pt 0;
      margin: 2pt 0 8pt 0;
      text-align: center;
    }
    .annex-code {
      font-size: 9.5pt;
      color: #475569;
      letter-spacing: 0.5pt;
    }
    .annex-title-lv { font-size: 14pt; margin: 4pt 0 2pt 0; }
    .annex-title-en { font-size: 9.5pt; color: #475569; font-style: italic; }
    .gen-meta {
      font-size: 8.5pt;
      color: #64748b;
      margin: 0 0 14pt 0;
      display: flex;
      gap: 6pt;
    }
    .section-title {
      background: #e2e8f0;
      padding: 5pt 8pt;
      margin: 10pt 0 0 0;
      font-weight: 700;
      font-size: 10pt;
      letter-spacing: 0.3pt;
    }
    /* field-table: two-column label/value layout. Uses <table> (not flex)
       so html-to-docx renders the two-column structure faithfully. */
    .field-table {
      width: 100%;
      border-collapse: collapse;
      margin: 0 0 2pt 0;
    }
    .field-table td {
      padding: 5pt 8pt;
      border: 1px solid #cbd5e1;
      vertical-align: top;
      font-size: 9.5pt;
    }
    .field-table td.label {
      width: 140pt;
      color: #334155;
      font-weight: 600;
      background: #f8fafc;
    }
    .field-table td.val { color: #0f172a; }
    .field-table td.val.prefilled { background: #fef9c3; }
    .field-table td.val.empty {
      color: #94a3b8;
      font-style: italic;
    }
    .declaration {
      margin: 10pt 0;
      padding: 8pt 10pt;
      border: 1px solid #0f172a;
      background: #f8fafc;
      font-size: 9.5pt;
      line-height: 1.5;
    }
    /* signature-block: <table> so DOCX gets the two columns (name / date). */
    .signature-block {
      width: 100%;
      margin-top: 18pt;
      border-collapse: collapse;
      page-break-inside: avoid;
    }
    .signature-block td {
      border: none;
      border-top: 1px solid #0f172a;
      padding: 3pt 10pt 3pt 0;
      font-size: 9pt;
      color: #475569;
      vertical-align: top;
    }
    .signature-block td.sig-name { width: 280pt; }
    .signature-block td.sig-date { width: 140pt; }
    .risk-row.prefilled {
      background: #fef9c3;
    }
    .risk-row.prefilled td { position: relative; }
    .risk-row .prefill-note {
      display: block;
      margin-top: 3pt;
      font-size: 8.5pt;
      color: #854d0e;
      font-style: italic;
      line-height: 1.3;
    }
    .evidence-link {
      font-size: 8.5pt;
      color: #1d4ed8;
      font-style: italic;
    }
    .footer-chain {
      margin-top: 20pt;
      padding-top: 8pt;
      border-top: 1px solid #cbd5e1;
      color: #64748b;
      font-size: 8pt;
      line-height: 1.45;
    }
    ul { margin: 3pt 0 3pt 16pt; padding: 0; }
    ul li { margin: 1pt 0; }
  `;
}

export function signatureBlockHtml(reviewer: string): string {
  return `
    <table class="signature-block" style="width: 100%; border-collapse: collapse; margin-top: 18pt;">
      <tbody>
        <tr>
          <td class="sig-name" style="width: 280pt; border-top: 1pt solid #0f172a; padding: 3pt 10pt 3pt 0; font-size: 9pt; color: #475569; vertical-align: top;">
            <div style="height: 18pt;">&nbsp;</div>
            ${reviewer ? `<div style="font-weight:600;color:#0f172a;">${escapeHtml(reviewer)}</div>` : ""}
            <div>[vārds, uzvārds un paraksts / name, surname and signature]</div>
          </td>
          <td class="sig-date" style="width: 140pt; border-top: 1pt solid #0f172a; padding: 3pt 10pt 3pt 0; font-size: 9pt; color: #475569; vertical-align: top;">
            <div style="height: 18pt;">&nbsp;</div>
            <div>Datums / Date</div>
          </td>
        </tr>
      </tbody>
    </table>
  `;
}

export function footerChainHtml(info: {
  screeningId: string;
  generatedAt: string;
}): string {
  return `
    <div class="footer-chain">
      <strong>Chain of custody:</strong> Ģenerēts no AML skrīninga ieraksta
      <code>${escapeHtml(info.screeningId)}</code> ${escapeHtml(new Date(info.generatedAt).toISOString())}.
      Ekrānuzņēmumi un avotu URL ir pievienoti skrīninga ieraksta pilnajam PDF eksportam.
      Šo veidlapu pirms iesniegšanas jāpārskata advokātam.
    </div>
  `;
}
