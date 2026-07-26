"""
Convert a numbered-list DOCX to XLSX with columns: section, title, text.

Usage:
    python docx_to_xlsx.py thing.docx output.xlsx
"""

import sys
import re
from docx import Document
from docx.oxml.ns import qn
from openpyxl import Workbook


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
    """Check if a paragraph contains an image/drawing."""
    ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
    return len(paragraph._element.findall(f'.//{ns}drawing')) > 0


def is_figure_or_table_caption(text, bold_runs):
    """Return True if this is a Figure/Table caption to skip."""
    if not bold_runs:
        return False
    t = text.strip()
    return t.startswith('Figure') or t.startswith('Table')


def get_numbering_patterns(numbering_part):
    """
    Parse numbering definitions.
    Returns: numId -> {ilvl -> {'pattern': str, 'start': int}}
    """
    root = numbering_part._element
    patterns = {}

    for num in root.findall(qn('w:num')):
        num_id = int(num.get(qn('w:numId')))
        abs_id_el = num.find(qn('w:abstractNumId'))
        if abs_id_el is None:
            continue
        abs_id = int(abs_id_el.get(qn('w:val')))

        abs_num = root.find(f'.//{qn("w:abstractNum")}[@{qn("w:abstractNumId")}="{abs_id}"]')
        if abs_num is None:
            continue

        levels = {}
        for lvl in abs_num.findall(qn('w:lvl')):
            ilvl = int(lvl.get(qn('w:ilvl')))
            fmt_el = lvl.find(qn('w:numFmt'))
            fmt = fmt_el.get(qn('w:val')) if fmt_el is not None else 'bullet'
            lvlText_el = lvl.find(qn('w:lvlText'))
            lvlText = lvlText_el.get(qn('w:val')) if lvlText_el is not None else ''
            start_el = lvl.find(qn('w:start'))
            start = int(start_el.get(qn('w:val'))) if start_el is not None else 1
            levels[ilvl] = {'fmt': fmt, 'pattern': lvlText, 'start': start}

        # Apply overrides
        for override in num.findall(qn('w:lvlOverride')):
            o_ilvl = int(override.get(qn('w:ilvl')))
            start_el = override.find(qn('w:startOverride'))
            if start_el is not None and o_ilvl in levels:
                levels[o_ilvl]['start'] = int(start_el.get(qn('w:val')))

        patterns[num_id] = levels

    return patterns


def render_section(levels, counters, ilvl):
    """
    Render the section number for a paragraph at given ilvl.
    
    levels: dict from get_numbering_patterns(), for this numId
    counters: list of current counter values indexed by level [lvl0, lvl1, ...]
    ilvl: the level of the current paragraph
    
    The pattern for this ilvl uses %1, %2, etc. which reference counters
    at absolute level positions 0, 1, 2, ...
    """
    level_info = levels.get(ilvl)
    if not level_info:
        return ""
    
    pattern = level_info['pattern']
    
    # For bullet formats, don't render a section number
    if level_info['fmt'] == 'bullet':
        return ""
    
    def repl(m):
        idx = int(m.group(1)) - 1  # %1 -> index 0
        if 0 <= idx < len(counters) and counters[idx] > 0:
            return str(counters[idx])
        return "0"
    
    return re.sub(r'%(\d+)', repl, pattern)


def get_clean_text(paragraph):
    """Get paragraph text, replacing embedded images with '[IMAGE]'."""
    text = ''.join(r.text for r in paragraph.runs).strip()
    if has_drawing(paragraph):
        if text:
            text += " [IMAGE]"
        else:
            text = "[IMAGE]"
    return text


def convert_docx_to_xlsx(docx_path, xlsx_path):
    """Main conversion function."""
    doc = Document(docx_path)
    num_patterns = get_numbering_patterns(doc.part.numbering_part)
    
    rows = []
    current_title = ""
    current_body_parts = []
    
    def flush_current():
        nonlocal current_title, current_body_parts
        if current_title:
            body = "\n".join(current_body_parts).strip()
            rows.append((current_title, body))
        current_title = ""
        current_body_parts = []
    
    for para in doc.paragraphs:
        numId, ilvl = get_num_info(para)
        bold_runs = [r.text for r in para.runs if r.bold]
        bold_text = ''.join(bold_runs).strip()
        clean_text = get_clean_text(para)
        
        # Skip empty paragraphs with no numbering and no drawing
        if not clean_text and not has_drawing(para) and numId is None:
            continue
        
        # Skip figure/table captions entirely
        if is_figure_or_table_caption(clean_text, bold_runs):
            continue
        
        # Classify this paragraph
        is_header = (
            numId is not None and ilvl is not None
            and bold_text
            and numId == 1
            and num_patterns.get(numId, {}).get(ilvl, {}).get('fmt') == 'decimal'
        )
        
        if is_header:
            flush_current()
            current_title = clean_text
        
        elif numId == 2:
            # Bullet list (numId=2 -> abstractNum 0, bullets)
            current_body_parts.append(f"- {clean_text}")
        
        elif numId == 1 and num_patterns.get(numId, {}).get(ilvl, {}).get('fmt') == 'bullet':
            # Bullet from numId=1 (ilvl=5+)
            current_body_parts.append(f"- {clean_text}")
        
        elif numId is None and clean_text:
            # Plain body text
            current_body_parts.append(clean_text)
        
        elif has_drawing(para):
            # Image paragraph
            current_body_parts.append(clean_text)
        
        elif clean_text:
            # Catch-all for anything else
            current_body_parts.append(clean_text)
    
    flush_current()
    
    # Write XLSX
    wb = Workbook()
    ws = wb.active
    ws.title = "Specification"
    ws.append(["Title", "Type", "Text"])
    
    for title, text in rows:
        row_type = "Heading" if not text.strip() else "Requirement"
        ws.append([title, row_type, text])
    
    ws.column_dimensions['A'].width = 40
    ws.column_dimensions['B'].width = 14
    ws.column_dimensions['C'].width = 80
    wb.save(xlsx_path)
    
    print(f"Written {len(rows)} rows to {xlsx_path}")
    return rows


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    
    docx_path = sys.argv[1]
    xlsx_path = sys.argv[2] if len(sys.argv) > 2 else docx_path.replace('.docx', '.xlsx')
    
    rows = convert_docx_to_xlsx(docx_path, xlsx_path)
    
    print("\nPreview:")
    for i, (s, t, body) in enumerate(rows):
        bp = body[:80].replace('\n', '\\n')
        print(f"  {i+1:2d}. [{s:15s}] {t:40s} | {bp}")
