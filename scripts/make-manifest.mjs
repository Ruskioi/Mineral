#!/usr/bin/env node
/*
 * Generate a manifest from manifest.template.xml by filling in the host URL and
 * add-in id. Lets you point Simba at any HTTPS host without hand-editing the
 * manifest, and keeps the committed dev manifest (localhost) in sync.
 *
 * Usage:
 *   node scripts/make-manifest.mjs [--base <url>] [--id <guid>] [--new-id] [--out <file>]
 *
 * Defaults reproduce the committed dev manifest (localhost:3000, dev id), so
 * running it with no args regenerates manifest.xml unchanged.
 *
 * Examples:
 *   # Production manifest for your host (fresh GUID), written to manifest.prod.xml
 *   node scripts/make-manifest.mjs --base https://simba.example.com --new-id --out manifest.prod.xml
 *
 *   # Regenerate the dev manifest (localhost)
 *   node scripts/make-manifest.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEV_BASE = "https://localhost:3000";
const DEV_ID = "b6f3e1a2-7c4d-4f9a-9e2b-1a2c3d4e5f60";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const base = (arg("base", process.env.SIMBA_BASE_URL) || DEV_BASE).replace(/\/+$/, "");
const id = flag("new-id") ? randomUUID() : arg("id", process.env.SIMBA_ADDIN_ID) || DEV_ID;
const outlook = flag("outlook"); // produce the Outlook (Mailbox) manifest instead of Excel
const word = flag("word");       // produce the Word (Document) manifest instead of Excel
const out = arg("out", outlook ? "manifest.outlook.xml" : word ? "manifest.word.xml" : "manifest.xml");
const aad = arg("aad", process.env.SIMBA_AAD_CLIENT_ID); // Azure AD app (client) id — enables SSO

if (!/^https:\/\//.test(base)) {
  console.error(`[make-manifest] BASE_URL must be HTTPS (Office requires it): got "${base}"`);
  process.exit(1);
}

const template = readFileSync(resolve(root, outlook ? "manifest.outlook.template.xml" : word ? "manifest.word.template.xml" : "manifest.template.xml"), "utf8");
let xml = template.replaceAll("{{BASE_URL}}", base).replaceAll("{{ADDIN_ID}}", id);

// The SSO <WebApplicationInfo> block is filled in only when an Azure AD client id
// is supplied; otherwise it's removed so the manifest has no leftover placeholders.
if (aad) {
  const host = base.replace(/^https:\/\//, "");
  xml = xml
    .replaceAll("{{AAD_CLIENT_ID}}", aad)
    .replaceAll("{{AAD_RESOURCE}}", `api://${host}/${aad}`)
    .replace(/[ \t]*<!-- SSO:BEGIN[\s\S]*?-->\n/, "")
    .replace(/[ \t]*<!-- SSO:END -->\n/, "");
} else {
  xml = xml.replace(/[ \t]*<!-- SSO:BEGIN[\s\S]*?SSO:END -->\n/, "");
}

writeFileSync(resolve(root, out), xml);
console.log(`[make-manifest] wrote ${out}\n  host: ${outlook ? "Outlook (Mailbox)" : word ? "Word (Document)" : "Excel (Workbook)"}\n  base: ${base}\n  id:   ${id}\n  sso:  ${aad ? `enabled (${aad})` : "disabled"}`);
