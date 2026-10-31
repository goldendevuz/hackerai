#!/usr/bin/env python3
"""Build a professional security-report PDF from a JSON spec.

    python3 /usr/local/lib/hackerai/hackerai_report.py spec.json report.pdf

or `from hackerai_report import build_report`. The layout is fixed on purpose:
the agent supplies content, this module owns the design, so every report looks
the same. Spec (all keys but title/sections optional):

    {
      "title": "...", "subtitle": "target URL or one-line scope",
      "badge": {"label": "CRITICAL 9.1", "tone": "critical|high|medium|low|info|success"},
      "footer": "Report name shown on every page",
      "summary": [["What", "..."], ["Impact", "..."], ["Fix", "..."]],
      "meta": [["Endpoint", "/login"], ["CWE", "CWE-89"]],
      "sections": [{"heading": "...", "blocks": [
          {"p": "text with **bold** and `code`"},
          {"ol": ["step", "step"]}, {"ul": ["item"]},
          {"code": "raw text", "caption": "optional"},
          {"image": "/path/to.png", "caption": "optional"}]}]
    }

Design rules (do not override): no cover page, left-aligned text, one Unicode
font family, gray monospace blocks, at most one summary callout, consistent
footer with page x of y.
"""
import json
import os
import re
import sys
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader, simpleSplit
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.pdfmetrics import registerFontFamily
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as pdfcanvas
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    CondPageBreak,
    HRFlowable,
    Image,
    KeepTogether,
    PageTemplate,
    Paragraph,
    Preformatted,
    Spacer,
    Table,
    TableStyle,
)

NAVY = colors.HexColor("#111827")
ORANGE = colors.HexColor("#EA580C")
TEXT = colors.HexColor("#1F2937")
MUTED = colors.HexColor("#6B7280")
PANEL = colors.HexColor("#F3F4F6")
RULE = colors.HexColor("#E5E7EB")
TONES = {
    "critical": "#EF4444",
    "high": "#F97316",
    "medium": "#EAB308",
    "low": "#3B82F6",
    "info": "#64748B",
    "success": "#16A34A",
}

PAGE_W, PAGE_H = A4
MARGIN = 16 * mm
CONTENT_W = PAGE_W - 2 * MARGIN
CODE_SIZE = 8.5
SHORT_CODE_LINES = 18  # blocks up to this long are never split across pages

FONT_DIRS = ["/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu"]


def register_fonts():
    """DejaVu covers Latin, Cyrillic and Uzbek's oʻ/gʻ; Helvetica is the fallback.

    Only the three files shipped in fonts-dejavu-core are required; there is no
    italic face, so captions use the regular face in a muted color.
    """
    for directory in FONT_DIRS:
        paths = {
            "Sans": "DejaVuSans.ttf",
            "Sans-Bold": "DejaVuSans-Bold.ttf",
            "Mono": "DejaVuSansMono.ttf",
        }
        if all(os.path.exists(os.path.join(directory, f)) for f in paths.values()):
            for name, file in paths.items():
                pdfmetrics.registerFont(TTFont(name, os.path.join(directory, file)))
            registerFontFamily("Sans", normal="Sans", bold="Sans-Bold", italic="Sans", boldItalic="Sans-Bold")
            return "Sans", "Sans-Bold", "Sans", "Mono"
    return "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Courier"


SANS, BOLD, ITALIC, MONO = register_fonts()


def styles():
    base = dict(fontName=SANS, textColor=TEXT, alignment=TA_LEFT)
    return {
        "body": ParagraphStyle("body", fontSize=10, leading=14.5, spaceAfter=5, **base),
        "heading": ParagraphStyle(
            "heading", fontName=BOLD, fontSize=13, leading=16, textColor=ORANGE, spaceBefore=12, spaceAfter=2
        ),
        "label": ParagraphStyle("label", fontName=BOLD, fontSize=9.5, leading=13, textColor=NAVY),
        "cell": ParagraphStyle("cell", fontSize=9.5, leading=13, **base),
        "caption": ParagraphStyle(
            "caption", fontName=ITALIC, fontSize=8.5, leading=11, textColor=MUTED, spaceBefore=3, spaceAfter=8
        ),
        "mono": ParagraphStyle("mono", fontName=MONO, fontSize=CODE_SIZE, leading=11, textColor=TEXT),
    }


