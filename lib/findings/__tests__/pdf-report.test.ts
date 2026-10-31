import { renderFindingPdf, stripMarkdown } from "../pdf-report";
import type { FindingDetailRecord } from "@/types/finding";

describe("stripMarkdown", () => {
  it("preserves a literal single asterisk instead of pairing it with an unrelated later one", () => {
    // Regression: the first shipped version greedily matched "*([^*]+)*"
    // across the whole field, pairing this "*" with the next unrelated "*"
    // later in the same paragraph and deleting both — corrupting
    // "SELECT * FROM products" into "SELECT FROM products".
    const text =
      "The query is SELECT * FROM products. Later the report also discusses a * bullet marker.";
    expect(stripMarkdown(text)).toContain("SELECT * FROM products");
  });

  it("strips a fenced code block's backtick fences without leaving stray backticks", () => {
    const text =
      "Resulting query:\n```sql\nSELECT * FROM products;\n```\nThat's the payload.";
    const result = stripMarkdown(text);
    expect(result).not.toContain("```");
    expect(result).toContain("SELECT * FROM products;");
  });

  it("still strips bold, inline code, and heading markers", () => {
    expect(stripMarkdown("**bold** and `code` and __also bold__")).toBe(
      "bold and code and also bold",
    );
    expect(stripMarkdown("## Heading\nBody")).toBe("Heading\nBody");
  });
});

const baseFinding: FindingDetailRecord = {
  finding_id: "finding-1",
  title: "Confirmed IDOR",
  target: "https://app.example.test",
  endpoint: "/api/invoices/other",
  method: "GET",
  severity: "high",
  cvss_score: 7.1,
  category: "access_control",
  status: "active",
  chat_id: "chat-1",
  chat_title: "Invoice test",
  created_at: 1,
  updated_at: 1,
  message_id: "message-1",
  description: "Another account's invoice is readable.",
  impact: "Billing data disclosure.",
  technical_analysis: "The handler omits an owner predicate.",
  poc_description: "Request another account's invoice.",
  poc_script_code: "curl /api/invoices/other",
  remediation_steps: "Add an owner predicate.",
  evidence: "HTTP 200 returned the other account's data.",
  assumptions: "Ordinary authenticated account.",
  fix_effort: "low",
  cvss_vector: "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N",
  cvss_breakdown: {
    attack_vector: "N",
    attack_complexity: "L",
    privileges_required: "L",
    user_interaction: "N",
    scope: "U",
    confidentiality: "H",
    integrity: "N",
    availability: "N",
  },
  cwe: "CWE-639",
  code_locations: [
    {
      file: "app/api/invoices/route.ts",
      start_line: 20,
      end_line: 22,
      label: "Missing ownership predicate",
      snippet: "findUnique({ id })",
      fix_before:
        "const invoice = await db.invoice.findUnique({\n  where: { id },\n});",
      fix_after:
        "const invoice = await db.invoice.findUnique({\n  where: { id, userId },\n});",
    },
  ],
};

describe("renderFindingPdf", () => {
  it("produces a non-trivial application/pdf blob for a representative finding", async () => {
    const blob = await renderFindingPdf(baseFinding);
    expect(blob.type).toBe("application/pdf");
    // A single-page report with real section text is well over 1KB; a near-empty
    // size would mean the renderer silently dropped content or crashed mid-build.
    expect(blob.size).toBeGreaterThan(1000);
  });

  it("does not throw on the exact bug report: a fenced SQL block plus a literal SELECT *", async () => {
    const withEmbeddedSql: FindingDetailRecord = {
      ...baseFinding,
      technical_analysis:
        "The query is built as follows:\n```sql\nSELECT * FROM products WHERE category = '<user_input>' AND released = 1;\n```\nThe category parameter is embedded without validation.",
    };
    await expect(renderFindingPdf(withEmbeddedSql)).resolves.toBeInstanceOf(
      Blob,
    );
  });

  it("does not throw when every optional field (long body, closure, missing CVE/CWE) is present", async () => {
    const closed: FindingDetailRecord = {
      ...baseFinding,
      status: "closed",
      closure_reason: "already_fixed",
      closure_context: "Patched in release 4.2.",
      closed_at: 2,
      confidence: "medium",
      confidence_rationale: "Single environment tested.",
      counterevidence: "Could not reproduce on staging.",
      severity_change_conditions: "Would rise if mass-exploitable.",
      cve: undefined,
      cwe: undefined,
      // Markdown emphasis the renderer's stripMarkdown pass must not choke on.
      description:
        "**Confirmed** via `GET /api/invoices/other` — see ## notes.",
    };
    await expect(renderFindingPdf(closed)).resolves.toBeInstanceOf(Blob);
  });

  it("escapes severity into the header badge without throwing for every severity level", async () => {
    const severities: FindingDetailRecord["severity"][] = [
      "critical",
      "high",
      "medium",
      "low",
      "info",
    ];
    for (const severity of severities) {
      await expect(
        renderFindingPdf({ ...baseFinding, severity }),
      ).resolves.toBeInstanceOf(Blob);
    }
  });

  it("still exports when the Unicode font files cannot be fetched", async () => {
    // Regression guard for the Helvetica fallback: a failed /fonts request
    // (offline desktop, blocked asset) must degrade the glyphs, not the export.
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error("offline"));
    try {
      await expect(
        renderFindingPdf({
          ...baseFinding,
          description: "Oʻzbekcha matn va кириллица",
        }),
      ).resolves.toBeInstanceOf(Blob);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("lays out list items and label lines without throwing", async () => {
    await expect(
      renderFindingPdf({
        ...baseFinding,
        impact:
          "Summary line.\n1. First step\n- bullet item\nRoot Cause: missing owner check",
      }),
    ).resolves.toBeInstanceOf(Blob);
  });

  it("renders a markdown table as a grid instead of leaving literal pipe characters", async () => {
    // Regression: before table support, a field like the agent's endpoint
    // comparison table rendered as raw "| cell | cell |" prose lines instead
    // of an actual grid, unlike the finding page's markdown-rendered view.
    const withTable: FindingDetailRecord = {
      ...baseFinding,
      technical_analysis:
        "Comparing the two endpoints:\n\n| Request | Result |\n| --- | --- |\n| GET /api/draft/ (no credentials) | 401 |\n| POST /api/shares/ (no credentials) | 201 Created |\n\nThe second row proves the gap.",
    };
    const blob = await renderFindingPdf(withTable);
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(1000);
  });

  it("does not throw on a malformed table row with a mismatched cell count", async () => {
    const withRaggedTable: FindingDetailRecord = {
      ...baseFinding,
      technical_analysis:
        "| A | B | C |\n| --- | --- | --- |\n| only-one-cell |\n| x | y | z |",
    };
    await expect(renderFindingPdf(withRaggedTable)).resolves.toBeInstanceOf(
      Blob,
    );
  });
});
