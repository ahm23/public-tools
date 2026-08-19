# Requirements Explorer

An Electrobun desktop app for exploring and editing requirements specifications —
Word documents and Excel workbooks — as a structured table, with a collapsible
heading outline on the left.

Plain CSS (no Tailwind). React + Vite renderer, Bun/Cottontail main process,
Python converters spawned over a JSON-over-files protocol.

## What it does

- View a specification as a table: `Title | Type | ID | Text`
- Left navigation pane: heading tree (Word Heading 1–9 levels) with collapsible
  elements and per-section item counts
- Double-click any cell to edit: heading titles, requirement IDs, and text
- Add requirements (auto-suggested `REQ####` IDs) or headings below the selection
- Delete rows with a confirmation dialog (deleting a heading removes its subtree)
- Import from `.docx` or `.xlsx`, export to `.docx` or `.xlsx`

## Data model

A spec is an ordered list of blocks:

```json
{ "type": "heading", "level": 1, "title": "Functional Requirements" }
{ "type": "item", "kind": "requirement", "id": "REQ1001", "text": "…" }
```

Rules (matching `../docx-xlsx-converter/req-docx_to_xlsx.py`):

- Title is only meaningful on heading rows — items have a blank title.
- An item is a `requirement` when it has an ID or its text contains
  *shall / should / may*; otherwise `comment`.
- Heading levels survive DOCX ↔ JSON round-trips; XLSX flattens them (the
  4-column sheet has no level column).

## Getting started

Requires: Node 18+ and the Arch package `libayatana-appindicator`
(`sudo pacman -S libayatana-appindicator` on Arch; equivalent on other distros),
plus GTK3 / WebKitGTK 4.1 runtime libs.

```bash
npm install

# one-time: create the Python converter venv
python -m venv converters/.venv
converters/.venv/bin/pip install -r converters/requirements.txt

# dev (no HMR)
npm run dev

# dev with HMR
npm run dev:hmr

# typecheck / build
npm run typecheck
npm run build
```

The app spawns `converters/req_convert.py` from its venv — no system Python
packages are needed.

## Project structure

```
├── src/
│   ├── bun/index.ts            # Main process: window, RPC handlers, converter spawn
│   ├── mainview/               # React renderer (plain CSS)
│   │   ├── App.tsx
│   │   ├── ipc.ts              # typed RPC wrapper (+ browser fallback)
│   │   └── components/         # NavTree, SpecTable, EditableCell, Modal
│   └── shared/rpcSchema.ts     # RPC schema + spec types shared by both sides
├── converters/
│   ├── req_convert.py          # docx2json / json2docx / xlsx2json / json2xlsx
│   └── requirements.txt        # python-docx, openpyxl
└── electrobun.config.ts
```
