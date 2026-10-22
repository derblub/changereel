import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { openBrowser } from "../src/browser.mjs";
import { execFileSync } from "node:child_process";
import { cpSync, symlinkSync, writeFileSync } from "node:fs";
import { compare, parseArgs, renderMarkdown, toScenes } from "../src/cli.mjs";
import { serveVersions } from "../src/versions.mjs";
import { alignRows, diffPages, drawnSpan, mergeRuns, nearNoise, noiseBoxes, onlyNoise, paint, trimBlank } from "../src/diff.mjs";
import { collectRoutes, parseSitemap, slug, toRoute } from "../src/routes.mjs";
import { serve } from "./serve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A white page of 100 pixels width; each band is [height, colour, optional x range]. */
function page(...bands) {
  const height = bands.reduce((sum, [h]) => sum + h, 0);
  const png = new PNG({ width: 100, height });
  png.data.fill(255);
  let y = 0;
  for (const [h, colour, from = 10, to = 90] of bands) {
    if (colour) {
      for (let row = y; row < y + h; row++) {
        for (let x = from; x < to; x++) png.data.writeUInt32BE(colour, (row * 100 + x) * 4);
      }
    }
    y += h;
  }
  return PNG.sync.write(png);
}
const RED = 0xcc0000ff;
const BLUE = 0x0000ccff;
const GREEN = 0x00aa00ff;

/**
 * A white page of 100 pixels width with one row of things: each is [x, width, colour], and
 * dark in its lower half, as a word has more than one colour from top to bottom.
 */
function row(...things) {
  const png = new PNG({ width: 100, height: 50 });
  png.data.fill(255);
  for (const [from, width, colour] of things) {
    for (let y = 20; y < 30; y++) for (let x = from; x < from + width; x++) png.data.writeUInt32BE(y < 25 ? colour : 0x222222ff, (y * 100 + x) * 4);
  }
  return PNG.sync.write(png);
}

