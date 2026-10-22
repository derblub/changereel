import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { openBrowser } from "../src/browser.mjs";
import { cssString, runSteps } from "../src/steps.mjs";
import { serve } from "./serve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const chrome = [process.env.CHROME_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(
  (path) => path && existsSync(path),
);

// Steps as readStates gives them, with a short time so that a stop does not hold the tests up
const steps = (...list) => list.map((step) => ({ timeout: 3000, ...step, ...(step.action === "waitFor" && { state: step.state ?? "visible" }) }));
const button = (name, nth) => ({ role: "button", name, ...(nth !== undefined && { nth }) });

describe("states", { skip: !chrome && "no Chromium" }, () => {
  let was;
  let is;
  let browser;
  const dialogs = [];
  before(async () => {
    was = await serve(join(HERE, "site", "states", "before"));
    is = await serve(join(HERE, "site", "states", "after"));
    browser = await openBrowser({ wait: 0, onDialog: (dialog) => dialogs.push(dialog) });
  });
  after(async () => {
    await browser?.close();
    was?.close();
    is?.close();
  });

  const login = steps(
    { action: "navigate", path: "/login" },
    { action: "fill", target: { label: "Email" }, value: "ada@example.com" },
    { action: "fill", target: { label: "Password" }, valueFrom: { env: "CHANGEREEL_TEST_PASSWORD" } },
    { action: "press", key: "Enter" },
    { action: "waitFor", target: button("Log out") },
  );
  const env = { CHANGEREEL_TEST_PASSWORD: "secret" };

  test("each side has its own cookies, even on one host", async () => {
    assert.deepEqual(await browser.run("before", login, { base: was.url, env }), { reached: true });
    const account = steps({ action: "navigate", path: "/account" }, { action: "waitFor", target: button("Log out") });
    assert.deepEqual(await browser.run("before", account, { base: was.url }), { reached: true });
    // Both sites are on 127.0.0.1; one cookie jar would log the after side in as well
    assert.deepEqual(await browser.run("after", account, { base: is.url }), { reached: false, step: 1, reason: "not found" });
    // A fresh context has forgotten the login
    await browser.resetSide("before");
    assert.deepEqual(await browser.run("before", account, { base: was.url }), { reached: false, step: 1, reason: "not found" });
  });

  test("a dialog that slides in is reached, clicked in once it stands still, and captured", async () => {
    const plain = await browser.capture(was.url + "/cart", { side: "before" });
    const open = steps(
      { action: "click", target: button("Checkout") },
      { action: "click", target: button("Pay") },
      { action: "waitFor", target: { role: "dialog", name: "Checkout" } },
    );
    const shot = await browser.capture(was.url + "/cart", { side: "before", steps: open });
    assert.equal(shot.stopped, undefined);
    assert.equal(await browser.evaluate("pay.textContent"), "Paid");
    // The dialog's border, where it ends its slide: 120 from the top, 400 wide in the middle
    const pixel = (png, x, y) => PNG.sync.read(png).data.readUInt32BE((y * 1280 + x) * 4);
    assert.equal(pixel(shot.page, 640, 121), 0x18181bff);
    assert.equal(pixel(shot.page, 441, 300), 0x18181bff);
    assert.notEqual(pixel(plain.page, 640, 121), 0x18181bff);
  });

  test("a renamed tab stops the state at its first step, with a picture of where it stands", async () => {
    const billing = steps(
      { action: "click", target: { role: "tab", name: "Billing" } },
      { action: "waitFor", target: { role: "tabpanel", name: "Billing" } },
    );
    const reached = await browser.capture(was.url + "/settings", { side: "before", steps: billing });
    assert.equal(reached.stopped, undefined);
    const stopped = await browser.capture(is.url + "/settings", { side: "after", steps: billing });
    assert.deepEqual(stopped.stopped, { step: 0, reason: "not found" });
    assert.ok(PNG.sync.read(stopped.page).height > 0);
    assert.equal(stopped.layers.length, 1);
  });

  test("a button under a cookie banner is not clicked, and the banner is named", async () => {
    const { stopped } = await browser.capture(was.url + "/banner", {
      steps: steps({ action: "click", target: button("Subscribe"), timeout: 500 }, { action: "waitFor", target: { css: "h1" } }),
    });
    assert.deepEqual(stopped, { step: 0, reason: "covered by div.cookie-banner" });
  });

  test("two buttons of one name need nth, and nth picks in document order", async () => {
    const add = (nth) =>
      steps({ action: "click", target: button("Add", nth), timeout: 500 }, { action: "waitFor", target: { css: "#out" } });
    const both = await browser.run("before", [{ action: "navigate", path: "/twins", timeout: 3000 }, ...add()], { base: was.url });
    assert.deepEqual(both, { reached: false, step: 1, reason: "found 2; add nth to pick one" });
    const { stopped } = await browser.capture(was.url + "/twins", { steps: add(1) });
    assert.equal(stopped, undefined);
    assert.equal(await browser.evaluate("out.textContent"), "second");
    const beyond = await browser.capture(was.url + "/twins", { steps: add(2) });
    assert.deepEqual(beyond.stopped, { step: 0, reason: "found 2; there is no nth 2" });
  });

  test("a hidden element is not visible and does not count as a second one", async () => {
    const save = steps({ action: "click", target: { css: ".save" }, timeout: 500 }, { action: "waitFor", target: { css: "#out" } });
    assert.equal((await browser.capture(was.url + "/twins", { steps: save })).stopped, undefined);
    const hidden = steps({ action: "click", target: { css: ".save", nth: 1 }, timeout: 500 }, { action: "waitFor", target: { css: "#out" } });
    assert.deepEqual((await browser.capture(was.url + "/twins", { steps: hidden })).stopped, { step: 0, reason: "found 1; there is no nth 1" });
    const only = steps({ action: "waitFor", target: { css: "button.save[style]" }, timeout: 300 });
    assert.deepEqual(await browser.run("before", only), { reached: false, step: 0, reason: "not visible" });
  });

  test("confirm() is accepted and reported", async () => {
    dialogs.length = 0;
    const { stopped } = await browser.capture(is.url + "/confirm", {
      side: "after",
      steps: steps({ action: "click", target: button("Delete") }, { action: "waitFor", target: { role: "heading", name: "Deleted" } }),
    });
    assert.equal(stopped, undefined);
    assert.deepEqual(dialogs, [{ side: "after", type: "confirm", message: "Delete the report?" }]);
  });

  test("fill puts the text in, a field that hears only change reacts, Enter sends the form", async () => {
    const form = steps(
      { action: "fill", target: { label: "Search" }, value: "old" },
      { action: "fill", target: { label: "Search" }, valueFrom: { env: "CHANGEREEL_TEST_QUERY" } },
      { action: "press", key: "Enter" },
      { action: "fill", target: { label: "Nickname" }, value: "Ada" },
      { action: "waitFor", target: { role: "heading", name: "Hello Ada" } },
      { action: "waitFor", target: { role: "heading", name: "Results for chairs" } },
    );
    const { stopped } = await browser.capture(was.url + "/form", { steps: form, env: { CHANGEREEL_TEST_QUERY: "chairs" } });
    assert.equal(stopped, undefined);
    assert.equal(await browser.evaluate("query.value"), "chairs");
    const empty = steps({ action: "fill", target: { label: "Nickname" }, value: "" }, { action: "waitFor", target: { css: "#out" } });
    await browser.run("before", empty);
    assert.equal(await browser.evaluate("nickname.value"), "");
  });

  test("fill on a button says what it found", async () => {
    const { stopped } = await browser.capture(was.url + "/twins", {
      steps: steps({ action: "fill", target: { css: "#first" }, value: "x" }, { action: "waitFor", target: { css: "h1" } }),
    });
    assert.deepEqual(stopped, { step: 0, reason: "takes no text (button)" });
  });

  test("a button that comes late is waited for, ten times in a row", async () => {
    const late = steps(
      { action: "navigate", path: "/late" },
      { action: "click", target: button("Continue") },
      { action: "waitFor", target: { role: "heading", name: "Done" } },
    );
    for (let run = 0; run < 10; run++) assert.deepEqual(await browser.run("after", late, { base: is.url }), { reached: true });
  });

  test("waitFor hidden, and navigate to a page that is not there", async () => {
    const gone = steps(
      { action: "navigate", path: "/random" },
      { action: "waitFor", target: { role: "dialog", name: "Code" }, state: "hidden" },
      { action: "click", target: button("Show code") },
      { action: "waitFor", target: { role: "dialog", name: "Code" }, state: "hidden", timeout: 300 },
    );
    assert.deepEqual(await browser.run("before", gone, { base: was.url }), { reached: false, step: 3, reason: "still visible" });
    const missing = steps({ action: "navigate", path: "/nowhere" }, { action: "waitFor", target: { css: "h1" } });
    assert.deepEqual(await browser.run("before", missing, { base: was.url }), { reached: false, step: 0, reason: "HTTP 404" });
  });

  test("shootHere captures the page where the steps left it", async () => {
    const opened = steps(
      { action: "navigate", path: "/new" },
      { action: "click", target: button("Export") },
      { action: "waitFor", target: { role: "region", name: "Export" } },
    );
    assert.deepEqual(await browser.run("after", opened, { base: is.url }), { reached: true });
    const here = await browser.shootHere("after");
    assert.equal(await browser.evaluate("panel.hidden"), false);
    const fresh = await browser.capture(is.url + "/new", { side: "after" });
    assert.notEqual(Buffer.compare(here.page, fresh.page), 0);
  });

  test("a page that stops answering ends the step when its time is over, and answers again after", async () => {
    const busy = steps(
      { action: "navigate", path: "/busy" },
      { action: "click", target: button("Freeze") },
      { action: "waitFor", target: { role: "heading", name: "Never" }, timeout: 1000 },
    );
    const started = Date.now();
    const end = await browser.run("before", busy, { base: was.url });
    const took = Date.now() - started;
    assert.equal(end.step, 2);
    assert.match(end.reason, /^(not found \()?timed out\)?$/);
    // Its second, the second it may run late, and loading and clicking before
    assert.ok(took < 4000, `took ${took} ms`);
    // The script that did not end was stopped: the picture of where it stood can be taken
    assert.equal(await browser.evaluate("1 + 1", "before"), 2);
    assert.ok(PNG.sync.read((await browser.shootHere("before")).page).height > 0);
  });

  test("a value with line breaks and form feeds is a CSS string the browser reads", async () => {
    const value = "a\r\f\nb";
    const found = await browser.evaluate(
      `(() => {
        const el = document.createElement("i");
        el.setAttribute("data-x", ${JSON.stringify(value)});
        document.body.append(el);
        return document.querySelector("[data-x=" + ${JSON.stringify(cssString(value))} + "]") === el;
      })()`,
      "before",
    );
    assert.equal(found, true);
  });
});

