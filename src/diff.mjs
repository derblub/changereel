/**
 * What changed between two full-page screenshots of the same route.
 *
 * A page is compared like a text file whose lines are its pixel rows. A section that was
 * added pushes everything below it down; a pixel-by-pixel comparison would call all of that
 * changed. Aligning the rows first tells "this band is new" from "this band moved", so only
 * the part that really differs is reported:
 *
 *   added    rows that exist only in the after page
 *   removed  rows that exist only in the before page
 *   changed  rows at the same place in both pages whose pixels differ
 *
 * A changed band also gets the box around the differing pixels, so a video can point at a
 * button instead of at the full width of the page.
 *
 * Rows of a single colour are the blank lines of a page: they match anywhere, so they say
 * little about where a band begins. Bands are therefore judged and trimmed by their other
 * rows. A band with content on one side only was added or removed, whatever blank rows the
 * alignment paired it with, and a band of nothing but blank rows is spacing, not a change.
 */
import { diffArrays } from "diff";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/** One number per pixel row: equal rows get equal numbers (FNV-1a over the row's bytes). */
export function rowHashes(png) {
  const { width, height, data } = png;
  const hashes = new Array(height);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    let hash = 0x811c9dc5;
    const end = (y + 1) * stride;
    for (let i = y * stride; i < end; i++) {
      hash ^= data[i];
      hash = Math.imul(hash, 0x01000193);
    }
    hashes[y] = hash >>> 0;
  }
  return hashes;
}

/** Whether every pixel of a row has the colour of its first one. */
export function isBlankRow(png, y) {
  const { width, data } = png;
  const start = y * width * 4;
  const first = data.readUInt32LE(start);
  for (let x = 1; x < width; x++) {
    if (data.readUInt32LE(start + x * 4) !== first) return false;
  }
  return true;
}

/** A stretch of rows without the blank rows at its top and bottom; height 0 if all are blank. */
export function trimBlank(png, y, height) {
  let top = y;
  let bottom = y + height;
  while (top < bottom && isBlankRow(png, top)) top++;
  while (bottom > top && isBlankRow(png, bottom - 1)) bottom--;
  return { y: top, height: bottom - top };
}

/** Runs of rows that are equal, only in before, or only in after, in page order. */
export function alignRows(before, after) {
  const runs = [];
  let b = 0;
  let a = 0;
  for (const part of diffArrays(before, after)) {
    const count = part.value.length;
    if (part.added) {
      runs.push({ type: "added", beforeY: b, beforeH: 0, afterY: a, afterH: count });
      a += count;
    } else if (part.removed) {
      runs.push({ type: "removed", beforeY: b, beforeH: count, afterY: a, afterH: 0 });
      b += count;
    } else {
      b += count;
      a += count;
    }
  }
  return runs;
}

/**
 * Bands from runs: a removal directly followed by an addition is one band that was replaced,
 * and bands closer than `gap` rows belong together (the lines of one changed paragraph).
 */
export function mergeRuns(runs, gap = 24) {
  const bands = [];
  for (const run of runs) {
    const last = bands.at(-1);
    const near =
      last &&
      run.beforeY - (last.beforeY + last.beforeH) <= gap &&
      run.afterY - (last.afterY + last.afterH) <= gap;
    if (near) {
      last.beforeH = run.beforeY + run.beforeH - last.beforeY;
      last.afterH = run.afterY + run.afterH - last.afterY;
    } else {
      bands.push({ beforeY: run.beforeY, beforeH: run.beforeH, afterY: run.afterY, afterH: run.afterH });
    }
  }
  return bands.map((band) => ({
    type: band.beforeH === 0 ? "added" : band.afterH === 0 ? "removed" : "changed",
    ...band,
  }));
}

function crop(png, y, height) {
  const out = new PNG({ width: png.width, height });
  png.data.copy(out.data, 0, y * png.width * 4, (y + height) * png.width * 4);
  return out;
}

