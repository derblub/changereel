import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { openBrowser } from "../src/browser.mjs";
import { compare, parseArgs } from "../src/cli.mjs";
import { collectRoutes } from "../src/routes.mjs";
import { serve } from "./serve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.mjs");
const STATES = join(HERE, "site", "states", "states.json");
const chrome = [process.env.CHROME_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(
  (path) => path && existsSync(path),
);

// A value that cannot turn up by chance: if it is anywhere in what a run leaves, it leaked
const SECRET = "Zebra-7731-Quokka";
const ENV = { CHANGEREEL_TEST_PASSWORD: SECRET };

/** The command, run apart: its exit code and everything it printed. */
function run(args, { env = {}, cwd } = {}) {
  return new Promise((ok) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      ok({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
}

/** A states file in a fresh directory. */
function statesFile(data) {
  const path = join(mkdtempSync(join(tmpdir(), "changereel-test-")), "states.json");
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  return path;
}

/** Every file under a directory, as text, for looking for what must not be there. */
const everything = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "latin1"));

describe("--states and --check", () => {
  test("--states reads and checks the file, and keeps the environment for the steps only", () => {
    const options = parseArgs(["--before", "http://a.test", "--after", "http://b.test", "--states", STATES], ENV);
    assert.equal(options.states.states.length, 7);
    assert.equal(options.states.setup.length, 5);
    assert.equal(options.env, ENV);
    assert.equal(JSON.stringify(options.states).includes(SECRET), false);
    assert.throws(
      () => parseArgs(["--before", "http://a.test", "--after", "http://b.test", "--states", STATES], {}),
      /setup\[2\]\.valueFrom\.env: CHANGEREEL_TEST_PASSWORD is not set/,
    );
    assert.throws(() => parseArgs(["--before", "http://a.test", "--after", "http://b.test", "--states"]), /--states needs/);
  });

  test("--check needs a states file, and no sites", () => {
    assert.throws(() => parseArgs(["--check"]), /--check checks a states file/);
    assert.equal(parseArgs(["--states", STATES, "--check"], ENV).check, true);
  });

  test("--check says the file is right and stops with 0, or with 2 and where it is wrong", async () => {
    const right = await run(["--states", STATES, "--check"], { env: ENV });
    assert.equal(right.code, 0);
    assert.match(right.stdout, /states\.json is right: 7 states, setup with 5 steps/);
    const wrong = statesFile({ schemaVersion: 1, states: [{ name: "A", route: "/", steps: [{ action: "click", target: { role: "button" } }] }] });
    const told = await run(["--states", wrong, "--check"]);
    assert.equal(told.code, 2);
    assert.match(told.stderr, /states\[0\]\.steps: must end with waitFor; ends with click/);
  });

  test("a wrong file stops the run before anything is built", async () => {
    const dir = mkdtempSync(join(tmpdir(), "changereel-test-"));
    const wrong = statesFile('{ "schemaVersion": 1, "states": [ }');
    const marker = join(dir, "built");
    const result = await run(["--base", "main", "--build", `touch ${marker}`, "--serve", `touch ${marker}`, "--states", wrong], { cwd: dir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /is not JSON: line 1/);
    assert.equal(existsSync(marker), false);
  });

  test("with states, a site without a sitemap has no routes instead of an error", async () => {
    const nothing = async () => {
      throw new Error("404");
    };
    const sites = { before: "http://before.test", after: "http://after.test" };
    assert.deepEqual(await collectRoutes({ ...sites, orNone: true }, nothing), []);
    await assert.rejects(collectRoutes(sites, nothing), /404/);
    // A sitemap that was asked for must be there
    await assert.rejects(collectRoutes({ ...sites, sitemap: "http://after.test/map.xml", orNone: true }, nothing), /404/);
    assert.deepEqual(await collectRoutes({ ...sites, routes: ["/a"], orNone: true }, nothing), ["/a"]);
  });
});

describe("comparing states", { skip: !chrome && "no Chromium" }, () => {
  let was;
  let is;
  before(async () => {
    was = await serve(join(HERE, "site", "states", "before"));
    is = await serve(join(HERE, "site", "states", "after"));
  });
  after(() => {
    was?.close();
    is?.close();
  });

  const options = (file, ...more) =>
    parseArgs(
      ["--before", was.url, "--after", is.url, "--states", file, "--out", mkdtempSync(join(tmpdir(), "changereel-test-")), "--no-video", "--wait", "0", "--passes", "1", ...more],
      ENV,
    );

  test("the command: logs in, compares routes and states in order, reports what stopped, ends with 2 for a state reached nowhere", async () => {
    const out = mkdtempSync(join(tmpdir(), "changereel-test-"));
    const started = Date.now();
    const result = await run(
      ["--before", was.url, "--after", is.url, "--states", STATES, "--routes", "/cart /account", "--out", out, "--no-video", "--wait", "0", "--passes", "1", "--confirm", "1"],
      { env: ENV },
    );
    const took = Date.now() - started;
    assert.equal(result.code, 2, result.stderr);
    // Routes in their order, each followed by its states in the order of the file, then the rest
    const order = result.stdout
      .split("\n")
      .filter((line) => /^[=≠✗+?] /.test(line))
      .map((line) => line.slice(2).split("  ")[0]);
    assert.deepEqual(order, [
      "/account",
      "/cart",
      "/cart › Checkout dialog",
      "/cart › Gift wrap",
      "/settings › Billing tab",
      "/new › Export panel",
      "/random › Code",
      "/late › Continue later",
      "/confirm › Report deleted",
    ]);
    assert.match(result.stdout, /✗ \/settings › Billing tab {2}can no longer be reached: step 1 \(click tab "Billing"\): not found/);
    assert.match(result.stdout, /after: the page showed a confirm "Delete the report\?", accepted/);
    assert.match(result.stderr, /Not compared, 1 state:\n {2}\/cart › Gift wrap: before step 1 \(click button "Wrap as a gift"\): not found; after step 1/);

    const report = JSON.parse(readFileSync(join(out, "changes.json"), "utf8"));
    const shape = report.pages.map(({ changes, ...page }) => ({ ...page, changes: changes.map(({ type, stopped }) => ({ type, ...(stopped && { stopped }) })) }));
    assert.deepEqual(shape, [
      // The title of the dialog changed; the dialog was reached on both sides
      { route: "/cart", state: { name: "Checkout dialog", steps: 2 }, changes: [{ type: "removed" }, { type: "changed" }] },
      {
        route: "/settings",
        state: { name: "Billing tab", steps: 2 },
        changes: [{ type: "unreached", stopped: { side: "after", step: 0, path: "states[1].steps[0]", does: 'click tab "Billing"', reason: "not found" } }],
      },
      {
        route: "/new",
        state: { name: "Export panel", steps: 2 },
        changes: [{ type: "reached", stopped: { side: "before", step: 0, path: "states[2].steps[0]", does: 'click button "Export"', reason: "not found" } }],
      },
    ]);
    // A whole-page finding with both pictures: the one where it stopped and the end of the state
    const unreached = report.pages[1].changes[0];
    assert.equal(unreached.page, true);
    assert.equal(unreached.view.before, "shots/state-Billing-tab-before.png");
    assert.equal(unreached.view.after, "shots/state-Billing-tab-after.png");
    assert.ok(unreached.view.beforeHeight > 0 && unreached.view.afterHeight > 0);
    assert.deepEqual(report.problems, [
      { name: "Gift wrap", route: "/cart", before: 'step 1 (click button "Wrap as a gift"): not found', after: 'step 1 (click button "Wrap as a gift"): not found' },
    ]);
    // The random number and the late button reached on both sides, and nothing changed
    assert.match(result.stdout, /= \/random › Code/);
    assert.match(result.stdout, /= \/late › Continue later/);
    assert.equal(report.checked, 8);

    // The routes were captured logged in on both sides: not what a fresh visit shows
    const account = readFileSync(join(out, "shots", "account-before.png"));
    assert.equal(Buffer.compare(account, readFileSync(join(out, "shots", "account-after.png"))), 0);
    const browser = await openBrowser({ wait: 0 });
    try {
      const signedOut = await browser.capture(was.url + "/account", { side: "before" });
      assert.notEqual(Buffer.compare(account, signedOut.page), 0);
    } finally {
      await browser.close();
    }

    // The password went into the field and nowhere else
    for (const text of [...everything(out), result.stdout, result.stderr]) assert.equal(text.includes(SECRET), false);
    console.log(`# the command over the states took ${(took / 1000).toFixed(1)} s`);
  });

  test("a setup that gets through on one side only is the one finding, and nothing else is compared", async () => {
    // Fits only before: the tab is called "Payment" after
    const file = statesFile({
      schemaVersion: 1,
      timeout: 1000,
      setup: [
        { action: "navigate", path: "/settings" },
        { action: "click", target: { role: "tab", name: "Billing" } },
        { action: "waitFor", target: { role: "tabpanel", name: "Billing" } },
      ],
      states: [{ name: "Checkout dialog", route: "/cart", steps: [{ action: "click", target: { role: "button", name: "Checkout" } }, { action: "waitFor", target: { role: "dialog" } }] }],
    });
    const lines = [];
    const problems = [];
    // No --routes, and the sample sites have no sitemap: only the states would be compared
    const opts = options(file, "--confirm", "1");
    const pages = await compare(opts, (line) => lines.push(line), problems);
    assert.equal(pages.length, 1);
    const [{ changes, ...page }] = pages;
    assert.deepEqual(page, { route: "/settings", setup: true });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, "unreached");
    assert.deepEqual(changes[0].stopped, { side: "after", step: 1, path: "setup[1]", does: 'click tab "Billing"', reason: "not found" });
    assert.deepEqual([changes[0].view.before, changes[0].view.after], ["shots/setup-before.png", "shots/setup-after.png"]);
    assert.ok(existsSync(join(opts.out, "shots", "setup-after.png")));
    assert.deepEqual(problems, []);
    assert.deepEqual(lines, ['✗ setup  no longer gets through: after stopped at step 2 (click tab "Billing"): not found; nothing else is compared']);
  });

  test("a setup that stops on both sides stops the run, with the step on each side", async () => {
    const file = statesFile({
      schemaVersion: 1,
      timeout: 500,
      setup: [{ action: "navigate", path: "/settings" }, { action: "click", target: { role: "tab", name: "Shipping" } }, { action: "waitFor", target: { role: "tabpanel" } }],
      states: [],
    });
    await assert.rejects(compare(options(file, "--confirm", "0", "--routes", "/account"), () => {}), {
      message:
        'The setup stopped on both versions, so nothing can be compared:\n  before: step 2 (click tab "Shipping"): not found\n  after: step 2 (click tab "Shipping"): not found',
    });
  });
});
