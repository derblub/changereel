/**
 * The steps of a state, run in one tab over the DevTools protocol: the target is found as a
 * screen reader or a test finds it, the step waits until a person could use it, then acts as
 * a person would, with real mouse and key events.
 *
 * A step that cannot be done is not an error of the run: on one version it is a finding about
 * the change. So every step ends in either nothing (done) or a short reason in plain words.
 */
import { keyEvents, sameName } from "./states.mjs";

const POLL_MS = 100;
// What a label target finds: the field a label names, not the text next to it
const FIELDS = ["textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "spinbutton", "slider", "listbox"];
// Handles to page objects made on one attempt are let go together after it
const GROUP = "changereel-steps";
const FRAME = "new Promise((r) => requestAnimationFrame(r))";
const TWO_FRAMES = "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))";

// How far past its time a step may run. An attempt begun in time is let finish on a slow page,
// so that its reason is the page's ("covered by …") and not the clock's; beyond that the step
// ends, whatever the page does. The wait for two frames after a step gets as long.
const LATE_MS = 1000;

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** A value as a CSS string, for an attribute selector: line breaks and form feeds as escapes, which a string cannot hold. */
export const cssString = (value) =>
  `"${value.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\a ").replace(/\r/g, "\\d ").replace(/\f/g, "\\c ")}"`;

/** Thrown when the step's time ran out while the page had not answered yet. */
class TimedOut extends Error {}

/**
 * Waits for `work` until `deadline` at most. A page that blocks its main thread never answers,
 * and the step must still end: what is still pending then is left to settle on its own.
 */
function within(work, deadline) {
  work.catch(() => {});
  let timer;
  const over = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new TimedOut("timed out")), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([work, over]).finally(() => clearTimeout(timer));
}

/**
 * A page that did not answer in time is most likely running a script that does not end
 * (`while (true)`): it is stopped, so that the picture of where the step stopped can still be
 * taken. Termination hits the next script when none is running; the empty one after it takes it.
 */
async function unblock(tab) {
  const soon = () => Date.now() + 1000;
  await within(tab.send("Runtime.terminateExecution"), soon()).catch(() => {});
  await within(tab.send("Runtime.evaluate", { expression: "0" }), soon()).catch(() => {});
}

const area = (q) => Math.abs((q[0] * q[3] - q[2] * q[1]) + (q[2] * q[5] - q[4] * q[3]) + (q[4] * q[7] - q[6] * q[5]) + (q[6] * q[1] - q[0] * q[7])) / 2;

/** The first box of the element that has an area, or null: an element without one is not seen. */
async function quad(tab, backendNodeId) {
  try {
    const { quads } = await tab.send("DOM.getContentQuads", { backendNodeId });
    return quads.find((q) => area(q) > 0) ?? null;
  } catch {
    // Not rendered at all (display: none, detached)
    return null;
  }
}

// Asked of all candidates at once, in one call: which are seen, in document order. Seen is a
// box with an area (an element without one is not rendered) that is also shown: visibility:
// hidden (on the element or above it) and content-visibility keep the box but show nothing.
// The same rule for every kind of target.
const SEEN = `function (...nodes) {
  const boxed = (n) => {
    let rects;
    if (n.nodeType === 1) rects = n.getClientRects();
    else {
      const range = document.createRange();
      range.selectNodeContents(n);
      rects = range.getClientRects();
    }
    return [...rects].some((r) => r.width > 0 && r.height > 0);
  };
  const shown = (n) => {
    const el = n.nodeType === 1 ? n : n.parentElement;
    return !el || !el.checkVisibility || el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
  };
  const order = nodes.map((n, i) => i).sort((a, b) => (a === b ? 0 : nodes[a].compareDocumentPosition(nodes[b]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return order.filter((i) => nodes[i].isConnected && boxed(nodes[i]) && shown(nodes[i]));
}`;

