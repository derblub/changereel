/**
 * The comment in a pull request: what changed on which page, the sentence for each change
 * when there is one, and the way to the video.
 *
 *   node comment.mjs <out dir>
 *   node comment.mjs --drop        when the pull request is closed: its previews go
 *
 * Reads changes.json, reel.json and the preview changereel.gif from the out dir. Needs
 * GITHUB_TOKEN, GITHUB_REPOSITORY, the number of the pull request in CHANGEREEL_PR, the
 * address of the video in CHANGEREEL_VIDEO_URL when there is one, and the commit in
 * CHANGEREEL_SHA, which names the preview. One comment per pull request: a run that comes
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
export function commentBody({ pages, checked, scenes = [], videoUrl, previewUrl, embed, runUrl }) {
  const changed = pages.filter((page) => page.changes.length);
  const total = changed.reduce((sum, page) => sum + page.changes.length, 0);
  const lines = [MARKER, `### ${total ? `${total} visible change${total === 1 ? "" : "s"} on ${changed.length} of ${checked} pages` : `No visible change on ${checked} pages`}`, ""];
  // The video first where the comment can hold it (GitLab plays an uploaded one); else the
  // picture that moves and leads to it
  if (total && embed) lines.push(embed, "");
  else if (total && previewUrl) lines.push(videoUrl ? `[![What changed](${previewUrl})](${videoUrl})` : `![What changed](${previewUrl})`, "");
  if (!total) {
    lines.push("Every page looks as it did before.");
  } else if (scenes.length) {
    // Only sentences of a model say more than the columns; the plain one only repeats them
    const told = scenes.some((scene) => scene.told);
    lines.push(told ? "| | Page | What changed |" : "| | Page | Change |", "| --- | --- | --- |");
    scenes.forEach((scene, index) => {
      const page = `\`${cell(scene.route)}\`${scene.routes > 1 ? ` and ${scene.routes - 1} more` : ""}`;
      const what = told && scene.told ? cell(scene.text) : `${KIND[scene.type] ?? scene.type}${scene.page ? " page" : ""}`;
      lines.push(`| ${index + 1} | ${page} | ${what} |`);
    });
    // A scene can stand for several changes: on several pages, or close together on one
    const shown = scenes.reduce((sum, scene) => sum + (scene.routes || 1) * (scene.joined || 1), 0);
    if (total > shown) lines.push("", `${total - shown} more in the report of the run.`);
  } else {
    lines.push("| Page | Change |", "| --- | --- |");
    for (const page of changed) {
      for (const change of page.changes) lines.push(`| \`${cell(page.route)}\` | ${KIND[change.type] ?? change.type}${change.page ? " page" : ""} |`);
    }
  }
  const spoken = scenes.some((scene) => scene.audio);
  if (videoUrl) lines.push("", `**[Watch the video](${videoUrl})**${spoken ? ", with its sound" : ""}`);
  if (changed.some((page) => page.unstable)) {
    lines.push("", "<sub>Parts of some pages differ between two visits of the same version and were left out.</sub>");
  }
  lines.push("", `<sub>Made with [changereel](https://github.com/derblub/changereel)${runUrl ? ` in [this run](${runUrl})` : ""}.</sub>`);
  return lines.join("\n") + "\n";
}

/** The branch the previews are kept on, apart from the code. */
export const BRANCH = "changereel-previews";

/**
 * Put the preview into the repository, on a branch of its own, and give back its address.
 * A comment cannot hold a video, only a picture with an address; this is that address.
 * Only for a public repository: the picture of a private one would not show to GitHub.
 */
