/**
 * Full-page screenshots with headless Chromium over the DevTools protocol.
 *
 * Uses Node's own WebSocket, so there is no browser library to install. Chromium comes from
 * CHROME_PATH or the usual install paths. Pages load with prefers-reduced-motion: reduce and
 * with animations stopped, so two captures of the same page are the same picture.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { runSteps } from "./steps.mjs";

const PAGE_TIMEOUT_MS = 30_000;
/** Chromium cannot capture taller pictures in one piece; a page beyond this is cut off. */
export const MAX_HEIGHT = 12_000;
// Up to this height a page is also captured with twice the pixels, for the video
const SHARP_HEIGHT = 8000;

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error("No Chromium found; set CHROME_PATH.");
  return found;
}

function connect(url) {
  const ws = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id !== undefined) {
      const call = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) call.fail(new Error(`${call.method}: ${msg.error.message}`));
      else call.ok(msg.result);
      return;
    }
    for (const listener of listeners) listener(msg);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, fail) => {
      const id = ++nextId;
      pending.set(id, { ok, fail, method });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const once = (method, sessionId, timeout = PAGE_TIMEOUT_MS) =>
    new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        fail(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      const listener = (msg) => {
        if (msg.method !== method || msg.sessionId !== sessionId) return;
        clearTimeout(timer);
        listeners.delete(listener);
        ok(msg.params);
      };
      listeners.add(listener);
    });
  const on = (method, sessionId, fn) => {
    const listener = (msg) => {
      if (msg.method === method && msg.sessionId === sessionId) fn(msg.params);
    };
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const opened = new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error(`Cannot connect to ${url}`));
  });
  // A browser that goes away mid-run (crashed, out of memory) fails every call that waits
  // on it, instead of leaving the run hanging
  let gone = null;
  const lost = (why) => {
    if (gone) return;
    gone = new Error(why);
    for (const call of pending.values()) call.fail(gone);
    pending.clear();
  };
  ws.onclose = () => lost("The browser closed");
  ws.addEventListener("error", () => lost("The connection to the browser failed"));
  const guarded = (method, params, sessionId) => (gone ? Promise.reject(gone) : send(method, params, sessionId));
  return { opened, send: guarded, once, on, close: () => ws.close(), lost };
}

/**
 * A browser with a tab for each version, "before" and "after", each in a context of its own:
 * cookies are not kept apart by port, so with both versions on 127.0.0.1 a login on one side
 * would otherwise be the other's too.
 *
 * - `capture(url, { side, width, height, ignore, sharp, steps, stateIgnore, base,
 *   testIdAttribute, env })` gives `{ page, layers }`: the whole page as a PNG buffer for
 *   showing, and the pictures to compare. A page that scrolls as a whole is one layer; a page
 *   that scrolls inside an element is a content and a shell layer, each with its place (`x`,
 *   `y`) in the picture it is shown in. With `steps` (a state's, from readStates) the page is
 *   loaded, the steps run, and the picture is taken where they end; when one stops, the
 *   picture is of where the page stands then, and the result has `stopped: { step, reason }`.
 *   `base` is the address `navigate` paths go after (the origin of `url` when not given).
 * - `run(side, steps, { width, height, base, testIdAttribute, env })` runs steps without
 *   loading or capturing anything first, for a login: `{ reached: true }` or
 *   `{ reached: false, step, reason }`.
 * - `shootHere(side, { width, height, ignore, sharp })` captures the page as it stands, as
 *   capture does after loading: the end of a login, or where it stopped.
 * - `resetSide(side)` throws that side's context away and makes a fresh one: no cookies, no
 *   storage, as for a first visit.
 *
 * Dialogs of a page (alert, confirm, prompt, beforeunload) would hold it until someone
 * answers. They are accepted at once, and `onDialog({ side, type, message })` hears of each.
 */
