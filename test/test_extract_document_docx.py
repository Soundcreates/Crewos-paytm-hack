"""Focused regression check for DOCX table extraction and block ordering."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from docx import Document


EXTRACTOR = Path(__file__).resolve().parents[1] / 'backend' / 'scripts' / 'extract-document.py'


class DocxExtractionTest(unittest.TestCase):
    def test_paragraphs_and_table_rows_are_emitted_in_document_order(self):
        document = Document()
        document.add_paragraph('before table')
        table = document.add_table(rows=2, cols=2)
        table.cell(0, 0).text = 'first row left'
        table.cell(0, 1).text = 'first row right'
        table.cell(1, 0).text = 'second row left'
        table.cell(1, 1).text = 'second row right'
        document.add_paragraph('after table')

        with tempfile.TemporaryDirectory() as directory:
            docx_path = Path(directory) / 'sample.docx'
            document.save(docx_path)
            result = subprocess.run(
                [sys.executable, str(EXTRACTOR), str(docx_path)],
                check=True,
                capture_output=True,
                text=True,
            )

        self.assertEqual(
            result.stdout,
            'before table\n'
            'first row left\tfirst row right\n'
            'second row left\tsecond row right\n'
            'after table\n',
        )


if __name__ == '__main__':
    unittest.main()