ST = styles()


def inline(text):
    """Escape, then apply the tiny **bold** / `code` markup the spec allows."""
    out = escape(str(text))
    out = re.sub(r"`([^`]+)`", lambda m: f'<font name="{MONO}" size="9">{m.group(1)}</font>', out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", out)
    return out


def para(text, style="body"):
    return Paragraph(inline(text), ST[style])


def items(entries, ordered):
    rows = [
        [Paragraph(f"{i}." if ordered else "•", ST["cell"]), Paragraph(inline(e), ST["body"])]
        for i, e in enumerate(entries, 1)
    ]
    table = Table(rows, colWidths=[7 * mm, CONTENT_W - 7 * mm])
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    return table


def code_block(text):
    """Gray monospace panel; one fixed-height row per line so long blocks split
    cleanly and blank lines keep their height."""
    char_w = pdfmetrics.stringWidth("M", MONO, CODE_SIZE)
    per_line = max(20, int((CONTENT_W - 8 * mm) / char_w))
    lines = []
    for raw in str(text).strip("\n").split("\n"):
        raw = raw.expandtabs(4)
        lines.extend([raw[i : i + per_line] for i in range(0, len(raw), per_line)] or [""])
    leading = ST["mono"].leading
    pad = 3 * mm
    # Padding is separate rows: fixed-height rows would otherwise absorb it.
    rows = (
        [[Spacer(1, pad)]]
        + [[Preformatted(line, ST["mono"]) if line.strip() else Spacer(1, leading)] for line in lines]
        + [[Spacer(1, pad)]]
    )
    table = Table(rows, colWidths=[CONTENT_W], rowHeights=[pad] + [leading] * len(lines) + [pad])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), PANEL),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4 * mm),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4 * mm),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    table.short = len(lines) <= SHORT_CODE_LINES
    return table


def image_block(path):
    w, h = ImageReader(path).getSize()
    scale = min(CONTENT_W / w, 95 * mm / h, 1.0)
    return Image(path, width=w * scale, height=h * scale)


def block_flowables(block):
    """Returns (flowables, keep_together). Short code and images never split."""
    keep = False
    if "p" in block:
        out = [para(block["p"])]
    elif "ol" in block:
        out = [items(block["ol"], True), Spacer(1, 5)]
    elif "ul" in block:
        out = [items(block["ul"], False), Spacer(1, 5)]
    elif "code" in block:
        table = code_block(block["code"])
        keep = table.short
        out = [table, Spacer(1, 6)]
    elif "image" in block:
        out = [image_block(block["image"])]
        keep = True
    else:
        raise ValueError(f"Unknown block: {list(block)}")
    if block.get("caption"):
        out.append(para(block["caption"], "caption"))
    return out, keep


def section_flowables(section):
    head = [
        Paragraph(inline(section["heading"]), ST["heading"]),
        HRFlowable(width=28 * mm, thickness=1.2, color=ORANGE, hAlign="LEFT", spaceBefore=1, spaceAfter=5),
    ]
    units = [block_flowables(b) for b in section.get("blocks", [])]
    if not units:
        return head
    out = []
    for i, (parts, keep) in enumerate(units):
        if i == 0:
            # The heading always travels with the start of its content.
            out += [KeepTogether(head + parts)] if keep else [CondPageBreak(35 * mm)] + head + parts
        else:
            out += [KeepTogether(parts)] if keep else parts
    return out


def summary_panel(rows, accent):
    data = [[Paragraph(inline(k), ST["label"]), Paragraph(inline(v), ST["cell"])] for k, v in rows]
    table = Table(data, colWidths=[20 * mm, CONTENT_W - 20 * mm])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), PANEL),
                ("LINEBEFORE", (0, 0), (0, -1), 3, accent),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4 * mm),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                ("TOPPADDING", (0, 0), (-1, 0), 4 * mm),
                ("BOTTOMPADDING", (0, -1), (-1, -1), 4 * mm),
            ]
        )
    )
    return table


def meta_table(rows):
    data = [[Paragraph(inline(k), ST["label"]), Paragraph(inline(v), ST["cell"])] for k, v in rows]
    table = Table(data, colWidths=[32 * mm, CONTENT_W - 32 * mm])
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 2.5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
                ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
            ]
        )
    )
    return table


