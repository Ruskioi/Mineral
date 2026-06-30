# Deploy Simba AI to your team (Microsoft 365 Centralized Deployment)

This is the easiest way to give a whole team Simba: an admin uploads the
manifest **once** in the Microsoft 365 admin center, assigns it to people or
groups, and Simba appears automatically in everyone's Excel **Home** ribbon — no
per-user install, no file passing, no Trust Center, no public store review.

There are two roles in this guide:

- **Whoever hosts it** (a developer) — does Part 1 once.
- **A Microsoft 365 Global Administrator** — does Part 2 once.

End users do nothing.

---

## How it fits together

```
Excel (every assigned user)
   │  loads the sidebar from your host (HTTPS)
   ▼
One Node service you host ──► Claude API
  - serves the sidebar (dist/)      (ANTHROPIC_API_KEY lives here, server-side)
  - serves /api  (the Claude proxy)
```

Simba runs as a **single service on one origin**: the same Node app serves the
sidebar *and* the `/api` backend. That means one thing to host, no CORS, and the
Anthropic API key never leaves the server. End users only ever load a manifest
that points at this host.

---

## Part 1 — Host the service (developer, once)

You need an HTTPS host that runs Node 18+ and lets you set an environment
variable. Anything works: Azure App Service, Render, Railway, Fly.io, a VM
behind a reverse proxy, etc. It must have a **valid CA-signed TLS certificate**
(the localhost dev cert won't do) — most platforms provide one automatically on
their `*.azurewebsites.net` / `*.onrender.com` / your custom domain.

1. **Build the sidebar** (same-origin, so leave the API base empty):

   ```bash
   npm install
   npm run build        # outputs dist/
   ```

2. **Deploy** the project to your host and start it with:

   ```bash
   node server/server.js
   ```

   - Set **`ANTHROPIC_API_KEY`** in the host's environment (not in a committed
     file). Optionally `SIMBA_MODEL` (defaults to `claude-opus-4-8`).
   - The host injects `PORT`; the server already honors it.
   - On boot you should see `serving the sidebar from .../dist (single-origin mode)`.
     If you see "API only", the `dist/` build wasn't deployed — run `npm run build`
     and include `dist/` in what you ship.

   > Tip: `npm run start:prod` does `build` then `node server/server.js` in one step.

3. **Confirm it's live** in a browser:
   - `https://YOUR_HOST/taskpane.html` → the sidebar UI loads
   - `https://YOUR_HOST/api/health` → `{"ok":true,"keyConfigured":true,...}`

   If `keyConfigured` is `false`, the `ANTHROPIC_API_KEY` env var isn't set on the host.

4. **Generate the production manifest** pointing at your host, with a fresh GUID:

   ```bash
   SIMBA_BASE_URL=https://YOUR_HOST npm run manifest:prod
   #  → manifest.prod.xml
   ```

   Validate it before handing it off:

   ```bash
   npx office-addin-manifest validate manifest.prod.xml
   ```

   Give `manifest.prod.xml` to your Global Administrator.

> **Recommended:** test the manifest yourself first by sideloading it in Excel on
> the web (Insert → Add-ins → Upload My Add-in) before org-wide deployment.

---

## Part 2 — Deploy to the org (Global Administrator, once)

1. Go to the **Microsoft 365 admin center**: <https://admin.microsoft.com>
2. **Settings → Integrated apps**.
3. Click **Upload custom apps**.
4. Choose **App type: Office Add-in**, then **Upload manifest file (.xml)** and
   select `manifest.prod.xml` (you can also point to a manifest URL instead).
5. **Assign users**: *Just me* (to pilot), *Specific users/groups*, or *Entire
   organization*.
6. Review the **permissions and capabilities** screen (Simba requests
   `ReadWriteDocument` — read/write the active workbook) and the host URL it
   loads from.
7. **Finish deployment**.

> Requires the **Global Administrator** role. Deployment propagates to users
> within a few hours (Microsoft allows up to 24h). Users may need to fully
> restart Excel once.

After it propagates, assigned users open Excel → **Home tab → Ask Simba** → the
sidebar opens. Done.

