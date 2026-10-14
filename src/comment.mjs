/**
 * The comment in a pull request: what changed on which page, the sentence for each change
 * when there is one, and the way to the video.
 *
 *   node comment.mjs <out dir>
 *
 * Reads changes.json and reel.json from the out dir. Needs GITHUB_TOKEN, GITHUB_REPOSITORY,
 * the number of the pull request in CHANGEREEL_PR, and the address of the video in
 * CHANGEREEL_VIDEO_URL when there is one. One comment per pull request: a run that comes
 * later changes it instead of adding another, so the newest state is in one place.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** What a comment of changereel starts with, to find it again. */
export const MARKER = "<!-- changereel -->";

const KIND = { added: "Added", removed: "Removed", changed: "Changed" };
const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");

/**
 * The text of the comment. `scenes` are those of the video, with their sentences; changes
 * that are not in the video (more than it holds) are counted at the end.
 */
export function commentBody({ pages, checked, scenes = [], videoUrl, runUrl }) {
  const changed = pages.filter((page) => page.changes.length);
  const total = changed.reduce((sum, page) => sum + page.changes.length, 0);
  const lines = [MARKER, `### ${total ? `${total} visible change${total === 1 ? "" : "s"} on ${changed.length} of ${checked} pages` : `No visible change on ${checked} pages`}`, ""];
  if (!total) {
    lines.push("Every page looks as it did before.");
  } else if (scenes.length) {
    const told = scenes.some((scene) => scene.text);
    lines.push(told ? "| | Page | What changed |" : "| | Page | Change |", "| --- | --- | --- |");
    scenes.forEach((scene, index) => {
      const page = `\`${cell(scene.route)}\`${scene.routes > 1 ? ` and ${scene.routes - 1} more` : ""}`;
      const what = told && scene.text ? cell(scene.text) : `${KIND[scene.type]}${scene.page ? " page" : ""}`;
      lines.push(`| ${index + 1} | ${page} | ${what} |`);
    });
    const shown = scenes.reduce((sum, scene) => sum + (scene.routes || 1), 0);
    if (total > shown) lines.push("", `${total - shown} more in the report of the run.`);
  } else {
    lines.push("| Page | Change |", "| --- | --- |");
    for (const page of changed) {
      for (const change of page.changes) lines.push(`| \`${cell(page.route)}\` | ${KIND[change.type]}${change.page ? " page" : ""} |`);
    }
  }
  if (videoUrl) lines.push("", `**[Watch the video](${videoUrl})** (a zip with \`changereel.mp4\`)`);
  if (changed.some((page) => page.unstable)) {
    lines.push("", "<sub>Parts of some pages differ between two visits of the same version and were left out.</sub>");
  }
  lines.push("", `<sub>Made with [changereel](https://github.com/derblub/changereel)${runUrl ? ` in [this run](${runUrl})` : ""}.</sub>`);
  return lines.join("\n") + "\n";
}

/**
 * Write the comment, or change the one there is. With nothing changed and no comment yet,
 * nothing is written: a pull request that changes no page needs no word about it.
 */
export async function postComment({ token, repo, number, body, quiet = false, fetch: request = fetch }) {
  const api = `https://api.github.com/repos/${repo}/issues`;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  let found;
  for (let page = 1; !found; page++) {
    const response = await request(`${api}/${number}/comments?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} when reading the comments`);
    const comments = await response.json();
    found = comments.find((comment) => comment.body?.startsWith(MARKER));
    if (comments.length < 100) break;
  }
  if (!found && quiet) return "none";
  const response = await request(found ? `${api}/comments/${found.id}` : `${api}/${number}/comments`, {
    method: found ? "PATCH" : "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} when writing the comment`);
  return found ? "updated" : "created";
}

async function main() {
  const out = process.argv[2];
  const { checked, pages } = JSON.parse(readFileSync(join(out, "changes.json"), "utf8"));
  const reel = existsSync(join(out, "reel.json")) ? JSON.parse(readFileSync(join(out, "reel.json"), "utf8")) : {};
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, CHANGEREEL_PR: number, CHANGEREEL_VIDEO_URL: videoUrl } = process.env;
  const runUrl =
    process.env.GITHUB_RUN_ID && `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const body = commentBody({ pages, checked, scenes: reel.scenes, videoUrl, runUrl });
  const quiet = !pages.some((page) => page.changes.length);
  try {
    console.log(`Comment ${await postComment({ token, repo, number, body, quiet })}`);
  } catch (err) {
    // A pull request from a fork gets a token that may not write; the run is not wrong for that
    console.log(`::warning::No comment on the pull request: ${err.message}. The job needs "pull-requests: write".`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