describe("diff", () => {
  test("a link put into a menu is framed alone, and before, the gap it went into", () => {
    // Aligned to the right: the link on the left makes room by moving left
    const was = row([56, 10, RED], [78, 12, BLUE]);
    const is = row([32, 10, RED], [54, 12, GREEN], [78, 12, BLUE]);
    const { changes } = diffPages(was, is);
    assert.equal(changes.length, 1);
    const [change] = changes;
    assert.equal(change.blank, "before");
    assert.deepEqual([change.box.x, change.box.width], [54, 12]);
    assert.deepEqual([change.boxBefore.x, change.boxBefore.width], [66, 12]);
    // For the video: the link on the left moved by 24 pixels, and the ground is white
    assert.deepEqual(change.slide, { moves: [{ x: 56, width: 10, dx: -24 }], ground: "#ffffff" });
    // And the other way round: a link taken out
    const [gone] = diffPages(is, was).changes;
    assert.equal(gone.blank, "after");
    assert.deepEqual([gone.boxBefore.x, gone.boxBefore.width], [54, 12]);
    assert.deepEqual([gone.box.x, gone.box.width], [66, 12]);
  });

  test("identical pages have no changes", () => {
    const a = page([20], [30, RED], [20]);
    assert.deepEqual(diffPages(a, a).changes, []);
  });

  test("a new section is one added band, and what it pushed down is not a change", () => {
    const was = page([20], [30, RED], [20], [30, BLUE], [20]);
    const is = page([20], [30, RED], [20], [40, GREEN], [20], [30, BLUE], [20]);
    const { changes } = diffPages(was, is);
    assert.equal(changes.length, 1);
    assert.deepEqual(
      { type: changes[0].type, afterY: changes[0].afterY, afterH: changes[0].afterH, beforeH: changes[0].beforeH },
      { type: "added", afterY: 70, afterH: 40, beforeH: 0 },
    );
  });

  test("a section that is gone is one removed band", () => {
    const was = page([20], [30, RED], [20], [40, GREEN], [20], [30, BLUE]);
    const is = page([20], [30, RED], [20], [30, BLUE]);
    const { changes } = diffPages(was, is);
    assert.equal(changes.length, 1);
    assert.deepEqual([changes[0].type, changes[0].beforeY, changes[0].beforeH], ["removed", 70, 40]);
  });

  test("a change in place gets the box around the pixels that differ", () => {
    const was = page([20], [30, RED], [20]);
    const is = page([20], [30, RED, 10, 60], [20]);
    const { changes } = diffPages(was, is);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, "changed");
    assert.deepEqual(
      { x: changes[0].box.x, width: changes[0].box.width, height: changes[0].box.height },
      { x: 60, width: 30, height: 30 },
    );
  });

  test("a few pixels in a band of unchanged height are not a change", () => {
    const was = page([20], [30, RED], [20]);
    const is = page([20], [30, RED, 10, 89], [20]); // one column of 30 pixels
    assert.deepEqual(diffPages(was, is).changes, []);
    assert.equal(diffPages(was, is, { minPixels: 10 }).changes.length, 1);
  });

  test("a band that grew a lot is shown whole, not by the box of its first rows", () => {
    const was = page([20], [10, RED], [20], [30, BLUE]);
    const is = page([20], [60, GREEN], [20], [30, BLUE]);
    const { changes } = diffPages(was, is, { gap: 0 });
    assert.equal(changes.length, 1);
    assert.deepEqual([changes[0].type, changes[0].beforeH, changes[0].afterH, changes[0].box], ["changed", 10, 60, null]);
  });

  test("more or less blank space is not a change", () => {
    const was = page([20], [30, RED], [20], [30, BLUE]);
    const is = page([20], [30, RED], [60], [30, BLUE]);
    assert.deepEqual(diffPages(was, is).changes, []);
  });

  test("the largest change comes first", () => {
    const was = page([20], [30, RED], [40], [30, BLUE], [20]);
    const is = page([20], [30, RED, 10, 20], [40], [30, GREEN], [20]);
    const { changes } = diffPages(was, is);
    assert.equal(changes.length, 2);
    assert.equal(changes[0].beforeY, 90);
  });

  test("changes closer than the gap are one band", () => {
    const was = page([20], [30, RED], [20], [30, BLUE], [20]);
    const is = page([20], [30, RED, 10, 20], [20], [30, GREEN], [20]);
    assert.equal(diffPages(was, is).changes.length, 1);
    assert.equal(diffPages(was, is, { gap: 8 }).changes.length, 2);
  });

  test("pages of different widths cannot be compared", () => {
    const narrow = PNG.sync.write(new PNG({ width: 50, height: 10 }));
    assert.throws(() => diffPages(page([10]), narrow), /width/);
  });

  test("alignRows and mergeRuns: a replaced run is one band", () => {
    const bands = mergeRuns(alignRows([1, 2, 3, 4, 5], [1, 9, 9, 9, 4, 5]), 0);
    assert.deepEqual(bands, [{ type: "changed", beforeY: 1, beforeH: 2, afterY: 1, afterH: 3 }]);
  });

  test("trimBlank drops blank rows at both ends", () => {
    const png = PNG.sync.read(page([5], [10, RED], [5]));
    assert.deepEqual(trimBlank(png, 0, 20), { y: 5, height: 10 });
    assert.deepEqual(trimBlank(png, 0, 5), { y: 5, height: 0 });
  });
});

