import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { MARKER } from "../src/comment.mjs";
import { commentOnGitLab, inMergeRequest } from "../src/gitlab.mjs";

/** A GitLab on this machine: it keeps what is sent to it and answers like the real one. */
async function gitlab(notes = []) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = Buffer.alloc(0);
    req.on("data", (chunk) => (body = Buffer.concat([body, chunk])));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, token: req.headers["private-token"], type: req.headers["content-type"], body: body.toString("latin1") });
      res.setHeader("content-type", "application/json");
      if (req.url.endsWith("/uploads")) return res.end(JSON.stringify({ markdown: "![changereel.mp4](/uploads/abc/changereel.mp4)" }));
      if (req.method === "GET") return res.end(JSON.stringify(notes));
      res.end("{}");
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const env = {
    GITLAB_CI: "true",
    CI_API_V4_URL: `http://127.0.0.1:${server.address().port}/api/v4`,
    CI_PROJECT_ID: "12",
    CI_MERGE_REQUEST_IID: "5",
    CI_JOB_URL: "https://git.example/job/1",
    CHANGEREEL_GITLAB_TOKEN: "secret",
  };
  return { seen, env, close: () => server.close() };
}

const pages = [{ route: "/", changes: [{ type: "added" }] }];
const scenes = [{ route: "/", routes: 1, type: "added", text: "A banner was added.", told: true }];

describe("gitlab", () => {
  test("knows when it runs for a merge request", () => {
    assert.equal(inMergeRequest({ GITLAB_CI: "true", CI_MERGE_REQUEST_IID: "5", CI_API_V4_URL: "x", CI_PROJECT_ID: "1" }), true);
    assert.equal(inMergeRequest({ GITLAB_CI: "true", CI_API_V4_URL: "x", CI_PROJECT_ID: "1" }), false);
  });

  test("uploads the video and plays it at the top of a new comment", async () => {
    const { seen, env, close } = await gitlab();
    const video = join(mkdtempSync(join(tmpdir(), "changereel-gl-")), "changereel.mp4");
    writeFileSync(video, "MP4");
    const log = [];
    assert.equal(await commentOnGitLab({ pages, checked: 2, scenes, video, env, log: (line) => log.push(line) }), "created");
    close();
    const [upload, list, post] = seen;
    assert.equal(upload.url, "/api/v4/projects/12/uploads");
    assert.match(upload.type, /^multipart\/form-data/);
    assert.match(upload.body, /filename="changereel\.mp4"/);
    assert.equal(upload.token, "secret");
    assert.equal(list.url, "/api/v4/projects/12/merge_requests/5/notes?per_page=100&page=1&sort=asc");
    assert.equal(post.method, "POST");
    const body = JSON.parse(post.body).body;
    assert.ok(body.startsWith(MARKER));
    assert.ok(body.indexOf("/uploads/abc/changereel.mp4") < body.indexOf("A banner was added."));
    assert.match(body, /\[this run\]\(https:\/\/git\.example\/job\/1\)/);
  });

  test("a later run changes its comment", async () => {
    const { seen, env, close } = await gitlab([{ id: 3, body: "Looks good" }, { id: 9, body: `${MARKER}\nold` }]);
    assert.equal(await commentOnGitLab({ pages, checked: 2, scenes, env, log: () => {} }), "updated");
    close();
    assert.equal(seen.at(-1).method, "PUT");
    assert.equal(seen.at(-1).url, "/api/v4/projects/12/merge_requests/5/notes/9");
  });

  test("without a token, or when GitLab says no, it tells and does not fail", async () => {
    const lines = [];
    assert.equal(await commentOnGitLab({ pages, checked: 2, env: { CI_API_V4_URL: "x", CI_PROJECT_ID: "1" }, log: (line) => lines.push(line) }), "none");
    assert.match(lines[0], /CHANGEREEL_GITLAB_TOKEN/);
    const refused = async () => ({ ok: false, status: 403, json: async () => ({}) });
    const env = { CI_API_V4_URL: "http://x/api/v4", CI_PROJECT_ID: "1", CI_MERGE_REQUEST_IID: "5", CHANGEREEL_GITLAB_TOKEN: "t" };
    assert.equal(await commentOnGitLab({ pages, checked: 2, env, fetch: refused, log: (line) => lines.push(line) }), "none");
    assert.match(lines[1], /GitLab answered 403/);
  });
});
