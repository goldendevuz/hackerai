"""Build the shipped example spec and check the PDF is produced and paginated."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import unittest.mock

HERE = Path(__file__).parent
HAS_REPORTLAB = importlib.util.find_spec("reportlab") is not None


@unittest.skipUnless(HAS_REPORTLAB, "reportlab is only installed in the sandbox image")
class BuildReportTest(unittest.TestCase):
    def load(self):
        spec = importlib.util.spec_from_file_location("hackerai_report", HERE / "hackerai_report.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_example_spec_builds_a_multi_page_pdf(self):
        module = self.load()
        spec = json.loads((HERE / "hackerai_report_example.json").read_text())
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "report.pdf"
            module.build_report(spec, str(out))
            data = out.read_bytes()
        self.assertTrue(data.startswith(b"%PDF"))
        self.assertGreaterEqual(data.count(b"/Type /Page\n") + data.count(b"/Type /Page "), 2)

    def test_non_latin_text_and_blank_code_lines_do_not_break_the_build(self):
        module = self.load()
        spec = {
            "title": "Oʻzbekcha sarlavha — Кириллица",
            "sections": [{"heading": "Dalil", "blocks": [{"code": "a\n\n\nb"}, {"p": "gʻalaba **qalin** `kod`"}]}],
        }
        with tempfile.TemporaryDirectory() as tmp:
            module.build_report(spec, str(Path(tmp) / "r.pdf"))

    def test_summary_panel_widens_the_label_column_for_long_labels(self):
        # Regression: a fixed 20mm label column broke "Tuzatish" mid-word
        # ("Tuzatis" / "h" on the next line) instead of fitting it on one
        # line. The column must now grow with the widest label.
        module = self.load()
        from reportlab.lib.units import mm

        narrow = module.summary_panel([["Nima", "x"], ["Ta'sir", "x"]], module.ORANGE)
        wide = module.summary_panel(
            [["Nima", "x"], ["Ta'sir", "x"], ["Tuzatish", "x"]], module.ORANGE
        )
        self.assertGreater(wide._colWidths[0], narrow._colWidths[0])
        self.assertLessEqual(wide._colWidths[0], 45 * mm)

    def test_register_fonts_warns_instead_of_silently_falling_back(self):
        # When fonts-dejavu-core isn't present, Helvetica can't render
        # Uzbek oʻ/gʻ or Cyrillic -- this used to fail silently, producing
        # a report with garbled glyphs and no diagnostic anywhere.
        module = self.load()
        with unittest.mock.patch.object(module, "FONT_DIRS", ["/nonexistent"]):
            captured = io.StringIO()
            with contextlib.redirect_stderr(captured):
                result = module.register_fonts()
        self.assertEqual(result, ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Courier"))
        self.assertIn("fonts-dejavu-core not found", captured.getvalue())

    def test_unknown_block_type_is_rejected(self):
        module = self.load()
        spec = {"title": "t", "sections": [{"heading": "h", "blocks": [{"video": "x"}]}]}
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(ValueError):
            module.build_report(spec, str(Path(tmp) / "r.pdf"))


if __name__ == "__main__":
    unittest.main()