describe("noise", () => {
  test("what differs between two captures of one page becomes boxes, and painting them makes the captures equal", () => {
    const first = page([40], [30, RED], [40], [30, BLUE], [40]);
    const second = page([40], [30, RED], [40], [30, GREEN, 40, 60], [40]);
    const boxes = noiseBoxes(first, second);
    assert.equal(boxes.length, 1);
    assert.ok(boxes[0].y <= 110 && boxes[0].y + boxes[0].height >= 140);
    assert.equal(Buffer.compare(paint(first, boxes), paint(second, boxes)), 0);
    assert.deepEqual(noiseBoxes(first, first), []);
  });

  test("a part that is taller on one visit is noise of full width, and is then only spacing", () => {
    const first = page([40], [30, RED], [40], [30, GREEN], [40], [30, BLUE], [40]);
    const second = page([40], [30, RED], [40], [70, GREEN, 30, 50], [40], [30, BLUE], [40]);
    const boxes = noiseBoxes(first, second);
    assert.deepEqual(boxes, [{ x: 0, y: 110, width: 100, height: 30 }]);
    const other = noiseBoxes(second, first);
    assert.deepEqual(diffPages(paint(first, boxes), paint(second, other)).changes, []);
  });

  test("nearNoise: a change that is mostly in or next to a noisy spot", () => {
    const boxes = [{ x: 0, y: 500, width: 100, height: 50 }];
    const change = (afterY, afterH = 20, box = null) => ({ beforeY: afterY, beforeH: afterH, afterY, afterH, box });
    assert.equal(nearNoise(change(510), boxes, "after", 100), true);
    assert.equal(nearNoise(change(580), boxes, "after", 100), true); // 30 below, within the margin
    assert.equal(nearNoise(change(700), boxes, "after", 100), false);
    assert.equal(nearNoise(change(510, 20, { x: 300, y: 0, width: 40, height: 20 }), boxes, "after", 400), false);
    assert.equal(nearNoise(change(510), [], "after", 100), false);
    // Removed on the after side: only a place there, and it is inside the noisy spot
    const removed = { beforeY: 900, beforeH: 40, afterY: 520, afterH: 0, box: null };
    assert.equal(nearNoise(removed, boxes, "after", 100), true);
    assert.equal(nearNoise({ ...removed, afterY: 800 }, boxes, "after", 100), false);
  });

  test("a random number whose first digit came up the same twice on one side is still only noise", () => {
    // "Code: " and three digits; each side visited twice
    const label = [10, 20, BLUE];
    const before = [row(label, [40, 10, RED], [50, 10, GREEN], [60, 10, RED]), row(label, [40, 10, GREEN], [50, 10, RED], [60, 10, GREEN])];
    const after = [row(label, [40, 10, BLUE], [50, 10, RED], [60, 10, RED]), row(label, [40, 10, BLUE], [50, 10, GREEN], [60, 10, GREEN])];
    const was = noiseBoxes(...before);
    const is = noiseBoxes(...after);
    // Painted from the first digit on one side and from the second on the other
    assert.ok(was[0].x < is[0].x);
    const { changes } = diffPages(paint(before[0], was), paint(after[0], is));
    assert.equal(changes.length, 1);
    assert.equal(onlyNoise(paint(before[0], was), paint(after[0], is), changes[0], was, is), true);
    // A label that changed next to the number stays a change
    const renamed = row([10, 20, GREEN], [40, 10, BLUE], [50, 10, RED], [60, 10, RED]);
    const [change] = diffPages(paint(before[0], was), paint(renamed, is)).changes;
    assert.equal(onlyNoise(paint(before[0], was), paint(renamed, is), change, was, is), false);
    assert.equal(onlyNoise(before[0], after[0], change, [], []), false);
  });

  test("nearNoise: a large change with a hairline of noise inside it stays", () => {
    const sliver = [{ x: 0, y: 300, width: 11, height: 48 }];
    const large = { beforeY: 100, beforeH: 500, afterY: 100, afterH: 700, box: { x: 0, y: 0, width: 600, height: 500 } };
    assert.equal(nearNoise(large, sliver, "after", 700), false);
  });
});

describe("span", () => {
  test("a new section is framed around what is drawn in it", () => {
    const { changes } = diffPages(page([40, RED], [40]), page([40, RED], [30, BLUE, 20, 60], [40]));
    assert.equal(changes[0].type, "added");
    assert.deepEqual(changes[0].span, { x: 20, width: 40 });
  });

  test("rows with nothing drawn, or drawn from edge to edge, have no span", () => {
    const empty = PNG.sync.read(page([20]));
    assert.equal(drawnSpan(empty, 0, 20), null);
    const full = PNG.sync.read(page([20, RED, 0, 100]));
    assert.equal(drawnSpan(full, 0, 20), null);
  });
});

