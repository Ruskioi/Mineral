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
| "Simba backend error" in the chat | `/api/health` shows `keyConfigured:false` → set `ANTHROPIC_API_KEY` on the host. |
| Upload rejected in Integrated apps | Run `npx office-addin-manifest validate manifest.prod.xml`; ensure no `localhost` URLs and a unique GUID (`--new-id`). |
| Host build fails with `webpack: not found` / "Exited with status 1" | The host set `NODE_ENV=production`, pruning devDependencies. This repo's `.npmrc` (`include=dev`) prevents that — make sure it's deployed. As a fallback, set `NPM_CONFIG_PRODUCTION=false` in the host env, or use build command `npm ci --include=dev && npm run build`. |
| Edits don't apply to the sheet | The user unchecked "Let Simba edit the sheet" in the sidebar. |

## Notes on cost & security

The backend holds your Anthropic key and bills your account for every assigned
user's usage. Before a wide rollout, consider adding **auth, per-user rate
limiting, and logging** to `server/server.js` so usage stays bounded.