/** The box around the pixels that differ in a band both pages have, or null if none do. */
export function changedBox(before, after, band) {
  const height = Math.min(band.beforeH, band.afterH);
  if (!height) return null;
  const width = before.width;
  const mask = new PNG({ width, height });
  const count = pixelmatch(
    crop(before, band.beforeY, height).data,
    crop(after, band.afterY, height).data,
    mask.data,
    width,
    height,
    { threshold: 0.1, diffMask: true },
  );
  if (!count) return null;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask.data[(y * width + x) * 4 + 3]) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1, pixels: count };
}

/**
 * A box around changed pixels, widened to what they belong to. Of a price that went from
 * 599 to 549 one digit differs; a frame around that digit cuts the number in two. The box
 * first loses what is empty at its edges on this picture, then grows to each side until it meets `gap` columns or rows in which nothing is drawn, so it
 * holds the words around the digit, and stops at the space around them. A side that finds
 * no such space within `reach` pixels stays where it was: the change sits in a picture or
 * on a pattern, and has no edge to grow to.
 */
export function snapBox(png, band, box, { gap = 10, reach = 240 } = {}) {
  const pixel = (x, y) => png.data.readUInt32LE((y * png.width + x) * 4);
  let { x: left, y: top } = box;
  let right = box.x + box.width - 1;
  let bottom = box.y + box.height - 1;
  top += band.afterY;
  bottom += band.afterY;
  const limit = { top: band.afterY, bottom: Math.min(png.height, band.afterY + band.afterH) - 1 };
  const flatColumn = (x) => {
    const first = pixel(x, top);
    for (let y = top + 1; y <= bottom; y++) if (pixel(x, y) !== first) return false;
    return true;
  };
  const flatRow = (y) => {
    const first = pixel(left, y);
    for (let x = left + 1; x <= right; x++) if (pixel(x, y) !== first) return false;
    return true;
  };
  // Walk outwards from `from` until `gap` flat lines in a row; the edge is the last one drawn
  const walk = (from, step, end, flat) => {
    let edge = from;
    let run = 0;
    for (let at = from + step; step > 0 ? at <= end : at >= end; at += step) {
      if (Math.abs(at - from) > reach) return from;
      if (flat(at)) {
        if (++run >= gap) return edge;
      } else {
        run = 0;
        edge = at;
      }
    }
    return edge;
  };
  // First inwards: the box holds what differs on either side, and on this side less may be
  // drawn in it (the shorter label of a button). Lines that are empty come off the edges:
  // flat, and in the colour of what lies outside the box on that side. A flat line in
  // another colour is the edge of something, such as a button, and stays.
  const whole = { left, right, top, bottom };
  const outside = {
    left: pixel(Math.max(0, left - 1), top),
    right: pixel(Math.min(png.width - 1, right + 1), top),
    top: pixel(left, Math.max(0, top - 1)),
    bottom: pixel(left, Math.min(png.height - 1, bottom + 1)),
  };
  while (left < right && flatColumn(left) && pixel(left, top) === outside.left) left++;
  while (right > left && flatColumn(right) && pixel(right, top) === outside.right) right--;
  while (top < bottom && flatRow(top) && pixel(left, top) === outside.top) top++;
  while (bottom > top && flatRow(bottom) && pixel(left, bottom) === outside.bottom) bottom--;
  if (left === right || top === bottom) ({ left, right, top, bottom } = whole);
  // Then outwards. Twice: what is found to the sides changes which rows count, and the
  // other way round
  for (let pass = 0; pass < 2; pass++) {
    left = walk(left, -1, 0, flatColumn);
    right = walk(right, 1, png.width - 1, flatColumn);
    top = walk(top, -1, limit.top, flatRow);
    bottom = walk(bottom, 1, limit.bottom, flatRow);
  }
  return { ...box, x: left, y: top - band.afterY, width: right - left + 1, height: bottom - top + 1 };
}

