/**
 * The states file: what a page shows only after a click or a login, named as a few steps.
 *
 * The file is checked here with plain code, not with a schema validator: that would be a
 * dependency for this alone, and the messages here say in words where and what is wrong.
 * schema/states.schema.json says the same for editors; a test runs both over the same files
 * so the two cannot drift apart.
 */
import { readFileSync } from "node:fs";

export const ACTIONS = ["navigate", "click", "fill", "press", "waitFor"];

/** The roles of WAI-ARIA 1.2 that stand for something on the page, as in the schema. */
export const ROLES = [
  "alert", "alertdialog", "article", "banner", "button", "cell", "checkbox", "columnheader", "combobox",
  "complementary", "contentinfo", "dialog", "figure", "form", "grid", "gridcell", "group", "heading", "img",
  "link", "list", "listbox", "listitem", "main", "menu", "menubar", "menuitem", "menuitemcheckbox",
  "menuitemradio", "navigation", "option", "progressbar", "radio", "radiogroup", "region", "row", "rowheader",
  "search", "searchbox", "separator", "slider", "spinbutton", "status", "switch", "tab", "table", "tablist",
  "tabpanel", "textbox", "toolbar", "tooltip", "tree", "treeitem",
];

export const DEFAULT_TIMEOUT = 10000;
const MAX_TIMEOUT = 120000;
const WAYS = ["role", "label", "testId", "css"];
const FIELDS = {
  top: ["$schema", "schemaVersion", "setup", "states", "timeout", "testIdAttribute"],
  state: ["name", "route", "steps", "ignore"],
  target: [...WAYS, "name", "nth"],
  valueFrom: ["env"],
  navigate: ["action", "path", "timeout"],
  click: ["action", "target", "timeout"],
  fill: ["action", "target", "value", "valueFrom", "timeout"],
  press: ["action", "key", "target", "timeout"],
  waitFor: ["action", "target", "state", "timeout"],
};
const REQUIRED = { navigate: ["path"], click: ["target"], fill: ["target"], press: ["key"], waitFor: ["target"] };

/** Bits of `modifiers` in Input.dispatchKeyEvent, and the key each one is. */
const MODIFIERS = {
  Alt: { bit: 1, code: "AltLeft", windowsVirtualKeyCode: 18 },
  Control: { bit: 2, code: "ControlLeft", windowsVirtualKeyCode: 17 },
  Meta: { bit: 4, code: "MetaLeft", windowsVirtualKeyCode: 91 },
  Shift: { bit: 8, code: "ShiftLeft", windowsVirtualKeyCode: 16 },
};

