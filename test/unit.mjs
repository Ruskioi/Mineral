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
// Passage-grounded context: the matched snippet should reach the model.
const _vaultCtx = await retrieveForContext("t-test", "vad kostar produkten");
// Chunking splits long docs into overlapping passages for fine-grained retrieval.
const { chunkText: _chunkText } = await import("../server/embeddings.js");
const _chunks = _chunkText("Mening ett. ".repeat(400));
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
// Write path: a POST endpoint with a JSON template renders concrete bodies.
const _connW = await _conn.createConnector("t-connw", { name: "NEXT", base_url: "https://api.next.example", headers: { Authorization: "Bearer s" }, endpoints: [{ label: "Skapa tidpost", path: "v1/time", method: "POST", body_template: '{"employee":"{{email}}","hours":{{hours}},"date":"{{date}}"}' }] });
const _connWepMethod = _connW.endpoints[0]?.method;
const _connBuilt = await _conn.buildWriteRequests("t-connw", _connW.id, _connW.endpoints[0].key, [{ email: "a@x.se", hours: 8, date: "2026-07-01" }]);
const _connWriteRejectsGet = await _conn.writeConnector("t-conn", "Fortnox", "fakturor", { x: 1 }).then(() => false).catch((e) => e.status === 400);
// Ingest: docx extraction round-trip through the minimal zip reader.
import { execSync as _exec } from "node:child_process";
import * as _fs from "node:fs";
_fs.mkdirSync("/tmp/simba-test/word", { recursive: true });
_fs.writeFileSync("/tmp/simba-test/word/document.xml", "<w:document><w:p><w:r><w:t>Hej ingest.</w:t></w:r></w:p></w:document>");
_exec("cd /tmp/simba-test && rm -f t.docx && zip -q -r t.docx word");
const { extractText: _extractText } = await import("../server/ingest.js");
const _ingestDocx = await _extractText("t.docx", _fs.readFileSync("/tmp/simba-test/t.docx"), null);
// Citations: retrieval must report which entries it used ("Pris" created above).
const { retrieveWithSources: _rws } = await import("../server/vault.js");
const _ctxSources = (await _rws("t-test", "vad kostar produkten")).sources;
// Usage accounting: estimated cost + round-trip.
const _usage = await import("../server/usage.js");
const _usdOpus = _usage.estimateCost("claude-opus-4-8", { input_tokens: 1_000_000, output_tokens: 0 }).cost;
const _usdHaiku = _usage.estimateCost("claude-haiku-4-5", { input_tokens: 1_000_000, output_tokens: 0 }).cost;
await _usage.recordUsage("t-usage", "claude-opus-4-8", { input_tokens: 100, output_tokens: 50 });
const _usageSummary = await _usage.getUsage("t-usage");
// Org agents: run-log + approval round-trip.
const _oa = await import("../server/orgagents.js");
const _ag = await _oa.createAgent("t-oa", { name: "TR", type: "time_reconciler", config: { mailbox: "t@x.se", recipient: "e@x.se" } });
const _agRun = await _oa.logRun("t-oa", _ag.id, { status: "compiled", summary: "x" });
const _agRuns = (await _oa.listRuns("t-oa", _ag.id)).length;
await _oa.createApproval("t-oa", _ag.id, _agRun.id, "send_email", { to: "e@x.se", subject: "s", body: "b" });
const _pend = await _oa.listApprovals("t-oa");
await _oa.decideApproval("t-oa", _pend[0].id, "approved", "boss");
const _agentApprovalsAfter = (await _oa.listApprovals("t-oa")).length;
const _agentRuns = _agRuns;

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
  assert(/"propose_plan"/.test(taskpane) && /"delegate_task"/.test(taskpane), "plan/delegate must work in desktop mode (DESKTOP_TOOLS)");
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

