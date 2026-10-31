import type { FindingDetailRecord } from "@/types/finding";
import type { jsPDF } from "jspdf";
import type { FindingSeverity } from "@/lib/findings/cvss31";

/**
 * Renders a saved finding (already written by the agent via the finding
 * tools — this module adds no new content, only layout) as a colorful PDF,
 * for a local, zero-cost alternative to the existing Markdown export.
 *
 * Text is set in DejaVu (served from /fonts) so non-Latin scripts — Cyrillic,
 * Uzbek's "oʻ"/"gʻ" — render correctly. jsPDF's built-in Helvetica/Courier
 * only cover Latin-1 and remain the fallback if the font files can't be
 * fetched, so export never fails on a font error.
 */

// Mirrors FindingCard.tsx's severityDotClasses (Tailwind *-500) so the PDF
// badge matches the in-app severity color for the same finding.
const SEVERITY_RGB: Record<FindingSeverity, [number, number, number]> = {
  critical: [239, 68, 68], // red-500
  high: [249, 115, 22], // orange-500
  medium: [234, 179, 8], // yellow-500
  low: [59, 130, 246], // blue-500
  info: [100, 116, 139], // slate-500
};

const NAVY: [number, number, number] = [17, 24, 39];
const ORANGE: [number, number, number] = [234, 88, 12]; // amber-600-ish accent
const DARK_TEXT: [number, number, number] = [31, 41, 55];
const LIGHT_GRAY: [number, number, number] = [243, 244, 246];
const MUTED: [number, number, number] = [107, 114, 128];
const RULE: [number, number, number] = [229, 231, 235];
const WHITE: [number, number, number] = [255, 255, 255];

const PAGE_WIDTH = 210;
const MARGIN = 16;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BOTTOM_MARGIN = 20;

// "2026-10-28 06:11 UTC" — ISO seconds/milliseconds are noise in a report.
const formatTimestamp = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

type FontFamilies = { sans: string; mono: string };

const FONT_FILES = [
  { file: "DejaVuSans.ttf", family: "DejaVuSans", style: "normal" },
  { file: "DejaVuSans-Bold.ttf", family: "DejaVuSans", style: "bold" },
  { file: "DejaVuSansMono.ttf", family: "DejaVuMono", style: "normal" },
] as const;

const toBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked so String.fromCharCode never exceeds the argument-count limit.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const registerUnicodeFonts = async (doc: jsPDF): Promise<FontFamilies> => {
  try {
    const buffers = await Promise.all(
      FONT_FILES.map(async ({ file }) => {
        const response = await fetch(`/fonts/${file}`);
        if (!response.ok) throw new Error(`Font ${file}: ${response.status}`);
        return response.arrayBuffer();
      }),
    );
    FONT_FILES.forEach(({ file, family, style }, i) => {
      doc.addFileToVFS(file, toBase64(buffers[i]));
      doc.addFont(file, family, style);
    });
    return { sans: "DejaVuSans", mono: "DejaVuMono" };
  } catch {
    return { sans: "helvetica", mono: "courier" };
  }
};

// Strips the common Markdown tokens the agent's prose/section fields use
// (fenced/inline code, bold, heading hashes) so they read as plain text
// instead of showing literal "```"/"**"/"##"/backtick characters. Not a full
// Markdown renderer: links, tables, and nested lists are left as-is.
//
// Deliberately does NOT strip single-asterisk "*italic*" spans: agent prose
// routinely contains lone literal asterisks that are not emphasis markers
// (SQL `SELECT * FROM`, glob patterns, multiplication, pointer derefs). A
// greedy "/\*([^*]+)\*/" pairs the first such asterisk with the next
// unrelated one anywhere later in the same field and deletes both — which
// silently corrupted "SELECT * FROM products" into "SELECT FROM products"
// in an earlier version of this function. Losing real single-asterisk
// italics is an acceptable trade for never corrupting literal content.
export const stripMarkdown = (text: string): string =>
  text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1");

