import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { renderMarkdown, toScenes } from "../src/cli.mjs";
import { commentBody } from "../src/comment.mjs";
import { checkStates, describeStep, keyEvents, normalizeName, readStates, ROLES, sameName } from "../src/states.mjs";
import { TEXTS, stopLine } from "../src/texts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(HERE, "..", "schema", "states.schema.json"), "utf8"));
const EXAMPLE = JSON.parse(readFileSync(join(HERE, "site", "states", "example.states.json"), "utf8"));
const ENV = { CHANGEREEL_USER: "someone@example.com", CHANGEREEL_PASSWORD: "hunter2" };
const validate = new Ajv2020({ allErrors: true }).compile(SCHEMA);

const dir = mkdtempSync(join(tmpdir(), "changereel-states-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
/** Writes a file to read back with readStates; a string is written as it is. */
function write(content) {
  const path = join(dir, `${++files}.states.json`);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return path;
}

const waitFor = (name = "Checkout") => ({ action: "waitFor", target: { role: "dialog", name } });
const click = (target = { role: "button", name: "Checkout" }) => ({ action: "click", target });
/** A right file of one state, with other steps or more fields at the top. */
function one(steps = [click(), waitFor()], top = {}) {
  return { schemaVersion: 1, states: [{ name: "Checkout dialog", route: "/cart", steps }], ...top };
}

const VALID = {
  "the example of the documentation": EXAMPLE,
  "the example of the README": { ...EXAMPLE, states: EXAMPLE.states.slice(0, 1) },
  "setup only, with no states": { schemaVersion: 1, setup: EXAMPLE.setup, states: [] },
  "setup only, without states": { schemaVersion: 1, setup: EXAMPLE.setup },
  "every kind of step and target": {
    schemaVersion: 1,
    timeout: 5000,
    testIdAttribute: "data-test",
    states: [
      {
        name: "Search",
        route: "/search?q=1",
        ignore: [".ad", "#clock"],
        steps: [
          { action: "fill", target: { label: "Search" }, value: "shoes", timeout: 200 },
          { action: "fill", target: { testId: "note" }, value: "" },
          { action: "press", key: "Enter", target: { label: "Search" } },
          { action: "press", key: "Shift++" },
          { action: "press", key: "Control+Shift+ArrowDown" },
          { action: "click", target: { css: ".result a", nth: 1 } },
          { action: "navigate", path: "/search/2" },
          { action: "click", target: { role: "link", nth: 0 } },
          { action: "waitFor", target: { role: "progressbar" }, state: "hidden", timeout: 120000 },
        ],
      },
    ],
  },
};

/*
 * One wrong file per rule. `schema` names the rule when the JSON Schema cannot say it and so
 * accepts the file; there are exactly the three below, and the parity test holds the schema to
 * every other case.
 */
const SCHEMA_CANNOT = {
  env: "an environment variable has to be set: the schema sees the file only",
  unique: "names unique without regard to case: JSON Schema compares exactly",
  last: "the last step a waitFor: JSON Schema cannot name the last item of a list",
};
const INVALID = {
  "a step without action": [one([{ target: { role: "button" } }, waitFor()]), ["states[0].steps[0]", "needs action"]],
  "an unknown action": [one([{ action: "clik", target: { role: "button" } }, waitFor()]), ["states[0].steps[0].action", '"clik" is not an action; did you mean "click"?']],
  "an unknown field at the top": [one(undefined, { colour: "red" }), ["colour", "unknown field"]],
  "a misspelt field at the top": [{ ...one(), timout: 5 }, ["timout", 'unknown field; did you mean "timeout"?']],
  "an unknown field in a state": [
    { schemaVersion: 1, states: [{ name: "A", route: "/", steps: [waitFor()], stpes: [] }] },
    ["states[0].stpes", 'unknown field; did you mean "steps"?'],
  ],
  "an unknown field in a step": [one([{ ...click(), wait: 1 }, waitFor()]), ["states[0].steps[0].wait", "unknown field"]],
  "a field of another kind of step": [one([{ ...click(), key: "Enter" }, waitFor()]), ["states[0].steps[0].key", "click takes no key"]],
  "an unknown field in a target": [one([click({ role: "button", text: "Save" }), waitFor()]), ["states[0].steps[0].target.text", "unknown field"]],
  "an unknown field in valueFrom": [
    one([{ action: "fill", target: { label: "Email" }, valueFrom: { env: "CHANGEREEL_USER", default: "x" } }, waitFor()]),
    ["states[0].steps[0].valueFrom.default", "unknown field"],
  ],
  "a target with two ways of finding": [
    one([click(), { action: "waitFor", target: { role: "dialog", css: ".dialog" } }]),
    ["states[0].steps[1].target", "needs one of role, label, testId, css; has role and css"],
  ],
  "a target with three ways of finding": [
    one([click({ label: "A", testId: "a", css: "a" }), waitFor()]),
    ["states[0].steps[0].target", "needs one of role, label, testId, css; has label, testId and css"],
  ],
  "a target with none": [one([click({}), waitFor()]), ["states[0].steps[0].target", "needs one of role, label, testId, css; has none"]],
  "a name without a role": [
    one([click({ label: "Email", name: "Email" }), waitFor()]),
    ["states[0].steps[0].target.name", "goes only with role"],
  ],
  "nth negative": [one([click({ role: "button", nth: -1 }), waitFor()]), ["states[0].steps[0].target.nth", "must be a whole number, 0 or more"]],
  "nth not whole": [one([click({ role: "button", nth: 0.5 }), waitFor()]), ["states[0].steps[0].target.nth", "must be a whole number, 0 or more"]],
  "value and valueFrom together": [
    one([{ action: "fill", target: { label: "Email" }, value: "a", valueFrom: { env: "CHANGEREEL_USER" } }, waitFor()]),
    ["states[0].steps[0]", "needs value or valueFrom, not both"],
  ],
  "fill with neither": [one([{ action: "fill", target: { label: "Email" } }, waitFor()]), ["states[0].steps[0]", "needs value or valueFrom"]],
  "a variable name that is none": [
    one([{ action: "fill", target: { label: "Email" }, valueFrom: { env: "1PASSWORD" } }, waitFor()]),
    ["states[0].steps[0].valueFrom.env", "must be the name of an environment variable, such as CHANGEREEL_PASSWORD"],
  ],
  "a state not ending with waitFor": [one([waitFor(), click()]), ["states[0].steps", "must end with waitFor; ends with click"], "last"],
  "setup not ending with waitFor": [
    { ...EXAMPLE, setup: EXAMPLE.setup.slice(0, 4) },
    ["setup", "must end with waitFor; ends with press"],
    "last",
  ],
  "empty steps": [one([]), ["states[0].steps", "needs at least one step"]],
  "empty setup": [{ ...one(), setup: [] }, ["setup", "needs at least one step"]],
  "names differing only in case": [
    { schemaVersion: 1, states: [one().states[0], { ...one().states[0], name: "checkout  Dialog" }] },
    ["states[1].name", '"checkout  Dialog" is the name of states[0] already (names are compared without case)'],
    "unique",
  ],
  "a name too long": [{ schemaVersion: 1, states: [{ ...one().states[0], name: "x".repeat(81) }] }, ["states[0].name", "must be a text of 1 to 80 characters"]],
  "a state without route and steps": [{ schemaVersion: 1, states: [{ name: "A" }] }, ["states[0]", "needs route and steps"]],
  "a route with a host": [
    { schemaVersion: 1, states: [{ ...one().states[0], route: "https://shop.example/cart?x=1" }] },
    ["states[0].route", '"https://shop.example/cart?x=1" names a host; give the path only, such as /cart?x=1'],
  ],
  "a route with a host after two slashes": [
    { schemaVersion: 1, states: [{ ...one().states[0], route: "//shop.example/cart" }] },
    ["states[0].route", '"//shop.example/cart" names a host; give the path only, such as /cart'],
  ],
  "a path with a host after a backslash": [
    one([{ action: "navigate", path: "/\\shop.example" }, waitFor()]),
    ["states[0].steps[0].path", '"/\\\\shop.example" names a host; give the path only, such as /'],
  ],
  "a route without its slash": [{ schemaVersion: 1, states: [{ ...one().states[0], route: "cart" }] }, ["states[0].route", '"cart" must start with /']],
  "an unknown role": [one([click({ role: "buton", name: "Save" }), waitFor()]), ["states[0].steps[0].target.role", '"buton" is not a role; did you mean "button"?']],
  "a misspelt key": [one([{ action: "press", key: "Entr" }, waitFor()]), ["states[0].steps[0].key", '"Entr" is not a key; did you mean "Enter"?']],
  "a key with a misspelt modifier": [one([{ action: "press", key: "Ctrl+a" }, waitFor()]), ["states[0].steps[0].key", '"Ctrl+a" is not a key; did you mean "Control+a"?']],
  "a key that is no key": [
    one([{ action: "press", key: "ß" }, waitFor()]),
    ["states[0].steps[0].key", '"ß" is not a key; use a key such as Enter, Tab or a, with Shift+, Control+, Alt+ or Meta+ before it'],
  ],
  "a modifier alone": [
    one([{ action: "press", key: "Shift" }, waitFor()]),
    ["states[0].steps[0].key", '"Shift" is not a key; use a key such as Enter, Tab or a, with Shift+, Control+, Alt+ or Meta+ before it'],
  ],
  "an unknown waitFor state": [one([click(), { ...waitFor(), state: "gone" }]), ["states[0].steps[1].state", "must be visible or hidden"]],
  "schemaVersion 2": [
    { schemaVersion: 2, states: [{ name: "A", route: "/", steps: [{ action: "hover" }] }], later: true },
    ["schemaVersion", "is 2, newer than this changereel reads (1); update changereel"],
  ],
  "schemaVersion missing": [{ states: one().states }, ["top level", "needs schemaVersion"]],
  "timeout 0": [one(undefined, { timeout: 0 }), ["timeout", "must be a whole number of milliseconds from 1 to 120000"]],
  "a step timeout too long": [one([click(), { ...waitFor(), timeout: 120001 }]), ["states[0].steps[1].timeout", "must be a whole number of milliseconds from 1 to 120000"]],
  "a bad testIdAttribute": [one(undefined, { testIdAttribute: "data test" }), ["testIdAttribute", "must be an attribute name such as data-testid"]],
  "an empty ignore selector": [{ schemaVersion: 1, states: [{ ...one().states[0], ignore: [".ad", ""] }] }, ["states[0].ignore[1]", "must be a CSS selector, not empty"]],
  "neither states nor setup": [{ schemaVersion: 1 }, ["top level", "needs states, or setup"]],
  "no states and no setup": [{ schemaVersion: 1, states: [] }, ["states", "needs at least one state, or setup next to it"]],
  "a file that is a list": [[one()], ["top level", "must be an object with schemaVersion and states"]],
  "a variable not set": [
    { ...EXAMPLE, setup: EXAMPLE.setup.map((step) => (step.valueFrom ? { ...step, valueFrom: { env: "CHANGEREEL_NOT_SET" } } : step)) },
    ["setup[1].valueFrom.env", "CHANGEREEL_NOT_SET is not set"],
    ["setup[2].valueFrom.env", "CHANGEREEL_NOT_SET is not set"],
    "env",
  ],
};

describe("states file", () => {
  for (const [name, file] of Object.entries(VALID)) {
    test(`right: ${name}`, () => {
      assert.deepEqual(checkStates(file, ENV), []);
      assert.ok(validate(file), JSON.stringify(validate.errors));
    });
  }

  for (const [name, [file, ...rest]] of Object.entries(INVALID)) {
    test(`wrong: ${name}`, () => {
      const known = typeof rest.at(-1) === "string" ? rest.pop() : undefined;
      const problems = checkStates(file, ENV).map(({ path, message }) => [path, message]);
      assert.deepEqual(problems, rest);
      // The schema agrees, except where it cannot say the rule
      if (known) {
        assert.ok(SCHEMA_CANNOT[known], `${known} is not a known difference`);
        assert.ok(validate(file), `the schema now finds what it could not: ${known}`);
      } else assert.equal(validate(file), false, "the schema accepts a file changereel refuses");
    });
  }

  test("several problems are all reported, in the order of the file, the environment last", () => {
    const file = {
      schemaVersion: 1,
      setup: [
        { action: "navigate", path: "/login" },
        { action: "fill", target: { label: "Email" }, valueFrom: { env: "CHANGEREEL_USER" } },
        { action: "fill", target: { label: "Password" }, valueFrom: { env: "CHANGEREEL_NOT_SET" } },
        { action: "press", key: "Enter" },
        { action: "waitFor", target: { role: "button", name: "Log out" } },
      ],
      states: [
        { name: "A", route: "/a", steps: [click(), { action: "waitFor", target: { role: "dialog", css: ".x" } }] },
        { name: "B", route: "/b", steps: [waitFor(), click()] },
      ],
    };
    const path = write(file);
    assert.throws(() => readStates(path, ENV), {
      message: [
        `${path} has 3 problems:`,
        "  states[0].steps[1].target: needs one of role, label, testId, css; has role and css",
        "  states[1].steps: must end with waitFor; ends with click",
        "  setup[2].valueFrom.env: CHANGEREEL_NOT_SET is not set",
      ].join("\n"),
    });
    // Within the file, problems come as the file is written: setup before states when it is first
    const mixed = { schemaVersion: 1, setup: [click({ role: "buton" }), waitFor()], timeout: 0, states: [{ name: "A", route: "a", steps: [{ action: "fill", target: {} }] }] };
    assert.deepEqual(
      checkStates(mixed, ENV).map(({ path }) => path),
      ["setup[0].target.role", "timeout", "states[0].route", "states[0].steps", "states[0].steps[0]", "states[0].steps[0].target"],
    );
  });

  test("one problem is one problem", () => {
    const path = write(one([click()]));
    assert.throws(() => readStates(path, ENV), { message: `${path} has 1 problem:\n  states[0].steps: must end with waitFor; ends with click` });
  });

  test("a file that is not JSON is named with line and column", () => {
    // The reason is V8's and its words may change between versions of Node; where it is, is ours
    const where = (path, line, column) => ({ message: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not JSON: line ${line}, column ${column}: \\S`) });
    const comma = write('{\n  "schemaVersion": 1\n  "states": []\n}');
    assert.throws(() => readStates(comma, ENV), where(comma, 3, 3));
    // A message without a position, and one that quotes the text, which is left out
    const token = write('{\n  "schemaVersion": 1,\n  "states": x }');
    assert.throws(() => readStates(token, ENV), where(token, 3, 13));
    assert.throws(() => readStates(token, ENV), (err) => !err.message.includes('"states"'));
    const cut = write('{ "schemaVersion": 1');
    assert.throws(() => readStates(cut, ENV), where(cut, 1, 21));
    const empty = write("");
    assert.throws(() => readStates(empty, ENV), where(empty, 1, 1));
    const missing = join(dir, "missing.json");
    assert.throws(() => readStates(missing, ENV), { message: `${missing} cannot be read: there is no such file` });
  });

  test("a variable that is empty is named, and no value of one is ever shown", () => {
    const secret = "Zq9-distinctive-s3cret";
    const file = {
      schemaVersion: 1,
      setup: [
        { action: "fill", target: { label: "Password" }, valueFrom: { env: "CHANGEREEL_PASSWORD" } },
        { action: "fill", target: { label: "Token" }, valueFrom: { env: "CHANGEREEL_TOKEN" } },
        { action: "press", key: "Entr", target: { label: "Password" } },
        waitFor(),
      ],
      states: [],
    };
    const env = { CHANGEREEL_PASSWORD: secret, CHANGEREEL_TOKEN: "" };
    const path = write(file);
    let message = "";
    try {
      readStates(path, env);
    } catch (err) {
      message = err.message;
    }
    assert.match(message, /setup\[1\]\.valueFrom\.env: CHANGEREEL_TOKEN is empty/);
    assert.match(message, /setup\[2\]\.key: "Entr" is not a key/);
    assert.ok(!message.includes(secret));
    // Right, the file read and its steps described still carry only the name
    file.setup.splice(1, 2);
    const read = readStates(write(file), env);
    const said = [JSON.stringify(read), ...read.setup.map(describeStep)].join("\n");
    assert.ok(!said.includes(secret));
    assert.equal(describeStep(read.setup[0]), 'fill label "Password" from $CHANGEREEL_PASSWORD');
  });

  test("the file read has its defaults filled in", () => {
    const read = readStates(write(one([click(), waitFor()], { timeout: 3000 })), ENV);
    assert.deepEqual(read, {
      schemaVersion: 1,
      timeout: 3000,
      testIdAttribute: "data-testid",
      setup: [],
      states: [
        {
          name: "Checkout dialog",
          route: "/cart",
          ignore: [],
          steps: [
            { ...click(), timeout: 3000 },
            { ...waitFor(), timeout: 3000, state: "visible" },
          ],
        },
      ],
    });
    const example = readStates(write(EXAMPLE), ENV);
    assert.equal(example.timeout, 10000);
    assert.equal(example.setup[0].timeout, 10000);
    assert.equal(example.$schema, undefined);
  });

  test("the roles are those of the schema", () => {
    assert.deepEqual(ROLES, SCHEMA.$defs.role.enum);
  });
});

describe("steps", () => {
  test("described as they are written", () => {
    const cases = [
      [{ action: "navigate", path: "/cart" }, "navigate /cart"],
      [click(), 'click button "Checkout"'],
      [click({ role: "button" }), "click button"],
      [click({ label: "Email" }), 'click label "Email"'],
      [click({ testId: "save" }), 'click testId "save"'],
      [click({ css: ".x", nth: 1 }), 'click css ".x" (nth 1)'],
      [click({ role: "button", name: "Save", nth: 0 }), 'click button "Save" (nth 0)'],
      [{ action: "fill", target: { label: "Password" }, valueFrom: { env: "CHANGEREEL_PASSWORD" } }, 'fill label "Password" from $CHANGEREEL_PASSWORD'],
      [{ action: "fill", target: { role: "textbox", name: "Password" }, valueFrom: { env: "CHANGEREEL_PASSWORD" } }, 'fill textbox "Password" from $CHANGEREEL_PASSWORD'],
      [{ action: "fill", target: { label: "Search" }, value: "shoes" }, 'fill label "Search" with "shoes"'],
      [{ action: "press", key: "Enter" }, "press Enter"],
      [{ action: "press", key: "Enter", target: { label: "Search" } }, 'press Enter in label "Search"'],
      [waitFor(), 'waitFor dialog "Checkout"'],
      [{ ...waitFor(), state: "visible" }, 'waitFor dialog "Checkout"'],
      [{ ...waitFor(), state: "hidden" }, 'waitFor dialog "Checkout" hidden'],
    ];
    for (const [step, said] of cases) assert.equal(describeStep(step), said);
  });

  test("keys become the events of a keyboard", () => {
    assert.deepEqual(keyEvents("Enter"), { modifiers: 0, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", held: [] });
    assert.deepEqual(keyEvents("Shift+Tab"), {
      modifiers: 8,
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
      held: [{ key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 }],
    });
    assert.deepEqual(keyEvents("a"), { modifiers: 0, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a", held: [] });
    // A shortcut types nothing
    assert.deepEqual(keyEvents("Control+a"), {
      modifiers: 2,
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      held: [{ key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 }],
    });
    assert.deepEqual(keyEvents("Space"), { modifiers: 0, key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " ", held: [] });
    assert.equal(keyEvents("Shift+a").text, "A");
    assert.deepEqual([keyEvents("/").code, keyEvents("?").code, keyEvents("7").code], ["Slash", "Slash", "Digit7"]);
    assert.equal(keyEvents("Alt+Meta+Control+Shift+End").modifiers, 15);
    assert.throws(() => keyEvents("Shift"), { message: '"Shift" is not a key' });
  });

  test("names are compared with whitespace and line breaks made one space, with case", () => {
    assert.equal(normalizeName("  Log\n\t  out  "), "Log out");
    assert.ok(sameName("Log out", " Log\n out "));
    assert.ok(sameName("Check out", "Check out"));
    assert.ok(!sameName("Log out", "log out"));
    assert.ok(!sameName("Logout", "Log out"));
  });
});

describe("states in the summary, the comment and the scenes", () => {
  const view = { before: "b.png", after: "a.png", width: 1280, beforeHeight: 800, afterHeight: 800 };
  const header = () => ({ type: "changed", layer: "page", beforeY: 30, beforeH: 10, afterY: 30, afterH: 10, box: { x: 300, y: 0, width: 60, height: 10 }, view });
  const lower = (y) => ({ type: "changed", layer: "page", beforeY: y, beforeH: 10, afterY: y, afterH: 10, box: null, view });
  const whole = (type, stopped) => ({ type, page: true, beforeY: 0, beforeH: 800, afterY: 0, afterH: 800, box: null, view, stopped });
  const unreached = whole("unreached", { side: "after", step: 0, path: "states[1].steps[0]", does: 'click button "Checkout"', reason: "not found" });
  const reached = whole("reached", { side: "before", step: 0, path: "states[2].steps[0]", does: 'click button "Export"', reason: "not found" });
  const gone = whole("unreached", { side: "after", step: null, path: "states[3].route", does: "load /old", reason: "HTTP 404" });
  const dialog = { name: "Checkout dialog", steps: 2 };
  // 12 routes and 2 states were compared; /cart and its dialog have the new link in the header
  const pages = [
    { route: "/cart", changes: [header()] },
    { route: "/cart", state: dialog, changes: [header(), lower(400)] },
    { route: "/settings", state: { name: "Billing tab", steps: 2 }, changes: [unreached] },
    ...Array.from({ length: 11 }, (_, i) => ({ route: `/p${i}`, changes: [] })),
  ];
  const problems = [{ name: "Gift wrap", route: "/cart", before: 'step 1 (click button "Wrap as a gift"): not found', after: null }];
  const setup = {
    route: "/login",
    setup: true,
    changes: [whole("unreached", { side: "after", step: 1, path: "setup[1]", does: 'fill textbox "Password" from $CHANGEREEL_PASSWORD', reason: "not found" })],
  };

  test("a state is named with its route, its kinds of change are said, and the heading counts states apart", () => {
    const markdown = renderMarkdown(pages, 14);
    assert.match(markdown, /^## 4 visible changes on 1 of 12 pages and 2 of 2 states\n/);
    assert.match(markdown, /\| `\/cart` \| Changed \| 10 px at 30 px \|/);
    assert.match(markdown, /\| `\/cart` › Checkout dialog \| Changed \| 10 px at 400 px \|/);
    assert.match(markdown, /\| `\/settings` › Billing tab \| Can no longer be reached \(step 1: click button “Checkout”, not found\) \| the whole page \|/);
    const more = renderMarkdown([{ route: "/new", state: { name: "Export panel", steps: 2 }, changes: [reached] }, { route: "/old", state: { name: "Old", steps: 1 }, changes: [gone] }], 2);
    assert.match(more, /\| `\/new` › Export panel \| Can be reached now \| the whole page \|/);
    assert.match(more, /\| `\/old` › Old \| Can no longer be reached \(the page is not there\) \|/);
    assert.match(more, /^## 2 visible changes on 0 of 0 pages and 2 of 2 states/);
    // Without states the heading is what it always was
    assert.match(renderMarkdown([{ route: "/", changes: [lower(10)] }, { route: "/a", changes: [] }], 2), /^## 1 visible change on 1 of 2 pages\n/);

    const body = commentBody({ pages: pages.filter((page) => page.changes.length), checked: 14, checkedStates: 2 });
    assert.match(body, /### 4 visible changes on 1 of 12 pages and 2 of 2 states/);
    assert.match(body, /\| `\/cart` › Checkout dialog \| Changed \|/);
    assert.match(body, /\| `\/settings` › Billing tab \| Can no longer be reached \(step 1: click button “Checkout”, not found\) \|/);
    assert.doesNotMatch(body, /reached \(.*\) page/);
    assert.match(commentBody({ pages: [], checked: 14, checkedStates: 1 }), /### No visible change on 13 pages and 1 state\n/);
    assert.match(commentBody({ pages: [], checked: 14 }), /### No visible change on 14 pages\n/);
  });

  test("the comment names a state the same way in the rows of the video's scenes", () => {
    const scenes = toScenes(pages.filter((page) => page.changes.length), { perRoute: 2, maxScenes: 8 });
    const body = commentBody({ pages: pages.filter((page) => page.changes.length), checked: 14, checkedStates: 2, scenes });
    assert.match(body, /\| 1 \| `\/cart` and 1 more \| Changed \|/);
    assert.match(body, /\| 2 \| `\/cart` › Checkout dialog \| Changed \|/);
    assert.match(body, /\| 3 \| `\/settings` › Billing tab \| Can no longer be reached \(step 1: click button “Checkout”, not found\) \|/);
  });

  test("states that could not be compared are listed under the table, also when nothing changed", () => {
    const markdown = renderMarkdown(pages, 14, { problems });
    assert.match(markdown, /\*\*Not compared\*\*\n\n- `\/cart` › Gift wrap: before: step 1 \(click button “Wrap as a gift”\): not found\n/);
    assert.ok(markdown.indexOf("Not compared") > markdown.indexOf("| Page"));
    assert.match(renderMarkdown([{ route: "/", changes: [] }], 1, { problems }), /No page looks different\.\n\*\*Not compared\*\*/);
    const body = commentBody({ pages: [], checked: 3, checkedStates: 1, problems });
    assert.match(body, /Every page looks as it did before\.\n\n\*\*Not compared\*\*\n\n- `\/cart` › Gift wrap: before: step 1/);
    assert.doesNotMatch(renderMarkdown(pages, 14), /Not compared/);
  });

  test("a login that stopped on one side replaces the table with one line", () => {
    const markdown = renderMarkdown([setup], 1);
    assert.equal(
      markdown,
      "## The login no longer gets through\n\nThe login stopped on the version after, at step 2: fill textbox “Password” from $CHANGEREEL_PASSWORD, not found. " +
        "It gets through on the version before. Nothing else was compared: every page would differ only by the login.\n",
    );
    const body = commentBody({ pages: [setup], checked: 1, scenes: toScenes([setup], { perRoute: 2, maxScenes: 8 }) });
    assert.match(body, /### The login no longer gets through\n/);
    assert.match(body, /The login stopped on the version after, at step 2/);
    assert.doesNotMatch(body, /\| Page/);
    const back = { ...setup, changes: [{ ...setup.changes[0], type: "reached", stopped: { ...setup.changes[0].stopped, side: "before" } }] };
    assert.match(renderMarkdown([back], 1), /## The login gets through only now\n\nThe login stopped on the version before, at step 2.*It gets through on the version after\./);
  });

  test("a state is a page of its own for the scenes: one scene over a page and a state, and its own share", () => {
    const scenes = toScenes(pages.filter((page) => page.changes.length), { perRoute: 2, maxScenes: 8 });
    assert.deepEqual(
      scenes.map((scene) => [scene.route, scene.state, scene.type, scene.routes]),
      [
        ["/cart", undefined, "changed", 2],
        ["/cart", "Checkout dialog", "changed", 1],
        ["/settings", "Billing tab", "unreached", 1],
      ],
    );
    assert.deepEqual(scenes[2].stopped, unreached.stopped);
    assert.equal(scenes[2].steps, 2);
    assert.equal(scenes[2].page, true);
    assert.equal("id" in scenes[0] || "seen" in scenes[0], false);
    // --per-route holds for the dialog apart from its route: two of each, not two of both
    const many = (state, at) => ({ route: "/cart", ...(state && { state: dialog }), changes: [lower(at), lower(at + 200), lower(at + 400)] });
    const held = toScenes([many(false, 100), many(true, 150)], { perRoute: 2, maxScenes: 4 });
    assert.deepEqual(held.map((scene) => [scene.state ?? "", scene.afterY]), [["", 100], ["", 300], ["Checkout dialog", 150], ["Checkout dialog", 350]]);
    // The login that stopped is the first scene
    const [first] = toScenes([{ route: "/", changes: [lower(10)] }, setup], { perRoute: 2, maxScenes: 8 });
    assert.equal(first.setup, true);
  });

  test("the line under a scene says which step stopped, in English and German", () => {
    const scene = { type: "unreached", page: true, state: "Checkout dialog", steps: 2, stopped: unreached.stopped };
    assert.equal(stopLine(scene, TEXTS.en), "Step 1 of 2 stopped: click button “Checkout”, not found");
    assert.equal(stopLine(scene, TEXTS.de), "Schritt 1 von 2 gescheitert: click button „Checkout“, nicht gefunden");
    assert.equal(stopLine({ ...scene, stopped: gone.stopped }, TEXTS.en), "The page is not there: HTTP 404");
    const now = { ...scene, type: "reached", stopped: reached.stopped };
    assert.equal(stopLine(now, TEXTS.en), "Before, step 1 of 2 stopped: click button “Export”, not found");
    assert.equal(stopLine(now, TEXTS.de), "Vorher scheiterte Schritt 1 von 2: click button „Export“, nicht gefunden");
    const login = { type: "unreached", page: true, setup: true, stopped: setup.changes[0].stopped };
    assert.equal(stopLine(login, TEXTS.en), "The login stopped on the version after: step 2, fill textbox “Password” from $CHANGEREEL_PASSWORD, not found");
    assert.equal(stopLine(login, TEXTS.de), "Die Anmeldung brach in der neuen Version ab: Schritt 2, fill textbox „Password“ from $CHANGEREEL_PASSWORD, nicht gefunden");
    assert.equal(stopLine({ type: "changed" }, TEXTS.en), null);
    // Every language has every word
    for (const texts of Object.values(TEXTS)) assert.deepEqual(Object.keys(texts).sort(), Object.keys(TEXTS.en).sort());
  });
});