check("in-chat model picker (Auto / Pluto / Simba) is wired", () => {
  // server: honor a forced model preference
  assert(/function pickModel/.test(server) && /pref === "pluto"/.test(server) && /pref === "simba"/.test(server), "server pickModel must map pluto/simba");
  assert(/runModel\(req\.body\.messages/.test(server) && /req\.body\.model/.test(server), "chat handler must pass the model preference to runModel");
  // client: Claude-style pills + naming + request
  assert(/MODEL_CHOICES/.test(taskpane) && /"pluto"/.test(taskpane) && /"simba"/.test(taskpane), "model choices missing");
  assert(/function prettyModel/.test(taskpane) && /return "Simba"/.test(taskpane) && /return "Pluto"/.test(taskpane), "haiku→Simba / opus→Pluto naming missing");
  assert(/function openPillMenu/.test(taskpane) && /id="model-pill"/.test(read("src/taskpane/taskpane.html")), "model pill UI missing");
  assert(/model: modelPref/.test(taskpane), "chat request must send the chosen model");
  assert(/\.mpick-menu/.test(read("src/taskpane/taskpane.css")), "model dropdown styling missing");
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
  // Decluttered UI: features live in a nav drawer/rail (☰), reachable on every surface.
  assert(/id="menu"/.test(tp) && /id="sb-nav"/.test(tp) && /id="nav-backdrop"/.test(tp), "menu button / sidebar nav / backdrop missing");
  assert(/function wireSidebar/.test(taskpane) && /function buildSidebarNav/.test(taskpane) && /function toggleNav/.test(taskpane), "sidebar drawer wiring missing");
  assert(/wireSidebar\(\)/.test(taskpane), "sidebar must be wired on boot for every surface (not desktop-only)");
  assert(/label: "Agenter", run: openAgents/.test(taskpane), "Agenter must be reachable from the sidebar nav");
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
  // Cloud files are reachable from the SSO-gated sidebar nav / ⋯ menu now.
  assert(/label: "Molnfiler", run: openFilesBrowser/.test(taskpane), "Molnfiler must be reachable from the sidebar nav");
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

check("centralized org agents (visible, logged, approvable) are wired", () => {
  const oa = read("server/orgagents.js");
  assert(/simba_agents/.test(oa) && /simba_agent_runs/.test(oa) && /simba_agent_approvals/.test(oa), "agents/runs/approvals tables missing");
  assert(/export async function logRun/.test(oa) && /export async function decideApproval/.test(oa), "activity log / approvals missing");
  assert(/app\.get\("\/api\/agents"/.test(server) && /app\.post\("\/api\/agents\/:id\/run"/.test(server) && /app\.post\("\/api\/agents-approvals\/:id\/decide"/.test(server), "agent endpoints missing");
  assert(/export async function runOrgAgent/.test(read("server/scheduler.js")) && /time_reconciler/.test(read("server/scheduler.js")), "time-reconciler executor missing");
  assert(/export async function listMailboxMessages/.test(read("server/graph.js")), "mailbox read (for the agent address) missing");
  assert(/function renderOrgAgents/.test(taskpane) && /function agentCreateForm/.test(taskpane), "org-agents UI missing");
  // store round-trip prepared below
  assert(_agentRuns >= 1 && _agentApprovalsAfter === 0, "agent run-log + approval decision should round-trip");
});

check("supplier-invoice agent (leverantörsfakturor) is wired", () => {
  const sch = read("server/scheduler.js");
  const gr = read("server/graph.js");
  assert(/supplier_invoice/.test(sch) && /function runSupplierInvoice/.test(sch), "supplier-invoice executor missing");
  assert(/function extractInvoice/.test(sch) && /type: "document"/.test(sch) && /application\/pdf/.test(sch), "invoice PDF/image extraction missing");
  assert(/intervalMinutes/.test(sch) && /seenIds/.test(sch), "invoice poll interval / dedupe cursor missing");
  assert(/agent\.type === "supplier_invoice"/.test(sch), "runOrgAgent must dispatch the invoice type");
  assert(/export async function getMailboxAttachments/.test(gr) && /hasAttachments/.test(gr), "app-only attachment read missing");
  // client: a type selector + label so admins can create it
  assert(/AGENT_TYPES/.test(taskpane) && /supplier_invoice/.test(taskpane) && /Leverantörsfakturor/.test(taskpane), "invoice agent not offered in the create form");
  assert(/id="oa-type"/.test(taskpane), "agent type selector missing");
});

check("API templates (Fortnox/Visma) in the connector builder", () => {
  assert(/CONNECTOR_TEMPLATES/.test(taskpane) && /fortnox/.test(taskpane) && /visma/.test(taskpane), "connector templates missing");
  assert(/id="dc-template"/.test(taskpane), "template selector missing in the builder");
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

check("audit hardening: perf + race + timezone fixes stay in place", () => {
  // One shared pg pool — module-local pools regress connection usage 6x.
  assert(/export function getPool/.test(read("server/db.js")), "shared db pool module missing");
  for (const f of ["store", "vault", "usage", "connectors", "orgagents", "jobs"]) {
    assert(!/new pg\.Pool/.test(read(`server/${f}.js`)), `${f}.js must use the shared pool`);
  }
  // Prompt cache: per-turn retrieval must ride in the messages, not the system prompt.
  assert(/function injectContext/.test(server) && /injectContext\(messages, vault, workspace, ambient\)/.test(server), "context injection missing");
  assert(!/buildSystem\(memory, surface, vault/.test(server), "vault text must not re-enter the system prompt (kills the conversation cache)");
  // Atomic approvals: claim-before-act + reopen on failure.
  const oa = read("server/orgagents.js");
  assert(/AND status='pending' RETURNING/.test(oa) && /export async function reopenApproval/.test(oa), "approval claim/reopen missing");
  assert(/reopenApproval\(orgOf\(user\)/.test(server), "decide handler must reopen on side-effect failure");
  // Scheduler: agents tick inside the overlap guard.
  const sch = read("server/scheduler.js");
  assert(sch.indexOf("await tickAgents(client, model)") < sch.indexOf("scheduler tick failed"), "tickAgents must run inside the overlap guard (before tick()'s catch)");
  // Connector test endpoint pins the stored host when merging stored secrets.
  assert(/base = cur\.base_url/.test(read("server/connectors.js")), "testConnector must pin the stored host");
  // Timezone-correct bucketing (Swedish users, UTC servers).
  assert(/Europe\/Stockholm/.test(read("server/usage.js")) && /Europe\/Stockholm/.test(server), "local-timezone day bucketing missing");
  // Vault retrieval caching (hot path) + invalidation on writes.
  assert(/rawCache/.test(read("server/vault.js")) && /invalidateOrg\(orgKey\)/.test(read("server/vault.js")), "vault read cache/invalidation missing");
  // Client: local-day keys, streaming append, near-bottom scroll, conv-switch guard.
  assert(/function localDayKey/.test(taskpane) && /createTextNode\(chunk\)/.test(taskpane), "client day-key / streaming append fixes missing");
  assert(/nearBottom/.test(taskpane), "scroll must respect the user's position");
  assert(/Vänta – Simba skriver klart först/.test(taskpane), "openConversation must guard against mid-turn switching");
  assert(/const snapMessages = messages/.test(taskpane), "saveConversation must snapshot at schedule time");
});

check("vault auto-ingest (SharePoint/OneDrive folders) is wired", () => {
  const ing = read("server/ingest.js");
  assert(/export async function syncSource/.test(ing) && /export async function createSource/.test(ing) && /export async function tickIngest/.test(ing), "ingest engine missing");
  assert(/export function zlibSync/.test(read("server/zipmini.js")), "zip reader (docx/pptx) missing");
  assert(/docx/.test(ing) && /pptx/.test(ing) && /xlsx/.test(ing) && /pdf/.test(ing), "extraction must handle Office formats + pdf");
  assert(/export async function upsertExternal/.test(read("server/vault.js")) && /ext_id/.test(read("server/vault.js")), "vault external-entry tracking missing");
  assert(/resolveShareUrl/.test(read("server/graph.js")) && /listFolderChildren/.test(read("server/graph.js")), "graph folder helpers missing");
  assert(/app\.get\("\/api\/ingest-sources"/.test(server) && /app\.post\("\/api\/ingest-sources\/:id\/sync"/.test(server), "ingest endpoints missing");
  assert(/tickIngest\(client\)/.test(read("server/scheduler.js")), "ingest must run on the scheduler tick");
  assert(/function renderIngestSources/.test(taskpane) && /data-v="sources"/.test(taskpane), "ingest admin UI (Källor tab) missing");
  assert(_ingestDocx === "Hej ingest.", "docx extraction should round-trip");
});

check("citations (answer sources) are wired", () => {
  assert(/export async function retrieveWithSources/.test(read("server/vault.js")), "retrieveWithSources missing");
  assert(/sources: vaultSources/.test(server), "final SSE event must carry the sources");
  assert(/app\.get\("\/api\/vault\/:id"/.test(server), "single-entry endpoint (chip click) missing");
  assert(/function renderSourceChips/.test(taskpane) && /Baserat på kunskapsbanken/.test(taskpane), "source chips missing");
  assert(/\.src-chip/.test(read("src/taskpane/taskpane.css")), "citation styling missing");
  assert(Array.isArray(_ctxSources) && _ctxSources.length === 1 && _ctxSources[0].title === "Pris", "retrieval must report its sources");
});

check("inbox-triage agent is wired", () => {
  const sch = read("server/scheduler.js");
  assert(/function runInboxTriage/.test(sch) && /agent\.type === "inbox_triage"/.test(sch), "inbox agent executor missing");
  assert(/createApproval\(tid, agent\.id, run\.id, "send_email"/.test(sch), "drafted replies must go through the approval queue");
  assert(/inbox_triage/.test(taskpane) && /Inkorgsassistent/.test(taskpane), "inbox agent not offered in the create form");
});

check("Teams bot is wired", () => {
  const tb = read("server/teamsbot.js");
  assert(/export async function verifyBotToken/.test(tb) && /api\.botframework\.com/.test(tb), "bot token verification missing");
  assert(/export async function sendActivity/.test(tb), "bot reply sender missing");
  assert(/app\.post\("\/api\/teams\/messages"/.test(server) && /verifyBotToken/.test(server), "Teams endpoint missing/unverified");
  assert(/retrieveWithSources\(tid/.test(server) && /getMemory\(userKey\)/.test(server), "Teams answers must use the shared brain (vault + memory)");
  assert(read("docs/teams-manifest.template.json").includes("REPLACE_WITH_TEAMS_APP_ID"), "Teams manifest template missing");
});

check("second-tier features (charts, plan cards, templates, search, voice, changelog)", () => {
  // Inline charts + live plan cards (client tools with server schemas — parity test covers the pairing)
  assert(/name: "show_chart"/.test(server) && /function chartSVG/.test(taskpane) && /function renderChartCard/.test(taskpane), "inline charts missing");
  assert(/name: "update_plan"/.test(server) && /plan-step/.test(taskpane) && /\.plan-card/.test(read("src/taskpane/taskpane.css")), "live plan cards missing");
  // Org templates
  assert(/export async function createTemplate/.test(read("server/templates.js")) && /app\.get\("\/api\/templates"/.test(server), "templates store/endpoints missing");
  assert(/function openTemplates/.test(taskpane) && /label: "Mallar"/.test(taskpane), "templates UI missing");
  // Global search in ⌘K
  assert(/globalSearch/.test(taskpane) && /group: "Kunskapsbank"/.test(taskpane) && /group: "E-post"/.test(taskpane), "global search missing");
  // Voice input
  assert(/function wireVoiceInput/.test(taskpane) && /webkitSpeechRecognition/.test(taskpane) && /id="mic"/.test(read("src/taskpane/taskpane.html")), "voice input missing");
  // Change log with stepwise revert
  assert(/function openChangeLog/.test(taskpane) && /Ångra hit/.test(taskpane) && /currentToolName/.test(taskpane), "sheet change log missing");
});

check("Djupresearch (multi-round cited research) is wired", () => {
  assert(/app\.post\("\/api\/deepresearch"/.test(server) && /DEEPRESEARCH_SYSTEM/.test(server), "deepresearch endpoint missing");
  assert(/pause_turn/.test(server.slice(server.indexOf('app.post("/api/deepresearch"'))), "deepresearch must resume on pause_turn (long server-tool runs)");
  assert(/function openDeepResearch/.test(taskpane) && /function postSSE/.test(taskpane), "deepresearch UI / SSE helper missing");
  assert(/label: "Djupresearch"/.test(taskpane), "Djupresearch must be reachable from nav/palette");
});

check("watchers (proactive bevakningar) are wired", () => {
  const w = read("server/watchers.js");
  assert(/export async function createWatcher/.test(w) && /export async function checkWatcher/.test(w) && /export async function tickWatchers/.test(w), "watcher store/checker/tick missing");
  assert(/COOLDOWN_MS/.test(w) && /lastSignature/.test(w), "watcher alerts must be throttled (cooldown + same-finding dedup)");
  assert(/judgeCondition/.test(w) && /triggered=false/.test(w), "NL condition judging (fail-closed) missing");
  assert(/tickWatchers\(client, SIMPLE_MODEL\)/.test(read("server/scheduler.js")), "watchers must run from the scheduler tick");
  assert(/app\.get\("\/api\/watchers"/.test(server) && /app\.post\("\/api\/watchers"/.test(server) && /\/api\/watchers\/:id\/check/.test(server), "watcher endpoints missing");
  assert(/function openWatchers/.test(taskpane) && /label: "Bevakningar"/.test(taskpane), "watchers UI missing");
});

check("RAG quality eval (retrieval log + precision judging) is wired", () => {
  const vlt = read("server/vault.js");
  assert(/export function retrievalLog/.test(vlt) && /function logRetrieval/.test(vlt) && /slice\(-100\)/.test(vlt), "bounded retrieval log missing");
  assert(/app\.post\("\/api\/vault\/eval"/.test(server) && /misses/.test(server), "eval endpoint (precision + zero-hit queries) missing");
  assert(/function openVaultEval/.test(taskpane) && /id="vault-eval"/.test(taskpane), "eval UI in the vault missing");
});

check("voice mode (hands-free conversation loop) is wired", () => {
  assert(/function toggleVoiceMode/.test(taskpane) && /function speakLastReply/.test(taskpane) && /SpeechSynthesisUtterance/.test(taskpane), "voice mode / TTS missing");
  assert(/function stripForSpeech/.test(taskpane), "markdown must be stripped before speaking");
  assert(/speechSynthesis\?\.cancel\(\)/.test(taskpane) || /speechSynthesis\.cancel\(\)/.test(taskpane), "barge-in (talking interrupts speech) missing");
  assert(/Röstläge/.test(taskpane) && /speakLastReply\(\);/.test(taskpane), "voice mode must be reachable and speak after turns");
});

check("meeting notes (transcript → minutes → workspace) are wired", () => {
  assert(/function openMeetingNotes/.test(taskpane) && /åtgärdspunkter/i.test(taskpane), "meeting-notes flow missing");
  assert(/label: "Mötesanteckningar"/.test(taskpane), "meeting notes must be reachable from nav/palette");
});

check("governance (org-wide usage, top users, spend cap) is wired", () => {
  const usg = read("server/usage.js");
  assert(/export async function getOrgUsage/.test(usg) && /export async function orgSpendToday/.test(usg) && /export async function rememberUser/.test(usg), "org usage store missing");
  assert(/simba_users/.test(usg), "user directory (names for the governance view) missing");
  assert(/app\.get\("\/api\/org-usage"/.test(server) && /isOrgAdmin/.test(server), "org-usage endpoint must be admin-gated");
  assert(/SIMBA_ORG_DAILY_USD/.test(server) && /orgSpendToday\(orgOf\(user\)\)/.test(server), "optional org daily spend cap missing");
  assert(/rememberUser\(user\.key/.test(server), "chat must feed the governance directory");
  assert(/function openGovernance/.test(taskpane) && /label: "Styrning"/.test(taskpane), "governance UI missing");
});

check("ambient context (recent-inbox weaving) is wired & cached", () => {
  const amb = read("server/ambient.js");
  assert(/export async function ambientContext/.test(amb) && /oboGraphToken/.test(amb), "ambient module must use the user's own delegated consent");
  assert(/TTL/.test(amb) && /cache\.get\(userKey\)/.test(amb), "ambient snapshot must be cached (one Graph call per burst, cache-stable in tool loops)");
  assert(/catch \{[^}]*\}/.test(amb) || /catch \{/.test(amb), "ambient must fail soft (no consent → empty, never an error)");
  assert(/req\.body\.ambient === false \? "" : ambientContext\(bearer\(req\), user\.key\)/.test(server), "chat must fetch ambient context (opt-out honoured)");
  assert(/Läget just nu/.test(server), "ambient text must be labelled in the injected context");
  assert(/prefAmbient/.test(taskpane) && /ambient: prefAmbient\(\)/.test(taskpane) && /id="ambient-seg"/.test(taskpane), "client ambient toggle missing");
});

check("auto-memory (background fact extraction) is wired & guarded", () => {
  const am = read("server/automemory.js");
  assert(/export async function distillMemory/.test(am) && /setMemory/.test(am), "auto-memory extractor missing");
  assert(/THROTTLE_MS/.test(am) && /isDuplicate/.test(am), "auto-memory must be throttled and dedupe near-duplicates");
  assert(/distillMemory\(client, MODEL_SIMPLE/.test(server) && /req\.body\.autoMemory !== false/.test(server) && /stop_reason === "end_turn"/.test(server), "chat must run auto-memory in the background on completed turns (opt-out honoured)");
  assert(/prefAutoMem/.test(taskpane) && /autoMemory: prefAutoMem\(\)/.test(taskpane) && /id="automem-seg"/.test(taskpane), "client auto-memory toggle missing");
  assert(/function refreshMemoryFromServer/.test(taskpane) && /refreshMemoryFromServer\(\)/.test(taskpane), "client must re-pull memory after turns (or local pushes clobber learned notes)");
});

check("browser agent (computer use) is wired, flag-gated & bounded", () => {
  const br = read("server/browser.js");
  assert(/export async function runBrowserTask/.test(br) && /computer_20250124/.test(br) && /computer-use-2025-01-24/.test(br), "computer-use loop missing");
  assert(/SIMBA_BROWSER === "1"/.test(br), "browser agent must be flag-gated (off by default)");
  assert(/MAX_STEPS/.test(br) && /TASK_BUDGET_MS/.test(br), "browser tasks must be step- and time-bounded");
  assert(/BLOCKED_URL/.test(br) && /FÖRBJUDET/.test(br), "URL scheme blocklist + no-credentials rule missing");
  assert(/import\("playwright"\)/.test(br), "playwright must be a dynamic import (optional heavy dependency)");
  assert(/app\.post\("\/api\/browser"/.test(server) && server.slice(server.indexOf('app.post("/api/browser"')).slice(0, 400).includes("enforceAuth"), "/api/browser endpoint must be auth-checked");
  assert(/name: "browse_website"/.test(server) && /async browse_website\(/.test(taskpane), "browse_website tool must exist on both sides (parity)");
});

check("Uppdrag (goal+rubric missions) are wired", () => {
  const ms = read("server/missions.js");
  assert(/export async function createMission/.test(ms) && /export async function runMission/.test(ms) && /export async function cancelMission/.test(ms), "mission store/runner missing");
  assert(/EVAL_SYSTEM/.test(ms) && /max_iter/.test(ms) && /feedback/.test(ms), "missions must iterate against a rubric with evaluator feedback");
  assert(/stillWanted/.test(ms), "mission runner must honour mid-run cancellation");
  assert(/done_partial/.test(ms), "missions must deliver best-effort when iterations run out");
  assert(/app\.post\("\/api\/missions"/.test(server) && /runMission\(client, MODEL/.test(server) && /\/api\/missions\/:id\/cancel/.test(server), "mission endpoints / background start missing");
  assert(/function openMissions/.test(taskpane) && /label: "Uppdrag"/.test(taskpane) && /MISSION_STATUS/.test(taskpane), "missions UI missing");
});

check("profile view: usage + estimated spend is wired", () => {
  const usg = read("server/usage.js");
  assert(/export function estimateCost/.test(usg) && /export async function recordUsage/.test(usg) && /export async function getUsage/.test(usg), "usage store API missing");
  assert(/opus/.test(usg) && /haiku/.test(usg), "per-model pricing table missing");
  assert(/recordUsage\(user\.key/.test(server) && /app\.get\("\/api\/usage"/.test(server), "usage must be recorded per turn + exposed via /api/usage");
  // client: a Profil tab that renders identity + usage cards + chart
  assert(/data-tab="profile"/.test(taskpane) && /function populateProfile/.test(taskpane), "profile UI missing");
  assert(/\/api\/usage/.test(taskpane) && /pf-cards/.test(taskpane), "profile must fetch usage + render cards");
  assert(/\.pf-avatar/.test(read("src/taskpane/taskpane.css")) && /\.pf-chart/.test(read("src/taskpane/taskpane.css")), "profile styling missing");
  // store behaviour prepared above: Opus is priced above Haiku; a turn round-trips
  assert(_usdOpus === 5 && _usdHaiku === 1, "per-1M input pricing should match list prices (Opus $5, Haiku $1)");
  assert(_usageSummary.today.turns === 1 && _usageSummary.all.cost > 0, "usage summary should round-trip a recorded turn");
});

check("home dashboard (welcome-screen activity stats) is wired", () => {
  const usg = read("server/usage.js");
  assert(/export async function getStats/.test(usg) && /simba_usage_models/.test(usg) && /simba_usage_hours/.test(usg), "stats store (models + hours) missing");
  assert(/app\.get\("\/api\/stats"/.test(server) && /getStats\(user\.key\)/.test(server), "/api/stats endpoint missing");
  // client: dashboard renders greeting + cells + heatmap + models tab
  assert(/function renderHomeStats/.test(taskpane) && /function drawHomeStats/.test(taskpane), "home stats render functions missing");
  assert(/id="home-stats"/.test(taskpane) && /function heatmapHTML/.test(taskpane), "home stats slot / heatmap missing");
  assert(/Favoritmodell/.test(taskpane) && /Populäraste tid/.test(taskpane) && /längsta streak|Längsta streak/.test(taskpane), "stat cells missing");
  assert(/\.hs-card/.test(read("src/taskpane/taskpane.css")) && /\.hs-heat-grid/.test(read("src/taskpane/taskpane.css")), "dashboard styling missing");
});

check("connector WRITES (post hours into e.g. NEXT) are wired & approval-gated", () => {
  const conn = read("server/connectors.js");
  const sch = read("server/scheduler.js");
  assert(/export async function writeConnector/.test(conn) && /export function renderTemplate/.test(conn) && /export async function buildWriteRequests/.test(conn), "write executor/template/builder missing");
  assert(/async function rawSend/.test(conn) && /Endast HTTPS/.test(conn), "hardened POST/PUT sender missing");
  // time reconciler posts structured rows via an approval, never auto-writing
  assert(/buildWriteRequests/.test(sch) && /connector_write/.test(sch) && /cfg\.post/.test(sch), "time reconciler must build a connector_write approval");
  // approval decision actually performs the write
  assert(/ap\.kind === "connector_write"/.test(server) && /writeConnector\(orgOf\(user\)/.test(server), "approval handler must execute the write");
  // client: write endpoint editor + agent link + approval preview
  assert(/dc-ep-method/.test(taskpane) && /dc-ep-body-tpl/.test(taskpane), "connector builder write-endpoint UI missing");
  assert(/oa-post-conn/.test(taskpane) && /function wireAgentPostSource/.test(taskpane), "agent → data source link UI missing");
  assert(/connector_write/.test(taskpane), "approval preview must handle connector_write");
  // store behavior prepared above
  assert(_connWepMethod === "POST", "write endpoint must persist its method");
  assert(_connBuilt.bodies?.[0]?.hours === 8 && _connBuilt.bodies[0].employee === "a@x.se", "template must render concrete request bodies");
  assert(_connWriteRejectsGet === true, "writing to a GET (read) endpoint must be rejected");
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
  // Visual mail panel + folders + attachments (reachable from the sidebar nav / ⋯ menu)
  assert(/label: "E-post", run: openMail/.test(taskpane), "E-post must be reachable from the sidebar nav");
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
  assert(/retrieveWithSources\(orgOf\(user\)/.test(server), "chat must inject the org vault context (with sources for citations)");
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
  // Stronger RAG: passage-level chunking + cross-encoder reranking, grounded context.
  assert(/export function chunkText/.test(emb) && /export async function rerank/.test(emb) && /api\.voyageai\.com\/v1\/rerank/.test(emb), "chunking / rerank helpers missing");
  assert(/chunks JSONB/.test(read("server/vault.js")) && /function computeVectors/.test(read("server/vault.js")), "vault must store passage chunks");
  assert(/rerankEnabled/.test(read("server/vault.js")) && /function searchRanked/.test(read("server/vault.js")), "rerank pipeline not wired into retrieval");
  assert(_chunks.length > 1, "chunkText should split a long document into multiple passages");
  assert(_vaultCtx.includes("990 kr"), "retrieveForContext must ground on the matched passage");
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
