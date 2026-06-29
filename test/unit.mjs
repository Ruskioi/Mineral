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
