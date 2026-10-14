import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { PNG } from "pngjs";
import { parseArgs } from "../src/cli.mjs";
import { cut, describe as describeScene, estimateWords, excerpts, pythonOf, spoken, isEmpty, narrate, plain, question, tidy, wavSeconds } from "../src/narrate.mjs";

/** A scene on a page of 400 by 2000 pixels with both pictures on disk. */
function sample(change = {}) {
  const out = mkdtempSync(join(tmpdir(), "changereel-narrate-"));
  mkdirSync(join(out, "shots"));
  const png = new PNG({ width: 400, height: 2000 });
  png.data.fill(255);
  for (const which of ["before", "after"]) writeFileSync(join(out, "shots", `index-${which}.png`), PNG.sync.write(png));
  const scene = {
    route: "/",
    routes: 1,
    type: "changed",
    before: "shots/index-before.png",
    after: "shots/index-after.png",
    pageWidth: 400,
    beforeY: 500,
    beforeH: 40,
    afterY: 500,
    afterH: 40,
    box: { x: 300, y: 10, width: 60, height: 20 },
    ...change,
  };
  return { out, scene };
}

/** A WAV header for one second of 16 bit mono at 22050 Hz, with `bytes` of sound after it. */
function wav(bytes, written = bytes) {
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write("RIFF", 0, "latin1");
  buffer.write("WAVEfmt ", 8, "latin1");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt32LE(44100, 28);
  buffer.write("data", 36, "latin1");
  buffer.writeUInt32LE(written, 40);
  return buffer;
}