describe("routes", () => {
  test("parseSitemap, toRoute and slug", () => {
    assert.deepEqual(parseSitemap("<urlset><url><loc>https://a.test/x?a=1&amp;b=2</loc></url></urlset>").locs, [
      "https://a.test/x?a=1&b=2",
    ]);
    assert.equal(toRoute("https://example.com/de/kontakt"), "/de/kontakt");
    assert.equal(slug("/"), "index");
    assert.equal(slug("/docs/a.html?b=1"), "docs-a-html-b-1");
  });

  test("without a list, the routes of both sitemaps: a new page is in one only", async () => {
    const files = {
      "http://after.test/sitemap.xml": "<urlset><url><loc>https://x.test/</loc></url><url><loc>https://x.test/new</loc></url></urlset>",
      "http://before.test/sitemap.xml": "<urlset><url><loc>https://x.test/</loc></url><url><loc>https://x.test/gone</loc></url></urlset>",
    };
    const reader = async (source) => {
      if (!(source in files)) throw new Error("404");
      return files[source];
    };
    const routes = await collectRoutes({ before: "http://before.test", after: "http://after.test" }, reader);
    assert.deepEqual(routes, ["/", "/gone", "/new"]);
  });

  test("robots.txt says where the sitemap is, and only its path counts", async () => {
    const files = {
      "http://local.test/robots.txt": "User-agent: *\nSitemap: https://example.com/sitemap_index.xml\n",
      "http://local.test/sitemap_index.xml": "<sitemapindex><sitemap><loc>https://example.com/en.xml</loc></sitemap></sitemapindex>",
      "http://local.test/en.xml": "<urlset><url><loc>https://example.com/about</loc></url></urlset>",
    };
    const reader = async (source) => {
      if (!(source in files)) throw new Error("404");
      return files[source];
    };
    assert.deepEqual(await collectRoutes({ before: "http://none.test", after: "http://local.test" }, reader), ["/about"]);
  });
});

describe("scenes", () => {
  const view = { before: "b.png", after: "a.png", width: 1280, beforeHeight: 800, afterHeight: 800 };
  const change = (type, afterY, extra = {}) => ({ type, beforeY: afterY, beforeH: 10, afterY, afterH: 10, box: null, view, ...extra });
  const site = (route, ...changes) => ({ route, changes });

  test("the same change on several pages is one scene, and is kept beyond the limit of a route", () => {
    const header = change("changed", 30, { box: { x: 300, y: 0, width: 60, height: 10 } });
    const scenes = toScenes(
      [site("/", change("added", 300), change("changed", 500), header), site("/pricing", header, change("changed", 400))],
      { perRoute: 2, maxScenes: 8 },
    );
    assert.deepEqual(
      scenes.map((s) => [s.route, s.afterY, s.routes]),
      [["/", 300, 1], ["/", 500, 1], ["/", 30, 2], ["/pricing", 400, 1]],
    );
    assert.equal(scenes[0].before, "b.png");
    assert.equal(scenes[0].pageWidth, 1280);
  });

  test("each route gets its share first, and room left in the video goes to the rest", () => {
    const pages = [site("/", change("added", 100), change("added", 300), change("added", 500)), site("/b", change("added", 700))];
    // Without limit of room: all, the route's held back one too
    assert.deepEqual(toScenes(pages, { perRoute: 1, maxScenes: 8 }).map((s) => [s.route, s.afterY]), [["/", 100], ["/", 300], ["/", 500], ["/b", 700]]);
    // With little room: first one per route, then what is left
    assert.deepEqual(toScenes(pages, { perRoute: 1, maxScenes: 3 }).map((s) => [s.route, s.afterY]), [["/", 100], ["/", 300], ["/b", 700]]);
    assert.equal(toScenes(pages, { perRoute: 3, maxScenes: 2 }).length, 2);
  });

  test("changes close together on one page are one scene, around all of them", () => {
    const row = (y, x) => change("changed", y, { box: { x, y: 2, width: 100, height: 6 }, boxBefore: { x, y: 2, width: 80, height: 6 } });
    const [table] = toScenes([site("/", row(100, 50), row(140, 300), row(180, 50))], { perRoute: 2, maxScenes: 8 });
    assert.equal(table.joined, 3);
    assert.deepEqual([table.afterY, table.afterH], [100, 90]);
    assert.deepEqual(table.box, { x: 50, y: 2, width: 350, height: 86 });
    assert.deepEqual(table.boxBefore, { x: 50, y: 2, width: 330, height: 86 });
    // A boxed change next to one without a box (a paragraph that grew): one scene around the
    // span of both, with no box
    const grew = change("changed", 130, { box: null, beforeH: 20, afterH: 60, span: { x: 40, width: 500 } });
    const [mixed] = toScenes([site("/", row(100, 50), grew)], { perRoute: 2, maxScenes: 8 });
    assert.equal(mixed.joined, 2);
    assert.equal(mixed.box, null);
    assert.deepEqual(mixed.span, { x: 40, width: 500 });
    // Far apart, or a different kind, they stay apart
    assert.equal(toScenes([site("/", row(100, 50), row(400, 50))], { perRoute: 2, maxScenes: 8 }).length, 2);
    assert.equal(toScenes([site("/", row(100, 50), change("added", 120))], { perRoute: 2, maxScenes: 8 }).length, 2);
  });
});