/** Every element the target names, as backend node ids, and those that are seen, in document order. */
async function search(tab, target, testIdAttribute) {
  let ids;
  if (target.role || target.label !== undefined) {
    // One query for each role a target can have, not the whole tree on every poll. The name
    // is not given to the query, which compares it exactly: names are compared here with
    // their whitespace normalized, as the file promises
    const { result } = await tab.send("Runtime.evaluate", { expression: "document", objectGroup: GROUP });
    const roles = target.role ? [target.role] : FIELDS;
    const answers = await Promise.all(roles.map((role) => tab.send("Accessibility.queryAXTree", { objectId: result.objectId, role })));
    const name = target.role ? target.name : target.label;
    ids = answers
      .flatMap(({ nodes }) => nodes)
      .filter((node) => !node.ignored && node.backendDOMNodeId)
      .filter((node) => name === undefined || sameName(node.name?.value ?? "", name))
      .map((node) => node.backendDOMNodeId);
  } else {
    const selector = target.css ?? `[${testIdAttribute}=${cssString(target.testId)}]`;
    const { root } = await tab.send("DOM.getDocument", { depth: 0 });
    const { nodeIds } = await tab.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector });
    ids = (await Promise.all(nodeIds.map((nodeId) => tab.send("DOM.describeNode", { nodeId })))).map(({ node }) => node.backendNodeId);
  }
  ids = [...new Set(ids)];
  if (!ids.length) return { found: 0, seen: [] };
  const objects = await Promise.all(ids.map((backendNodeId) => tab.send("DOM.resolveNode", { backendNodeId, objectGroup: GROUP })));
  const { result, exceptionDetails } = await tab.send("Runtime.callFunctionOn", {
    objectId: objects[0].object.objectId,
    functionDeclaration: SEEN,
    arguments: objects.map(({ object }) => ({ objectId: object.objectId })),
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return { found: ids.length, seen: result.value.map((i) => ids[i]) };
}

/**
 * The one element a target means, or why there is none. More than one without `nth` is a stop
 * on purpose: when a version adds a second "Save", the state should not click another one.
 */
function pick({ found, seen }, nth) {
  if (!found) return { reason: "not found" };
  if (!seen.length) return { reason: "not visible" };
  if (nth !== undefined) return nth < seen.length ? { node: seen[nth] } : { reason: `found ${seen.length}; there is no nth ${nth}` };
  if (seen.length > 1) return { reason: `found ${seen.length}; add nth to pick one` };
  return { node: seen[0] };
}

async function call(tab, backendNodeId, functionDeclaration, args = []) {
  const { object } = await tab.send("DOM.resolveNode", { backendNodeId, objectGroup: GROUP });
  const { result, exceptionDetails } = await tab.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration,
    arguments: args,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
}

// Called on the target with what is at its middle: "" when that is the target, something in
// it or a label of it (a click there reaches the target as well); otherwise what covers it,
// the outermost element that does not hold the target, as tag#id.class
const COVERED = `function (hit) {
  const up = (n) => n.parentNode || n.host || null;
  const holds = (outer, n) => { for (; n; n = up(n)) if (n === outer) return true; return false; };
  if (holds(this, hit)) return "";
  let el = hit.nodeType === 1 ? hit : hit.parentElement;
  if (el && el.closest("label") && el.closest("label").control === this) return "";
  while (el && up(el) && up(el).nodeType === 1 && !holds(up(el), this)) el = up(el);
  if (!el) return "something";
  const classes = typeof el.className === "string" ? el.className.trim().split(/\\s+/).filter(Boolean) : [];
  return el.localName + (el.id ? "#" + el.id : "") + classes.map((c) => "." + c).join("");
}`;

/**
 * Whether a person could click the element now, and where: enabled, no longer moving (a
 * dialog sliding in is clicked once it is in place), and not under something else, the most
 * common reason for a click that does nothing.
 */
async function ready(tab, node) {
  const { nodes } = await tab.send("Accessibility.getPartialAXTree", { backendNodeId: node, fetchRelatives: false });
  const ax = nodes.find((n) => n.backendDOMNodeId === node) ?? nodes[0];
  if (ax?.properties?.some((p) => p.name === "disabled" && p.value?.value === true)) return { reason: "disabled" };
  await tab.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node });
  const first = await quad(tab, node);
  await tab.send("Runtime.evaluate", { expression: FRAME, awaitPromise: true });
  const second = await quad(tab, node);
  if (!first || !second) return { reason: "not visible" };
  if (first.some((v, i) => v !== second[i])) return { reason: "still moving" };
  // The middle of the part the window shows: an element taller than the window has its own
  // middle outside it, where nothing can be clicked
  const { cssVisualViewport: view } = await tab.send("Page.getLayoutMetrics");
  const xs = [second[0], second[2], second[4], second[6]];
  const ys = [second[1], second[3], second[5], second[7]];
  const [left, right] = [Math.max(Math.min(...xs), 0), Math.min(Math.max(...xs), view.clientWidth)];
  const [top, bottom] = [Math.max(Math.min(...ys), 0), Math.min(Math.max(...ys), view.clientHeight)];
  if (left >= right || top >= bottom) return { reason: "not visible" };
  const [x, y] = [(left + right) / 2, (top + bottom) / 2];
  // The quads are where the window shows the element; the hit test takes a place on the page
  const hit = await tab.send("DOM.getNodeForLocation", { x: Math.round(x + view.pageX), y: Math.round(y + view.pageY) });
  const { object } = await tab.send("DOM.resolveNode", { backendNodeId: hit.backendNodeId, objectGroup: GROUP });
  const cover = await call(tab, node, COVERED, [{ objectId: object.objectId }]);
  if (cover) return { reason: `covered by ${cover}` };
  return { x, y, role: ax?.role?.value ?? "element" };
}

