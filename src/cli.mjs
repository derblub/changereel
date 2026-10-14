#!/usr/bin/env node
/**
 * Find what a change did to the pages of a site and show it as a before and after video.
 *
 *   changereel --before http://localhost:3001 --after http://localhost:3002
 *   changereel --before https://example.com --after http://localhost:3000 --routes "/ /pricing"
 *
 * Both sites have to be running. Every route is captured on both, the two pictures are
 * compared (see diff.mjs), and each change becomes a scene: the page before, a wipe to the
 * page after, and a frame around what is different. With --narrate a local model says in
 * one sentence what each change is, and with --voice the sentence is spoken (see
 * narrate.mjs). Writes the screenshots, changes.json and the video to --out (default ./out).
 *
 * Exit code 0 also when nothing changed (then there is no video), 2 when it could not run.
 */
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openBrowser } from "./browser.mjs";
import { diffPages, nearNoise, noiseBoxes, paint } from "./diff.mjs";
import { narrate } from "./narrate.mjs";
import { collectRoutes, slug } from "./routes.mjs";
import { TEXTS, textsFor } from "./texts.mjs";
import { serveVersions } from "./versions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  // Either two running sites, or a commit to build and serve next to the current one
  const base = opt("base");
  const site = (name) => {
    const value = (opt(name) || "").replace(/\/$/, "");
    if (base && !value) return null;
    if (!URL.canParse(value)) throw new Error(`--${name} needs the address of the running site, or use --base`);
    return value;
  };
  if (base && !opt("serve")) throw new Error("--base needs --serve, the command that serves a version on {port}");
  const number = (name, fallback) => {
    const value = Number(opt(name) ?? fallback);
    if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} needs a number`);
    return value;
  };
  return {
    before: site("before"),
    after: site("after"),
    base,
    head: opt("head") || "HEAD",
    build: opt("build"),
    serve: opt("serve"),
    readyTimeout: number("ready-timeout", 120) * 1000,
    routes: (opt("routes") || "").split(/[\s,]+/).filter(Boolean),
    sitemap: opt("sitemap"),
    ignore: (opt("ignore") || "").split(",").map((selector) => selector.trim()).filter(Boolean),
    out: resolve(opt("out") || "out"),
    title: opt("title") || "What changed",
    // Names for the two versions on the opening card, instead of a commit or an address
    beforeLabel: opt("before-label"),
    afterLabel: opt("after-label"),
    width: number("width", 1280),
    wait: number("wait", 500),
    passes: Math.max(1, number("passes", 2)),
    confirm: number("confirm", 2),
    noiseMargin: number("noise-margin", 64),
    maxScenes: number("max-scenes", 8),
    perRoute: number("per-route", 2),
    video: !argv.includes("--no-video"),
    // A small animated picture of the video as well, for where a video cannot be shown
    preview: argv.includes("--preview"),
    // In GitLab CI for a merge request: a comment there with the video
    comment: argv.includes("--comment"),
    // A sentence per scene from a model (local, or claude-… at Anthropic), spoken when there is a voice
    narrate: argv.includes("--narrate"),
    model: opt("model") || "gemma3:4b",
    host: opt("ollama") || process.env.OLLAMA_HOST || "http://127.0.0.1:11434",
    voice: opt("voice"),
    language: TEXTS[opt("language")] ? opt("language") : "en",
    piper: opt("piper") || process.env.CHANGEREEL_PIPER || "piper",
  };
}

/**
 * One side of a route: its layers, each captured `passes` times. What differs between two
 * captures of the same page is noise, and is painted over before the sides are compared.
 * Null when the page is not there on this side.
 */
async function shoot(browser, url, options) {
  let first;
  try {
    first = await browser.capture(url, { width: options.width, ignore: options.ignore, sharp: options.video });
  } catch (err) {
    // Gone or never there. Any other answer (a login, a rate limit) is not a missing page
    if (/^HTTP (404|410)$/.test(err.message)) return null;
    throw new Error(`${url}: ${err.message}`);
  }
  for (const layer of first.layers) layer.noise = [];
  first.url = url;
  for (const layer of first.layers) layer.clean = layer.png;
  for (let pass = 1; pass < options.passes; pass++) await revisit(browser, first, options);
  return first;
}

/** One more visit of a side: what differs from its first capture is noise as well. */
async function revisit(browser, side, options) {
  const again = await browser.capture(side.url, { width: options.width, ignore: options.ignore });
  for (const layer of side.layers) {
    const other = again.layers.find((l) => l.name === layer.name);
    if (!other) continue;
    const boxes = noiseBoxes(layer.png, other.png);
    if (boxes.length) layer.unstable = true;
    layer.noise.push(...boxes);
  }
  for (const layer of side.layers) layer.clean = paint(layer.png, layer.noise);
}

/** The picture of a side that the video shows: the one with twice the pixels when there is one. */
const shown = (name, which, suffix, side) =>
  `shots/${name}-${which}${suffix}${side.sharp?.[suffix ? "window" : "page"] ? "@2x" : ""}.png`;

/** Both sites, every route: screenshots on disk and the list of changes. */
export async function compare(options, log = console.log) {
  const routes = await collectRoutes(options);
  const shots = join(options.out, "shots");
  mkdirSync(shots, { recursive: true });
  const browser = await openBrowser({ wait: options.wait });
  const pages = [];
  try {
    const names = new Set();
    for (const route of routes) {
      // Two routes can have one slug ("/about" and "/about/"): the second gets a number
      let name = slug(route);
      for (let n = 2; names.has(name); n++) name = `${slug(route)}-${n}`;
      names.add(name);
      const sides = {};
      for (const which of ["before", "after"]) {
        const side = await shoot(browser, options[which] + route, options);
        sides[which] = side;
        if (!side) continue;
        writeFileSync(join(shots, `${name}-${which}.png`), side.page);
        if (side.sharp?.page) writeFileSync(join(shots, `${name}-${which}@2x.png`), side.sharp.page);
        if (side.sharp?.window) writeFileSync(join(shots, `${name}-${which}-window@2x.png`), side.sharp.window);
        for (const layer of side.layers) {
          if (layer.window) writeFileSync(join(shots, `${name}-${which}-window.png`), layer.window);
        }
      }
      const { before, after } = sides;
      if (!before && !after) continue;
      const height = (buffer) => buffer.readUInt32BE(20); // IHDR
      const width = (buffer) => buffer.readUInt32BE(16);
      const page = { route, changes: [] };
      if (!before || !after) {
        const there = before || after;
        page.changes.push({
          type: after ? "added" : "removed",
          page: true,
          beforeY: 0,
          beforeH: before ? height(there.page) : 0,
          afterY: 0,
          afterH: after ? height(there.page) : 0,
          box: null,
          view: {
            before: before && shown(name, "before", "", before),
            after: after && shown(name, "after", "", after),
            width: options.width,
            beforeHeight: before ? height(there.page) : 0,
            afterHeight: after ? height(there.page) : 0,
          },
        });
      } else {
        const differences = () => {
          const found = [];
          // A page that scrolls as a whole on one side and inside an element on the other has
          // no layers in common: then the whole pages are compared
          const shared =
            before.layers.every((layer) => after.layers.some((l) => l.name === layer.name && width(l.png) === width(layer.png)));
          // The whole page of a side, with what --ignore names left out and the noise of its
          // layers painted over, each layer's boxes moved to where the layer sits on the page
          const whole = (side) => {
            const noise = side.layers.flatMap((layer) => layer.noise.map((box) => ({ ...box, x: box.x + layer.x, y: box.y + layer.y })));
            return { name: "page", clean: paint(side.compared, noise), noise, unstable: side.layers.some((layer) => layer.unstable), x: 0, y: 0, shown: "page" };
          };
          const pairs = shared
            ? before.layers.map((layer) => [layer, after.layers.find((l) => l.name === layer.name)])
            : [[whole(before), whole(after)]];
          for (const [was, is] of pairs) {
            if (was.unstable || is.unstable) page.unstable = true;
            const suffix = was.shown === "window" ? "-window" : "";
            const view = {
              before: shown(name, "before", suffix, before),
              after: shown(name, "after", suffix, after),
              width: options.width,
              beforeHeight: height(was.shown === "window" ? was.window : before.page),
              afterHeight: height(is.shown === "window" ? is.window : after.page),
            };
            for (const change of diffPages(was.clean, is.clean).changes) {
              // What is left around a noisy spot after painting it over
              const wide = height(is.clean) && is.clean.readUInt32BE(16); // IHDR: width
              if (
                nearNoise(change, is.noise, "after", wide, options.noiseMargin) ||
                nearNoise(change, was.noise, "before", wide, options.noiseMargin)
              ) {
                continue;
              }
              found.push({
                ...change,
                layer: was.name,
                beforeY: change.beforeY + was.y,
                afterY: change.afterY + is.y,
                box: change.box && { ...change.box, x: change.box.x + is.x },
                span: change.span && { ...change.span, x: change.span.x + is.x },
              ...(change.boxBefore ? { boxBefore: { ...change.boxBefore, x: change.boxBefore.x + was.x } } : {}),
              ...(change.spanBefore ? { spanBefore: { ...change.spanBefore, x: change.spanBefore.x + was.x } } : {}),
                view,
              });
            }
          }
          return found;
        };
        page.changes = differences();
        // A random part can look the same on two visits of one side and still differ from the
        // other side. Before a page is said to have changed, both sides are visited again:
        // what was chance shows up as noise then, and a change stays a change.
        for (let round = 0; round < options.confirm && page.changes.length; round++) {
          await revisit(browser, before, options);
          await revisit(browser, after, options);
          page.changes = differences();
        }
      }
      pages.push(page);
      const count = page.changes.length;
      log(`${count ? "≠" : "="} ${route}${count ? `  ${count} change${count > 1 ? "s" : ""}` : ""}${page.unstable ? "  (parts differ between two visits and are left out)" : ""}`);
    }
  } finally {
    await browser.close();
  }
  return pages;
}

/**
 * Changes of one page that lie close together, joined into one: the rows of a table whose
 * cells moved on are each a change of their own, and each alone says something false (a
 * row that lost a name it only passed on to the next). Only changes of the same kind
 * "changed" in the same layer are joined; something added next to something changed stays
 * two scenes.
 */
export function joinNear(changes, gap = 96) {
  const parts = changes.filter((change) => !change.page && change.type === "changed").sort((a, b) => a.afterY - b.afterY);
  const rest = changes.filter((change) => !parts.includes(change));
  const joined = [];
  // A rectangle in page coordinates, from a box that is measured from the top of its band
  const onPage = (box, y) => box && { x: box.x, y: y + box.y, right: box.x + box.width, bottom: y + box.y + box.height };
  const union = (a, b) => a && b && { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
  const relative = (rect, y) => rect && { x: rect.x, y: rect.y - y, width: rect.right - rect.x, height: rect.bottom - rect.y };
  const spanUnion = (a, b) => a && b && { x: Math.min(a.x, b.x), width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x) };
  for (const change of parts) {
    const last = joined.at(-1);
    const near =
      last &&
      last.layer === change.layer &&
      last.view?.before === change.view?.before &&
      change.beforeY - (last.beforeY + last.beforeH) <= gap &&
      change.afterY - (last.afterY + last.afterH) <= gap;
    if (!near) {
      joined.push({ ...change, order: changes.indexOf(change) });
      continue;
    }
    const beforeY = Math.min(last.beforeY, change.beforeY);
    const afterY = Math.min(last.afterY, change.afterY);
    // Boxes join into a box; a box next to a change without one (a section that grew) joins
    // the spans, so that the frame still goes around what is drawn and not from edge to edge
    const asSpan = (box, span) => (box ? { x: box.x, width: box.width } : span);
    const bothBoxed = last.box && change.box;
    const box = bothBoxed ? union(onPage(last.box, last.afterY), onPage(change.box, change.afterY)) : null;
    const boxBefore = bothBoxed ? union(onPage(last.boxBefore, last.beforeY), onPage(change.boxBefore, change.beforeY)) : null;
    Object.assign(last, {
      beforeH: Math.max(last.beforeY + last.beforeH, change.beforeY + change.beforeH) - beforeY,
      afterH: Math.max(last.afterY + last.afterH, change.afterY + change.afterH) - afterY,
      beforeY,
      afterY,
      box: relative(box, afterY),
      boxBefore: relative(boxBefore, beforeY) ?? undefined,
      span: bothBoxed ? undefined : spanUnion(asSpan(last.box, last.span), asSpan(change.box, change.span)),
      spanBefore: bothBoxed ? undefined : spanUnion(asSpan(last.boxBefore, last.spanBefore), asSpan(change.boxBefore, change.spanBefore)) ?? undefined,
      blank: bothBoxed && last.blank === change.blank ? last.blank : undefined,
      joined: (last.joined ?? 1) + 1,
      order: Math.min(last.order, changes.indexOf(change)),
    });
  }
  // In the order the comparison gave them, largest first
  return [...rest.map((change) => ({ ...change, order: changes.indexOf(change) })), ...joined]
    .sort((a, b) => a.order - b.order)
    .map(({ order, ...change }) => change);
}

/**
 * The scenes of the video, in route order. A change that is the same on several pages, such
 * as a new link in the header, is one scene that says on how many pages it is, and it is
 * always shown. Changes close to each other on one page, such as the rows of a table whose
 * cells moved on, are one scene: shown apart, each row would say little. Of the changes only
 * one page has, each route first gives its `perRoute` largest; places left over in the
 * video go to the next largest, so a site of one page still shows all its changes.
 */
export function toScenes(pages, { perRoute, maxScenes }) {
  const groups = new Map();
  for (const page of pages) {
    for (const change of joinNear(page.changes)) {
      let key = change.page
        ? `page ${page.route}`
        : // Without the position down the page: a changed footer sits at another height on every page
          JSON.stringify([
            change.layer,
            change.type,
            change.afterH,
            change.beforeH,
            change.box ? [change.box.x, change.box.width, change.box.height] : [change.beforeY, change.afterY],
          ]);
      const group = groups.get(key);
      // The same change on another page joins its scene; twice on one page it is two
      if (group && !group.seen.has(page.route)) {
        group.routes += 1;
        group.seen.add(page.route);
        continue;
      }
      if (group) key = `${key} ${page.route} ${change.afterY}`;
      const { view, ...rest } = change;
      groups.set(key, {
        route: page.route,
        routes: 1,
        before: view.before,
        after: view.after,
        pageWidth: view.width,
        beforeHeight: view.beforeHeight,
        afterHeight: view.afterHeight,
        seen: new Set([page.route]),
        ...rest,
      });
    }
  }
  const taken = new Map();
  const scenes = [];
  const later = [];
  for (const scene of groups.values()) {
    if (scene.routes === 1) {
      const count = taken.get(scene.route) ?? 0;
      if (count >= perRoute) {
        later.push(scene);
        continue;
      }
      taken.set(scene.route, count + 1);
    }
    scenes.push(scene);
  }
  // What is left of the room in the video: the changes held back, in their order
  const all = [...scenes, ...later.slice(0, Math.max(0, maxScenes - scenes.length))];
  const chosen = new Set(all.slice(0, maxScenes));
  return [...groups.values()].filter((scene) => chosen.has(scene)).map(({ seen, ...scene }) => scene);
}

/**
 * Remotion compiles JSX only outside node_modules. Installed from npm, the video of this
 * package is inside node_modules, so its own files are let through as well.
 */
export function compileOwn(config) {
  const own = resolve(HERE, "..");
  const rules = config.module.rules.map((rule) =>
    rule.exclude instanceof RegExp && rule.exclude.test("/node_modules/")
      ? { ...rule, exclude: (path) => rule.exclude.test(path) && !path.startsWith(own + sep) }
      : rule,
  );
  return { ...config, module: { ...config.module, rules } };
}

async function render(props, out, { preview = false } = {}) {
  const { bundle } = await import("@remotion/bundler");
  const { renderMedia, selectComposition } = await import("@remotion/renderer");
  const fonts = join(HERE, "..", "video", "fonts");
  mkdirSync(join(out, "fonts"), { recursive: true });
  for (const file of readdirSync(fonts)) copyFileSync(join(fonts, file), join(out, "fonts", file));
  const serveUrl = await bundle({ entryPoint: join(HERE, "..", "video", "index.jsx"), publicDir: out, webpackOverride: compileOwn });
  const browserExecutable = process.env.CHANGEREEL_RENDER_CHROME || undefined;
  const composition = await selectComposition({ serveUrl, id: "Reel", inputProps: props, browserExecutable });
  const outputLocation = join(out, "changereel.mp4");
  await renderMedia({ composition, serveUrl, codec: "h264", outputLocation, inputProps: props, browserExecutable });
  if (!preview) return { video: outputLocation };
  // Every fifth frame at two fifths of the size: about 3 MB for a minute
  const previewLocation = join(out, "changereel.gif");
  await renderMedia({ composition, serveUrl, codec: "gif", everyNthFrame: 5, scale: 0.4, outputLocation: previewLocation, inputProps: props, browserExecutable });
  return { video: outputLocation, preview: previewLocation };
}

/** The changes as Markdown, for a job summary or a comment. */
export function renderMarkdown(pages, checked) {
  const changed = pages.filter((page) => page.changes.length);
  const total = changed.reduce((sum, page) => sum + page.changes.length, 0);
  const lines = [`## ${total} visible change${total === 1 ? "" : "s"} on ${changed.length} of ${checked} pages`, ""];
  if (!total) return lines.join("\n") + "No page looks different.\n";
  lines.push("| Page | Change | Where |", "| --- | --- | --- |");
  const kind = { added: "Added", removed: "Removed", changed: "Changed" };
  for (const page of changed) {
    for (const change of page.changes) {
      const where = change.page
        ? "the whole page"
        : change.type === "removed"
          ? `${change.beforeH} px at ${change.beforeY} px, before`
          : `${change.afterH} px at ${change.afterY} px${change.layer === "shell" ? ", outside the scrolling part" : ""}`;
      lines.push(`| \`${page.route.replace(/\|/g, "\\|")}\` | ${kind[change.type]} | ${where} |`);
    }
  }
  if (changed.some((page) => page.unstable)) {
    lines.push("", "Parts of some pages differ between two visits of the same version and were left out.");
  }
  return lines.join("\n") + "\n";
}

