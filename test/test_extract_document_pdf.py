"""Focused regression check for PDF text extraction."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


EXTRACTOR = Path(__file__).resolve().parents[1] / 'backend' / 'scripts' / 'extract-document.py'


def sample_pdf(text):
    literal = text.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)').encode('ascii')
    content = b'BT /F1 12 Tf 72 720 Td (' + literal + b') Tj ET'
    stream = b'<< /Length ' + str(len(content)).encode() + b' >>\nstream\n' + content + b'\nendstream'
    objects = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        stream,
    ]
    pdf = bytearray(b'%PDF-1.4\n')
    offsets = [0]
    for index, item in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf.extend(f'{index} 0 obj\n'.encode() + item + b'\nendobj\n')
    xref = len(pdf)
    pdf.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:
        pdf.extend(f'{offset:010d} 00000 n \n'.encode())
    pdf.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    return bytes(pdf)


class PdfExtractionTest(unittest.TestCase):
    def test_extracts_text_from_a_pdf_page(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf_path = Path(directory) / 'refund-policy.pdf'
            pdf_path.write_bytes(sample_pdf('Refunds over $500 require manager approval.'))
            result = subprocess.run(
                [sys.executable, str(EXTRACTOR), str(pdf_path)],
                check=True,
                capture_output=True,
                text=True,
            )

        self.assertIn('Refunds over $500 require manager approval.', result.stdout)


if __name__ == '__main__':
    unittest.main()
