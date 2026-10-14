import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SCENE, VIEW_H, WINDOW_W, closeUp, plan, sceneFrames, scrollFor } from "../video/geometry.mjs";

/** A scene on a page of 1280 by 3000 pixels; the change lies at `y`. */
function scene(change) {
  return {
    route: "/",
    routes: 1,
    before: "shots/index-before.png",
    after: "shots/index-after.png",
    pageWidth: 1280,
    beforeHeight: 3000,
    afterHeight: 3000,
    ...change,
  };
}

describe("geometry", () => {
  test("a scene lasts as long as its sentence takes, and never less than a scene", () => {
    assert.equal(sceneFrames({}), SCENE);
    assert.equal(sceneFrames({ seconds: 1 }), SCENE);
    assert.equal(sceneFrames({ seconds: 10 }), 15 + 300 + 24);
  });

  test("the page is scrolled so the change is in the middle, and kept inside the page", () => {
    assert.equal(scrollFor(1000, 40, 3000), 1000 + 20 - VIEW_H / 2);
    assert.equal(scrollFor(10, 40, 3000), 0);
    assert.equal(scrollFor(2950, 40, 3000), 3000 - VIEW_H);
    // A part taller than the window starts at its top, with a little room above
    assert.equal(scrollFor(1000, 900, 3000), 952);
  });

  test("the camera goes close to a small change and leaves a large one", () => {
    const small = closeUp({ left: 600, top: 400, width: 120, height: 40 }, WINDOW_W, 864);
    assert.equal(small.scale, 1.6);
    const large = closeUp({ left: 0, top: 100, width: WINDOW_W, height: 500 }, WINDOW_W, 864);
    assert.equal(large.scale, 1);
  });

  test("closer, the page still fills the window", () => {
    for (const left of [0, 700, WINDOW_W - 120]) {
      const close = closeUp({ left, top: 10, width: 120, height: 40 }, WINDOW_W, 864);
      // Where the left and the right edge of the page end up
      const edge = (x) => (x - close.cx) * close.scale + close.cx + close.x;
      assert.ok(edge(0) <= 0.001, `left edge at ${edge(0)}`);
      assert.ok(edge(WINDOW_W) >= WINDOW_W - 0.001, `right edge at ${edge(WINDOW_W)}`);
    }
  });

  test("each side is marked at its own place: a shorter label before, a longer one after", () => {
    const { rects, empty } = plan(
      scene({
        type: "changed",
        beforeY: 1000,
        beforeH: 50,
        afterY: 1000,
        afterH: 50,
        box: { x: 160, y: 0, width: 223, height: 50 },
        boxBefore: { x: 160, y: 0, width: 125, height: 50 },
      }),
    );
    assert.ok(rects.before.width < rects.after.width);
    assert.equal(rects.before.left, rects.after.left);
    assert.deepEqual(empty, { before: false, after: false });
  });

  test("a section that is new is a low slot before and the whole section after", () => {
    const { rects, empty } = plan(
      scene({ type: "added", beforeY: 1200, beforeH: 0, afterY: 1200, afterH: 300, box: null, span: { x: 160, width: 960 } }),
    );
    assert.deepEqual(empty, { before: true, after: false });
    assert.ok(rects.before.height < 20);
    assert.ok(rects.after.height > 300);
    // The slot is where the section begins
    assert.ok(Math.abs(rects.before.top + rects.before.height / 2 - rects.after.top) < 30);
  });

  test("a spot that is empty before is said to be so", () => {
    const { empty } = plan(
      scene({ type: "changed", beforeY: 100, beforeH: 20, afterY: 100, afterH: 20, blank: "before", box: { x: 400, y: 0, width: 60, height: 20 } }),
    );
    assert.deepEqual(empty, { before: true, after: false });
  });

  test("when one page is shorter both stand at its scroll, so nothing jumps", () => {
    const { tops, rects } = plan(scene({ type: "changed", beforeY: 2600, beforeH: 40, afterY: 2600, afterH: 40, beforeHeight: 2800, box: { x: 0, y: 0, width: 100, height: 40 } }));
    assert.equal(tops.before, 2800 - VIEW_H);
    assert.equal(tops.after, tops.before);
    assert.equal(rects.before.top, rects.after.top);
  });

  test("each side keeps its own scroll when the change would leave the window otherwise", () => {
    // Much was added above the change: after, it lies far below where the short page ends
    const { tops } = plan(scene({ type: "changed", beforeY: 1900, beforeH: 40, afterY: 2900, afterH: 40, beforeHeight: 2000, afterHeight: 3600, box: { x: 0, y: 0, width: 100, height: 40 } }));
    assert.notEqual(tops.before, tops.after);
  });
});
