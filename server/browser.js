/*
 * Browser agent — Claude "computer use" driving a real headless Chromium via
 * Playwright, for tasks web_lookup can't do: JS-heavy pages, data behind
 * clicks/filters, stepwise flows. The model sees screenshots and acts
 * (click/type/scroll); we execute each action on the page and screenshot back.
 *
 * Deliberately conservative:
 *  - Flag-gated: requires SIMBA_BROWSER=1 AND `playwright` installed (it's a
 *    heavy optional dependency — dynamic import, never required at startup).
 *  - Ephemeral: a fresh browser per task; no cookies or sessions persist.
 *  - No credentials: the system prompt forbids logins/passwords/purchases.
 *  - Bounded: step cap + per-task time budget; one task at a time per server.
 */

export const browserEnabled = process.env.SIMBA_BROWSER === "1";

const W = 1280, H = 800;
const MAX_STEPS = 30;
const TASK_BUDGET_MS = 4 * 60_000;
const BLOCKED_URL = /^(file|chrome|about|data|javascript|view-source):/i;

let pwPromise = null;
function playwright() {
  if (!pwPromise) pwPromise = import("playwright").then((m) => m.default || m).catch(() => null);
  return pwPromise;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// xdotool-style key names (what computer-use emits) → Playwright key names.
const KEYMAP = {
  return: "Enter", enter: "Enter", kp_enter: "Enter", tab: "Tab", escape: "Escape", esc: "Escape",
  backspace: "Backspace", back_space: "Backspace", delete: "Delete", space: " ",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  page_up: "PageUp", page_down: "PageDown", home: "Home", end: "End",
  ctrl: "Control", control: "Control", alt: "Alt", shift: "Shift", super: "Meta", cmd: "Meta", meta: "Meta",
};
function toKeyCombo(spec) {
  return String(spec || "")
    .split("+")
    .map((k) => KEYMAP[k.trim().toLowerCase()] || (k.trim().length === 1 ? k.trim() : k.trim()[0].toUpperCase() + k.trim().slice(1)))
    .join("+");
}

async function act(page, input) {
  const a = String(input?.action || "");
  const [x, y] = Array.isArray(input?.coordinate) ? input.coordinate : [];
  switch (a) {
    case "screenshot": return;
    case "cursor_position": return;
    case "left_click": await page.mouse.click(x, y); break;
    case "double_click": await page.mouse.dblclick(x, y); break;
    case "triple_click": await page.mouse.click(x, y, { clickCount: 3 }); break;
    case "right_click": await page.mouse.click(x, y, { button: "right" }); break;
    case "middle_click": await page.mouse.click(x, y, { button: "middle" }); break;
    case "mouse_move": await page.mouse.move(x, y); break;
    case "left_click_drag": {
      const [sx, sy] = input.start_coordinate || [x, y];
      await page.mouse.move(sx, sy); await page.mouse.down();
      await page.mouse.move(x, y, { steps: 10 }); await page.mouse.up();
      break;
    }
    case "type": await page.keyboard.type(String(input.text || "").slice(0, 2000), { delay: 8 }); break;
    case "key": await page.keyboard.press(toKeyCombo(input.text)); break;
    case "hold_key": await page.keyboard.press(toKeyCombo(input.text)); break;
    case "scroll": {
      const dir = String(input.scroll_direction || "down");
      const amt = Math.min(10, Math.max(1, Number(input.scroll_amount) || 3)) * 120;
      if (x != null && y != null) await page.mouse.move(x, y);
      await page.mouse.wheel(dir === "left" ? -amt : dir === "right" ? amt : 0, dir === "up" ? -amt : dir === "down" ? amt : 0);
      break;
    }
    case "wait": await sleep(Math.min(3000, (Number(input.duration) || 1) * 1000)); break;
    default: throw new Error(`Ohanterad åtgärd: ${a}`);
  }
  // Give the page a beat to react before the follow-up screenshot.
  await page.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => {});
  await sleep(250);
}

async function shot(page) {
  const buf = await page.screenshot({ type: "png" });
  return { type: "image", source: { type: "base64", media_type: "image/png", data: buf.toString("base64") } };
}

