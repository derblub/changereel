/**
 * The comment in a merge request on GitLab: the video itself, which GitLab plays in the
 * comment, and what changed on which page.
 *
 *   changereel … --comment        in a GitLab CI job for a merge request
 *
 * Needs a token that may write comments, in CHANGEREEL_GITLAB_TOKEN: a project access token
 * with the scope "api" and at least the role Reporter. The token of the job itself
 * (CI_JOB_TOKEN) may not. Everything else comes from the variables GitLab sets in a job for
 * a merge request: CI_API_V4_URL, CI_PROJECT_ID, CI_MERGE_REQUEST_IID, CI_JOB_URL.
 *
 * One comment per merge request: a run that comes later changes it instead of adding one.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { MARKER, commentBody } from "./comment.mjs";

/** Whether this runs in GitLab CI for a merge request, with what is needed to comment. */
export function inMergeRequest(env = process.env) {
  return Boolean(env.GITLAB_CI && env.CI_MERGE_REQUEST_IID && env.CI_API_V4_URL && env.CI_PROJECT_ID);
}

/** Talk to the GitLab API of the project the job runs for. */
function client({ api, project, token, fetch: request = fetch }) {
  const base = `${api.replace(/\/$/, "")}/projects/${encodeURIComponent(project)}`;
  return async (method, path, body) => {
    const form = body instanceof FormData;
    const response = await request(`${base}${path}`, {
      method,
      headers: { "private-token": token, ...(body && !form ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: form ? body : JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitLab answered ${response.status} to ${method} ${path}`);
    return response.json();
  };
}

/** Upload a file to the project; gives back the Markdown that shows it, a player for a video. */
export async function upload({ file, ...options }) {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(file)]), basename(file));
  const { markdown } = await client(options)("POST", "/uploads", form);
  return markdown;
}

/**
 * Write the comment on the merge request, or change the one there is. With nothing changed
 * and no comment yet, nothing is written.
 */
export async function postNote({ iid, body, quiet = false, ...options }) {
  const call = client(options);
  let found;
  for (let page = 1; !found; page++) {
    const notes = await call("GET", `/merge_requests/${iid}/notes?per_page=100&page=${page}&sort=asc`);
    found = notes.find((note) => note.body?.startsWith(MARKER));
    if (notes.length < 100) break;
  }
  if (!found && quiet) return "none";
  if (found) await call("PUT", `/merge_requests/${iid}/notes/${found.id}`, { body });
  else await call("POST", `/merge_requests/${iid}/notes`, { body });
  return found ? "updated" : "created";
}

/**
 * Comment on the merge request this job runs for. A comment that cannot be written is a
 * warning, not a failed run: the comparison is done and its files are there.
 */
export async function commentOnGitLab({ pages, checked, scenes, video, env = process.env, log = console.log, fetch: request = fetch }) {
  const options = {
    api: env.CI_API_V4_URL,
    project: env.CI_PROJECT_ID,
    token: env.CHANGEREEL_GITLAB_TOKEN,
    fetch: request,
  };
  if (!options.token) {
    log("No comment on the merge request: set CHANGEREEL_GITLAB_TOKEN, a project access token with the scope api.");
    return "none";
  }
  try {
    const quiet = !pages.some((page) => page.changes.length);
    const embed = video && !quiet ? await upload({ ...options, file: video }) : undefined;
    const body = commentBody({ pages, checked, scenes, embed, runUrl: env.CI_JOB_URL });
    const done = await postNote({ ...options, iid: env.CI_MERGE_REQUEST_IID, body, quiet });
    log(`Comment ${done}`);
    return done;
  } catch (err) {
    log(`No comment on the merge request: ${err.message}`);
    return "none";
  }
}