describe("command", () => {
  test("runs when started through a link, as npm installs it", () => {
    const dir = mkdtempSync(join(tmpdir(), "changereel-bin-"));
    const link = join(dir, "changereel");
    symlinkSync(join(HERE, "..", "src", "cli.mjs"), link);
    const version = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version;
    assert.equal(execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" }).trim(), version);
    assert.match(execFileSync(process.execPath, [link, "--help"], { encoding: "utf8" }), /--base main/);
  });
});

describe("parseArgs", () => {
  test("defaults and errors", () => {
    const options = parseArgs(["--before", "http://a.test/", "--after", "http://b.test"]);
    assert.equal(options.before, "http://a.test");
    assert.equal(options.width, 1280);
    assert.equal(options.video, true);
    assert.throws(() => parseArgs(["--before", "http://a.test"]), /--after/);
    assert.throws(() => parseArgs(["--base", "main"]), /--serve/);
    const built = parseArgs(["--base", "main", "--serve", "npx serve -l {port}", "--build", "npm run build"]);
    assert.deepEqual([built.base, built.head, built.before, built.build], ["main", "HEAD", null, "npm run build"]);
  });
});

const chrome = [process.env.CHROME_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(
  (path) => path && existsSync(path),
);

describe("capture", { skip: !chrome && "no Chromium" }, () => {
  test("a page that scrolls inside an element is captured whole", async () => {
    const site = await serve(join(HERE, "site", "shell"));
    const browser = await openBrowser({ wait: 0 });
    try {
      const { page, layers } = await browser.capture(site.url + "/", { width: 1000, height: 800 });
      // 40 padding, three sections of 600 with 40 below each, 40 padding
      assert.equal(PNG.sync.read(page).height, 2000);
      const content = layers.find((layer) => layer.name === "content");
      const shell = layers.find((layer) => layer.name === "shell");
      assert.deepEqual([content.x, content.y], [240, 0]);
      const cut = PNG.sync.read(content.png);
      assert.deepEqual([cut.width, cut.height], [760, 2000]);
      // The third section starts at 40 + 2 * 640, far below the window of 800
      assert.equal(cut.data.readUInt32BE((1400 * 760 + 100) * 4), 0xf4f4f5ff);
      // The shell is the window with the content blanked: the sidebar is still there
      const window = PNG.sync.read(shell.png);
      assert.deepEqual([window.width, window.height], [1000, 800]);
      assert.equal(window.data.readUInt32BE((400 * 1000 + 600) * 4), 0x80808080);
      assert.equal(window.data.readUInt32BE((400 * 1000 + 100) * 4), 0x18181bff);
    } finally {
      await browser.close();
      site.close();
    }
  });
});

describe("ignore", { skip: !chrome && "no Chromium" }, () => {
  test("what --ignore names is in the picture that is shown and not in the one that is compared", async () => {
    const site = await serve(join(HERE, "site", "after"));
    const browser = await openBrowser({ wait: 0 });
    try {
      const plain = await browser.capture(site.url + "/", { width: 1000 });
      const { page, layers } = await browser.capture(site.url + "/", { width: 1000, ignore: [".note"] });
      assert.equal(Buffer.compare(page, plain.page), 0);
      assert.notEqual(Buffer.compare(layers[0].png, page), 0);
      await assert.rejects(browser.capture(site.url + "/", { ignore: ["a["] }), /not a selector/);
    } finally {
      await browser.close();
      site.close();
    }
  });
});

describe("versions", () => {
  test("two commits of a repository are built and served, and cleaned up after", async () => {
    const repo = mkdtempSync(join(tmpdir(), "changereel-repo-"));
    const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    cpSync(join(HERE, "serve.mjs"), join(repo, "serve.mjs"));
    cpSync(join(HERE, "site", "before"), join(repo, "site"), { recursive: true });
    git("add", "-A");
    git("commit", "-q", "-m", "before");
    cpSync(join(HERE, "site", "after"), join(repo, "site"), { recursive: true });
    git("add", "-A");
    git("commit", "-q", "-m", "after");
    writeFileSync(join(repo, "uncommitted.txt"), "stays");

    const versions = await serveVersions(
      { cwd: repo, base: "HEAD~1", build: "echo built > site/built.txt", serve: `"${process.execPath}" serve.mjs site {port}` },
      () => {},
    );
    try {
      const text = async (url) => (await fetch(url)).text();
      assert.match(await text(versions.before + "/"), /Shop now/);
      assert.match(await text(versions.after + "/"), /Browse the catalogue/);
      assert.equal((await fetch(versions.before + "/contact.html")).status, 404);
      assert.equal((await fetch(versions.after + "/contact.html")).status, 200);
      assert.match(await text(versions.after + "/built.txt"), /built/);
    } finally {
      await versions.stop();
    }
    assert.equal(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }).trim().split("\n").length, 1);
    assert.equal(existsSync(join(repo, "uncommitted.txt")), true);
    await assert.rejects(fetch(versions.after + "/"));
  });

  test("a build that fails says so, with the end of its output, and leaves nothing behind", async () => {
    const repo = mkdtempSync(join(tmpdir(), "changereel-repo-"));
    const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a");
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    await assert.rejects(
      serveVersions({ cwd: repo, base: "HEAD", build: "echo no such thing >&2; exit 3", serve: "true {port}" }, () => {}),
      /ended with 3[\s\S]*no such thing/,
    );
    assert.equal(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }).trim().split("\n").length, 1);
    await assert.rejects(serveVersions({ cwd: repo, base: "HEAD", serve: "true" }, () => {}), /\{port\}/);
  });
});