// Inputs that take no typed text, whatever role they show as
const NO_TEXT = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
const TAKES_TEXT = `function () {
  if (this.isContentEditable || this.localName === "textarea") return true;
  return this.localName === "input" && !${JSON.stringify(NO_TEXT)}.includes(this.type);
}`;
const SELECT_ALL = `function () {
  if (this.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(this);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  } else this.select();
}`;
// A person leaves a field after typing, and only then does the page hear "change" (Vue's
// v-model.lazy, many plain forms). The next step may not leave it: Enter in the password
// field must still send the form. So "change" is fired here while the field keeps the focus.
const CHANGED = `function () {
  if (!this.isContentEditable) this.dispatchEvent(new Event("change", { bubbles: true }));
}`;

/**
 * Presses a key, with its modifiers held around it. Gives `{ done }` or `{ stop }`, never an
 * error to try again on: once a key went down it is not pressed a second time, since a second
 * Enter sends a form twice and a second "a" types twice. A failure after the key itself
 * counts as done, since the page has it: the usual cause is that it went on to another page
 * (Enter sent the form) while the key was still going up, and the next step's waitFor says
 * whether that worked. A failure after a modifier only
 * stops the step. Modifiers held down are let go in any case, as well as can be.
 */
async function pressKey(tab, key) {
  const { held, modifiers, text, ...event } = keyEvents(key);
  const send = (params) => tab.send("Input.dispatchKeyEvent", { modifiers, ...params });
  const down = [];
  let pressed = false;
  try {
    for (const modifier of held) {
      // Counted before it is sent: a call that fails may still have reached the page
      down.push(modifier);
      await send({ type: "rawKeyDown", ...modifier });
    }
    pressed = true;
    await send({ type: text ? "keyDown" : "rawKeyDown", ...event, ...(text && { text, unmodifiedText: text }) });
    await send({ type: "keyUp", ...event });
    while (down.length) {
      await send({ type: "keyUp", ...down.at(-1) });
      down.pop();
    }
  } catch (err) {
    // Also after the step's time is over: a modifier left down would hold for the steps after
    const release = (tab.raw ?? tab).send;
    for (const modifier of down.toReversed()) await release("Input.dispatchKeyEvent", { modifiers, type: "keyUp", ...modifier }).catch(() => {});
    return pressed ? { done: true } : { stop: `press failed: ${err.message}` };
  }
  return { done: true };
}

/**
 * One try at a step against the page as it is now. `done` when it happened, `reason` to try
 * again, `stop` when trying again cannot help.
 */
