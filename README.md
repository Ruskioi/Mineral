# 🐶 Simba AI — Excel Add-in

An AI assistant **sidebar inside Microsoft Excel**, in the same spirit as Claude's
Excel side panel. Simba's mascot is a Pomeranian. Open the task pane, chat with Simba about your data, and let it
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

## Deploy to a team (recommended)

The easiest rollout for coworkers on one Microsoft 365 tenant: host Simba as a
**single service**, then a Global Admin uploads the manifest once via the M365
admin center (**Integrated Apps**) and assigns it — Simba appears in everyone's
Excel ribbon automatically, no per-user setup.

**👉 Full step-by-step: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**

Short version:

```bash
# 1. Build the sidebar (same origin — leave SIMBA_API_BASE empty)
npm run build

# 2. Deploy the project to one HTTPS Node host and start it:
node server/server.js        # serves BOTH the sidebar and /api on one origin
#    set ANTHROPIC_API_KEY in the host's environment

# 3. Generate the production manifest pointing at that host (fresh GUID)
SIMBA_BASE_URL=https://YOUR_HOST npm run manifest:prod   # → manifest.prod.xml

# 4. Global Admin: admin.microsoft.com → Settings → Integrated apps →
#    Upload custom apps → manifest.prod.xml → assign users → deploy
```

Office requires **HTTPS** with a real CA-signed cert for every manifest URL (the
`localhost` dev cert is dev-only). When `dist/` is present, `server/server.js`
serves the front-end and the `/api` proxy on the **same origin**, so there's one
thing to host, no CORS, and the API key stays server-side.

### Other distribution options
- **Sideload** a single user: Excel on the web → Insert → Add-ins → *Upload My
  Add-in* → `manifest.prod.xml` (no admin, no tooling).
- **AppSource** (public store): also needs a privacy policy, support URL, real
  icons, and Partner Center validation.

### Manifest configuration
`manifest.xml` stays the localhost dev manifest. `manifest.template.xml` +
`scripts/make-manifest.mjs` generate host-specific manifests
(`npm run manifest` with `--base`, `--id`, `--new-id`, `--out`).

### Before a wide rollout
The backend holds your Anthropic key and bills your account for every user's
usage — add **auth, rate limiting, and logging** to `server/server.js` first.

## License

MIT
