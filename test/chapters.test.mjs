import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { addChapters, chapterTitle, chapters, escapeMetadata, ffmetadata } from "../src/chapters.mjs";
import { TEXTS } from "../src/texts.mjs";
import { duration, sceneStarts } from "../video/geometry.mjs";

const { en, de } = TEXTS;
const scene = (change = {}) => ({ route: "/", routes: 1, type: "changed", ...change });
// Run only where there is an ffmpeg that can make a video to try them on
const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("chapters", () => {
  // 105 frames of the opening card, scenes of 246 frames or longer for a long sentence, 120 of the closing card, at 30 fps
  const scenes = [scene(), scene({ seconds: 10 }), scene()];

  test("start where the video starts its scenes, the first at 0 for the opening card", () => {
    const list = chapters(scenes, en);
    assert.deepEqual(
      list.map(({ start, end }) => [start, end]),
      [
        [0, 11700],
        [11700, 23000],
        [23000, 31200],
        [31200, 35200],
      ],
    );
    assert.deepEqual(sceneStarts(scenes).slice(1), [351, 690]);
    assert.equal(list.at(-1).end, Math.round((duration(scenes) * 1000) / 30));
    assert.equal(list.at(-1).title, "Summary");
  });

  test("without a chapter for the closing card, the last scene runs to the end", () => {
    const list = chapters(scenes, en, { summary: null });
    assert.equal(list.length, 3);
    assert.deepEqual(list.at(-1), { start: 23000, end: 35200, title: "/ · Changed" });
  });

  test("one scene, and none", () => {
    assert.deepEqual(chapters([scene()], de), [
      { start: 0, end: 11700, title: "/ · Geändert" },
      { start: 11700, end: 15700, title: "Zusammenfassung" },
    ]);
    assert.deepEqual(chapters([], en), []);
  });

  test("a title says where and what kind of change, in the words of the video", () => {
    assert.equal(chapterTitle(scene({ route: "/pricing", type: "added", page: true }), en), "/pricing · Added page");
    assert.equal(chapterTitle(scene({ route: "/pricing", type: "removed" }), en), "/pricing · Removed");
    assert.equal(chapterTitle(scene({ route: "/cart", state: "Checkout dialog" }), en), "/cart › Checkout dialog · Changed");
    assert.equal(chapterTitle(scene({ route: "/account", state: "Orders", type: "unreached" }), en), "/account › Orders · No longer reachable");
    assert.equal(chapterTitle(scene({ route: "/login", setup: true, type: "unreached" }), en), "Login · No longer reachable");
  });

  test("a scene on several pages says how many more", () => {
    assert.equal(chapterTitle(scene({ routes: 4 }), en), "/ +3 · Changed");
  });

  test("a narrated scene keeps the title of its comparison", () => {
    const text = "The price of the Ethiopia bag went down from 16 euros to 14 euros, and a badge was added.";
    assert.equal(chapterTitle(scene({ route: "/shop", text, seconds: 6 }), en), "/shop · Changed");
  });

  test("in German", () => {
    assert.equal(chapterTitle(scene({ route: "/preise", type: "added", page: true }), de), "/preise · Neue Seite");
    assert.equal(chapterTitle(scene({ route: "/konto", state: "Bestellungen", type: "reached" }), de), "/konto › Bestellungen · Jetzt erreichbar");
    assert.equal(chapterTitle(scene({ setup: true, type: "reached" }), de), "Anmeldung · Jetzt erreichbar");
  });

  test("a title is escaped for the FFMETADATA file", () => {
    assert.equal(escapeMetadata("a=b;c#d\\e\nf"), "a\\=b\\;c\\#d\\\\e\\\nf");
    assert.equal(
      ffmetadata([{ start: 0, end: 8200, title: "/?q=1 · Changed" }]),
      ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=8200\ntitle=/?q\\=1 · Changed\n",
    );
  });

  test("without ffmpeg the video stays as it is, with one line in the log", () => {
    const out = mkdtempSync(join(tmpdir(), "changereel-chapters-"));
    const video = join(out, "changereel.mp4");
    writeFileSync(video, "not a video");
    const lines = [];
    assert.equal(addChapters(video, chapters([scene()], en), (line) => lines.push(line), "no-such-ffmpeg"), false);
    assert.deepEqual(lines, ["The video has no chapters: no-such-ffmpeg was not found"]);
    assert.equal(readFileSync(video, "utf8"), "not a video");
    assert.deepEqual(readdirSync(out), ["changereel.mp4"]);
  });

  test("written into the video without encoding it again", { skip: !ffmpeg && "no ffmpeg on the PATH" }, () => {
    const out = mkdtempSync(join(tmpdir(), "changereel-chapters-"));
    const video = join(out, "changereel.mp4");
    const made = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=16", "-pix_fmt", "yuv420p", video]);
    assert.equal(made.status, 0, String(made.stderr));
    const probe = (what) => JSON.parse(spawnSync("ffprobe", ["-v", "error", what, "-show_streams", "-of", "json", video], { encoding: "utf8" }).stdout);
    const before = probe("-show_format");
    assert.equal(addChapters(video, chapters([scene({ route: "/a=b" })], en), assert.fail), true);
    const after = probe("-show_chapters");
    assert.deepEqual(
      after.chapters.map((chapter) => [chapter.start_time, chapter.end_time, chapter.tags.title]),
      [
        ["0.000000", "11.700000", "/a=b · Changed"],
        ["11.700000", "15.700000", "Summary"],
      ],
    );
    // The same pictures; the MP4 writer adds a track of chapter names for QuickTime
    const media = ({ streams }) => streams.filter((stream) => stream.codec_type !== "data").map((stream) => [stream.codec_name, stream.nb_frames]);
    assert.deepEqual(media(after), media(before));
    assert.deepEqual(readdirSync(out), ["changereel.mp4"]);
  });
});