---

## Updating Simba later

- **Code / behavior / backend changes:** redeploy the host (Part 1, steps 1–3).
  Because the manifest only points at URLs, you do **not** need to re-upload the
  manifest for code changes — users get the new sidebar on next load.
- **Manifest changes** (name, icons, host URL, permissions): regenerate
  `manifest.prod.xml`, then in **Integrated apps** select the app → **Update**.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Add-in doesn't appear after deploying | Propagation delay (wait, then restart Excel). Confirm the user is in the assigned group. |
| Sidebar is blank / won't load | `https://YOUR_HOST/taskpane.html` not reachable, or TLS cert isn't CA-trusted. |
| **"Error loading add-in" in Excel even though the app appears** | The host isn't serving the built sidebar. First open `https://YOUR_HOST/taskpane.html` in a browser: if it 404s, `dist/` was never built/served. Root cause is almost always the **Start Command set to `npm start`** (that runs the *dev* webpack server, not production). Fix on the host: **Build** `npm ci && npm run build`, **Start** `node server/server.js` (or `npm run start:prod`); or switch the service to **Docker** (use the bundled `Dockerfile` / `render.yaml`). |
| First load is slow then errors, later loads work | Free-tier hosts (e.g. Render Free) spin down when idle; the cold start exceeds Excel's load timeout. Upgrade off the free plan, or hit `https://YOUR_HOST/api/health` once to wake it before opening Excel. |
| "Simba backend error" in the chat | `/api/health` shows `keyConfigured:false` → set `ANTHROPIC_API_KEY` on the host. |
| Upload rejected in Integrated apps | Run `npx office-addin-manifest validate manifest.prod.xml`; ensure no `localhost` URLs and a unique GUID (`--new-id`). |
| Host build fails with `webpack: not found` / "Exited with status 1" | The host set `NODE_ENV=production`, pruning devDependencies. This repo's `.npmrc` (`include=dev`) prevents that — make sure it's deployed. As a fallback, set `NPM_CONFIG_PRODUCTION=false` in the host env, or use build command `npm ci --include=dev && npm run build`. |
| Host build says `failed to read dockerfile` / uses a Docker runtime | The repo ships a `Dockerfile` (single-service: builds the sidebar, serves it + `/api`). Redeploy and it will be picked up. Alternatively switch the service to the **Node** runtime — build `npm install && npm run build`, start `node server/server.js`. Either way, set `ANTHROPIC_API_KEY` in the host environment. |
| Edits don't apply to the sheet | The user unchecked "Let Simba edit the sheet" in the sidebar. |

## Desktop app

`desktop/` is a thin Electron shell that opens the **same** Simba UI from the
**same** backend, so it's linked to the Excel add-in: same account, same memory
(when SSO is on), same model. It runs in *desktop mode* (chat, web search, memory,
OneDrive/SharePoint files, attachments); live worksheet editing stays in Excel.

```bash
cd desktop && npm install && npm start      # run
npm run dist                                # package an installer
SIMBA_URL=https://your-host/taskpane.html npm start   # point at your host
```

The hosted web UI auto-detects there's no Excel host and switches to desktop mode,
so no separate build is needed — see `desktop/README.md`.

## Performance / speed

Simba is tuned for fast answers:

- **Prompt caching** — the system prompt and tool definitions are cached, so every
  turn after the first skips re-processing them (lower latency and cost).
- **Speed preference** — users pick **Snabb / Balanserad / Noggrann** in Settings.
  Balanced (the default) uses `medium` thinking effort; Thorough uses `high`; Fast
  also enables Opus fast mode (~2.5× faster generation, premium token price; it
  falls back to standard speed automatically if the fast-mode rate limit is hit).
- Set the default with `SIMBA_SPEED` (`fast` | `balanced` | `thorough`) in the host env.

For the snappiest experience, keep the host off a free tier (free instances cold-start
slowly) and near your users' region.

## Microsoft 365 sign-in + cross-device memory (optional)

