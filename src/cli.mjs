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
import { kokoroVoice, narrate } from "./narrate.mjs";
import { collectRoutes, slug, toRoute } from "./routes.mjs";
import { describeStep, readStates } from "./states.mjs";
import { TEXTS, textsFor } from "./texts.mjs";
import { serveVersions } from "./versions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The options of a run. A states file is read and checked here, before anything is built or
 * served, so that a wrong file costs no build. `env` is where `valueFrom` takes its values.
 */
export function parseArgs(argv, env = process.env) {
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  // Either two running sites, or a commit to build and serve next to the current one
  const base = opt("base");
  // Checking a states file needs neither
  const check = argv.includes("--check");
  const site = (name) => {
    const value = (opt(name) || "").replace(/\/$/, "");
    if ((base || check) && !value) return null;
    if (!URL.canParse(value)) throw new Error(`--${name} needs the address of the running site, or use --base`);
    return value;
  };
  if (base && !opt("serve")) throw new Error("--base needs --serve, the command that serves a version on {port}");
  const number = (name, fallback) => {
    const value = Number(opt(name) ?? fallback);
    if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} needs a number`);
    return value;
  };
  if (argv.includes("--states") && !opt("states")) throw new Error("--states needs the path of a states file");
  const statesFile = opt("states");
  if (check && !statesFile) throw new Error("--check checks a states file: pass it with --states");
  return {
    ...(statesFile && { states: readStates(resolve(statesFile), env), statesFile, env }),
    check,
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
    // The Python Kokoro is installed in, for a voice "kokoro:af_heart"
    kokoro: opt("kokoro") || process.env.CHANGEREEL_KOKORO || "python3",
  };
}

/** What one visit of a side is asked to do: for a state, load its route and run its steps. */
function visit(which, options, state) {
  const plain = { side: which, width: options.width, ignore: options.ignore };
  if (!state) return plain;
  return { ...plain, steps: state.steps, stateIgnore: state.ignore, base: options[which], testIdAttribute: options.states.testIdAttribute, env: options.env };
}

/**
 * One visit of a side. A state whose page is gone on this side cannot be reached: that is a
 * stop before its first step, with a picture of what the address shows instead.
 */
async function look(browser, url, options, which, state, sharp = false) {
  try {
    return await browser.capture(url, { ...visit(which, options, state), sharp });
  } catch (err) {
    if (!state || !/^HTTP (404|410)$/.test(err.message)) throw err;
    const here = await browser.shootHere(which, { width: options.width, ignore: [...options.ignore, ...state.ignore], sharp });
    return { ...here, stopped: { step: null, reason: err.message } };
  }
}

/**
 * One side of a route or a state: its layers, each captured `passes` times. What differs
 * between two captures of the same page is noise, and is painted over before the sides are
 * compared. Null when the page is not there on this side. A state is reached anew for every
 * visit, from a freshly loaded route: captured twice from where its steps left it, the noise
 * would only measure the second picture, not the way there. `visits` keeps, for each visit,
 * where the steps stopped (null when they got through).
 */
async function shoot(browser, url, options, which, state) {
  let first;
  try {
    first = await look(browser, url, options, which, state, options.video);
  } catch (err) {
    // Gone or never there. Any other answer (a login, a rate limit) is not a missing page
    if (/^HTTP (404|410)$/.test(err.message)) return null;
    throw new Error(`${url}: ${err.message}`);
  }
  for (const layer of first.layers) layer.noise = [];
  first.url = url;
  first.which = which;
  first.state = state;
  first.visits = [first.stopped ?? null];
  for (const layer of first.layers) layer.clean = layer.png;
  // A side that stopped is a picture of where it stopped: there is no noise to learn
  if (!first.stopped) for (let pass = 1; pass < options.passes; pass++) await revisit(browser, first, options);
  return first;
}

/** One more visit of a side: what differs from its first capture is noise as well. */
async function revisit(browser, side, options) {
  const again = await look(browser, side.url, options, side.which, side.state);
  side.visits.push(again.stopped ?? null);
  // Stopped on the way, the picture is of another page and says nothing about noise
  if (again.stopped) return;
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

const height = (buffer) => buffer.readUInt32BE(20); // IHDR
const width = (buffer) => buffer.readUInt32BE(16);

function writeShots(shots, name, which, side) {
  writeFileSync(join(shots, `${name}-${which}.png`), side.page);
  if (side.sharp?.page) writeFileSync(join(shots, `${name}-${which}@2x.png`), side.sharp.page);
  if (side.sharp?.window) writeFileSync(join(shots, `${name}-${which}-window@2x.png`), side.sharp.window);
  for (const layer of side.layers) {
    if (layer.window) writeFileSync(join(shots, `${name}-${which}-window.png`), layer.window);
  }
}

/**
 * A change of the whole page: a page added or removed, or a state or a login that gets through
 * on one side only. Then both pictures are there, the stopped side's of where it stopped.
 */
function wholePage(type, name, { before, after }, options) {
  return {
    type,
    page: true,
    beforeY: 0,
    beforeH: before ? height(before.page) : 0,
    afterY: 0,
    afterH: after ? height(after.page) : 0,
    box: null,
    view: {
      before: before && shown(name, "before", "", before),
      after: after && shown(name, "after", "", after),
      width: options.width,
      beforeHeight: before ? height(before.page) : 0,
      afterHeight: after ? height(after.page) : 0,
    },
  };
}

/** The changes between two sides that are both there, with the noise of their visits left out. */
function differences(name, { before, after }, options, page) {
  const found = [];
  // A page that scrolls as a whole on one side and inside an element on the other has
  // no layers in common: then the whole pages are compared
  const shared = before.layers.every((layer) => after.layers.some((l) => l.name === layer.name && width(l.png) === width(layer.png)));
  // The whole page of a side, with what --ignore names left out and the noise of its
  // layers painted over, each layer's boxes moved to where the layer sits on the page
  const whole = (side) => {
    const noise = side.layers.flatMap((layer) => layer.noise.map((box) => ({ ...box, x: box.x + layer.x, y: box.y + layer.y })));
    return { name: "page", clean: paint(side.compared, noise), noise, unstable: side.layers.some((layer) => layer.unstable), x: 0, y: 0, shown: "page" };
  };
  const pairs = shared ? before.layers.map((layer) => [layer, after.layers.find((l) => l.name === layer.name)]) : [[whole(before), whole(after)]];
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
      if (nearNoise(change, is.noise, "after", wide, options.noiseMargin) || nearNoise(change, was.noise, "before", wide, options.noiseMargin)) {
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
        ...(change.slide
          ? { slide: { ground: change.slide.ground, moves: change.slide.moves.map((move) => ({ ...move, x: move.x + was.x, dx: move.dx + is.x - was.x })) } }
          : {}),
        view,
      });
    }
  }
  return found;
}

/** A step as a person reads it: from 1, with what it does. "step 1 (click button "Checkout")" */
const stepText = (stop, steps, route) =>
  stop.step === null ? `loading ${route}` : `step ${stop.step + 1} (${describeStep(steps[stop.step])})`;
const stopText = (stop, steps, route) => `${stepText(stop, steps, route)}: ${stop.reason}`;

/**
 * How the visits of a side went: reached every time, stopped every time at the same step, or
 * neither, which is a way to the state that comes and goes.
 */
function outcome(side, steps, route) {
  const stops = side.visits.filter(Boolean);
  if (!stops.length) return { reached: true };
  if (stops.length === side.visits.length && stops.every((stop) => stop.step === stops[0].step)) {
    return { stopped: stops[0], text: stopText(stops[0], steps, route) };
  }
  return { text: `unstable: stopped on ${stops.length} of ${side.visits.length} visits, last at ${stopText(stops.at(-1), steps, route)}` };
}

/**
 * A route, or a state reached from it, on both sides. Gives the page entry, or for a state
 * that cannot be compared (stopped on both sides, or not the same on every visit) a problem.
 */
async function compareOne(browser, options, shots, name, route, state, index) {
  const sides = {};
  for (const which of ["before", "after"]) {
    const side = await shoot(browser, options[which] + route, options, which, state);
    sides[which] = side;
    if (side) writeShots(shots, name, which, side);
  }
  const { before, after } = sides;
  if (!before && !after) return {};
  const page = { route, ...(state && { state: { name: state.name, steps: state.steps.length } }), changes: [] };
  if (!before || !after) {
    page.changes.push(wholePage(after ? "added" : "removed", name, sides, options));
    return { page };
  }
  if (state && (before.stopped || after.stopped)) {
    // A stop on one side is said only once it happens on every visit, at the same step: the
    // steps run again on both sides, as a change is confirmed
    const one = Boolean(before.stopped) !== Boolean(after.stopped);
    for (let round = 0; one && round < options.confirm; round++) {
      await revisit(browser, before, options);
      await revisit(browser, after, options);
    }
  } else {
    page.changes = differences(name, sides, options, page);
    // A random part can look the same on two visits of one side and still differ from the
    // other side. Before a page is said to have changed, both sides are visited again:
    // what was chance shows up as noise then, and a change stays a change.
    for (let round = 0; round < options.confirm && page.changes.length; round++) {
      await revisit(browser, before, options);
      await revisit(browser, after, options);
      page.changes = differences(name, sides, options, page);
    }
  }
  if (!state) return { page };
  const was = outcome(before, state.steps, route);
  const is = outcome(after, state.steps, route);
  if (was.reached && is.reached) return { page };
  const gone = was.reached && is.stopped ? "after" : is.reached && was.stopped ? "before" : null;
  if (!gone) return { problem: { name: state.name, route, before: was.text ?? null, after: is.text ?? null } };
  const stop = (gone === "after" ? is : was).stopped;
  page.changes = [
    {
      ...wholePage(gone === "after" ? "unreached" : "reached", name, sides, options),
      stopped: {
        side: gone,
        step: stop.step,
        path: stop.step === null ? `states[${index}].route` : `states[${index}].steps[${stop.step}]`,
        does: stop.step === null ? `load ${route}` : describeStep(state.steps[stop.step]),
        reason: stop.reason,
      },
    },
  ];
  delete page.unstable;
  return { page };
}

/**
 * The login of a states file, run once on each side before anything is captured, so that
 * every page and state is seen with the session it leaves. A side that does not get through
 * tries again `confirm` times, each from the first step in a fresh context: a slow server is
 * not a broken login. Gives the page entry of the finding when only one side got through.
 */
async function setUp(browser, options, shots, log) {
  const { setup, testIdAttribute, timeout } = options.states;
  const ends = {};
  for (const which of ["before", "after"]) {
    const run = { width: options.width, base: options[which], testIdAttribute, env: options.env };
    for (let round = 0; ; round++) {
      if (round) await browser.resetSide(which);
      // Steps that do not start by going somewhere start on the home page of the version
      if (setup[0].action !== "navigate") {
        const home = await browser.run(which, [{ action: "navigate", path: "/", timeout }], run);
        if (!home.reached) throw new Error(`${options[which]}/: ${home.reason}`);
      }
      ends[which] = await browser.run(which, setup, run);
      if (ends[which].reached || round >= options.confirm) break;
    }
  }
  const { before, after } = ends;
  if (before.reached && after.reached) return null;
  const text = (end) => `step ${end.step + 1} (${describeStep(setup[end.step])}): ${end.reason}`;
  if (!before.reached && !after.reached) {
    throw new Error(`The setup stopped on both versions, so nothing can be compared:\n  before: ${text(before)}\n  after: ${text(after)}`);
  }
  const gone = before.reached ? "after" : "before";
  const end = ends[gone];
  // Where it stopped: the page the tab shows, or else the last page the steps went to
  const here = await browser.evaluate("location.href", gone);
  const route =
    typeof here === "string" && here.startsWith(options[gone])
      ? toRoute(here)
      : (setup.slice(0, end.step + 1).findLast((step) => step.action === "navigate")?.path ?? "/");
  const sides = {};
  for (const which of ["before", "after"]) {
    sides[which] = await browser.shootHere(which, { width: options.width, ignore: options.ignore, sharp: options.video });
    writeShots(shots, "setup", which, sides[which]);
  }
  log(`✗ setup  ${gone === "after" ? "no longer gets through" : "gets through only now"}: ${gone} stopped at ${text(end)}; nothing else is compared`);
  return {
    route,
    setup: true,
    changes: [
      {
        ...wholePage(gone === "after" ? "unreached" : "reached", "setup", sides, options),
        stopped: { side: gone, step: end.step, path: `setup[${end.step}]`, does: describeStep(setup[end.step]), reason: end.reason },
      },
    ],
  };
}

/** Every CSS selector of the states file, read by the browser: one it cannot read would only ever be "not found". */
async function checkSelectors(browser, options) {
  const { setup, states } = options.states;
  const selectors = [
    ...setup.map((step, i) => [step.target?.css, `setup[${i}].target.css`]),
    ...states.flatMap((state, s) => [
      ...state.steps.map((step, i) => [step.target?.css, `states[${s}].steps[${i}].target.css`]),
      ...state.ignore.map((selector, i) => [selector, `states[${s}].ignore[${i}]`]),
    ]),
  ].filter(([selector]) => selector !== undefined);
  const wrong = [];
  for (const [selector, path] of selectors) {
    const readable = await browser.evaluate(`(() => { try { document.querySelector(${JSON.stringify(selector)}); return true; } catch { return false; } })()`, "before");
    if (!readable) wrong.push(`  ${path}: "${selector}" is not a selector`);
  }
  if (wrong.length) throw new Error(`${options.statesFile} has ${wrong.length} problem${wrong.length === 1 ? "" : "s"}:\n${wrong.join("\n")}`);
}

/**
 * Both sites, every route and every state: screenshots on disk and the list of changes. States
 * that could not be compared go into `problems`. With a states file the order is: the setup on
 * each side, then the routes, each followed by the states that start from it, in the order of
 * the file, then the states whose route is not among the routes.
 */
export async function compare(options, log = console.log, problems = []) {
  const states = options.states?.states ?? [];
  const routes = await collectRoutes({ ...options, orNone: states.length > 0 });
  const shots = join(options.out, "shots");
  mkdirSync(shots, { recursive: true });
  const browser = await openBrowser({
    wait: options.wait,
    onDialog: ({ side, type, message }) => log(`  ${side}: the page showed a ${type}${message ? ` "${message}"` : ""}, accepted`),
  });
  const pages = [];
  try {
    if (options.states) {
      await checkSelectors(browser, options);
      if (options.states.setup.length) {
        const stopped = await setUp(browser, options, shots, log);
        // Every other page would differ only because one side is logged out
        if (stopped) return [stopped];
      }
    }
    const order = [];
    for (const route of routes) {
      order.push({ route });
      for (const [index, state] of states.entries()) if (state.route === route) order.push({ route, state, index });
    }
    for (const [index, state] of states.entries()) if (!routes.includes(state.route)) order.push({ route: state.route, state, index });
    const names = new Set();
    const started = Date.now();
    let statesTook = 0;
    for (const { route, state, index } of order) {
      // Two routes can have one slug ("/about" and "/about/"): the second gets a number
      const base = state ? `state-${slug(state.name)}` : slug(route);
      let name = base;
      for (let n = 2; names.has(name); n++) name = `${base}-${n}`;
      names.add(name);
      const since = Date.now();
      const { page, problem } = await compareOne(browser, options, shots, name, route, state, index);
      if (state) statesTook += Date.now() - since;
      const label = state ? `${route} › ${state.name}` : route;
      if (problem) {
        problems.push(problem);
        const sides = ["before", "after"].filter((which) => problem[which]).map((which) => `${which} ${problem[which]}`);
        log(`? ${label}  not compared: ${sides.join("; ")}`);
        continue;
      }
      if (!page) continue;
      pages.push(page);
      const count = page.changes.length;
      const stop = page.changes[0]?.stopped;
      if (stop) {
        const at = `${stop.step === null ? `loading ${route}` : `step ${stop.step + 1} (${stop.does})`}: ${stop.reason}`;
        log(stop.side === "after" ? `✗ ${label}  can no longer be reached: ${at}` : `+ ${label}  can be reached now; before stopped at ${at}`);
        continue;
      }
      log(`${count ? "≠" : "="} ${label}${count ? `  ${count} change${count > 1 ? "s" : ""}` : ""}${page.unstable ? "  (parts differ between two visits and are left out)" : ""}`);
    }
    if (states.length) log(`${states.length} state${states.length === 1 ? "" : "s"} took ${Math.round(statesTook / 1000)} s of ${Math.round((Date.now() - started) / 1000)} s`);
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
      // Two edits of a row are not one slide
      slide: undefined,
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
      // Until the table knows them: states reached on one side only show their kind as it is
      lines.push(`| \`${page.route.replace(/\|/g, "\\|")}\` | ${kind[change.type] ?? change.type} | ${where} |`);
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
  --states states.json     states behind a click or a login, compared as well (--check: only check the file)
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
  if (options.check) {
    const { setup, states } = options.states;
    const steps = setup.length ? `, setup with ${setup.length} step${setup.length === 1 ? "" : "s"}` : ", no setup";
    console.log(`${options.statesFile} is right: ${states.length} state${states.length === 1 ? "" : "s"}${steps}`);
    return;
  }
  // Before the long part: Kokoro times words in English only, and speaks no German
  if (kokoroVoice(options.voice) && (options.language !== "en" || !/^[ab]/.test(kokoroVoice(options.voice)))) {
    throw new Error(`Kokoro speaks the sentences in English only: take an American (a…) or British (b…) voice, or a Piper voice for --language ${options.language}`);
  }
  let versions;
  if (options.base) {
    // CHANGEREEL_CWD: the repository to take the versions from, when it is not where this runs
    versions = await serveVersions({ ...options, cwd: process.env.CHANGEREEL_CWD || process.cwd() });
    options.before = versions.before;
    options.after = versions.after;
  }
  let pages;
  const problems = [];
  try {
    pages = await compare(options, console.log, problems);
  } finally {
    await versions?.stop();
  }
  const changed = pages.filter((page) => page.changes.length);
  const total = changed.reduce((sum, page) => sum + page.changes.length, 0);
  mkdirSync(options.out, { recursive: true });
  writeFileSync(
    join(options.out, "changes.json"),
    JSON.stringify(
      {
        before: options.base ?? options.before,
        after: options.base ? options.head : options.after,
        checked: pages.length,
        pages: changed,
        ...(options.states && { problems }),
      },
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
  // A state reached on neither version says the file does not fit the site: the run is done,
  // but it does not pass
  if (problems.length) {
    console.error(`\nNot compared, ${problems.length} state${problems.length === 1 ? "" : "s"}:`);
    for (const { name, route, before, after } of problems) {
      console.error(`  ${route} › ${name}: ${[before && `before ${before}`, after && `after ${after}`].filter(Boolean).join("; ")}`);
    }
    process.exitCode = 2;
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
