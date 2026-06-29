/*
 * Simba AI — desktop app (Electron).
 *
 * It loads the SAME Simba web UI from the SAME backend as the Excel add-in, so
 * the two are "linked": same account, same memory (once SSO is enabled), same
 * Claude brain. The web UI detects there's no Excel host and runs in desktop
 * mode (chat, web search, memory, cloud files, attachments). Live worksheet
 * editing still happens in the Excel add-in.
 *
 * Run:     npm install && npm start
 * Package: npm run dist          (electron-builder → installer per OS)
 * Point at another host:  SIMBA_URL=https://your-host/taskpane.html npm start
 */
const { app, BrowserWindow, shell } = require("electron");

const SIMBA_URL = process.env.SIMBA_URL || "https://mineral-qd8c.onrender.com/taskpane.html";

// Auto-update (only in a packaged build). Reads the publish feed configured in
// package.json (build.publish). Optional — wrapped so a missing module/feed
// never breaks startup.
function initAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.on("update-downloaded", () => autoUpdater.quitAndInstall(true, true));
    autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error("[Simba] update check failed:", e?.message || e));
  } catch (e) {
    console.error("[Simba] auto-update unavailable:", e?.message || e);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 460,
    height: 780,
    minWidth: 360,
    minHeight: 520,
    title: "Simba AI",
    backgroundColor: "#faf9f5",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.loadURL(SIMBA_URL);

  // Open external links (e.g. citations) in the user's real browser, not in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  createWindow();
  initAutoUpdate();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