export async function renderFindingPdf(
  finding: FindingDetailRecord,
): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const fonts = await registerUnicodeFonts(doc);
  let y = MARGIN;

  const ensureSpace = (needed: number) => {
    if (y + needed > doc.internal.pageSize.getHeight() - BOTTOM_MARGIN) {
      doc.addPage();
      y = MARGIN;
    }
  };

  const heading = (text: string) => {
    // Keep the heading with at least two lines of the content below it.
    ensureSpace(24);
    y += 3;
    doc.setFont(fonts.sans, "bold");
    doc.setFontSize(13);
    doc.setTextColor(...ORANGE);
    doc.text(text, MARGIN, y);
    doc.setDrawColor(...ORANGE);
    doc.setLineWidth(0.5);
    doc.line(MARGIN, y + 1.5, MARGIN + 28, y + 1.5);
    y += 8;
  };

  const LINE_HEIGHT = 5.4;
  const CODE_LINE_HEIGHT = 4.2;
  const LIST_INDENT = 6;
  const LIST_ITEM = /^\s*(\d+[.)]|[-*•])\s+(.*)$/;
  // "Root Cause: ..." style lead-ins the agent writes as plain text.
  const LABEL_LINE = /^([A-Z][\w/ ()—–-]{1,60}):\s+(.+)$/;

  // Draws one wrapped run of prose at `x`; `firstLineOffset` shifts only the
  // first line so a bold label can sit in front of it.
  const proseRun = (text: string, x: number, firstLineOffset = 0) => {
    const [first, ...rest] = doc.splitTextToSize(
      text,
      CONTENT_WIDTH - (x - MARGIN) - firstLineOffset,
    ) as string[];
    if (first === undefined) return;
    ensureSpace(LINE_HEIGHT);
    doc.text(first, x + firstLineOffset, y);
    y += LINE_HEIGHT;
    if (rest.length === 0) return;
    const remainder = text.slice(text.indexOf(first) + first.length).trim();
    for (const line of doc.splitTextToSize(
      remainder,
      CONTENT_WIDTH - (x - MARGIN),
    ) as string[]) {
      ensureSpace(LINE_HEIGHT);
      doc.text(line, x, y);
      y += LINE_HEIGHT;
    }
  };

  // Draws a line at `x`, bolding a leading "Label:" when it has one.
  const labelledLine = (line: string, x: number) => {
    const label = LABEL_LINE.exec(line);
    if (!label) {
      proseRun(line, x);
      return;
    }
    const lead = `${label[1]}:`;
    doc.setFont(fonts.sans, "bold");
    const leadWidth = doc.getTextWidth(`${lead} `);
    ensureSpace(LINE_HEIGHT);
    doc.text(lead, x, y);
    doc.setFont(fonts.sans, "normal");
    proseRun(label[2], x, leadWidth);
  };

  const prose = (text: string) => {
    doc.setFontSize(10.5);
    doc.setTextColor(...DARK_TEXT);
    for (const raw of stripMarkdown(text).split("\n")) {
      const line = raw.trimEnd();
      if (!line.trim()) {
        y += 2;
        continue;
      }
      doc.setFont(fonts.sans, "normal");
      const item = LIST_ITEM.exec(line);
      if (item) {
        ensureSpace(LINE_HEIGHT);
        doc.text(item[1], MARGIN, y);
        labelledLine(item[2], MARGIN + LIST_INDENT);
        continue;
      }
      labelledLine(line, MARGIN);
    }
    y += 2;
  };

  const code = (text: string) => {
    doc.setFont(fonts.mono, "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...DARK_TEXT);
    const lines: string[] = doc.splitTextToSize(text, CONTENT_WIDTH - 6);
    const lineHeight = CODE_LINE_HEIGHT;
    // Draw the gray box per page instead of reserving space for the
    // whole block up front: a long code/evidence block that doesn't fit
    // would otherwise jump to a fresh page in one piece, orphaning its
    // heading above a near-empty rest of the current page. Chunking lets
    // each page fill up before the content continues onto the next one.
    const pageHeight = doc.internal.pageSize.getHeight();
    let i = 0;
    while (i < lines.length) {
      if (y + lineHeight + 4 > pageHeight - BOTTOM_MARGIN) {
        doc.addPage();
        y = MARGIN;
      }
      const available = pageHeight - BOTTOM_MARGIN - (y - 4);
      const linesThatFit = Math.max(
        1,
        Math.floor((available - 4) / lineHeight),
      );
      const chunk = lines.slice(i, i + linesThatFit);
      const chunkHeight = chunk.length * lineHeight + 4;
      doc.setFillColor(...LIGHT_GRAY);
      doc.rect(MARGIN, y - 4, CONTENT_WIDTH, chunkHeight, "F");
      let cy = y + 0.5;
      for (const line of chunk) {
        doc.text(line, MARGIN + 3, cy);
        cy += lineHeight;
      }
      y = cy + 3;
      i += chunk.length;
    }
  };

  const paragraph = (text: string, mono = false) => {
    if (mono) {
      code(text);
      return;
    }
    // Fenced blocks inside prose (e.g. the vulnerable and the exploited query
    // in the technical analysis) become gray code panels; with the capture
    // group, odd split indexes are the fenced bodies.
    text.split(/```[^\n]*\n([\s\S]*?)```/).forEach((part, i) => {
      if (i % 2) code(part.replace(/\n$/, ""));
      else if (part.trim()) prose(part);
    });
  };

  const section = (title: string, value: string | undefined, mono = false) => {
    if (!value) return;
    if (mono) {
      // A block that fits on one page moves there whole, with its heading,
      // instead of splitting a few lines across a page break. Longer blocks
      // (over ~40% of a page) are chunked by code() so they never leave a
      // half-empty page behind.
      doc.setFont(fonts.mono, "normal");
      doc.setFontSize(8.5);
      const lineCount = (
        doc.splitTextToSize(value, CONTENT_WIDTH - 6) as string[]
      ).length;
      const blockHeight = lineCount * CODE_LINE_HEIGHT + 22;
      const pageSpace =
        doc.internal.pageSize.getHeight() - BOTTOM_MARGIN - MARGIN;
      if (blockHeight <= pageSpace * 0.4) ensureSpace(blockHeight);
    }
    heading(title);
    paragraph(value, mono);
  };

  const severityColor = SEVERITY_RGB[finding.severity];

  // ---- Header ----
  // Title band, severity badge and a compact metadata list share the first
  // page with the opening sections: a dedicated, mostly-empty cover page
  // wasted a full page of the report.
  doc.setFont(fonts.sans, "bold");
  doc.setFontSize(17);
  const titleLines: string[] = doc.splitTextToSize(
    finding.title,
    CONTENT_WIDTH,
  );
  doc.setFont(fonts.sans, "normal");
  doc.setFontSize(9.5);
  const targetLines: string[] = doc.splitTextToSize(
    finding.target,
    CONTENT_WIDTH,
  );
  const bandHeight =
    14 + titleLines.length * 7.5 + targetLines.length * 4.6 + 6;
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, PAGE_WIDTH, bandHeight, "F");
  doc.setFillColor(...severityColor);
  doc.rect(0, bandHeight, PAGE_WIDTH, 2.5, "F");

  doc.setTextColor(...WHITE);
  doc.setFont(fonts.sans, "bold");
  doc.setFontSize(17);
  doc.text(titleLines, MARGIN, 16);
  doc.setFont(fonts.sans, "normal");
  doc.setFontSize(9.5);
  doc.text(targetLines, MARGIN, 16 + titleLines.length * 7.5 + 2);

  y = bandHeight + 12;
  doc.setFont(fonts.sans, "bold");
  doc.setFontSize(11);
  const badgeText = `${finding.severity.toUpperCase()}  ${finding.cvss_score.toFixed(1)}`;
  const badgeWidth = doc.getTextWidth(badgeText) + 12;
  doc.setFillColor(...severityColor);
  doc.roundedRect(MARGIN, y, badgeWidth, 9, 2, 2, "F");
  doc.setTextColor(...WHITE);
  doc.text(badgeText, MARGIN + badgeWidth / 2, y + 6.2, { align: "center" });
  y += 17;

  const META_VALUE_X = MARGIN + 32;
  doc.setFontSize(9.5);
  const meta: Array<[string, string | undefined]> = [
    ["Status", finding.status],
    ["CVSS vector", finding.cvss_vector],
    ["Category", finding.category],
    ["Fix effort", finding.fix_effort],
    ["Endpoint", finding.endpoint],
    ["Method", finding.method],
    ["CVE", finding.cve],
    ["CWE", finding.cwe],
    ["Confidence", finding.confidence],
    ["Created", formatTimestamp(finding.created_at)],
    ["Updated", formatTimestamp(finding.updated_at)],
  ];
  for (const [label, value] of meta) {
    if (!value) continue;
    doc.setFont(fonts.sans, "bold");
    doc.setTextColor(...NAVY);
    doc.text(`${label}:`, MARGIN, y);
    doc.setFont(fonts.sans, "normal");
    doc.setTextColor(...DARK_TEXT);
    const valueLines: string[] = doc.splitTextToSize(
      String(value),
      PAGE_WIDTH - MARGIN - META_VALUE_X,
    );
    doc.text(valueLines, META_VALUE_X, y);
    y += valueLines.length * 4.8 + 1.2;
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.2);
    doc.line(MARGIN, y - 3.4, PAGE_WIDTH - MARGIN, y - 3.4);
    y += 1.4;
  }
  y += 2;

  // ---- Body sections (agent-authored content; this module only lays it out) ----
  // Narrative order, matching the reference report: what it is, how to
  // reproduce it, proof, consequences, then the fix and supporting reasoning.
  section("Summary", finding.description);
  section("Reproduction steps", finding.poc_description);
  section("Evidence", finding.evidence, true);
  section("Proof of concept", finding.poc_script_code, true);
  section("Impact", finding.impact);
  section("Remediation", finding.remediation_steps);
  section("Technical analysis", finding.technical_analysis);
  section("Assumptions and prerequisites", finding.assumptions);
  section("Confidence rationale", finding.confidence_rationale);
  section("Counterevidence", finding.counterevidence);
  section("What would change severity", finding.severity_change_conditions);

  for (const location of finding.code_locations ?? []) {
    heading("Code location");
    paragraph(`${location.file}:${location.start_line}-${location.end_line}`);
    if (location.label) paragraph(location.label);
    if (location.snippet) paragraph(location.snippet, true);
  }

  if (finding.status === "closed") {
    heading("Closure");
    paragraph(`Reason: ${finding.closure_reason ?? "unspecified"}`);
    if (finding.closure_context) paragraph(finding.closure_context);
  }

  // ---- Footer on every page ----
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont(fonts.sans, "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(
      `HackerAI finding report — ${finding.finding_id}`,
      MARGIN,
      doc.internal.pageSize.getHeight() - 10,
    );
    doc.text(
      `Page ${i} of ${pageCount}`,
      PAGE_WIDTH - MARGIN,
      doc.internal.pageSize.getHeight() - 10,
      { align: "right" },
    );
  }

  return doc.output("blob");
}