describe("summary", () => {
  test("renderMarkdown lists every change, and says when nothing changed", () => {
    const view = {};
    const pages = [
      { route: "/", changes: [{ type: "changed", beforeY: 1, beforeH: 2, afterY: 300, afterH: 40, layer: "content", view }], unstable: true },
      { route: "/new", changes: [{ type: "added", page: true, beforeY: 0, beforeH: 0, afterY: 0, afterH: 900, view }] },
      { route: "/same", changes: [] },
    ];
    const markdown = renderMarkdown(pages, 3);
    assert.match(markdown, /2 visible changes on 2 of 3 pages/);
    assert.match(markdown, /\| `\/` \| Changed \| 40 px at 300 px \|/);
    assert.match(markdown, /\| `\/new` \| Added \| the whole page \|/);
    assert.match(markdown, /left out/);
    assert.match(renderMarkdown([{ route: "/", changes: [] }], 1), /No page looks different/);
  });
});

describe("against two real sites", { skip: !chrome && "no Chromium" }, () => {
  let was;
  let is;
  before(async () => {
    was = await serve(join(HERE, "site", "before"));
    is = await serve(join(HERE, "site", "after"));
  });
  after(() => {
    was.close();
    is.close();
  });

  test("finds the new section, the changed button, the new link, the new price and the new page", async () => {
    const out = mkdtempSync(join(tmpdir(), "changereel-test-"));
    const options = parseArgs(["--before", was.url, "--after", is.url, "--out", out, "--wait", "0"]);
    const pages = await compare(options, () => {});
    const byRoute = Object.fromEntries(pages.map((p) => [p.route, p.changes.map((c) => c.type)]));
    assert.deepEqual(byRoute, {
      "/": ["added", "changed", "changed"],
      "/about.html": [],
      "/contact.html": ["added"],
      "/pricing.html": ["changed", "changed"],
    });
    const scenes = toScenes(pages.filter((p) => p.changes.length), options);
    assert.equal(scenes.length, 5);
    assert.equal(scenes.find((s) => s.routes === 2).route, "/");
    assert.equal(pages.some((p) => p.unstable), false);
    assert.equal(scenes[0].before, "shots/index-before@2x.png");
    assert.ok(readFileSync(join(out, "shots", "index-before@2x.png")).readUInt32BE(16) === 2560);
    assert.ok(readFileSync(join(out, "shots", "index-after.png")).length > 1000);
    assert.equal(existsSync(join(out, "shots", "contact-html-before.png")), false);
  });
});