def badge(label, color):
    cell = Paragraph(
        f'<font color="white"><b>{escape(label)}</b></font>',
        ParagraphStyle("badge", fontName=BOLD, fontSize=10.5, leading=13, alignment=1),
    )
    width = pdfmetrics.stringWidth(label, BOLD, 10.5) + 12 * mm
    table = Table([[cell]], colWidths=[width], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), color),
                ("ROUNDEDCORNERS", [4, 4, 4, 4]),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return table


class NumberedCanvas(pdfcanvas.Canvas):
    """Two-pass canvas so the footer can say "Page x of y"."""

    footer = ""
    running_title = ""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved = []

    def showPage(self):
        self._saved.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._saved)
        for state in self._saved:
            self.__dict__.update(state)
            self._draw_chrome(total)
            super().showPage()
        super().save()

    def _draw_chrome(self, total):
        self.setFont(SANS, 7.5)
        self.setFillColor(MUTED)
        self.drawString(MARGIN, 10 * mm, self.footer)
        self.drawRightString(PAGE_W - MARGIN, 10 * mm, f"Page {self._pageNumber} of {total}")
        if self._pageNumber > 1 and self.running_title:
            self.setStrokeColor(RULE)
            self.line(MARGIN, PAGE_H - 12 * mm, PAGE_W - MARGIN, PAGE_H - 12 * mm)
            self.drawString(MARGIN, PAGE_H - 9.5 * mm, self.running_title[:110])


def build_report(spec, out_path):
    tone = (spec.get("badge") or {}).get("tone", "info")
    accent = colors.HexColor(TONES.get(tone, TONES["info"]))
    title, subtitle = spec["title"], spec.get("subtitle", "")

    title_lines = simpleSplit(title, BOLD, 17, CONTENT_W)
    sub_lines = simpleSplit(subtitle, SANS, 9.5, CONTENT_W) if subtitle else []
    band = (14 + 7.5 * len(title_lines) + 4.6 * len(sub_lines) + 6) * mm

    def first_page(canv, doc):
        canv.setFillColor(NAVY)
        canv.rect(0, PAGE_H - band, PAGE_W, band, stroke=0, fill=1)
        canv.setFillColor(accent)
        canv.rect(0, PAGE_H - band - 2.5 * mm, PAGE_W, 2.5 * mm, stroke=0, fill=1)
        canv.setFillColor(colors.white)
        y = PAGE_H - 16 * mm
        canv.setFont(BOLD, 17)
        for line in title_lines:
            canv.drawString(MARGIN, y, line)
            y -= 7.5 * mm
        canv.setFont(SANS, 9.5)
        y -= 1 * mm
        for line in sub_lines:
            canv.drawString(MARGIN, y, line)
            y -= 4.6 * mm

    NumberedCanvas.footer = spec.get("footer", title)[:100]
    NumberedCanvas.running_title = title

    doc = BaseDocTemplate(
        out_path,
        pagesize=A4,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        title=title,
        author="HackerAI",
    )
    first = Frame(MARGIN, 18 * mm, CONTENT_W, PAGE_H - band - 2.5 * mm - 18 * mm - 8 * mm, id="first", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    later = Frame(MARGIN, 18 * mm, CONTENT_W, PAGE_H - 18 * mm - 18 * mm, id="later", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates(
        [
            PageTemplate(id="first", frames=[first], onPage=first_page, autoNextPageTemplate="later"),
            PageTemplate(id="later", frames=[later]),
        ]
    )

    story = []
    if spec.get("badge"):
        story += [badge(spec["badge"]["label"], accent), Spacer(1, 5 * mm)]
    if spec.get("summary"):
        story += [summary_panel(spec["summary"], accent), Spacer(1, 4 * mm)]
    if spec.get("meta"):
        story += [meta_table(spec["meta"]), Spacer(1, 2 * mm)]
    for section in spec["sections"]:
        story += section_flowables(section)

    doc.build(story, canvasmaker=NumberedCanvas)
    return out_path


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: hackerai_report.py spec.json out.pdf")
    with open(sys.argv[1], encoding="utf-8") as f:
        print(build_report(json.load(f), sys.argv[2]))