export async function openBrowser({ wait = 500, onDialog = () => {} } = {}) {
  const profileDir = mkdtempSync(join(tmpdir(), "changereel-"));
  const chrome = spawn(
    findChrome(),
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--hide-scrollbars",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  const endpoint = await new Promise((ok, fail) => {
    let buffer = "";
    chrome.stderr.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) ok(match[1]);
    });
    chrome.on("exit", (code) => fail(new Error(`Chromium exited (${code})`)));
  });
  const cdp = connect(endpoint);
  chrome.on("exit", (code) => cdp.lost(`Chromium exited (${code})`));
  await cdp.opened;

  async function openTab(side) {
    const { browserContextId } = await cdp.send("Target.createBrowserContext");
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, params = {}) => cdp.send(method, params, sessionId);
    await send("Page.enable");
    await send("Network.enable");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    // For finding what steps name, and for the handles to it
    await send("DOM.enable");
    await send("Accessibility.enable");
    await send("Runtime.enable");
    const off = cdp.on("Page.javascriptDialogOpening", sessionId, ({ type, message }) => {
      send("Page.handleJavaScriptDialog", { accept: true, promptText: "" }).catch(() => {});
      onDialog({ side, type, message });
    });
    return {
      side,
      browserContextId,
      sessionId,
      send,
      off,
      once: (method, timeout) => cdp.once(method, sessionId, timeout),
      on: (method, fn) => cdp.on(method, sessionId, fn),
    };
  }
  const tabs = { before: await openTab("before"), after: await openTab("after") };
  let last = tabs.before;
  const tabOf = (side) => {
    if (!Object.hasOwn(tabs, side)) throw new Error(`No side "${side}"`);
    return (last = tabs[side]);
  };

  async function resetSide(side) {
    const old = tabOf(side);
    try {
      await cdp.send("Target.disposeBrowserContext", { browserContextId: old.browserContextId });
    } catch {
      // Gone already, or it would not go: the side gets its fresh context all the same
    }
    // The old tab answers its dialogs until the new one is there: a side is never without
    last = tabs[side] = await openTab(side);
    old.off();
  }

  const viewport = (tab, width, height) =>
    tab.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

  /** Loads a page and waits for its load event; throws on a network error or an HTTP error. */
  async function load(tab, url, timeout) {
    let status = 0;
    const off = tab.on("Network.responseReceived", ({ type, response }) => {
      if (type === "Document" && !status) status = response.status;
    });
    const loaded = tab.once("Page.loadEventFired", timeout);
    // A navigation that fails never fires the event; its timer must not fail the run later
    loaded.catch(() => {});
    try {
      const nav = await tab.send("Page.navigate", { url });
      if (nav.errorText) throw new Error(nav.errorText);
      await loaded;
    } finally {
      off();
    }
    if (status >= 400) throw new Error(`HTTP ${status}`);
  }

  async function capture(url, { side = "before", width = 1280, height = 800, ignore = [], sharp = false, steps, stateIgnore = [], base, testIdAttribute, env } = {}) {
    const tab = tabOf(side);
    await viewport(tab, width, height);
    await load(tab, url);
    let stopped;
    if (steps?.length) {
      const done = await runSteps(tab, steps, {
        base: base ?? new URL(url).origin,
        load: (to, timeout) => load(tab, to, timeout),
        testIdAttribute,
        env,
      });
      if (!done.reached) stopped = { step: done.step, reason: done.reason };
    }
    const shot = await picture(tab, { width, height, ignore: [...ignore, ...stateIgnore], sharp });
    return stopped ? { ...shot, stopped } : shot;
  }

  async function run(side, steps, { width = 1280, height = 800, base, testIdAttribute, env } = {}) {
    const tab = tabOf(side);
    await viewport(tab, width, height);
    return runSteps(tab, steps, { base, load: (to, timeout) => load(tab, to, timeout), testIdAttribute, env });
  }

  async function shootHere(side, { width = 1280, height = 800, ignore = [], sharp = false } = {}) {
    const tab = tabOf(side);
    await viewport(tab, width, height);
    return picture(tab, { width, height, ignore, sharp });
  }

  /** The pictures of the page as it stands: settled, moving parts stopped, whole. */
  async function picture({ sessionId }, { width, height, ignore, sharp }) {
    // A selector the browser cannot read would silently hide nothing
    for (const selector of ignore) {
      const { exceptionDetails } = await cdp.send(
        "Runtime.evaluate",
        { expression: `document.querySelector(${JSON.stringify(selector)})` },
        sessionId,
      );
      if (exceptionDetails) throw new Error(`--ignore: "${selector}" is not a selector`);
    }
    // Fonts in, client rendering done, then everything that still moves is stopped at its end
    await cdp.send(
      "Runtime.evaluate",
      {
        expression: `(async () => {
          await document.fonts.ready;
          await new Promise((r) => setTimeout(r, ${Number(wait)}));
          // Parts that load when the browser is idle arrive later still. The page counts as
          // settled when its markup and its heights are the same on four looks in a row.
          const look = () => {
            let heights = document.documentElement.scrollHeight;
            for (const el of document.querySelectorAll("body *")) heights += el.scrollHeight;
            return document.documentElement.innerHTML.length + ":" + heights;
          };
          let last = look();
          for (let same = 0, tries = 0; same < 4 && tries < 40; tries++) {
            await new Promise((r) => setTimeout(r, 250));
            const now = look();
            same = now === last ? same + 1 : 0;
            last = now;
          }
          const style = document.createElement("style");
          // Frames hold what the page does not own (a captcha, a map, a video player) and
          // load in another state on every visit: they keep their place, but are not drawn
          style.textContent = "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; caret-color: transparent !important; } iframe { visibility: hidden !important; }";
          // What --ignore names is drawn in the pictures that are shown and left out of the
          // ones that are compared: its own sheet, switched on for those
          const left = document.createElement("style");
          left.id = "changereel-ignore";
          left.media = "not all";
          left.textContent = ${JSON.stringify(ignore.length ? `${ignore.join(", ")} { visibility: hidden !important; }` : "")};
          document.head.append(left);
          document.head.append(style);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        })()`,
        awaitPromise: true,
      },
      sessionId,
    );
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
      return result.value;
    };
    const shot = async (clip, beyond = false, scale = 1) => {
      const { data } = await cdp.send(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: beyond, clip: { ...clip, scale } },
        sessionId,
      );
      return Buffer.from(data, "base64");
    };
    const settle = "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))";

    // A page whose content scrolls inside an element (an app shell with a fixed sidebar) is
    // as tall as the window, whatever it holds. Such a page is two layers: the shell, which
    // is the window with the scrolling element blanked, and the content. For the content the
    // window is made taller by what the element hides, so it shows everything at once, and
    // the element is cut out of that picture. The sidebar in it is stretched to the height
    // of the content and would differ whenever the content got longer; that is why the
    // shell is compared as the window shows it.
    //
    // Scrolling through the element and stitching the parts would keep the window as it is,
    // but everything that answers to the scroll position (a heading that gains weight while
    // it passes, a card that lights up in view) would be caught at another moment on each
    // side as soon as one side is a few pixels longer.
    const find = `(() => {
      if (window.__changereel) return window.__changereel;
      if (document.documentElement.scrollHeight > innerHeight) return null;
      let found = null;
      let hidden = 0;
      for (const el of document.querySelectorAll("body *")) {
        const extra = el.scrollHeight - el.clientHeight;
        if (extra <= hidden || el.clientWidth < innerWidth / 3) continue;
        const overflow = getComputedStyle(el).overflowY;
        if (overflow === "auto" || overflow === "scroll") {
          found = el;
          hidden = extra;
        }
      }
      return (window.__changereel = found);
    })()`;
    const place = `(() => {
      const el = ${find};
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.left + el.clientLeft),
        y: Math.round(rect.top + el.clientTop),
        width: el.clientWidth,
        height: el.clientHeight,
        full: el.scrollHeight,
      };
    })()`;

    const leaveOut = (on) =>
      evaluate(`(async () => { document.getElementById("changereel-ignore").media = "${on ? "all" : "not all"}"; await ${settle}; })()`);
    const layers = [];
    const scroller = await evaluate(place);
    let shell;
    let shown;
    let sharpWindow;
    if (scroller) {
      shown = await shot({ x: 0, y: 0, width, height });
      if (sharp) sharpWindow = await shot({ x: 0, y: 0, width, height }, false, 2);
      await leaveOut(true);
      shell = PNG.sync.read(await shot({ x: 0, y: 0, width, height }));
      await leaveOut(false);
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        { width, height: Math.min(height + scroller.full - scroller.height, MAX_HEIGHT), deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
      await evaluate(settle);
    }
    const { cssContentSize } = await cdp.send("Page.getLayoutMetrics", {}, sessionId);
    const full = Math.min(Math.ceil(cssContentSize.height), MAX_HEIGHT);
    const page = await shot({ x: 0, y: 0, width, height: full }, true);
    // For showing, the same picture with twice the pixels: a video enlarges the page and
    // moves closer to it. Not for a very long page, whose picture would be too large to draw.
    const sharpPage = sharp && full <= SHARP_HEIGHT ? await shot({ x: 0, y: 0, width, height: full }, true, 2) : null;
    await leaveOut(true);
    const compared = ignore.length ? await shot({ x: 0, y: 0, width, height: full }, true) : page;
    if (scroller) {
      const grown = await evaluate(place);
      const tall = PNG.sync.read(compared);
      const rows = Math.min(grown.height, tall.height - grown.y);
      const content = new PNG({ width: grown.width, height: rows });
      for (let row = 0; row < rows; row++) {
        const from = ((grown.y + row) * tall.width + grown.x) * 4;
        tall.data.copy(content.data, row * grown.width * 4, from, from + grown.width * 4);
      }
      // The shell without the content: one flat colour where the scrolling element is
      const blank = PNG.sync.read(PNG.sync.write(shell));
      for (let row = scroller.y; row < Math.min(scroller.y + scroller.height, height); row++) {
        blank.data.fill(0x80, (row * width + scroller.x) * 4, (row * width + scroller.x + scroller.width) * 4);
      }
      layers.push({ name: "content", png: PNG.sync.write(content), x: grown.x, y: grown.y, shown: "page" });
      layers.push({ name: "shell", png: PNG.sync.write(blank), x: 0, y: 0, shown: "window", window: shown });
    } else {
      layers.push({ name: "page", png: compared, x: 0, y: 0, shown: "page" });
    }
    return { page, compared, sharp: { page: sharpPage, window: sharpWindow ?? null }, layers };
  }

  /** Runs an expression in the page of a side, by default the one used last. For looking into a finding. */
  async function evaluate(expression, side) {
    const tab = side ? tabOf(side) : last;
    const { result } = await tab.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return result.value;
  }

  async function close() {
    cdp.close();
    const exited = new Promise((ok) => chrome.once("exit", ok));
    try {
      process.kill(-chrome.pid, "SIGTERM");
    } catch {
      chrome.kill();
    }
    await exited;
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.warn(`Could not remove ${profileDir}: ${err.message}`);
    }
  }

  return { capture, run, shootHere, resetSide, evaluate, close };
}
