# Simba AI — Desktop app

A standalone desktop window for Simba, **linked to the Excel add-in** by sharing
the same backend: same account, same memory (when SSO is on), same Claude model.

It loads the hosted Simba UI, which detects there's no Excel host and runs in
**desktop mode** — chat, web search, memory, OneDrive/SharePoint files, and
file attachments all work. **Live worksheet editing happens in the Excel add-in**
(Office.js only runs inside Excel), so the two surfaces complement each other:
think/research/read on the desktop, edit the grid in Excel.

## Run it
```bash
cd desktop
npm install
npm start
```

Point it at a different backend (e.g. your own host):
```bash
SIMBA_URL=https://your-host/taskpane.html npm start
```

## Package an installer
```bash
npm run dist        # electron-builder → dmg/zip (mac), nsis (win), AppImage (linux)
```

## How the link works
- Both the desktop app and the Excel add-in call the same `/api`.
- With **SSO enabled** (see `docs/DEPLOYMENT.md`), per-user memory lives in
  Postgres keyed to the Microsoft identity, so what Simba remembers follows you
  across both surfaces. Without SSO, memory is per-device (the desktop app and
  Excel keep separate local memory).
- Cloud files (`list_files`/`open_file`) work in both, using the signed-in user's
  own OneDrive/SharePoint permissions.

## Distribute to your Microsoft 365 organization

Important: the desktop app is a **normal Windows/Mac program**, not an Office
add-in. So it does **not** go in the M365 admin center → Integrated Apps (that
path is only for the Excel add-in). You roll the desktop app out with **Microsoft
Intune** (Endpoint Manager), which is part of Microsoft 365.

**1. Build a signed installer** (on the matching OS, with electron-builder):
```bash
cd desktop && npm install && npm run dist
```
- **Windows** → an `.exe` (NSIS) or `.msi`. **Code-sign it** with your org's code-
  signing certificate (set `CSC_LINK`/`CSC_KEY_PASSWORD`), or Windows SmartScreen
  warns users.
- **macOS** → a `.dmg`/`.pkg`, **signed with an Apple Developer ID and notarized**
  (`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`), or Gatekeeper blocks it.

**2. Upload to Intune and assign:**
- Windows: wrap the installer with the **Win32 Content Prep Tool** (`IntuneWinAppUtil`)
  → `.intunewin`; in Intune → **Apps → Windows → Add → Windows app (Win32)**, set the
  install command (e.g. `SimbaAI-Setup.exe /S`), an uninstall command, and a detection
  rule (installed path/registry), then **assign** to a user/device group.
- macOS: Intune → **Apps → macOS** → upload the `.pkg`, then assign.
- Users get it pushed silently or installable from **Company Portal**.

**3. Auto-update** — built in via `electron-updater`. On launch a packaged app
checks the feed in `package.json` → `build.publish` (a `generic` URL, default
`/updates/`), downloads a newer version, and installs it on quit. To publish a
release: bump `version`, run `npm run publish` (or `npm run dist` and upload the
output), so the installer **and** `latest.yml`/`latest-mac.yml` land at that URL.
Point the feed at your own host by editing `build.publish[0].url`. With this,
you only push to Intune for the first install; later updates are automatic.

> The two surfaces use different distribution channels: the **Excel add-in** →
> M365 admin center (Integrated Apps / Centralized Deployment, see
> `../docs/DEPLOYMENT.md`); the **desktop app** → Intune. Both talk to the same
> backend, so they stay linked (shared account, memory, and conversations).

## Notes
- Requires internet (it loads the hosted UI + Office.js).
- This is a thin shell over the web UI — updates to the hosted app appear
  automatically; only `main.js`/packaging changes require a rebuild.