// Enter carries "\r" so that pressing it in a field sends the form, as it does for a person
const NAMED_KEYS = {
  Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { code: "Home", windowsVirtualKeyCode: 36 },
  End: { code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { code: "PageDown", windowsVirtualKeyCode: 34 },
};

// The keys of a US keyboard for the other printable characters; a shifted one is on its base key
const PUNCTUATION = {
  ";": ["Semicolon", 186], "=": ["Equal", 187], ",": ["Comma", 188], "-": ["Minus", 189], ".": ["Period", 190],
  "/": ["Slash", 191], "`": ["Backquote", 192], "[": ["BracketLeft", 219], "\\": ["Backslash", 220],
  "]": ["BracketRight", 221], "'": ["Quote", 222],
};
const SHIFTED = {
  "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/",
};

/** Whitespace trimmed and runs of it, line breaks too, made one space: names as a person reads them. */
export function normalizeName(name) {
  return String(name).replace(/\s+/g, " ").trim();
}

/** Names match exactly and with case once their whitespace is normalized. No patterns. */
export function sameName(a, b) {
  return normalizeName(a) === normalizeName(b);
}

/** Edits to turn one word into the other. */
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** The word of the list nearest to the one given, without regard to case. */
export function closest(word, list) {
  const lower = String(word).toLowerCase();
  let best;
  let least = Infinity;
  for (const candidate of list) {
    const d = distance(lower, candidate.toLowerCase());
    if (d < least) [best, least] = [candidate, d];
  }
  return best;
}

/** "Shift+Tab" as its modifiers and its key, or null when it is not a key of the table. */
function parseKey(key) {
  if (typeof key !== "string") return null;
  const modifiers = [];
  let rest = key;
  let match;
  // "Shift++" is Shift and the plus key: a "+" ends the modifiers only when something follows
  while ((match = /^(Shift|Control|Alt|Meta)\+(?=.)/s.exec(rest))) {
    modifiers.push(match[1]);
    rest = rest.slice(match[0].length);
  }
  if (!Object.hasOwn(NAMED_KEYS, rest) && !/^[!-~]$/.test(rest)) return null;
  return { modifiers, name: rest };
}

/** A key of the table close to a misspelt one ("Ctrl+a" is "Control+a"), or null when none is. */
function nearKey(key) {
  const parts = key.split("+");
  const last = parts.pop();
  const near = [];
  for (const part of parts) {
    const modifier = closest(part, Object.keys(MODIFIERS));
    if (distance(part.toLowerCase(), modifier.toLowerCase()) > 3) return null;
    near.push(modifier);
  }
  if (parseKey(last)) near.push(last);
  else {
    const named = closest(last, Object.keys(NAMED_KEYS));
    if (last.length < 2 || distance(last.toLowerCase(), named.toLowerCase()) > 2) return null;
    near.push(named);
  }
  return near.join("+");
}

/**
 * The fields of Input.dispatchKeyEvent for a key of the file, and in `held` the modifier keys
 * to press before it and let go after it, in that order. A key without `text` is sent as
 * rawKeyDown; with Control, Alt or Meta held a character types nothing, it is a shortcut.
 */
export function keyEvents(key) {
  const parsed = parseKey(key);
  if (!parsed) throw new Error(`"${key}" is not a key`);
  const held = [...new Set(parsed.modifiers)].map((name) => ({ key: name, code: MODIFIERS[name].code, windowsVirtualKeyCode: MODIFIERS[name].windowsVirtualKeyCode }));
  const modifiers = held.reduce((bits, { key: name }) => bits | MODIFIERS[name].bit, 0);
  const shortcut = modifiers & (MODIFIERS.Alt.bit | MODIFIERS.Control.bit | MODIFIERS.Meta.bit);
  let event;
  if (Object.hasOwn(NAMED_KEYS, parsed.name)) {
    const { key: named = parsed.name, ...rest } = NAMED_KEYS[parsed.name];
    event = { key: named, ...rest };
  } else {
    let char = parsed.name;
    if (modifiers & MODIFIERS.Shift.bit && /[a-z]/.test(char)) char = char.toUpperCase();
    const base = SHIFTED[char] ?? char.toLowerCase();
    let code;
    let windowsVirtualKeyCode;
    if (/[a-z]/.test(base)) [code, windowsVirtualKeyCode] = [`Key${base.toUpperCase()}`, base.toUpperCase().charCodeAt(0)];
    else if (/[0-9]/.test(base)) [code, windowsVirtualKeyCode] = [`Digit${base}`, base.charCodeAt(0)];
    else [code, windowsVirtualKeyCode] = PUNCTUATION[base];
    event = { key: char, code, windowsVirtualKeyCode, text: char };
  }
  if (shortcut) delete event.text;
  return { modifiers, ...event, held };
}

/** How a target is written: `button "Checkout"`, `label "Email"`, `css ".x" (nth 1)`. */
function describeTarget(target) {
  const quote = JSON.stringify;
  let found;
  if (target.role) found = target.name === undefined ? target.role : `${target.role} ${quote(target.name)}`;
  else if (target.label !== undefined) found = `label ${quote(target.label)}`;
  else if (target.testId !== undefined) found = `testId ${quote(target.testId)}`;
  else found = `css ${quote(target.css)}`;
  return target.nth === undefined ? found : `${found} (nth ${target.nth})`;
}

/**
 * A step in a few words, for the log, the report and the video. A value from the environment
 * is named by its variable, never shown: `fill label "Password" from $CHANGEREEL_PASSWORD`.
 */
export function describeStep(step) {
  switch (step.action) {
    case "navigate":
      return `navigate ${step.path}`;
    case "click":
      return `click ${describeTarget(step.target)}`;
    case "fill":
      return step.valueFrom
        ? `fill ${describeTarget(step.target)} from $${step.valueFrom.env}`
        : `fill ${describeTarget(step.target)} with ${JSON.stringify(step.value)}`;
    case "press":
      return step.target ? `press ${step.key} in ${describeTarget(step.target)}` : `press ${step.key}`;
    case "waitFor":
      return `waitFor ${describeTarget(step.target)}${step.state === "hidden" ? " hidden" : ""}`;
    default:
      return String(step.action);
  }
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isInteger = (value) => typeof value === "number" && Number.isInteger(value);
const isText = (value) => typeof value === "string" && value.length > 0;
const and = (words) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);
const at = (path, key) => (path ? `${path}.${key}` : key);

/**
 * Every problem of an already parsed file, as { path, message }, in the order of the file;
 * those about the environment (section 4 of the checks: variables set) come last, after all
 * those about the file itself. No message carries the value of a variable.
 */
export function checkStates(data, env = process.env) {
  const problems = [];
  const variables = [];
  const say = (path, message) => problems.push({ path: path || "top level", message });

  const unknown = (path, key, fields, owner) => {
    // A field of another kind of step is a mix-up, not a typo
    if (owner && ACTIONS.some((action) => FIELDS[action].includes(key))) {
      return say(at(path, key), `${owner} takes no ${key}`);
    }
    const near = closest(key, fields);
    say(at(path, key), distance(key.toLowerCase(), near.toLowerCase()) <= 2 ? `unknown field; did you mean "${near}"?` : "unknown field");
  };
  const needs = (value, path, fields) => {
    const missing = fields.filter((field) => !Object.hasOwn(value, field));
    if (missing.length) say(path, `needs ${and(missing)}`);
  };
  const timeout = (value, path) => {
    if (!isInteger(value) || value < 1 || value > MAX_TIMEOUT) say(path, `must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT}`);
  };
  const route = (value, path) => {
    if (typeof value !== "string") return say(path, "must be a path such as /cart");
    // A backslash after the slash counts as a second slash in a browser: it names a host too
    if (/^\/[/\\]/.test(value) || (!value.startsWith("/") && URL.canParse(value))) {
      const own = URL.canParse(value, "http://host") ? new URL(value, "http://host") : null;
      return say(path, `${JSON.stringify(value)} names a host; give the path only${own ? `, such as ${own.pathname}${own.search}` : ""}`);
    }
    if (!value.startsWith("/")) say(path, `${JSON.stringify(value)} must start with /`);
  };

  const target = (value, path) => {
    if (!isObject(value)) return say(path, 'must be an object such as { "role": "button", "name": "Save" }');
    const ways = WAYS.filter((way) => Object.hasOwn(value, way));
    if (ways.length !== 1) say(path, `needs one of ${WAYS.join(", ")}; has ${ways.length ? and(ways) : "none"}`);
    for (const [key, field] of Object.entries(value)) {
      const here = at(path, key);
      if (key === "role") {
        if (typeof field !== "string") say(here, "must be a role such as button");
        else if (!ROLES.includes(field)) say(here, `${JSON.stringify(field)} is not a role; did you mean "${closest(field, ROLES)}"?`);
      } else if (key === "name") {
        if (!isText(field)) say(here, "must be a text, not empty");
        else if (!Object.hasOwn(value, "role")) say(here, "goes only with role");
      } else if (key === "label" || key === "testId" || key === "css") {
        if (!isText(field)) say(here, "must be a text, not empty");
      } else if (key === "nth") {
        if (!isInteger(field) || field < 0) say(here, "must be a whole number, 0 or more");
      } else unknown(path, key, FIELDS.target);
    }
  };

  const step = (value, path) => {
    if (!isObject(value)) return say(path, "must be an object with an action");
    if (!Object.hasOwn(value, "action")) return say(path, "needs action");
    const { action } = value;
    if (!ACTIONS.includes(action)) {
      // Without a known action there is no telling which fields belong
      return say(at(path, "action"), typeof action === "string" ? `${JSON.stringify(action)} is not an action; did you mean "${closest(action, ACTIONS)}"?` : `must be one of ${ACTIONS.join(", ")}`);
    }
    needs(value, path, REQUIRED[action]);
    if (action === "fill") {
      const has = ["value", "valueFrom"].filter((field) => Object.hasOwn(value, field));
      if (has.length === 0) say(path, "needs value or valueFrom");
      if (has.length === 2) say(path, "needs value or valueFrom, not both");
    }
    for (const [key, field] of Object.entries(value)) {
      const here = at(path, key);
      if (!FIELDS[action].includes(key)) unknown(path, key, FIELDS[action], action);
      else if (key === "timeout") timeout(field, here);
      else if (key === "path") route(field, here);
      else if (key === "target") target(field, here);
      else if (key === "value") {
        if (typeof field !== "string") say(here, "must be a text");
      } else if (key === "valueFrom") {
        if (!isObject(field)) say(here, 'must be an object such as { "env": "CHANGEREEL_PASSWORD" }');
        else {
          needs(field, here, ["env"]);
          for (const [inner, name] of Object.entries(field)) {
            if (inner !== "env") unknown(here, inner, FIELDS.valueFrom);
            else if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) say(at(here, "env"), "must be the name of an environment variable, such as CHANGEREEL_PASSWORD");
            else variables.push({ path: at(here, "env"), name });
          }
        }
      } else if (key === "key") {
        if (!parseKey(field)) {
          const near = typeof field === "string" ? nearKey(field) : null;
          say(here, `${JSON.stringify(field)} is not a key; ${near ? `did you mean "${near}"?` : "use a key such as Enter, Tab or a, with Shift+, Control+, Alt+ or Meta+ before it"}`);
        }
      } else if (key === "state") {
        if (field !== "visible" && field !== "hidden") say(here, "must be visible or hidden");
      }
    }
  };

  const steps = (value, path) => {
    if (!Array.isArray(value)) return say(path, "must be a list of steps");
    if (!value.length) return say(path, "needs at least one step");
    const last = value.at(-1);
    if (isObject(last) && ACTIONS.includes(last.action) && last.action !== "waitFor") say(path, `must end with waitFor; ends with ${last.action}`);
    value.forEach((item, i) => step(item, `${path}[${i}]`));
  };

  const states = (value, hasSetup) => {
    if (!Array.isArray(value)) return say("states", "must be a list of states");
    if (!value.length && !hasSetup) return say("states", "needs at least one state, or setup next to it");
    const names = new Map();
    value.forEach((state, i) => {
      const path = `states[${i}]`;
      if (!isObject(state)) return say(path, "must be an object with name, route and steps");
      needs(state, path, ["name", "route", "steps"]);
      for (const [key, field] of Object.entries(state)) {
        const here = at(path, key);
        if (key === "name") {
          if (typeof field !== "string" || [...field].length < 1 || [...field].length > 80) say(here, "must be a text of 1 to 80 characters");
          else {
            // The name is a heading in the video and the table: two that differ in case only are one
            const same = normalizeName(field).toLowerCase();
            if (names.has(same)) say(here, `${JSON.stringify(field)} is the name of ${names.get(same)} already (names are compared without case)`);
            else names.set(same, path);
          }
        } else if (key === "route") route(field, here);
        else if (key === "steps") steps(field, here);
        else if (key === "ignore") {
          if (!Array.isArray(field)) say(here, "must be a list of CSS selectors");
          else field.forEach((selector, j) => isText(selector) || say(`${here}[${j}]`, "must be a CSS selector, not empty"));
        } else unknown(path, key, FIELDS.state);
      }
    });
  };

  if (!isObject(data)) {
    say("", "must be an object with schemaVersion and states");
    return problems;
  }
  const version = data.schemaVersion;
  if (isInteger(version) && version > 1) {
    // A newer file may use fields this version does not know; listing them would only confuse
    say("schemaVersion", `is ${version}, newer than this changereel reads (1); update changereel`);
    return problems;
  }
  needs(data, "", ["schemaVersion"]);
  if (!Object.hasOwn(data, "states") && !Object.hasOwn(data, "setup")) say("", "needs states, or setup");
  for (const [key, value] of Object.entries(data)) {
    if (key === "$schema") {
      if (typeof value !== "string") say(key, "must be the address of the schema");
    } else if (key === "schemaVersion") {
      if (value !== 1) say(key, "must be 1");
    } else if (key === "timeout") timeout(value, key);
    else if (key === "testIdAttribute") {
      if (typeof value !== "string" || !/^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(value)) say(key, "must be an attribute name such as data-testid");
    } else if (key === "setup") steps(value, key);
    else if (key === "states") states(value, Object.hasOwn(data, "setup"));
    else unknown("", key, FIELDS.top);
  }

  // Last, as they are about where the run happens, not about the file
  for (const { path, name } of variables) {
    if (env[name] === undefined) say(path, `${name} is not set`);
    else if (env[name] === "") say(path, `${name} is empty`);
  }
  return problems;
}