/**
 * A tab that answers as a page with one text field would, and fails the calls `fail` names:
 * for what the browser cannot be made to do on purpose, such as losing the page mid-step.
 */
function fakeTab(fail) {
  const sent = [];
  const answers = {
    "Runtime.evaluate": () => ({ result: { objectId: "document" } }),
    "Accessibility.queryAXTree": ({ role }) => ({ nodes: role === "textbox" ? [{ backendDOMNodeId: 7, role: { value: "textbox" }, name: { value: "Email" } }] : [] }),
    "DOM.resolveNode": () => ({ object: { objectId: "field" } }),
    // Seen, not covered, takes text
    "Runtime.callFunctionOn": ({ functionDeclaration }) => ({
      result: { value: functionDeclaration.includes("compareDocumentPosition") ? [0] : functionDeclaration.includes("(hit)") ? "" : true },
    }),
    "Accessibility.getPartialAXTree": () => ({ nodes: [{ backendDOMNodeId: 7, role: { value: "textbox" } }] }),
    "DOM.getContentQuads": () => ({ quads: [[0, 0, 100, 0, 100, 20, 0, 20]] }),
    "Page.getLayoutMetrics": () => ({ cssVisualViewport: { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: 0 } }),
    "DOM.getNodeForLocation": () => ({ backendNodeId: 7 }),
  };
  const send = async (method, params = {}) => {
    sent.push({ method, ...params });
    if (fail(method, params)) throw new Error(`${method}: Inspected target navigated or closed`);
    return answers[method]?.(params) ?? {};
  };
  return { sent, send };
}

