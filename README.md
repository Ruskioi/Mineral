# 🦁 Simba AI — Excel Add-in

An AI assistant **sidebar inside Microsoft Excel**, in the same spirit as Claude's
Excel side panel. Open the task pane, chat with Simba about your data, and let it
read ranges, write values, and drop in formulas for you — all powered by the
Claude API (`claude-opus-4-8`).

![sidebar](assets/icon-128.png)

## What it does

- **Chat sidebar** docked next to your spreadsheet.
- **Reads your sheet** — current selection, any range, or the used range.
- **Edits your sheet** — writes values and broadcasts formulas (toggleable).
- **Agentic tool use** — Claude decides when to read/write; the task pane executes
  those actions through the Office.js Excel API.
- **Key stays server-side** — a small Node backend proxies the Claude API so your
  Anthropic key never ships to the browser.

## Architecture

```
┌──────────────────────────┐        ┌─────────────────────┐        ┌────────────┐
│  Excel task pane (sidebar)│  /api  │  Simba backend       │  SDK   │  Claude    │
│  src/taskpane/*           │ ─────▶ │  server/server.js    │ ─────▶ │  API       │
│  - chat UI                │ ◀───── │  - holds API key     │ ◀───── │ (opus-4-8) │
│  - executes Excel tools   │        │  - declares tools    │        └────────────┘
│    via Office.js          │        │  - returns blocks    │
└──────────────────────────┘        └─────────────────────┘
```

Claude requests a tool (e.g. `read_range`, `set_formula`); the backend relays the
request; the **task pane** runs it against the live workbook with Office.js and
sends the result back. The loop repeats until Claude has a final answer.

| Tool | Action in Excel |
|------|-----------------|
| `get_selection` | Read the user's current selection |
| `read_range` | Read any A1-style range |
| `write_range` | Write a 2D array of values |
| `set_formula` | Broadcast one formula across a range |
| `get_sheet_info` | Active sheet name + used range |

## Project layout

```
manifest.xml            Office Add-in manifest (registers the sidebar + ribbon button)
src/taskpane/           The sidebar: HTML, CSS, Office.js + chat/agent loop
src/commands/           Ribbon command entry point (required by the manifest)
server/server.js        Backend proxy to the Claude API (tools declared here)
assets/                 Add-in icons
webpack.config.js       Builds the task pane, serves HTTPS, proxies /api → backend
```

## Setup

Prerequisites: Node 18+ and Excel (desktop, or Excel on the web).

```bash
# 1. Install dependencies
npm install

# 2. Add your Anthropic API key
cp .env.example .env
#   then edit .env and set ANTHROPIC_API_KEY=sk-ant-...

# 3. Trust the local HTTPS dev certificate (one-time; Office requires HTTPS)
npm run dev-certs

# 4. Run the web (task pane) and the backend together
npm start
```

`npm start` runs two things via `concurrently`:
- the webpack dev server on **https://localhost:3000** (serves the task pane), and
- the Simba backend on **http://localhost:3001** (the dev server proxies `/api` to it).

### Load the add-in into Excel

Easiest path:

```bash
npm run sideload
```

This launches Excel and sideloads `manifest.xml`. Then click **Home → Ask Simba**
to open the sidebar.

To sideload manually instead, see Microsoft's guide:
<https://learn.microsoft.com/office/dev/add-ins/testing/sideload-office-add-ins-for-testing>
(or, on Excel for the web: *Insert → Add-ins → Upload My Add-in → manifest.xml*).

## Usage

1. Select some cells.
2. Open **Ask Simba** from the Home tab.
3. Try:
   - "Summarize the selected range."
   - "Add a column that multiplies B by C."
   - "Write a SUM formula for column D under the data."
   - "Find and highlight duplicate rows." *(reads + reasons; ask for the steps)*

Uncheck **"Let Simba edit the sheet"** to keep it read-only — it'll explain
formulas instead of applying them.

## Deploy & sideload anywhere (production)

Office requires **HTTPS** for every manifest URL — in dev (the `localhost` dev
cert) and in production (a real CA-signed cert). Two things get hosted:

- **Front-end** — the built `dist/` (static files): any HTTPS static host
  (Azure Static Web Apps, Vercel, Netlify, Cloudflare Pages, S3+CloudFront).
- **Backend** — `server/server.js` (holds the API key): any HTTPS runtime
  (Azure App Service, Render, Fly.io, Railway, AWS, Cloudflare Workers).

The backend base URL and the manifest host are both configurable — no
hand-editing:

```bash
# 1. Build the task pane, pointing it at your hosted backend.
#    Omit SIMBA_API_BASE if the backend is same-origin as the front-end.
SIMBA_API_BASE=https://simba-api.example.com npm run build
#    → dist/ (deploy these static files to your HTTPS front-end host)

# 2. Generate a production manifest for your front-end domain, with a fresh GUID.
SIMBA_BASE_URL=https://simba.example.com npm run manifest:prod
#    → manifest.prod.xml (gitignored)

# 3. Deploy server/ to your backend host with ANTHROPIC_API_KEY set in its env.

# 4. Sideload manifest.prod.xml into Excel — or distribute it org-wide via the
#    Microsoft 365 admin center → Integrated Apps (no public store needed).
```

`manifest.xml` stays the localhost dev manifest. `manifest.template.xml` +
`scripts/make-manifest.mjs` generate host-specific manifests (`npm run manifest`
with `--base`, `--id`, `--new-id`, `--out`).

### Production checklist
- Backend behind real HTTPS with `ANTHROPIC_API_KEY` set server-side (never shipped to the browser).
- Fresh `<Id>` GUID (`--new-id` does this) and no `localhost` URLs in the production manifest.
- The backend is intentionally minimal — add **auth, rate limiting, and logging**
  before exposing it publicly so others can't run up your Anthropic usage.
- For the public **AppSource** store you'd additionally need a privacy policy,
  support URL, real icons, and to pass Partner Center validation. Sideloading and
  M365 Integrated Apps deployment do not require store review.

## License

MIT