/** Why JSON.parse gave up, without the piece of the text V8 quotes in some messages. */
const jsonReason = (err) => err.message.replace(/, .*is not valid JSON$/s, "").replace(/ in JSON at position.*$/s, "");

/** Line and column, from 1, of where JSON.parse gave up. */
function whereJson(text, err) {
  let position = Number(err.message.match(/at position (\d+)/)?.[1]);
  if (Number.isNaN(position) && /Unexpected end/.test(err.message)) position = text.length;
  if (Number.isNaN(position)) {
    // "Unexpected token" names no position: find the shortest start of the text that fails the same way
    const reason = jsonReason(err);
    const fails = (end) => {
      try {
        JSON.parse(text.slice(0, end));
        return false;
      } catch (e) {
        return jsonReason(e) === reason;
      }
    };
    let [low, high] = [0, text.length];
    while (low < high) {
      const mid = (low + high) >> 1;
      if (fails(mid)) high = mid;
      else low = mid + 1;
    }
    position = Math.max(0, low - 1);
  }
  const before = text.slice(0, position).split("\n");
  return { line: before.length, column: before.at(-1).length + 1 };
}

/** The file with what it leaves out filled in, so that nothing after this needs a default. */
function normalize(data) {
  const file = structuredClone(data);
  const timeout = file.timeout ?? DEFAULT_TIMEOUT;
  const step = (s) => ({ ...s, timeout: s.timeout ?? timeout, ...(s.action === "waitFor" && { state: s.state ?? "visible" }) });
  return {
    schemaVersion: 1,
    timeout,
    testIdAttribute: file.testIdAttribute ?? "data-testid",
    setup: (file.setup ?? []).map(step),
    states: (file.states ?? []).map((state) => ({ ...state, steps: state.steps.map(step), ignore: state.ignore ?? [] })),
  };
}

/**
 * Reads and checks a states file. Throws one error with every problem, each on a line of its
 * own with the path to it; returns the file with defaults filled in. Values of `valueFrom`
 * stay in the environment: they are read when the step runs, so they are in no object here.
 */
export function readStates(file, env = process.env) {
  let text;
  try {
    text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch (err) {
    throw new Error(`${file} cannot be read: ${err.code === "ENOENT" ? "there is no such file" : err.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const { line, column } = whereJson(text, err);
    throw new Error(`${file} is not JSON: line ${line}, column ${column}: ${jsonReason(err)}`);
  }
  const problems = checkStates(data, env);
  if (problems.length) {
    const lines = problems.map(({ path, message }) => `  ${path}: ${message}`);
    throw new Error(`${file} has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
  }
  return normalize(data);
}