By default Simba's memory is stored per-device (in the browser). To make it follow
each user across devices, turn on Microsoft 365 single sign-on (SSO) and a database.
Everything degrades gracefully — if either piece is missing, Simba just keeps memory
on-device.

**1. Register an Azure AD app** (one-time, in your tenant — Entra admin center → App
registrations → New registration):
- Single tenant (or multitenant if your users span tenants).
- Under **Expose an API**: set the Application ID URI to `api://YOUR_HOST/CLIENT_ID`
  (e.g. `api://mineral-qd8c.onrender.com/<client-id>`), and add a scope named
  **`access_as_user`** (admins + users can consent).
- Under **API permissions**: add the delegated `profile`, `openid`, `email` scopes.
- Add the Office client app IDs as **authorized client applications** for the
  `access_as_user` scope (the well-known Office desktop/web app IDs from Microsoft's
  SSO docs), so Excel can request tokens silently.
- Copy the **Application (client) ID**.

**2. Bake the client id into the manifest** and re-upload it in Integrated Apps:

```bash
npm run manifest -- --base https://YOUR_HOST --aad <CLIENT_ID> --new-id --out manifest.prod.xml
```

This adds the required `<WebApplicationInfo>` block. Without `--aad`, the block is
omitted (SSO off).

**3. Provision Postgres and set env vars on the host:**
- `AAD_CLIENT_ID=<client-id>` — turns on token verification.
- `DATABASE_URL=postgres://…` — a free managed Postgres (Neon, Supabase, or Render).
  The `simba_memory` table is created automatically on first use.

**4. (Optional) OneDrive/SharePoint files** — to let Simba list/open the user's
Microsoft 365 files (`list_files` / `open_file`):
- In the Azure app, add the **delegated** Microsoft Graph permission **`Files.Read`**
  (grant admin consent), and create a **client secret**.
- Set `AAD_CLIENT_SECRET=<secret>` on the host. The server uses the on-behalf-of
  flow to exchange the user's SSO token for a Graph token — files are read with the
  signed-in user's own permissions, and the secret never leaves the server.
- Verify at `/api/health` → `"graphConfigured":true`.

Verify at `https://YOUR_HOST/api/health` → `{"ssoConfigured":true,"memoryStore":"postgres"}`.
Memory now syncs to each signed-in user and is keyed to their Microsoft identity.

## Scheduled server-side agent (optional)

Lets Simba run **recurring jobs that edit a OneDrive/SharePoint workbook on a
schedule even when no Excel window is open** — e.g. "every Monday 08:00, refresh
the dashboard with current FX and append today's totals". Users create jobs from
chat (`schedule_task`); the server runs them via Microsoft Graph and ExcelJS.

Because a job runs when the user is offline, it can't use their token — the app
authenticates **as itself**. So this needs extra setup on top of sign-in above:

1. **App-only Graph permission.** In the Azure app, add the **application**
   permission **`Files.ReadWrite.All`** (Microsoft Graph) and **grant admin
   consent**. (This is in addition to the delegated `Files.Read`.) The same
   client id + secret are reused.
2. **Pin the tenant.** Set `AAD_TENANT=<your-tenant-GUID>` (a concrete GUID, not
   `common`) — app-only tokens are minted per tenant.
3. **Durable jobs.** Set `DATABASE_URL` so schedules survive restarts (a
   `simba_jobs` table is created automatically).
4. **Turn it on, on ONE instance.** Set `SIMBA_SCHEDULER=1`. Enable it on a
   single replica only — two schedulers would run each job twice.

Verify in the server logs at boot: `[Simba] scheduled agent: on`. Caveat: ExcelJS
does not recalc formulas, so jobs should write concrete values for anything they
need to read back; formulas they write recalc when a person next opens the file.

## Notes on cost & security

The backend holds your Anthropic key and bills your account for every assigned
user's usage. Before a wide rollout, consider adding **auth, per-user rate
limiting, and logging** to `server/server.js` so usage stays bounded.

Fast mode bills output tokens at a premium rate — if cost matters more than
latency, set `SIMBA_SPEED=balanced` (the default) and leave Fast as an opt-in.