async function attempt(tab, step, { testIdAttribute, env }) {
  const target = step.target;
  if (step.action === "waitFor") {
    const found = await search(tab, target, testIdAttribute);
    if (step.state === "hidden") {
      const there = target.nth === undefined ? found.seen.length > 0 : found.seen.length > target.nth;
      return there ? { reason: "still visible" } : { done: true };
    }
    const picked = pick(found, target.nth);
    return picked.node ? { done: true } : picked;
  }
  if (step.action === "press" && !target) return pressKey(tab, step.key);
  const picked = pick(await search(tab, target, testIdAttribute), target.nth);
  if (!picked.node) return picked;
  const node = picked.node;
  if (step.action === "press") {
    await tab.send("DOM.focus", { backendNodeId: node });
    return pressKey(tab, step.key);
  }
  const place = await ready(tab, node);
  if (place.reason) return place;
  if (step.action === "click") {
    const mouse = { x: place.x, y: place.y, button: "left", clickCount: 1 };
    await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: place.x, y: place.y });
    // Once pressed, the click is never tried again: a second press would be a double click
    try {
      await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", ...mouse });
      await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...mouse });
    } catch (err) {
      return { stop: `click failed: ${err.message}` };
    }
    return { done: true };
  }
  // fill
  if (!(await call(tab, node, TAKES_TEXT))) return { stop: `takes no text (${place.role})` };
  const value = step.valueFrom ? env[step.valueFrom.env] : step.value;
  if (value === undefined) return { stop: `$${step.valueFrom.env} is not set` };
  await tab.send("DOM.focus", { backendNodeId: node });
  await call(tab, node, SELECT_ALL);
  // Typed text replaces the selection and fires beforeinput and input, as a keyboard would.
  // Once it is sent the field is filled, and the fill is not tried again: a failure after it
  // is the page going on (to another page, as a form does), not a field still empty
  if (value === "") {
    const pressed = await pressKey(tab, "Delete");
    if (!pressed.done) return pressed;
  } else {
    try {
      await tab.send("Input.insertText", { text: value });
    } catch {
      return { done: true };
    }
  }
  await call(tab, node, CHANGED).catch(() => {});
  return { done: true };
}

/** Why loading a page failed, in a few words. */
const loadReason = (err) => (/^Timed out/.test(err.message) ? "timed out" : err.message);

/**
 * Runs the steps in the tab, in order. Each target is searched for anew on every attempt, every
 * 100 ms until the step's time is over: a click may have loaded another page, and whatever was
 * found before is gone then. Gives `{ reached: true }`, or `{ reached: false, step, reason }`
 * with the index of the step that stopped and the last reason it could not be done.
 *
 * The step's time is a hard limit: a page that does not answer at all (its main thread busy
 * with a script that does not end) stops the step when the time is over, "timed out".
 *
 * `tab.send(method, params)` speaks to the tab; `load(url, timeout)` loads a page as capture
 * does and throws "HTTP 500" and the like; `base` is the address of the version, which
 * `navigate` paths are put after.
 */
export async function runSteps(tab, steps, { base, load, testIdAttribute = "data-testid", env = process.env }) {
  for (const [index, step] of steps.entries()) {
    const deadline = Date.now() + step.timeoutMs;
    // An attempt still waiting on the page when the time is over goes on once the page
    // answers; from then on it can no longer do anything to the page
    let over = false;
    const live = { ...tab, raw: tab, send: (method, params) => (over ? Promise.reject(new Error("the step is over")) : tab.send(method, params)) };
    let reason = await runStep(live, step, { base, load, testIdAttribute, env, deadline });
    if (!reason) {
      // What the step started (a dialog opening, a page loading) has begun before the next one
      const frames = live.send("Runtime.evaluate", { expression: TWO_FRAMES, awaitPromise: true });
      await within(frames, Math.max(deadline, Date.now()) + LATE_MS).catch((err) => {
        if (err instanceof TimedOut) reason = "timed out";
      });
    }
    over = true;
    if (reason === "timed out" || reason?.endsWith(" (timed out)")) await unblock(tab);
    if (reason) return { reached: false, step: index, reason };
  }
  return { reached: true };
}

async function runStep(tab, step, { base, load, testIdAttribute, env, deadline }) {
  if (step.action === "navigate") {
    try {
      await within(load(base.replace(/\/+$/, "") + step.path, step.timeoutMs), deadline + LATE_MS);
      return null;
    } catch (err) {
      return loadReason(err);
    }
  }
  // The reason of the last attempt that got an answer; none yet before the first
  let reason;
  for (;;) {
    let outcome;
    try {
      outcome = await within(attempt(tab, step, { testIdAttribute, env }), deadline + LATE_MS);
    } catch (err) {
      if (err instanceof TimedOut) return reason ? `${reason} (timed out)` : "timed out";
      // The page changed under the attempt (it was loading, a node went away): try again
      outcome = { reason: reason ?? "not found" };
    } finally {
      // Not waited for: the tab takes its calls in order, and one that hangs must not hold the step
      tab.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => {});
    }
    if (outcome.done) return null;
    if (outcome.stop) return outcome.stop;
    reason = outcome.reason;
    if (Date.now() + POLL_MS > deadline) return reason;
    await sleep(POLL_MS);
  }
}
