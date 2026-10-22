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

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** A value as a CSS string, for an attribute selector. */
const cssString = (value) => `"${value.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\a ")}"`;

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

// A box is not enough: visibility: hidden (on the element or above it) and content-visibility
// keep the box but show nothing. Asked of every kind of target, so the rule is the same for all.
const SHOWN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  return !el || !el.checkVisibility || el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
}`;

/** Every element the target names, as backend node ids in document order, and those that are seen. */
async function search(tab, target, testIdAttribute) {
  let ids;
  if (target.role || target.label !== undefined) {
    // The name is not given to the query, which compares it exactly: names are compared here
    // with their whitespace normalized, as the file promises
    const { result } = await tab.send("Runtime.evaluate", { expression: "document", objectGroup: GROUP });
    const { nodes } = await tab.send("Accessibility.queryAXTree", { objectId: result.objectId, ...(target.role && { role: target.role }) });
    const name = target.role ? target.name : target.label;
    ids = nodes
      .filter((node) => !node.ignored && node.backendDOMNodeId)
      .filter((node) => target.role || FIELDS.includes(node.role?.value))
      .filter((node) => name === undefined || sameName(node.name?.value ?? "", name))
      .map((node) => node.backendDOMNodeId);
  } else {
    const selector = target.css ?? `[${testIdAttribute}=${cssString(target.testId)}]`;
    const { root } = await tab.send("DOM.getDocument", { depth: 0 });
    const { nodeIds } = await tab.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector });
    ids = [];
    for (const nodeId of nodeIds) ids.push((await tab.send("DOM.describeNode", { nodeId })).node.backendNodeId);
  }
  ids = [...new Set(ids)];
  const seen = [];
  for (const id of ids) if ((await quad(tab, id)) && (await call(tab, id, SHOWN))) seen.push(id);
  return { found: ids.length, seen };
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

async function pressKey(tab, key) {
  const { held, modifiers, text, ...event } = keyEvents(key);
  const send = (params) => tab.send("Input.dispatchKeyEvent", { modifiers, ...params });
  for (const modifier of held) await send({ type: "rawKeyDown", ...modifier });
  await send({ type: text ? "keyDown" : "rawKeyDown", ...event, ...(text && { text, unmodifiedText: text }) });
  await send({ type: "keyUp", ...event });
  for (const modifier of held.toReversed()) await send({ type: "keyUp", ...modifier });
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
  if (step.action === "press" && !target) {
    await pressKey(tab, step.key);
    return { done: true };
  }
  const picked = pick(await search(tab, target, testIdAttribute), target.nth);
  if (!picked.node) return picked;
  const node = picked.node;
  if (step.action === "press") {
    await tab.send("DOM.focus", { backendNodeId: node });
    await pressKey(tab, step.key);
    return { done: true };
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
  // Typed text replaces the selection and fires beforeinput and input, as a keyboard would
  if (value === "") await pressKey(tab, "Delete");
  else await tab.send("Input.insertText", { text: value });
  await call(tab, node, CHANGED);
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
 * `tab.send(method, params)` speaks to the tab; `load(url, timeout)` loads a page as capture
 * does and throws "HTTP 500" and the like; `base` is the address of the version, which
 * `navigate` paths are put after.
 */
export async function runSteps(tab, steps, { base, load, testIdAttribute = "data-testid", env = process.env }) {
  for (const [index, step] of steps.entries()) {
    const reason = await runStep(tab, step, { base, load, testIdAttribute, env });
    if (reason) return { reached: false, step: index, reason };
    // What the step started (a dialog opening, a page loading) has begun before the next one
    await tab.send("Runtime.evaluate", { expression: TWO_FRAMES, awaitPromise: true }).catch(() => {});
  }
  return { reached: true };
}

async function runStep(tab, step, { base, load, testIdAttribute, env }) {
  if (step.action === "navigate") {
    try {
      await load(base.replace(/\/+$/, "") + step.path, step.timeout);
      return null;
    } catch (err) {
      return loadReason(err);
    }
  }
  const deadline = Date.now() + step.timeout;
  let reason = "not found";
  for (;;) {
    let outcome;
    try {
      outcome = await attempt(tab, step, { testIdAttribute, env });
    } catch {
      // The page changed under the attempt (it was loading, a node went away): try again
      outcome = { reason };
    } finally {
      await tab.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => {});
    }
    if (outcome.done) return null;
    if (outcome.stop) return outcome.stop;
    reason = outcome.reason;
    if (Date.now() + POLL_MS > deadline) return reason;
    await sleep(POLL_MS);
  }
}