describe("narrate", () => {
  test("the plain sentence says what kind of change and where", () => {
    assert.equal(plain({ type: "added", route: "/", routes: 1 }), "A part of the page was added on the home page.");
    assert.equal(plain({ type: "changed", route: "/pricing", routes: 1 }), "A part of the page changed on /pricing.");
    assert.equal(plain({ type: "removed", route: "/", routes: 4 }), "A part of the page was removed on 4 pages.");
    assert.equal(plain({ type: "added", route: "/contact", routes: 1, page: true }), "The page /contact was added.");
  });

  test("the plain sentence and the question follow the language", () => {
    assert.equal(plain({ type: "changed", route: "/", routes: 1 }, "de"), "Auf der Startseite hat sich ein Teil der Seite geändert.");
    assert.equal(plain({ type: "added", route: "/", routes: 3 }, "de"), "Auf 3 Seiten ist ein Teil der Seite neu.");
    assert.equal(plain({ type: "added", route: "/kontakt", routes: 1, page: true }, "de"), "Die Seite /kontakt ist neu.");
    assert.equal(plain({ type: "removed", route: "/", routes: 3 }, "xx"), "A part of the page was removed on 3 pages.");
    const german = question({}, { before: null, after: {} }, undefined, "de");
    assert.match(german, /Say that it was added\. Write the sentence in German\.$/);
    assert.doesNotMatch(german, /End the sentence/);
    assert.equal(question({}, { before: null, after: {} }, undefined, "xx"), question({}, { before: null, after: {} }));
  });

  test("the voice gets prices, units, badges and middle dots as they are said", () => {
    assert.equal(spoken('A "NEW" badge priced €18 · 250 g was added.'), 'A "New" badge priced 18 euros, 250 grams was added.');
    assert.equal(spoken("Plans priced €16 to €54, up 10% from $9.99."), "Plans priced 16 euros to 54 euros, up 10 percent from 9.99 dollars.");
    // Letters that are a name stay letters, and a word in capitals outside quotes stays
    assert.equal(spoken('The "AI" link and the CSS changed.'), 'The "AI" link and the CSS changed.');
  });

  test("the python of a piper command is read from its first line, also behind env", () => {
    const dir = mkdtempSync(join(tmpdir(), "changereel-piper-"));
    writeFileSync(join(dir, "direct"), "#!/opt/venv/bin/python3\nimport piper\n");
    writeFileSync(join(dir, "viaenv"), "#!/usr/bin/env python3\nimport piper\n");
    writeFileSync(join(dir, "binary"), "ELF\0\0");
    assert.equal(pythonOf(join(dir, "direct")), "/opt/venv/bin/python3");
    assert.equal(pythonOf(join(dir, "viaenv")), "python3");
    assert.equal(pythonOf(join(dir, "binary")), null);
  });

  test("an answer is cut down to its first sentence", () => {
    assert.equal(tidy('"The button text changed from **Buy** to Order now." It is also blue.'), "The button text changed from Buy to Order now.");
    assert.equal(tidy("<think>hm</think>\nAnswer: A price went up"), "A price went up.");
    assert.equal(tidy('A section with the heading "AI in Vienna." was added.'), 'A section with the heading "AI in Vienna." was added.');
    assert.equal(tidy('The text changed from "I build..." to "I check...". More.'), 'The text changed from "I build..." to "I check...".');
    assert.equal(tidy('A heading "AI in Vienna. Made to measure" was added. Fine.'), 'A heading "AI in Vienna. Made to measure" was added.');
    assert.equal(tidy(""), "");
    assert.ok(tidy("word ".repeat(80)).length <= 160);
    assert.ok(tidy("word ".repeat(80)).endsWith("…"));
  });

  test("a changed spot is shown with little around it, a new band at full width", () => {
    const { scene } = sample();
    assert.deepEqual(excerpts(scene).after, { x: 172, y: 478, width: 316, height: 84 });
    assert.deepEqual(excerpts(scene).before, { x: 172, y: 478, width: 316, height: 84 });
    const added = excerpts({ ...scene, type: "added", box: null, beforeH: 0, afterH: 3000 });
    assert.equal(added.before, null);
    assert.deepEqual(added.after, { x: 0, y: 468, width: 400, height: 900 });
    const grown = excerpts({ ...scene, box: null, beforeH: 40, afterH: 400 });
    assert.equal(grown.before, null);
    assert.equal(grown.after.height, 464);
    assert.equal(excerpts({ ...scene, box: null, beforeH: 40, afterH: 400 }, { oneSided: false }).before.height, 104);
    const shrunk = excerpts({ ...scene, box: null, beforeH: 400, afterH: 40 });
    assert.equal(shrunk.after, null);
    const rewritten = excerpts({ ...scene, box: null, beforeH: 160, afterH: 128 });
    assert.deepEqual([rewritten.before.height, rewritten.after.height], [224, 192]);
  });

  test("a cut stays inside the picture", () => {
    const png = new PNG({ width: 400, height: 2000 });
    const piece = PNG.sync.read(cut(png, { x: 60, y: 1900, width: 540, height: 260 }));
    assert.deepEqual([piece.width, piece.height], [340, 100]);
  });

  test("the question fits the pictures there are", () => {
    assert.match(question({}, { before: {}, after: {} }), /before a change/);
    assert.match(question({}, { before: null, after: {} }), /was added/);
    assert.match(question({}, { before: {}, after: null }), /was removed/);
    assert.match(question({ type: "changed" }, { before: null, after: {} }), /grew/);
    assert.match(question({ type: "added", page: true }, { before: null, after: {} }), /top of a page that was added to/);
    assert.match(question({ type: "removed", page: true }, { before: {}, after: null }), /removed from/);
    assert.match(question({ type: "changed" }, { before: {}, after: null }), /shortened/);
    assert.match(question({ type: "changed", beforeH: 40, afterH: 400 }, { before: {}, after: {} }), /second picture shows more: something was added/);
    assert.match(question({ type: "changed", beforeH: 400, afterH: 40 }, { before: {}, after: {} }), /first picture shows more: something was removed/);
    assert.match(question({}, { before: {}, after: {} }, "before"), /second picture is missing in the other one: it was added/);
    assert.match(question({}, { before: {}, after: {} }, "after"), /first picture is missing in the other one: it was removed/);
  });

  test("a spot of one colour is empty", () => {
    const png = new PNG({ width: 40, height: 40 });
    png.data.fill(255);
    assert.equal(isEmpty(png, { x: 10, y: 10, width: 20, height: 20 }), true);
    png.data.writeUInt32BE(0x000000ff, (15 * 40 + 15) * 4);
    assert.equal(isEmpty(png, { x: 10, y: 10, width: 20, height: 20 }), false);
    assert.equal(isEmpty(png, { x: 20, y: 20, width: 100, height: 100 }), true);
  });

  test("the model gets both excerpts and its answer is tidied", async () => {
    const { out, scene } = sample();
    let sent;
    const fetch = async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ message: { content: "The price changed from 19 to 24 euros. Nice." } }) };
    };
    const text = await describeScene(scene, out, { model: "m", host: "http://localhost:1/", fetch });
    assert.equal(text, "The price changed from 19 to 24 euros.");
    assert.equal(sent.url, "http://localhost:1/api/chat");
    assert.equal(sent.body.messages[0].images.length, 2);
    assert.equal(PNG.sync.read(Buffer.from(sent.body.messages[0].images[1], "base64")).height, 84);
  });

  test("a model of Anthropic gets the excerpts as pictures, and a fallback where there is one", async () => {
    const { out, scene } = sample();
    const sent = [];
    const anthropic = {
      beta: {
        messages: {
          create: async (body) => {
            sent.push(body);
            return { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "The price went up. Really." }] };
          },
        },
      },
    };
    assert.equal(await describeScene(scene, out, { model: "claude-opus-5-5", anthropic }), "The price went up.");
    assert.deepEqual(sent[0].messages[0].content.map((block) => block.type), ["image", "image", "text"]);
    assert.equal(sent[0].fallbacks, "default");
    await describeScene(scene, out, { model: "claude-haiku-5-5", anthropic });
    assert.equal("fallbacks" in sent[1], false);
    anthropic.beta.messages.create = async () => ({ stop_reason: "refusal", content: [] });
    await assert.rejects(describeScene(scene, out, { model: "claude-opus-5-5", anthropic }), /declined/);
  });

  test("a scene keeps the plain sentence when the model does not answer", async () => {
    const { out, scene } = sample();
    const lines = [];
    const fetch = async () => ({ ok: false, status: 404, text: async () => "model not found" });
    await narrate([scene], out, { model: "m", host: "http://localhost:1", fetch }, (line) => lines.push(line));
    assert.equal(scene.text, "A part of the page changed on the home page.");
    assert.equal(scene.told, undefined);
    assert.equal(scene.audio, undefined);
    assert.match(lines[0], /No sentence from m for scene 1: Ollama answered 404/);
  });

  test("a WAV file knows how long it plays, also when it was written as a stream", () => {
    assert.equal(wavSeconds(wav(44100)), 1);
    assert.equal(wavSeconds(wav(22050, 0)), 0.5);
    assert.equal(wavSeconds(wav(22050, 0xffffffff)), 0.5);
  });

  test("words get their time by their length when the voice cannot tell", () => {
    const words = estimateWords("A new, longer heading", 3);
    assert.deepEqual(words.map((word) => word.text), ["A", "new,", "longer", "heading"]);
    assert.equal(words[0].start, 0.06);
    assert.equal(words.at(-1).end, 2.8);
    assert.ok(words[2].end - words[2].start > words[0].end - words[0].start);
    for (let index = 1; index < words.length; index++) assert.equal(words[index].start, words[index - 1].end);
  });

  test("narration is off unless asked for", () => {
    const off = parseArgs(["--before", "http://a.test", "--after", "http://b.test"]);
    assert.equal(off.narrate, false);
    const on = parseArgs(["--before", "http://a.test", "--after", "http://b.test", "--narrate", "--model", "x", "--voice", "v.onnx"]);
    assert.deepEqual([on.narrate, on.model, on.voice], [true, "x", "v.onnx"]);
  });
});