/** Whether a rectangle of a picture is one flat colour: nothing is drawn there. */
export function isFlat(png, x, y, width, height) {
  const right = Math.min(png.width, x + width);
  const bottom = Math.min(png.height, y + height);
  if (x >= right || y >= bottom) return true;
  const first = png.data.readUInt32LE((y * png.width + x) * 4);
  for (let row = y; row < bottom; row++) {
    for (let col = x; col < right; col++) {
      if (png.data.readUInt32LE((row * png.width + col) * 4) !== first) return false;
    }
  }
  return true;
}

/**
 * From where to where something is drawn in a stretch of rows: the columns between the
 * first and the last pixel that is not the colour its row begins with. A section that came
 * or went is as wide as the page, but what is in it often is not, and a frame around the
 * text says more than one from edge to edge. Null when the rows are empty or what is drawn
 * reaches both edges.
 */
export function drawnSpan(png, y, height) {
  let left = png.width;
  let right = -1;
  const end = Math.min(png.height, y + height);
  for (let row = Math.max(0, y); row < end; row++) {
    const start = row * png.width * 4;
    const ground = png.data.readUInt32LE(start);
    let x = 0;
    while (x < left && png.data.readUInt32LE(start + x * 4) === ground) x++;
    if (x < left) left = x;
    x = png.width - 1;
    while (x > right && png.data.readUInt32LE(start + x * 4) === ground) x--;
    if (x > right) right = x;
  }
  if (right < left || (left === 0 && right === png.width - 1)) return null;
  return { x: left, width: right - left + 1 };
}

/**
 * The changes between two screenshots (PNG buffers of the same width), largest first.
 * Left out are added and removed bands lower than `minHeight` rows, and bands of unchanged
 * height in which fewer than `minPixels` pixels differ.
 */
export function diffPages(beforeBuffer, afterBuffer, { gap = 24, minHeight = 2, minPixels = 40, snap = true } = {}) {
  const before = PNG.sync.read(beforeBuffer);
  const after = PNG.sync.read(afterBuffer);
  if (before.width !== after.width) {
    throw new Error(`Screenshots differ in width: ${before.width} and ${after.width}`);
  }
  const bands = mergeRuns(alignRows(rowHashes(before), rowHashes(after)), gap);
  const changes = [];
  for (const band of bands) {
    const was = trimBlank(before, band.beforeY, band.beforeH);
    const is = trimBlank(after, band.afterY, band.afterH);
    if (!was.height && !is.height) continue; // only spacing
    if (was.height && is.height) {
      const box = changedBox(before, after, band);
      // Same height and no differing pixel: the rows only matched in another order
      if (!box && band.beforeH === band.afterH) continue;
      // A handful of pixels in a band of the same height: a hairline that rendered one
      // shade off, not something to show. A changed digit has more.
      if (box && box.pixels < minPixels && band.beforeH === band.afterH) continue;
      // The box is measured over the rows both sides have. Where one side is much taller,
      // most of the change lies below them, and the band says more than the box.
      const grew = Math.abs(band.afterH - band.beforeH) > Math.max(16, Math.min(band.beforeH, band.afterH) / 4);
      const whole = grew || !box;
      if (whole) {
        changes.push({
          ...band,
          type: "changed",
          box: null,
          span: drawnSpan(after, band.afterY, band.afterH),
          spanBefore: drawnSpan(before, band.beforeY, band.beforeH),
        });
      } else {
        // The same place on both sides, each widened on its own picture: a button that got
        // a longer label is wider after than before. A side on which the place is empty
        // (a link that is new, a badge that is gone) takes the box of the other.
        const blank = isFlat(before, box.x, band.beforeY + box.y, box.width, box.height)
          ? "before"
          : isFlat(after, box.x, band.afterY + box.y, box.width, box.height)
            ? "after"
            : undefined;
        // `snap` off keeps the box of the differing pixels as it is: what has to be painted
        // over as noise is all of it, on either side
        const now = snap ? snapBox(after, band, box) : box;
        const was = snap ? snapBox(before, { afterY: band.beforeY, afterH: band.beforeH }, box) : box;
        changes.push({
          ...band,
          type: "changed",
          box: blank === "after" ? { ...was, pixels: box.pixels } : now,
          boxBefore: blank === "before" ? now : was,
          ...(blank ? { blank } : {}),
        });
      }
    } else if (Math.max(was.height, is.height) >= minHeight) {
      changes.push({
        type: is.height ? "added" : "removed",
        beforeY: was.height ? was.y : band.beforeY,
        beforeH: was.height,
        afterY: is.height ? is.y : band.afterY,
        afterH: is.height,
        box: null,
        span: is.height ? drawnSpan(after, is.y, is.height) : drawnSpan(before, was.y, was.height),
      });
    }
  }
  const weight = (c) => (c.box ? c.box.width * c.box.height : before.width * Math.max(c.beforeH, c.afterH));
  return {
    width: before.width,
    beforeHeight: before.height,
    afterHeight: after.height,
    changes: changes.sort((x, y) => weight(y) - weight(x)),
  };
}

