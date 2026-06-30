/*
 * Simba ship-safety checks — static analysis, no browser/Office needed.
 * Run with: npm test
 *
 * These guard the bug classes most likely to break a release:
 * tool drift between client and server, malformed manifests/config, and
 * stray non-text bytes in source.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chooseModel } from "../server/router.js";
import { createEntry, searchVault, retrieveForContext, listVault } from "../server/vault.js";
import { saveWorkspace, workspaceContext } from "../server/store.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg || "assertion failed"); };

const server = read("server/server.js");
const taskpane = read("src/taskpane/taskpane.js");

// Prepare vault store behaviour (async) before the synchronous checks run.
await createEntry("t-test", { topic: "X", title: "Pris", content: "Produkten kostar 990 kr.", tags: ["pris"] });
const _vaultHits = await searchVault("t-test", "vad kostar produkten");
const _vaultOtherOrgCount = (await listVault("t-other")).length;
void retrieveForContext;
// File attachment round-trip (extracted text searchable; bytes retrievable).
const _vaultMod = await import("../server/vault.js");
const _fEntry = await _vaultMod.createEntry("t-file", { topic: "Y", title: "Prislista", content: "x", file: { name: "p.csv", type: "text/csv", data: Buffer.from("Plan,Pris").toString("base64"), text: "Plan,Pris" } });
const _vf = await _vaultMod.getFile("t-file", _fEntry.id);
const _vaultFileBytes = _vf ? Buffer.from(_vf.data, "base64").toString() : "";
// Shared workspace round-trip (cross-surface context).
await saveWorkspace("t-ws", { label: "T", content: "Q3-synctest data", source: "Excel" });
const _wsCtx = await workspaceContext("t-ws");
// Connectors: secrets hidden in the public list; HTTPS enforced.
const _conn = await import("../server/connectors.js");
await _conn.createConnector("t-conn", { name: "Fortnox", base_url: "https://api.example.com", headers: { "Access-Token": "topsecret" }, endpoints: [{ label: "Fakturor", path: "invoices" }] });
const _connList = await _conn.listConnectors("t-conn");
const _connListJson = JSON.stringify(_connList);
const _connHeaderNames = _connList[0]?.headerNames || [];
const _connHttpsRejected = await _conn.createConnector("t-conn", { name: "bad", base_url: "http://x.com", endpoints: [] }).then(() => false).catch((e) => e.status === 400);

console.log("\nSimba ship-safety checks\n");

check("package.json is valid JSON with required scripts", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const s of ["build", "start", "test", "manifest:prod"]) assert(pkg.scripts[s], `missing script: ${s}`);
  assert(pkg.engines && pkg.engines.node, "missing engines.node");
});

check(".npmrc keeps devDependencies so host builds don't prune webpack", () => {
  const npmrc = read(".npmrc");
  assert(/^\s*include\s*=\s*dev\s*$/m.test(npmrc), ".npmrc must set include=dev (build tools are devDependencies; hosts set NODE_ENV=production)");
});

// Only the client-facing TOOLS array — not the Anthropic server tools
// (code_execution/web_search/web_fetch) declared inside endpoint handlers.
const toolsBlock = server.slice(server.indexOf("const TOOLS = ["), server.indexOf("const app = express()"));

check("client and server expose the exact same tool set", () => {
  const beTools = [...toolsBlock.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  const block = taskpane.slice(taskpane.indexOf("const tools = {"), taskpane.indexOf("/* tool helpers */"));
  const feTools = [...block.matchAll(/^\s{2}async ([a-z_]+)\(/gm)].map((m) => m[1]);
  const be = new Set(beTools), fe = new Set(feTools);
  assert(beTools.length >= 15, `suspiciously few backend tools: ${beTools.length}`);
  const beOnly = [...be].filter((x) => !fe.has(x));
  const feOnly = [...fe].filter((x) => !be.has(x));
  assert(beOnly.length === 0, `backend-only tools: ${beOnly.join(", ")}`);
  assert(feOnly.length === 0, `frontend-only tools: ${feOnly.join(", ")}`);
});

