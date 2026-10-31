import sys
from pathlib import Path

path = Path(sys.argv[1])
suffix = path.suffix.lower()
if suffix == '.pdf':
    from pypdf import PdfReader
    text = '\n'.join(page.extract_text() or '' for page in PdfReader(path).pages)
elif suffix == '.docx':
    from docx import Document
    from docx.oxml.ns import qn
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    document = Document(path)
    blocks = []
    for child in document.element.body.iterchildren():
        if child.tag == qn('w:p'):
            blocks.append(Paragraph(child, document).text)
        elif child.tag == qn('w:tbl'):
            table = Table(child, document)
            blocks.extend('\t'.join(cell.text for cell in row.cells) for row in table.rows)
    text = '\n'.join(blocks)
else:
    text = path.read_text(encoding='utf-8', errors='replace')
print(text[:500_000])