const BROWSER_SYSTEM =
  "Du styr en riktig webbläsare via skärmdumpar för att utföra användarens uppgift. Arbeta målmedvetet: navigera, " +
  "klicka, skriv och läs det som behövs — ta en skärmdump efter varje steg för att se resultatet. Använd open_url för " +
  "att byta sida (snabbare än att skriva i adressfältet). ABSOLUT FÖRBJUDET: logga in, ange lösenord/koder, godkänna " +
  "köp eller lämna personuppgifter — avbryt och förklara om uppgiften kräver det. När du är klar: svara med resultatet " +
  "på svenska, konkret och komplett, med sidans URL som källa.";

let busy = false; // one browser task at a time — they're heavy (CPU + tokens)

export async function runBrowserTask(client, model, { task, url }) {
  if (!browserEnabled) throw Object.assign(new Error("Webbläsaragenten är avstängd på servern (sätt SIMBA_BROWSER=1)."), { status: 503 });
  const pw = await playwright();
  if (!pw?.chromium) throw Object.assign(new Error("Playwright är inte installerat på servern (npm install playwright)."), { status: 503 });
  if (busy) throw Object.assign(new Error("Webbläsaragenten är upptagen med en annan uppgift — försök strax igen."), { status: 429 });
  busy = true;
  const deadline = Date.now() + TASK_BUDGET_MS;
  const browser = await pw.chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    const start = String(url || "").trim();
    if (start && !BLOCKED_URL.test(start)) await page.goto(/^https?:/i.test(start) ? start : `https://${start}`, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});

    const tools = [
      { type: "computer_20250124", name: "computer", display_width_px: W, display_height_px: H },
      { name: "open_url", description: "Gå direkt till en webbadress i webbläsaren.",
        input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
    ];
    const messages = [{ role: "user", content: [
      { type: "text", text: `UPPGIFT:\n${task}\n\nWebbläsaren visar just nu:` },
      await shot(page),
    ] }];

    for (let step = 0; step < MAX_STEPS; step++) {
      if (Date.now() > deadline) return "Tidsbudgeten tog slut innan uppgiften blev klar. Det jag hann se framgår ovan — prova en snävare uppgift.";
      const resp = await client.beta.messages.create({
        model, max_tokens: 4000, betas: ["computer-use-2025-01-24"],
        system: BROWSER_SYSTEM, tools, messages,
      });
      const toolUses = resp.content.filter((b) => b.type === "tool_use");
      if (!toolUses.length) return resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || "Klart (inget textsvar).";
      messages.push({ role: "assistant", content: resp.content });
      const results = [];
      for (const b of toolUses) {
        try {
          if (b.name === "open_url") {
            const u = String(b.input?.url || "");
            if (BLOCKED_URL.test(u)) throw new Error("Endast http/https-adresser är tillåtna.");
            await page.goto(/^https?:/i.test(u) ? u : `https://${u}`, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
          } else {
            await act(page, b.input || {});
          }
          results.push({ type: "tool_result", tool_use_id: b.id, content: [{ type: "text", text: `OK · ${page.url()}` }, await shot(page)] });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: [{ type: "text", text: (e?.message || "Åtgärden misslyckades").slice(0, 300) }, await shot(page).catch(() => ({ type: "text", text: "(ingen skärmdump)" }))] });
        }
      }
      messages.push({ role: "user", content: results });
      // Keep the transcript bounded: only the latest few screenshots carry weight.
      let imgs = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const c = messages[i]?.content;
        if (!Array.isArray(c)) continue;
        for (const blk of c) {
          const inner = blk?.type === "tool_result" && Array.isArray(blk.content) ? blk.content : [blk];
          for (let k = inner.length - 1; k >= 0; k--) {
            if (inner[k]?.type === "image") { imgs++; if (imgs > 3) inner.splice(k, 1, { type: "text", text: "(äldre skärmdump borttagen)" }); }
          }
        }
      }
    }
    return "Maxantalet steg nåddes innan uppgiften blev klar. Prova att dela upp den i mindre uppgifter.";
  } finally {
    busy = false;
    await browser.close().catch(() => {});
  }
}