check("every backend tool has a name, description, and input_schema", () => {
  const tools = [...toolsBlock.matchAll(/\{\s*name:\s*"([a-z_]+)",\s*description:\s*"([^"]+)",\s*input_schema:/g)];
  const names = [...toolsBlock.matchAll(/name:\s*"([a-z_]+)"/g)];
  assert(tools.length === names.length, `${names.length} tools but only ${tools.length} fully-formed (name+description+input_schema)`);
});

check("HTML templates don't manually include the bundle (build injects it once)", () => {
  // A manual <script src="taskpane.js"> plus the auto-injected one loads the app
  // twice -> doubled event handlers -> doubled chat messages. Guard against it.
  const tp = read("src/taskpane/taskpane.html");
  const cm = read("src/commands/commands.html");
  assert(!/<script[^>]*src=["']taskpane\.js["']/.test(tp), "taskpane.html must not manually load taskpane.js");
  assert(!/<script[^>]*src=["']commands\.js["']/.test(cm), "commands.html must not manually load commands.js");
});

check("source files contain no stray NUL/control bytes", () => {
  for (const f of ["src/taskpane/taskpane.js", "src/taskpane/taskpane.css", "src/taskpane/taskpane.html", "server/server.js"]) {
    const buf = readFileSync(resolve(root, f));
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b === 0 || (b < 9) || (b > 13 && b < 32 && b !== 27)) {
        throw new Error(`${f} has a control byte 0x${b.toString(16)} at offset ${i}`);
      }
    }
  }
});

check("manifest.xml is configured (no leftover template placeholders)", () => {
  const m = read("manifest.xml");
  assert(!m.includes("{{"), "manifest.xml still has {{...}} placeholders");
  assert(/<Id>[0-9a-fA-F-]{36}<\/Id>/.test(m), "manifest.xml missing a GUID <Id>");
  for (const tag of ["<DisplayName", "<SourceLocation", "<Permissions>"]) assert(m.includes(tag), `manifest.xml missing ${tag}`);
});

check("manifest.template.xml has both placeholders and no localhost leak", () => {
  const t = read("manifest.template.xml");
  assert(t.includes("{{BASE_URL}}"), "template missing {{BASE_URL}}");
  assert(t.includes("{{ADDIN_ID}}"), "template missing {{ADDIN_ID}}");
  assert(!/localhost/.test(t), "template should not hardcode localhost");
});

check("assistant is instructed to respond in Swedish", () => {
  assert(/respond in Swedish|svenska/i.test(server), "system prompt must instruct Swedish responses");
});

check("backend uses the approved model and adaptive thinking", () => {
  assert(/claude-opus-4-8/.test(server), "expected default model claude-opus-4-8");
  assert(/type:\s*"adaptive"/.test(server), "expected adaptive thinking");
  assert(/budget_tokens/.test(server) === false, "budget_tokens is removed on this model");
});

check("replies stream to the task pane (SSE)", () => {
  assert(/text\/event-stream/.test(server), "server should send Server-Sent Events");
  assert(/event: \$\{event\}|event: final|send\("final"/.test(server), "server should emit a final SSE event");
  assert(/getReader\(\)/.test(taskpane), "client should read the SSE stream");
  assert(/function parseSSE/.test(taskpane), "client SSE parser missing");
  assert(/function startStream|function appendStream/.test(taskpane), "client streaming bubble missing");
});

check("speed + caching optimizations are wired", () => {
  assert(/cache_control/.test(server), "system/tools prompt caching missing (cache_control)");
  assert(/req\.body\.speed/.test(server), "server should read a per-request speed preference");
  assert(/fast-mode-2026-02-01/.test(server), "fast mode beta flag missing");
  assert(/simba\.speed/.test(taskpane), "client should persist a speed preference");
});

check("per-user memory is wired client + server", () => {
  assert(/req\.body\.memory/.test(server), "server should read per-user memory from the request");
  assert(/buildSystem/.test(server), "server should inject memory into the system blocks");
  assert(/simba\.memory/.test(taskpane), "client should persist memory in localStorage");
  assert(/memory:\s*memoryList\(\)/.test(taskpane), "client should send memory with each request");
});

check("Microsoft SSO + cross-device memory are wired", () => {
  const identity = read("server/identity.js");
  const storeFile = read("server/store.js");
  assert(/verifyToken/.test(identity), "identity.verifyToken missing");
  assert(/createRemoteJWKSet/.test(identity), "identity should verify against Microsoft's JWKS");
  assert(/simba_memory/.test(storeFile), "store should define the simba_memory table");
  assert(/DATABASE_URL/.test(storeFile), "store should use DATABASE_URL for Postgres");
  assert(/app\.get\("\/api\/memory"/.test(server) && /app\.put\("\/api\/memory"/.test(server), "memory endpoints missing");
  assert(/getAccessToken/.test(taskpane), "client SSO token fetch missing");
  const graph = read("server/graph.js");
  assert(/on_behalf_of/.test(graph), "Graph OBO flow missing");
  assert(/Files\.Read/.test(graph), "Graph should request the Files.Read scope");
  assert(/app\.get\("\/api\/files"/.test(server), "cloud files endpoint missing");
  const tmpl = read("manifest.template.xml");
  assert(/WebApplicationInfo/.test(tmpl) && /\{\{AAD_CLIENT_ID\}\}/.test(tmpl), "manifest template missing the SSO block");
  const pkg = JSON.parse(read("package.json"));
  for (const dep of ["jose", "pg"]) assert(pkg.dependencies[dep], `missing dependency: ${dep}`);
});

check("security hardening from the audit is in place", () => {
  assert(!/app\.use\(cors\(\)\)/.test(server), "wildcard CORS must be removed (use an allowlist)");
  assert(/SIMBA_ALLOWED_ORIGINS/.test(server), "CORS should be gated on an allowlist env var");
  assert(/ipRateLimited/.test(server), "per-IP rate limiting missing");
  assert(/X-Content-Type-Options/.test(server), "nosniff header missing");
  assert(!/res\.set\(\s*["']X-Frame-Options/i.test(server), "must NOT set X-Frame-Options (breaks Office embedding)");
  assert(/&quot;|&#39;/.test(read("src/taskpane/taskpane.js")), "escapeHtml must escape quotes (XSS)");
  const identity = read("server/identity.js");
  assert(/access_as_user/.test(identity), "SSO must require the access_as_user scope");
  assert(/no tenant id|tid\)/.test(identity), "SSO must require a tenant id");
});

check("shared conversation history is wired", () => {
  assert(/simba_conversations/.test(read("server/store.js")), "conversations table missing");
  assert(/app\.get\("\/api\/conversations"/.test(server) && /app\.put\("\/api\/conversations\/:id"/.test(server), "conversation endpoints missing");
  assert(/saveConversation/.test(taskpane) && /loadConversations/.test(taskpane), "client conversation sync missing");
  assert(/renderHistory/.test(taskpane), "client should rebuild chat from stored history");
});

check("desktop mode + Electron app (with auto-update) are wired", () => {
  assert(/IS_EXCEL/.test(taskpane), "client should track an Excel-vs-desktop flag");
  assert(/function boot\(/.test(taskpane), "client should have a host-agnostic boot()");
  assert(/applyDesktopMode/.test(taskpane), "client should have a desktop mode");
  assert(/req\.body\.surface|surface\)/.test(server), "server should honor a surface (excel/desktop) hint");
  const main = read("desktop/main.js");
  assert(/BrowserWindow/.test(main) && /loadURL/.test(main), "desktop/main.js should open a window loading the UI");
  assert(/electron-updater/.test(main), "desktop app should wire auto-update");
  const dpkg = JSON.parse(read("desktop/package.json"));
  assert(dpkg.devDependencies.electron, "desktop app needs electron");
  assert(dpkg.dependencies["electron-updater"], "desktop app needs electron-updater");
  assert(dpkg.build.publish, "electron-builder needs a publish feed for updates");
});

check("document generation (Skills) is wired", () => {
  assert(/app\.post\("\/api\/document"/.test(server), "document endpoint missing");
  assert(/skills-2025-10-02/.test(server) && /code-execution-2025-08-25/.test(server), "document gen should use the skills + code-execution betas");
  assert(/renderDownload/.test(taskpane) && /saveBase64/.test(taskpane), "client should render a downloadable file");
});

check("agent patterns (plan + delegate subagents) are wired", () => {
  assert(/name: "propose_plan"/.test(server) && /name: "delegate_task"/.test(server), "plan/delegate tool schemas missing");
  assert(/function confirmPlan/.test(taskpane) && /function renderPlan/.test(taskpane), "client plan approval UI missing");
  assert(/subagentDepth/.test(taskpane), "subagent recursion guard missing");
  assert(/function toolResultContent/.test(taskpane), "shared tool-result builder missing (used by the subagent loop)");
  assert(/propose_plan", "delegate_task"/.test(taskpane), "plan/delegate must work in desktop mode (DESKTOP_TOOLS)");
});

check("merge_cells preserves the title; read turns run in parallel", () => {
  const block = taskpane.slice(taskpane.indexOf("async merge_cells("), taskpane.indexOf("async freeze_panes("));
  assert(/KEEPS ONLY the top-left/.test(block) || /getCell\(0, 0\)\.values/.test(block), "merge_cells must move a non-top-left value into the kept cell");
  assert(/const READ_TOOLS = new Set/.test(taskpane), "read-only tool set missing");
  assert(/every\(\(u\) => READ_TOOLS\.has\(u\.name\)\)/.test(taskpane), "read-only turns should run concurrently");
  assert(/Do NOT destroy your own work/.test(server), "system prompt must guard the finalization step");
});

check("model router sends simple turns to Haiku, work to Opus", () => {
  const opt = { strong: "OPUS", simple: "HAIKU", on: true };
  const u = (t) => [{ role: "user", content: t }];
  assert(chooseModel(u("Vad är huvudstaden i Japan?"), "balanced", opt) === "HAIKU", "simple question should use the cheap model");
  assert(chooseModel(u("Bygg en budget med summor"), "balanced", opt) === "OPUS", "build requests must use the strong model");
  assert(chooseModel(u("Skriv en formel som summerar B"), "balanced", opt) === "OPUS", "formula requests must use the strong model");
  assert(chooseModel(u("Hej\n\n[Aktuell markering: A1:B3]"), "balanced", opt) === "OPUS", "selection context must use the strong model");
  assert(chooseModel(u("Hej"), "thorough", opt) === "OPUS", "thorough must force the strong model");
  assert(chooseModel(u("Hej"), "balanced", { ...opt, on: false }) === "OPUS", "router off must force the strong model");
  const loop = [{ role: "user", content: "x" }, { role: "assistant", content: [] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "{}" }] }];
  assert(chooseModel(loop, "balanced", opt) === "OPUS", "mid tool-loop must use the strong model");
  assert(/claude-haiku/.test(server), "server should configure a Haiku simple model");
  assert(/chooseModel\(messages, speed/.test(server), "runModel must use the router");
});

check("PWA (installable web app) is wired", () => {
  const mani = JSON.parse(read("web/site.webmanifest"));
  assert(mani.name && mani.start_url === "/" && mani.display === "standalone", "webmanifest missing name/start_url/standalone");
  assert(Array.isArray(mani.icons) && mani.icons.some((i) => i.sizes === "512x512"), "webmanifest needs a 512 icon");
  assert(mani.icons.some((i) => i.purpose === "maskable"), "webmanifest needs a maskable icon");
  for (const f of ["assets/icon-192.png", "assets/icon-512.png", "assets/icon-maskable-512.png"]) {
    assert(readFileSync(resolve(root, f)).length > 1000, `${f} missing or empty`);
  }
  const sw = read("web/sw.js");
  assert(/\/api\//.test(sw) && /startsWith\("\/api\/"\)/.test(sw), "service worker must explicitly bypass /api");
  assert(/registration|register\("\/sw\.js"\)/.test(taskpane), "client must register the service worker");
  const wp = read("webpack.config.js");
  assert(/site\.webmanifest/.test(wp) && /sw\.js/.test(wp), "webpack must copy the PWA files to the root");
});

check("specialist agents + tabbed settings are wired", () => {
  const tp = read("src/taskpane/taskpane.html");
  assert(/id="agents"/.test(tp), "agents button missing from the chat header");
  assert(/id="agent-chip"/.test(tp), "active-agent chip missing");
  assert(/const AGENTS = \[/.test(taskpane), "agent definitions missing");
  assert(/function openAgents/.test(taskpane) && /function setActiveAgent/.test(taskpane), "agents panel logic missing");
  assert(/activeAgent\.directive/.test(taskpane), "agent directive must be injected into the turn");
  assert(/function currentAvatar/.test(taskpane) && /currentAvatar\(\)/.test(taskpane), "agents should render with their own avatar");
  assert(/function renderAgentRun/.test(taskpane), "agent 'working' banner missing");
  // Settings is now tabbed, not one long list.
  assert(/class="tabs"/.test(taskpane) && /data-tab="schedules"/.test(taskpane), "settings tabs missing");
  assert(/data-panel="memory"/.test(taskpane) && /data-panel="general"/.test(taskpane), "settings tab panels missing");
});

check("cloud file browser is wired", () => {
  const tp = read("src/taskpane/taskpane.html");
  assert(/id="cloud"/.test(tp), "cloud-files button missing from the composer");
  assert(/function openFilesBrowser/.test(taskpane) && /function pickCloudFile/.test(taskpane), "cloud browser functions missing");
  assert(/\/api\/files\?q=/.test(taskpane), "browser must search /api/files");
  assert(/\/api\/files\/open/.test(taskpane), "browser must open files via /api/files/open");
  assert(/pendingAttachments\.push\(att\)/.test(taskpane), "opened cloud file should become an attachment");
});

check("settings panel exposes all features (incl. schedule management)", () => {
  assert(/function populateSchedules/.test(taskpane), "schedules manager UI missing");
  assert(/function jobSetEnabled/.test(taskpane) && /function jobDelete/.test(taskpane), "schedule pause/delete actions missing");
  assert(/id="sched-list"/.test(taskpane), "settings must render the schedules list");
  // Settings hub still covers the rest of the features directly.
  for (const re of [/theme-seg/, /speed-seg/, /memory-text/, /conv-list/, /memory-signin/]) {
    assert(re.test(taskpane), `settings panel missing a control: ${re}`);
  }
});

check("UI polish (micro-interactions) is present", () => {
  const css = read("src/taskpane/taskpane.css");
  assert(/Polish & micro-interactions/.test(css), "polish CSS block missing");
  assert(/@keyframes cheer/.test(css) && /function cheerMascot/.test(taskpane), "mascot cheer quirk missing");
  assert(/\.suggestion:hover::after/.test(css), "suggestion hover affordance missing");
});

check("chat mascot watermark + scroll fix are wired", () => {
  const tp = read("src/taskpane/taskpane.html");
  const css = read("src/taskpane/taskpane.css");
  assert(/id="chat-watermark"/.test(tp), "watermark element missing from the template");
  assert(/getElementById\("chat-watermark"\)/.test(taskpane), "client must fill the watermark with the mascot");
  assert(/\.chat-watermark/.test(css) && /grayscale\(1\)/.test(css), "watermark must render the mascot in grey");
  assert(/body\.has-chat/.test(css) && /classList\.add\("has-chat"\)/.test(taskpane), "watermark should recede once a chat starts");
  assert(/\.messages\s*\{[^}]*min-height:\s*0/.test(css), "messages must set min-height:0 so content scrolls instead of being cut off");
});

check("web entry + conversation sidebar are wired", () => {
  const wp = read("webpack.config.js");
  assert(/filename:\s*"index\.html"/.test(wp), "webpack must emit index.html (the web entry)");
  assert(/office:\s*false/.test(wp) && /office:\s*true/.test(wp), "Office.js must be conditional per entry");
  const tp = read("src/taskpane/taskpane.html");
  assert(/htmlWebpackPlugin\.options\.office/.test(tp), "template must gate Office.js on the office flag");
  assert(/id="sidebar"/.test(tp) && /id="sb-list"/.test(tp), "conversation sidebar markup missing");
  assert(/function refreshSidebar/.test(taskpane), "sidebar refresh logic missing");
});

check("Simba is a general standalone assistant (not Excel-only)", () => {
  assert(/general-purpose AI assistant/i.test(server), "system prompt should frame Simba as a general assistant");
  assert(/STANDALONE app/i.test(server) || /fristående AI-app/i.test(server), "system prompt should describe the standalone surface");
  assert(/name: "run_code"/.test(server), "general code-execution tool missing");
  assert(/app\.post\("\/api\/code"/.test(server), "/api/code endpoint missing");
  assert(/"run_code"/.test(taskpane), "run_code must be available in desktop mode (DESKTOP_TOOLS)");
  assert(/function desktopWelcomeHTML/.test(taskpane), "standalone welcome missing");
});

check("scheduled server-side agent is wired", () => {
  for (const t of ["schedule_task", "list_schedules", "cancel_schedule"]) assert(new RegExp(`name: "${t}"`).test(server), `${t} tool schema missing`);
  assert(/app\.get\("\/api\/jobs"/.test(server) && /app\.post\("\/api\/jobs"/.test(server) && /app\.delete\("\/api\/jobs\/:id"/.test(server), "job endpoints missing");
  const jobs = read("server/jobs.js");
  assert(/simba_jobs/.test(jobs), "jobs table missing");
  assert(/export function computeNextRun/.test(jobs), "next-run computation missing");
  const sched = read("server/scheduler.js");
  assert(/appOnlyGraphToken/.test(sched), "scheduler must use app-only Graph for unattended runs");
  assert(/uploadDriveItem/.test(sched), "scheduler must write the workbook back");
  assert(/SIMBA_SCHEDULER/.test(sched), "scheduler must be opt-in via env");
  const xlsx = read("server/xlsx-tools.js");
  assert(/export const XLSX_TOOLS/.test(xlsx) && /export function executeXlsxTool/.test(xlsx), "server-side xlsx toolset missing");
  const graph = read("server/graph.js");
  assert(/client_credentials/.test(graph), "graph app-only (client_credentials) flow missing");
  const pkg = JSON.parse(read("package.json"));
  assert(pkg.dependencies.exceljs, "missing dependency: exceljs");
});

check("Tier 3 hardening (CI, retry/backoff, scheduler claim+retry)", () => {
  const ci = read(".github/workflows/ci.yml");
  assert(/npm (run )?(check|test)/.test(ci) && /node server\/server\.js/.test(ci), "CI must run checks + smoke-test the server");
  assert(/function withRetry/.test(server) && /function isRetryable/.test(server), "server retry/backoff missing");
  assert(/withRetry\(\(\) => client\.messages\.create/.test(server), "server-tool calls should use retry");
  const jobs = read("server/jobs.js"), sched = read("server/scheduler.js");
  assert(/export async function claimJob/.test(jobs), "scheduler job-claim (multi-instance safety) missing");
  assert(/claimJob\(job\.id/.test(sched) && /attempt < 2/.test(sched), "scheduler must claim + retry jobs");
});

check("Tier 2 features (export, artifacts, palette, multi-attach, MCP)", () => {
  assert(/function exportChat/.test(taskpane), "chat export missing");
  assert(/function openArtifact/.test(taskpane) && /preview-btn/.test(taskpane), "HTML artifact preview missing");
  assert(/function openCommandPalette/.test(taskpane) && /e\.key === "k"/.test(taskpane), "command palette (⌘K) missing");
  assert(/let pendingAttachments = \[\]/.test(taskpane) && /MAX_ATTACH/.test(taskpane), "multi-file attach missing");
  assert(/SIMBA_MCP_SERVERS/.test(server) && /mcp_servers/.test(server), "MCP connector plumbing missing");
});

check("finance/business connectors bridge is wired & safe", () => {
  const conn = read("server/connectors.js");
  assert(/export async function queryConnector/.test(conn) && /export async function createConnector/.test(conn), "connector store missing");
  assert(/HTTPS/.test(conn) && /publicConnector/.test(conn), "connectors must be HTTPS-only and hide secrets");
  assert(/app\.post\("\/api\/connectors\/query"/.test(server) && /app\.post\("\/api\/connectors"/.test(server), "connector endpoints missing");
  assert(/canWriteVault\(user\)/.test(server.slice(server.indexOf('app.post("/api/connectors"'), server.indexOf('app.post("/api/connectors/query"'))), "connector config must be admin-gated");
  assert(/name: "list_data_sources"/.test(server) && /name: "query_data_source"/.test(server), "connector tools missing");
  assert(/function openConnectors/.test(taskpane) && /function connectorEdit/.test(taskpane), "connector admin UI missing");
  // Builder: dynamic rows + live test
  assert(/app\.post\("\/api\/connectors\/test"/.test(server) && /export async function testConnector/.test(conn), "connector live-test endpoint missing");
  assert(/dc-add-header/.test(taskpane) && /dc-add-ep/.test(taskpane) && /addEndpoint/.test(taskpane), "connector builder dynamic rows missing");
  assert(/\.dc-test-out/.test(read("src/taskpane/taskpane.css")), "connector builder styling missing");
  // store behavior prepared below
  assert(_connHeaderNames.includes("Access-Token") && !_connListJson.includes("topsecret"), "connector list must expose header names but never secret values");
  assert(_connHttpsRejected === true, "non-HTTPS base URL must be rejected");
});

check("shared workspace syncs context across surfaces", () => {
  const store = read("server/store.js");
  assert(/simba_workspace/.test(store) && /export async function saveWorkspace/.test(store) && /export async function workspaceContext/.test(store), "workspace store missing");
  assert(/app\.get\("\/api\/workspace"/.test(server) && /app\.post\("\/api\/workspace"/.test(server), "workspace endpoints missing");
  assert(/workspaceContext\(user\.key\)/.test(server), "chat must inject the shared workspace");
  assert(/name: "save_to_workspace"/.test(server) && /name: "get_workspace"/.test(server), "workspace tools missing");
  assert(/"save_to_workspace", "get_workspace"/.test(taskpane), "workspace tools must work cross-surface (desktop)");
  assert(_wsCtx.includes("Q3-synctest"), "workspace context should round-trip");
  // Settings → Synk view + Outlook current-email reading
  assert(/data-tab="workspace"/.test(taskpane) && /function populateWorkspace/.test(taskpane), "workspace settings view missing");
  assert(/name: "read_current_email"/.test(server) && /async read_current_email\(/.test(taskpane), "read-current-email tool missing");
  assert(/Office\.context\.mailbox/.test(taskpane), "current-email must use the Outlook mailbox item");
  assert(/IS_OUTLOOK/.test(taskpane) && /function toolAllowed/.test(taskpane), "Outlook host gating missing");
  assert(/surface === "outlook"/.test(server), "server should have an Outlook surface note");
});

check("Outlook mail (read/send/analyze) is wired", () => {
  const graph = read("server/graph.js");
  assert(/export async function listMail/.test(graph) && /export async function sendMail/.test(graph) && /export async function getMail/.test(graph), "graph mail functions missing");
  assert(/Mail\.Read/.test(graph) && /Mail\.Send/.test(graph), "mail scopes missing");
  assert(/app\.get\("\/api\/mail"/.test(server) && /app\.get\("\/api\/mail\/:id"/.test(server) && /app\.post\("\/api\/mail\/send"/.test(server), "mail endpoints missing");
  for (const t of ["list_emails", "read_email", "send_email"]) assert(new RegExp(`name: "${t}"`).test(server), `${t} tool schema missing`);
  assert(/function confirmSend/.test(taskpane), "send-email confirmation preview missing");
  assert(/"list_emails", "read_email", "send_email"/.test(taskpane), "mail tools must work in desktop mode");
  // Visual mail panel + folders + attachments
  assert(/id="mail"/.test(read("src/taskpane/taskpane.html")), "mail button missing from the header");
  assert(/function openMail/.test(taskpane) && /function openMailRead/.test(taskpane) && /function mailCompose/.test(taskpane), "mail panel UI missing");
  assert(/id="mail-folder"/.test(taskpane) && /sentitems/.test(taskpane), "mail folder selector missing");
  assert(/function loadMailAttachments/.test(taskpane), "mail attachment UI missing");
  assert(/export async function listAttachments/.test(read("server/graph.js")) && /app\.get\("\/api\/mail\/:id\/attachments"/.test(server), "attachment backend missing");
});

check("Simba is installable as an Outlook add-in", () => {
  const t = read("manifest.outlook.template.xml");
  assert(/xsi:type="MailApp"/.test(t) && /<Host Name="Mailbox"/.test(t), "Outlook manifest must target Mailbox");
  assert(/MessageReadCommandSurface/.test(t) && /ShowTaskpane/.test(t), "Outlook task pane button missing");
  assert(/\{\{AAD_CLIENT_ID\}\}/.test(t) && /SSO:BEGIN/.test(t), "Outlook manifest must support the SSO block");
  const mk = read("scripts/make-manifest.mjs");
  assert(/--outlook|flag\("outlook"\)/.test(mk) && /manifest\.outlook\.template\.xml/.test(mk), "make-manifest must support --outlook");
  const pkg = JSON.parse(read("package.json"));
  assert(pkg.scripts["manifest:outlook"], "manifest:outlook script missing");
});

check("company knowledge vault (Simba's shared mind) is wired", () => {
  // backend: schemas, endpoints, retrieval injection
  assert(/name: "search_vault"/.test(server) && /name: "save_to_vault"/.test(server), "vault tools missing");
  assert(/app\.get\("\/api\/vault"/.test(server) && /app\.post\("\/api\/vault"/.test(server) && /app\.delete\("\/api\/vault\/:id"/.test(server), "vault endpoints missing");
  assert(/retrieveForContext\(orgOf\(user\)/.test(server), "chat must inject the org vault context");
  assert(/Företagets kunskapsbank/.test(server), "system prompt must describe the vault");
  // client UI + tools
  assert(/function openVault/.test(taskpane) && /function vaultEdit/.test(taskpane), "vault UI missing");
  assert(/"search_vault", "save_to_vault"/.test(taskpane), "vault tools must work in desktop mode");
  // store behavior (org-scoped CRUD + keyword retrieval), prepared below
  assert(_vaultHits.some((e) => e.title === "Pris"), "vault keyword search should find the entry");
  assert(_vaultOtherOrgCount === 0, "vault must be isolated per org");
});

check("vault is a rich knowledge base (vectors, files, analyze, map)", () => {
  // semantic search (Voyage), gated + cosine helper
  const emb = read("server/embeddings.js");
  assert(/api\.voyageai\.com/.test(emb) && /export function cosine/.test(emb), "embeddings/vector search missing");
  assert(/vectorEnabled/.test(server) && /sim \* 8 \+ kw/.test(read("server/vault.js")), "hybrid (vector+keyword) search missing");
  // file attachments + retrieval
  assert(/file_data/.test(read("server/vault.js")), "vault attachment storage missing");
  assert(/app\.get\("\/api\/vault\/:id\/file"/.test(server), "vault file endpoint missing");
  assert(_vaultFileBytes === "Plan,Pris", "attachment bytes should round-trip");
  // analyze + tools
  assert(/app\.post\("\/api\/vault\/analyze"/.test(server) && /name: "analyze_vault"/.test(server), "vault analyze missing");
  assert(/name: "open_vault_file"/.test(server), "open_vault_file tool missing");
  // client: map + analyze UI + file attach
  assert(/function renderVaultMap/.test(taskpane) && /function analyzeVaultUI/.test(taskpane), "vault map / analyze UI missing");
  assert(/id="v-file"/.test(taskpane), "vault entry file-attach UI missing");
});

check("Tier 1 features (stop, conv management, job email, user quota)", () => {
  // Stop generation
  assert(/function stopGeneration/.test(taskpane) && /activeController\?\.abort/.test(taskpane), "stop-generation missing");
  assert(/stopRequested/.test(taskpane), "stop flag missing in the agent loop");
  // Conversation management
  assert(/function convRename/.test(taskpane) && /function convDelete/.test(taskpane), "conversation rename/delete missing");
  assert(/function uiPrompt/.test(taskpane) && /function uiConfirm/.test(taskpane), "modal prompt/confirm missing (native ones break in Office)");
  assert(/renameConversation/.test(read("server/store.js")), "store rename missing");
  assert(/id="sb-search"/.test(read("src/taskpane/taskpane.html")), "conversation search missing");
  // Scheduled-job email notifications
  assert(/export async function sendMailAsUser/.test(read("server/graph.js")), "Graph sendMail missing");
  assert(/async function notify\(/.test(read("server/scheduler.js")), "scheduler email notify missing");
  // Per-user quota
  assert(/SIMBA_USER_DAILY/.test(server) && /function quotaExceeded/.test(server), "per-user quota missing");
});

check("fail-safes are present (rate limit, validation, error handler, gating)", () => {
  assert(/rateLimited/.test(server), "missing rate limiter");
  assert(/validateMessages/.test(server), "missing message validation");
  assert(/app\.use\(\(err/.test(server), "missing central error handler");
  assert(/AbortController/.test(taskpane), "client missing request timeout");
  assert(/function gateEdit/.test(taskpane), "client missing edit gating");
  assert(/is2DArray/.test(taskpane), "client missing write validation");
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