describe("steps that reached the page are not done twice", () => {
  const run = (tab, ...list) => runSteps(tab, steps(...list), { base: "http://a.test", load: async () => {} });
  const keys = (tab, type) => tab.sent.filter((call) => call.method === "Input.dispatchKeyEvent" && call.type === type).map((call) => call.key);

  test("a key that went down is pressed once, also when letting it go fails, and Shift is let go", async () => {
    const tab = fakeTab((method, { type, key }) => method === "Input.dispatchKeyEvent" && type === "keyUp" && key === "Enter");
    assert.deepEqual(await run(tab, { action: "press", key: "Shift+Enter" }), { reached: true });
    assert.deepEqual(keys(tab, "keyDown"), ["Enter"]);
    assert.deepEqual(keys(tab, "keyUp"), ["Enter", "Shift"]);
  });

  test("a modifier that went down and then failed stops the step: no second try, and it is let go", async () => {
    const tab = fakeTab((method, { type, key }) => method === "Input.dispatchKeyEvent" && type === "rawKeyDown" && key === "Shift");
    const end = await run(tab, { action: "press", key: "Shift+Enter" });
    assert.equal(end.reached, false);
    assert.match(end.reason, /^press failed: /);
    assert.deepEqual(keys(tab, "rawKeyDown"), ["Shift"]);
    assert.deepEqual(keys(tab, "keyDown"), []);
    assert.deepEqual(keys(tab, "keyUp"), ["Shift"]);
  });

  test("fill: text sent once, also when the change after it or the text itself fails", async () => {
    const field = { action: "fill", target: { label: "Email" }, value: "ada@example.com" };
    for (const fails of [
      (method, { functionDeclaration }) => method === "Runtime.callFunctionOn" && functionDeclaration.includes('new Event("change"'),
      (method) => method === "Input.insertText",
    ]) {
      const tab = fakeTab(fails);
      assert.deepEqual(await run(tab, field), { reached: true });
      assert.equal(tab.sent.filter((call) => call.method === "Input.insertText").length, 1);
    }
    // An empty value presses Delete, once
    const tab = fakeTab((method, { type }) => method === "Input.dispatchKeyEvent" && type === "keyUp");
    assert.deepEqual(await run(tab, { ...field, value: "" }), { reached: true });
    assert.deepEqual(keys(tab, "rawKeyDown"), ["Delete"]);
  });

  test("CSS strings escape what a string cannot hold", () => {
    assert.equal(cssString('a\r\fb\n"\\'), '"a\\d \\c b\\a \\"\\\\"');
  });
});
