/**
 * Chapters for the MP4: one per scene, so a video watched without its voice can be jumped
 * through change by change. They start at the frames the video starts its scenes at, and
 * are written into the file without encoding it again.
 */
import { spawnSync } from "node:child_process";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { END, FPS, duration, sceneStarts } from "../video/geometry.mjs";
import { kindOf } from "./texts.mjs";

const ms = (frame) => Math.round((frame * 1000) / FPS);

/**
 * The title of a scene's chapter: where, then what kind of change, in the words of the line
 * above the recording ("/cart › Checkout dialog · Changed"). Not the spoken sentence: a list
 * of chapters is read as an index, and the place in front keeps it in the same shape on
 * every line, whatever a model said this time.
 */
export function chapterTitle(scene, texts) {
  if (scene.setup) return `${texts.login} · ${texts.kind[scene.type]}`;
  const where = `${scene.route}${scene.state ? ` › ${scene.state}` : ""}${scene.routes > 1 ? ` +${scene.routes - 1}` : ""}`;
  return `${where} · ${kindOf(scene, texts)}`;
}

/**
 * The chapters, in milliseconds. The opening card has none of its own: it lasts a few
 * seconds, and a player shows no chapter at all for the time before a first chapter that
 * starts later, so the first scene's chapter starts at 0. The closing card gets one when
 * `summary` names it, as the place to jump to for all changes at once.
 */
export function chapters(scenes, texts, { summary = texts.summaryChapter } = {}) {
  if (!scenes.length) return [];
  const starts = sceneStarts(scenes);
  const end = duration(scenes);
  const list = scenes.map((scene, index) => ({ start: index ? ms(starts[index]) : 0, end: 0, title: chapterTitle(scene, texts) }));
  if (summary) list.push({ start: ms(end - END), end: 0, title: summary });
  list.forEach((chapter, index) => (chapter.end = list[index + 1]?.start ?? ms(end)));
  return list;
}

/** A value of an FFMETADATA file: =, ;, #, \ and line breaks are escaped with a backslash. */
export const escapeMetadata = (text) => String(text).replace(/[=;#\\\n]/g, "\\$&");

export function ffmetadata(list) {
  return (
    ";FFMETADATA1\n" +
    list.map(({ start, end, title }) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${start}\nEND=${end}\ntitle=${escapeMetadata(title)}\n`).join("")
  );
}

/**
 * Writes the chapters into the video by copying its streams into a new file, which then takes
 * its place. The ffmpeg that Remotion brings is built without the reader of FFMETADATA
 * files, so this takes the one on the PATH. Without it the video stays as it is, and a run
 * never fails for its chapters.
 */
export function addChapters(video, list, log = console.log, ffmpeg = "ffmpeg") {
  if (!list.length) return false;
  const meta = join(dirname(video), "chapters.txt");
  // The ending tells ffmpeg the format
  const copy = join(dirname(video), "chapters.mp4");
  try {
    writeFileSync(meta, ffmetadata(list));
    // +faststart: the copy would otherwise put the index at the end, and a browser would load the whole file before it plays
    const args = ["-v", "error", "-y", "-i", video, "-i", meta, "-map", "0", "-map_metadata", "1", "-map_chapters", "1", "-c", "copy", "-movflags", "+faststart", copy];
    const run = spawnSync(ffmpeg, args, { encoding: "utf8" });
    if (run.error || run.status !== 0) {
      const why = run.error?.code === "ENOENT" ? `${ffmpeg} was not found` : (run.error?.message ?? run.stderr.trim().split("\n")[0]);
      log(`The video has no chapters: ${why}`);
      return false;
    }
    renameSync(copy, video);
    return true;
  } catch (error) {
    log(`The video has no chapters: ${error.message}`);
    return false;
  } finally {
    rmSync(meta, { force: true });
    rmSync(copy, { force: true });
  }
}
