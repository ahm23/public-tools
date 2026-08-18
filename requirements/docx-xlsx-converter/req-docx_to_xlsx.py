"""
Convert a specification DOCX to XLSX.

Columns: Title, Type, ID, Text
* Title       - the heading string (no “/” path)
* Type        - "Requirement" if the body contains *shall*, *should* or *may*,
                "Heading"   if the body is empty,
                "Comment"   otherwise.
* ID          - the token that was stripped from the requirement text. 
                Empty for heading rows.
* Text        - body text; images become “[IMAGE]”, tables become “[TABLE]”.

Usage:
    python req-docx_to_xlsx.py input.docx [output.xlsx]
"""

import itertools
import re
import sys
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from docx.text.paragraph import Paragraph
from openpyxl import Workbook


#  Helper functions
# --------------------------------------------------------------------------- #
def get_num_info(paragraph):
    """Return (numId, ilvl) for a paragraph, or (None, None) if not numbered."""
    pPr = paragraph._element.find(qn('w:pPr'))
    if pPr is None:
        return None, None
    numPr = pPr.find(qn('w:numPr'))
    if numPr is None:
        return None, None
    ilvl_el = numPr.find(qn('w:ilvl'))
    numId_el = numPr.find(qn('w:numId'))
    ilvl = int(ilvl_el.get(qn('w:val'))) if ilvl_el is not None else None
    numId = int(numId_el.get(qn('w:val'))) if numId_el is not None else None
    return numId, ilvl


def has_drawing(paragraph):
    ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
    return len(paragraph._element.findall(f'.//{ns}drawing')) > 0


def get_bold_text(paragraph):
    """Return concatenated bold text of a paragraph (run‑level or style‑level)."""
    style_bold = False
    if paragraph.style and paragraph.style.font:
        style_bold = paragraph.style.font.bold is True

    parts = []
    for r in paragraph.runs:
        if (r.bold is True) or (r.font.bold is True) or style_bold:
            parts.append(r.text)
    return ''.join(parts).strip()


def is_figure_or_table_caption(text, bold_text):
    """Return True if the paragraph looGDIR4510ks like a Figure/Table caption."""
    if not bold_text:
        return False
    t = text.strip()
    return t.startswith('Figure') or t.startswith('Table')


def get_clean_text(paragraph):
    """Plain paragraph text, with “[IMAGE]” placeholder when needed."""
    text = ''.join(r.text for r in paragraph.runs).strip()
    if has_drawing(paragraph):
        text = f"{text} [IMAGE]" if text else "[IMAGE]"
    return text


def is_heading(paragraph):
    """
    Detect Word's built‑in Heading styles.
    Returns (True, level) for Heading 1 … Heading 9, else (False, None).
    """
    if paragraph.style and paragraph.style.name:
        name = paragraph.style.name
        if name.startswith('Heading'):
            try:
                level = int(''.join(filter(str.isdigit, name)))
                if 1 <= level <= 9:
                    return True, level
            except ValueError:
                pass
    return False, None


#  Regex for the external‑ID token  (e.g. [REQ4510])
# --------------------------------------------------------------------------- #
TOKEN_RE = re.compile(r'\[([A-Z]{4}\d{4})\]')


def split_and_append(text: str, rows: list, title: str):
    """
    Split *text* on every ``[AAAA####]`` token.

    * ``title`` - the current heading string
    * ``rows``  - list that receives (title, external_id, body) triples.
    """
    matches = list(TOKEN_RE.finditer(text))

    # No token at all → a normal row (maybe a comment)
    if not matches:
        rows.append((title, "", text.strip()))
        return

    # Text that appears before the first token (if any)
    leading = text[:matches[0].start()].strip()
    if leading and leading != title:          # avoid a duplicate‑heading row
        rows.append((title, "", leading))

    # Process each token and its following body
    for i, m in enumerate(matches):
        ext_id = m.group(1)                                   # without brackets
        start = m.end()
        # end of this token’s body = start of next token (if any)
        end = matches[i + 1].start() if i + 1 < len(matches) else None
        body = text[start:end].strip() if end is not None else text[start:].strip()
        rows.append((title, ext_id, body))


