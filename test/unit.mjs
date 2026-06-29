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

check("client and server expose the exact same tool set", () => {
  const beTools = [...server.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
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
  const tools = [...server.matchAll(/\{\s*name:\s*"([a-z_]+)",\s*description:\s*"([^"]+)",\s*input_schema:/g)];
  const names = [...server.matchAll(/name:\s*"([a-z_]+)"/g)];
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
  assert(!/X-Frame-Options/.test(server), "must NOT set X-Frame-Options (breaks Office embedding)");
  assert(/&quot;|&#39;/.test(read("src/taskpane/taskpane.js")), "escapeHtml must escape quotes (XSS)");
  const identity = read("server/identity.js");
  assert(/access_as_user/.test(identity), "SSO must require the access_as_user scope");
  assert(/no tenant id|tid\)/.test(identity), "SSO must require a tenant id");
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