export async function putPreview({ token, repo, path, content, fetch: request = fetch }) {
  const api = `https://api.github.com/repos/${repo}`;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" };
  const call = async (method, url, body) => {
    const response = await request(`${api}${url}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok && !(method === "GET" && response.status === 404)) throw new Error(`GitHub answered ${response.status} to ${method} ${url}`);
    return response.ok ? response.json() : null;
  };
  const about = await call("GET", "");
  if (about?.private) return null;
  const ref = await call("GET", `/git/ref/heads/${BRANCH}`);
  const parent = ref && (await call("GET", `/git/commits/${ref.object.sha}`));
  const blob = await call("POST", "/git/blobs", { content: content.toString("base64"), encoding: "base64" });
  const tree = await call("POST", "/git/trees", {
    ...(parent ? { base_tree: parent.tree.sha } : {}),
    tree: [{ path, mode: "100644", type: "blob", sha: blob.sha }],
  });
  const commit = await call("POST", "/git/commits", { message: `Preview ${path}`, tree: tree.sha, parents: parent ? [parent.sha] : [] });
  if (ref) await call("PATCH", `/git/refs/heads/${BRANCH}`, { sha: commit.sha });
  else await call("POST", "/git/refs", { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  return `https://raw.githubusercontent.com/${repo}/${BRANCH}/${path}`;
}

/**
 * Take the previews of a pull request off their branch, once it is closed. Gives back how
 * many there were; none, or no branch at all, is not an error.
 */
export async function dropPreviews({ token, repo, number, fetch: request = fetch }) {
  const api = `https://api.github.com/repos/${repo}`;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" };
  const call = async (method, url, body) => {
    const response = await request(`${api}${url}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok && !(method === "GET" && response.status === 404)) throw new Error(`GitHub answered ${response.status} to ${method} ${url}`);
    return response.ok && response.status !== 204 ? response.json() : null;
  };
  const ref = await call("GET", `/git/ref/heads/${BRANCH}`);
  if (!ref) return 0;
  const parent = await call("GET", `/git/commits/${ref.object.sha}`);
  if (!parent) return 0;
  const { tree } = await call("GET", `/git/trees/${parent.tree.sha}?recursive=1`);
  const gone = tree.filter((entry) => entry.type === "blob" && entry.path.startsWith(`pr-${number}/`));
  if (!gone.length) return 0;
  // Without any preview left the branch goes as well: GitHub makes no empty tree
  if (gone.length === tree.filter((entry) => entry.type === "blob").length) {
    await call("DELETE", `/git/refs/heads/${BRANCH}`);
    return gone.length;
  }
  // A path with no blob takes it out of the tree
  const next = await call("POST", "/git/trees", {
    base_tree: parent.tree.sha,
    tree: gone.map((entry) => ({ path: entry.path, mode: "100644", type: "blob", sha: null })),
  });
  const commit = await call("POST", "/git/commits", { message: `Drop the previews of #${number}`, tree: next.sha, parents: [parent.sha] });
  await call("PATCH", `/git/refs/heads/${BRANCH}`, { sha: commit.sha });
  return gone.length;
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
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, CHANGEREEL_PR: number } = process.env;
  // A closed pull request needs no preview any more
  if (process.argv[2] === "--drop") {
    try {
      console.log(`Dropped ${await dropPreviews({ token, repo, number })} preview(s) of #${number}`);
    } catch (err) {
      console.log(`::warning::The previews of #${number} stay: ${err.message}. The job needs "contents: write" for it.`);
    }
    return;
  }
  const out = process.argv[2];
  const { checked, pages } = JSON.parse(readFileSync(join(out, "changes.json"), "utf8"));
  const reel = existsSync(join(out, "reel.json")) ? JSON.parse(readFileSync(join(out, "reel.json"), "utf8")) : {};
  const { CHANGEREEL_VIDEO_URL: videoUrl } = process.env;
  const runUrl =
    process.env.GITHUB_RUN_ID && `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  // The preview: kept on its branch under the number of the pull request and the commit
  let previewUrl;
  const preview = join(out, "changereel.gif");
  if (process.env.CHANGEREEL_PREVIEW !== "false" && existsSync(preview)) {
    const sha = (process.env.CHANGEREEL_SHA || "head").slice(0, 12);
    try {
      previewUrl = await putPreview({ token, repo, path: `pr-${number}/${sha}.gif`, content: readFileSync(preview) });
      if (!previewUrl) console.log("The repository is private: the comment links to the video without a picture.");
    } catch (err) {
      console.log(`::warning::No preview in the comment: ${err.message}. The job needs "contents: write" for it.`);
    }
  }
  const body = commentBody({ pages, checked, scenes: reel.scenes, videoUrl, previewUrl, runUrl });
  const quiet = !pages.some((page) => page.changes.length);
  try {
    console.log(`Comment ${await postComment({ token, repo, number, body, quiet })}`);
  } catch (err) {
    // A pull request from a fork gets a token that may not write; the run is not wrong for that
    console.log(`::warning::No comment on the pull request: ${err.message}. The job needs "pull-requests: write".`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => console.log(`::warning::No comment on the pull request: ${err.message}`));
}