/**
 * What differs between two captures of the same page, as boxes in the first one: a widget
 * that loads in another state each time, a random quote, a clock. The two are compared like
 * two versions, so a part that is taller on one visit is found as well. Where the height
 * differs, the box is the full width of the band: painted over, its rows are blank, and a
 * blank stretch of another height is spacing, not a change.
 */
export function noiseBoxes(firstBuffer, secondBuffer, pad = 8) {
  const { width, beforeHeight, changes } = diffPages(firstBuffer, secondBuffer, { minPixels: 1, minHeight: 1, snap: false });
  const boxes = [];
  for (const change of changes) {
    if (!change.beforeH) continue; // only on the second visit: nothing to paint in the first
    if (change.box && change.beforeH === change.afterH) {
      const x = Math.max(0, change.box.x - pad);
      const y = Math.max(0, change.beforeY + change.box.y - pad);
      boxes.push({
        x,
        y,
        width: Math.min(width, change.box.x + change.box.width + pad) - x,
        height: Math.min(beforeHeight, change.beforeY + change.box.y + change.box.height + pad) - y,
      });
    } else {
      boxes.push({ x: 0, y: change.beforeY, width, height: change.beforeH });
    }
  }
  return boxes;
}

/** A copy of a picture with the boxes painted in one flat colour, so they compare as equal. */
export function paint(buffer, boxes) {
  if (!boxes?.length) return buffer;
  const png = PNG.sync.read(buffer);
  for (const box of boxes) {
    for (let y = box.y; y < box.y + box.height; y++) {
      png.data.fill(0x80, (y * png.width + box.x) * 4, (y * png.width + box.x + box.width) * 4);
    }
  }
  return PNG.sync.write(png);
}

/**
 * Whether a change is mostly noise: at least `share` of it lies in or right next to a noisy
 * spot of its page. A random quote also moves the line under it and the button after it;
 * painting the quote does not cover those, so each box counts `margin` rows further up and
 * down. A large change with a flickering hairline somewhere inside it stays a change.
 * `side` is "before" or "after": which page the boxes belong to. `width` is the page's.
 */
export function nearNoise(change, boxes, side, width, margin = 64, share = 0.3) {
  if (!boxes?.length) return false;
  const boxed = change.box && side === "after";
  const rect = {
    x: boxed ? change.box.x : 0,
    y: change[`${side}Y`] + (boxed ? change.box.y : 0),
    width: boxed ? change.box.width : width,
    height: boxed ? change.box.height : change[`${side}H`],
  };
  if (!rect.width) return false;
  // Nothing on this side (the band was added or removed): its place is a line, in or out
  if (!rect.height) return boxes.some((box) => rect.y >= box.y - margin && rect.y <= box.y + box.height + margin);
  let area = 0;
  for (const box of boxes) {
    const w = Math.min(rect.x + rect.width, box.x + box.width) - Math.max(rect.x, box.x);
    const h = Math.min(rect.y + rect.height, box.y + box.height + margin) - Math.max(rect.y, box.y - margin);
    if (w > 0 && h > 0) area += w * h;
  }
  return area / (rect.width * rect.height) >= share;
}
