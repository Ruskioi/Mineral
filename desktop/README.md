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

## Notes
- Requires internet (it loads the hosted UI + Office.js).
- This is a thin shell over the web UI — updates to the hosted app appear
  automatically; only `main.js`/packaging changes require a rebuild.
