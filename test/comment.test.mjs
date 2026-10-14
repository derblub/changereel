import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MARKER, commentBody, postComment } from "../src/comment.mjs";

const pages = [
  { route: "/", changes: [{ type: "added" }, { type: "changed" }] },
  { route: "/about", changes: [] },
  { route: "/contact", changes: [{ type: "added", page: true }] },
];

/** A GitHub that answers from a list of comments and keeps what is sent to it. */
function github(comments) {
  const sent = [];
  const fetch = async (url, init = {}) => {
    sent.push({ url, method: init.method || "GET", body: init.body && JSON.parse(init.body) });
    return { ok: true, json: async () => (init.method ? {} : comments) };
  };
  return { sent, fetch };
}

describe("comment", () => {
  test("says what changed on which page, with the sentence of each scene", () => {
    const body = commentBody({
      pages,
      checked: 3,
      scenes: [
        { route: "/", routes: 1, type: "added", text: "A banner | with a pipe was added." },
        { route: "/contact", routes: 1, type: "added", page: true, text: "A contact page was added." },
      ],
      videoUrl: "https://example.test/artifact",
      runUrl: "https://example.test/run",
    });
    assert.ok(body.startsWith(MARKER));
    assert.match(body, /### 3 visible changes on 2 of 3 pages/);
    assert.match(body, /\| 1 \| `\/` \| A banner \\\| with a pipe was added\. \|/);
    assert.match(body, /1 more in the report of the run/);
    assert.match(body, /\[Watch the video\]\(https:\/\/example\.test\/artifact\)/);
    assert.match(body, /\[this run\]\(https:\/\/example\.test\/run\)/);
  });

  test("without sentences it names the kind of change, without a video it has no link", () => {
    const body = commentBody({ pages, checked: 3 });
    assert.match(body, /\| `\/contact` \| Added page \|/);
    assert.doesNotMatch(body, /Watch the video/);
  });

  test("a pull request with nothing changed gets no comment", async () => {
    const { sent, fetch } = github([]);
    assert.equal(await postComment({ token: "t", repo: "o/r", number: 7, body: "x", quiet: true, fetch }), "none");
    assert.deepEqual(sent.map((s) => s.method), ["GET"]);
  });

  test("a later run changes the comment there is instead of adding one", async () => {
    const { sent, fetch } = github([{ id: 1, body: "Nice work" }, { id: 42, body: `${MARKER}\nold` }]);
    assert.equal(await postComment({ token: "t", repo: "o/r", number: 7, body: "new", fetch }), "updated");
    assert.equal(sent[1].method, "PATCH");
    assert.equal(sent[1].url, "https://api.github.com/repos/o/r/issues/comments/42");
    assert.deepEqual(sent[1].body, { body: "new" });
  });

  test("the first run writes a new comment, also when nothing changed any more", async () => {
    const { sent, fetch } = github([]);
    assert.equal(await postComment({ token: "t", repo: "o/r", number: 7, body: "new", fetch }), "created");
    assert.equal(sent[1].url, "https://api.github.com/repos/o/r/issues/7/comments");
    const again = github([{ id: 42, body: `${MARKER}\nold` }]);
    assert.equal(await postComment({ token: "t", repo: "o/r", number: 7, body: "none now", quiet: true, fetch: again.fetch }), "updated");
  });
});