#  Main conversion function
# --------------------------------------------------------------------------- #
def convert_docx_to_xlsx(docx_path: str, xlsx_path: str):
    doc = Document(docx_path)

    # rows will store (title, external_id, text)
    rows = []
    current_title = ""           # most recent heading string
    current_body_parts = []      # raw body lines collected until next heading
    heading_stack = []           # kept for possible future hierarchical use

    def flush_current():
        """Write out the heading row and any accumulated body (splitting tokens)."""
        nonlocal current_title, current_body_parts
        if current_title:
            # 1. Heading row - empty Text and External ID
            rows.append((current_title, "", ""))

            # 2. Body rows - may become many rows after token split
            body = "\n".join(current_body_parts).strip()
            if body:
                split_and_append(body, rows, current_title)

        # Reset for the next heading
        current_body_parts = []

    # Walk the document in source order (paragraphs + tables)
    for child in doc.element.body.iterchildren():
        # 1. Paragraph (<w:p>)
        if child.tag == qn('w:p'):
            para = Paragraph(child, doc)      # low‑level Paragraph object

            numId, ilvl = get_num_info(para)
            bold_text   = get_bold_text(para)
            clean_text  = get_clean_text(para)

            # ---- skip truly empty paragraphs --------------------------------
            if not clean_text and not has_drawing(para) and numId is None:
                continue

            # ---- skip figure/table captions ---------------------------------
            if is_figure_or_table_caption(clean_text, bold_text):
                continue

            # ---- heading detection (style‑based only) -----------------------
            is_hd, hd_level = is_heading(para)

            if is_hd:
                flush_current()
                while len(heading_stack) >= hd_level:
                    heading_stack.pop()
                heading_stack.append(clean_text)
                current_title = clean_text
                continue

            # ---- numbered requirement items (still supported) --------------
            if numId is not None:
                current_body_parts.append(f"- {clean_text}")
                continue

            # ---- plain body text (or image paragraph) ----------------------
            if clean_text:
                current_body_parts.append(clean_text)
                continue

            # ---- fallback (rare) --------------------------------------------
            current_body_parts.append(clean_text)

        # 2. Table (<w:tbl>) - replace with placeholder "[TABLE]"
        elif child.tag == qn('w:tbl'):
            placeholder = "[TABLE]"
            if not current_title:
                # Table before any heading becomes its own heading
                current_title = placeholder
                flush_current()
            else:
                current_body_parts.append(placeholder)

        # Anything else (e.g. sectPr) is ignored
        else:
            continue

    # End of document ------------------------------------------------------ #
    flush_current()


    # Write the XLSX file (four columns)
    # ------------------------------------------------------------------- #
    wb = Workbook()
    ws = wb.active
    ws.title = "Specification"
    ws.append(["Title", "Type", "External ID", "Text"])

    for title, ext_id, text in rows:
        # Decide the “Type” column
        if not text.strip() and not ext_id:          # pure heading
            row_type = "Heading"
            text = title                             # show heading text in Text col
        elif ext_id:                                 # any external ID → Requirement
            row_type = "Requirement"
            title = ""                               # requirement rows have blank Title
        else:                                        # normal content rows
            title = ""
            lowered = text.lower()
            if any(w in lowered for w in ("shall", "should", "may")):
                row_type = "Requirement"
            else:
                row_type = "Comment"

        # Write data to XLSX
        ws.append([title, row_type, ext_id, text])

    # nice column widths
    ws.column_dimensions['A'].width = 40   # Title
    ws.column_dimensions['B'].width = 14   # Type
    ws.column_dimensions['C'].width = 18   # External ID
    ws.column_dimensions['D'].width = 80   # Text

    wb.save(xlsx_path)
    print(f"[!!] Written {len(rows)} rows to {xlsx_path}")
    return rows



#  CLI entry point
# --------------------------------------------------------------------------- #
if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    docx_path = sys.argv[1]
    xlsx_path = (
        sys.argv[2]
        if len(sys.argv) > 2
        else str(Path(docx_path).with_suffix('.xlsx'))
    )

    print(f"Reading {docx_path} …")
    rows = convert_docx_to_xlsx(docx_path, xlsx_path)

    # Diagnostics when nothing was produced
    # --------------------------------------------------------------- #
    if not rows:
        print("\n[!!] No rows produced - diagnostic dump of first 30 elements:")
        doc = Document(docx_path)
        for i, child in enumerate(itertools.islice(doc.element.body.iterchildren(), 30)):
            tag = child.tag.split('}')[-1]   # strip namespace
            txt = "(no text)"
            if tag == 'p':
                para = Paragraph(child, doc)
                txt = ''.join(r.text for r in para.runs)[:70] or "(empty)"
            elif tag == 'tbl':
                txt = "[TABLE]"
            print(f" [{i:02d}] {tag:4} → {repr(txt)}")
        print("\nVerify that your document really contains headings, "
              "numbered items, or tables as expected.")
    else:
        print("\n[!!] Preview (first 10 rows):")
        for i, (title, ext_id, body) in enumerate(rows[:10]):
            typ = "Heading" if not body.strip() and not ext_id else (
                "Requirement" if ext_id or any(w in body.lower()
                                              for w in ("shall", "should", "may"))
                else "Comment")
            preview = body.replace('\n', '\\n')[:80]
            print(f" {i+1:02d}. [{typ:11}] {title:30} | {ext_id:10} | {preview}")