const USAGE = `changereel: what a change did to the pages of a site, as a before and after video

From a repository, with both versions built and served:
  changereel --base main --build "npm ci && npm run build" --serve "npm run preview -- --port {port}"

Between two sites that are running:
  changereel --before https://example.com --after http://localhost:3000

Main options:
  --routes "/ /pricing"   paths to compare (default: from the sitemaps)
  --ignore ".quote"        CSS selectors of parts to leave out
  --out out                where screenshots, changes.json and changereel.mp4 go
  --no-video               only compare
  --narrate --voice x.onnx a sentence per change, spoken
  --language de            German sentences and words in the video
  --comment                in GitLab CI: a comment on the merge request, with the video

All options: https://github.com/derblub/changereel#on-the-command-line`;

async function main() {
  const argv = process.argv.slice(2);
  // Only as the first word: "--title -h" is a title
  if (["--help", "-h"].includes(argv[0]) || !argv.length) {
    console.log(USAGE);
    return;
  }
  if (["--version", "-v"].includes(argv[0])) {
    const { version } = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
    console.log(version);
    return;
  }
  const options = parseArgs(argv);
  let versions;
  if (options.base) {
    // CHANGEREEL_CWD: the repository to take the versions from, when it is not where this runs
    versions = await serveVersions({ ...options, cwd: process.env.CHANGEREEL_CWD || process.cwd() });
    options.before = versions.before;
    options.after = versions.after;
  }
  let pages;
  try {
    pages = await compare(options);
  } finally {
    await versions?.stop();
  }
  const changed = pages.filter((page) => page.changes.length);
  const total = changed.reduce((sum, page) => sum + page.changes.length, 0);
  mkdirSync(options.out, { recursive: true });
  writeFileSync(
    join(options.out, "changes.json"),
    JSON.stringify(
      { before: options.base ?? options.before, after: options.base ? options.head : options.after, checked: pages.length, pages: changed },
      null,
      2,
    ) + "\n",
  );
  console.log(`\n${total} change${total === 1 ? "" : "s"} on ${changed.length} of ${pages.length} routes`);
  let video = "";
  let preview = "";
  if (total && options.video) {
    const scenes = toScenes(changed, options);
    if (options.narrate) {
      console.log(`Describing ${scenes.length} scene${scenes.length === 1 ? "" : "s"} with ${options.model} …`);
      await narrate(scenes, options.out, options);
    }
    const texts = textsFor(options.language);
    // A version by its short name: the host of a running site, seven characters of a commit
    const short = (version) => (/^https?:\/\//.test(version) ? new URL(version).host : /^[0-9a-f]{40}$/.test(version) ? version.slice(0, 7) : version);
    const props = {
      title: options.title,
      summary: texts.summary(total, changed.length, pages.length),
      language: options.language,
      facts: [
        [texts.changes, String(total)],
        [texts.pages, texts.of(changed.length, pages.length)],
        [texts.before, options.beforeLabel || short(versions?.commits.before ?? options.before)],
        [texts.after, options.afterLabel || short(versions?.commits.after ?? options.after)],
      ],
      scenes,
    };
    writeFileSync(join(options.out, "reel.json"), JSON.stringify(props, null, 2) + "\n");
    console.log(`Rendering ${scenes.length} scene${scenes.length === 1 ? "" : "s"} …`);
    ({ video, preview = "" } = await render(props, options.out, { preview: options.preview }));
    console.log(video);
    if (preview) console.log(preview);
  }
  if (options.comment) {
    const { commentOnGitLab, inMergeRequest } = await import("./gitlab.mjs");
    if (inMergeRequest()) {
      const reel = video ? JSON.parse(readFileSync(join(options.out, "reel.json"), "utf8")) : {};
      await commentOnGitLab({ pages: changed, checked: pages.length, scenes: reel.scenes, video });
    } else {
      console.log("--comment works in a GitLab CI job for a merge request; on GitHub the action comments.");
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(pages, pages.length));
  if (process.env.GITHUB_OUTPUT) {
    // The heredoc form: a path may hold what a single line cannot
    const outputs = { changes: total, pages: changed.length, video, preview, report: join(options.out, "changes.json") };
    const mark = `changereel-${Date.now().toString(36)}`;
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}<<${mark}\n${value}\n${mark}\n`).join(""));
  }
}

// Run when started as a command. Through npm the command is a link to this file, so the
// path it was started by is followed to the file itself.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(2);
  });
}
