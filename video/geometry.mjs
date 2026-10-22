/**
 * The measures of the video and the arithmetic of a scene, apart from what draws it, so
 * that they can be tested without a renderer: how long things last, where the page is
 * scrolled to, where the change is marked on each side, and how close the camera goes.
 */

export const FPS = 30;
export const TITLE = 105;
export const SCENE = 246;
export const END = 120;
export const WIDTH = 1920;
export const HEIGHT = 1080;

// The stage: a line that says which scene this is, the recording, and room under it for the subtitle
export const MARGIN = 80;
export const WINDOW_W = 1536;
export const WINDOW_X = (WIDTH - WINDOW_W) / 2;
export const WINDOW_Y = 84;
// What the window shows of a page, in pixels of the page
export const VIEW_H = 720;

// A spoken scene starts talking once the page is in view and ends a moment after the voice
export const VOICE_FROM = 15;
export const VOICE_REST = 24;

/** How long a scene lasts: its usual length, or longer when its sentence takes longer to say. */
export const sceneFrames = (scene) =>
  Math.max(SCENE, scene.seconds ? VOICE_FROM + Math.ceil(scene.seconds * FPS) + VOICE_REST : 0);

export const duration = (scenes) => TITLE + scenes.reduce((sum, scene) => sum + sceneFrames(scene), 0) + END;

/** The frame each scene starts at: after the opening card, one after the other. The chapters of the MP4 start there too. */
export function sceneStarts(scenes) {
  const starts = [];
  let at = TITLE;
  for (const scene of scenes) {
    starts.push(at);
    at += sceneFrames(scene);
  }
  return starts;
}

/** Where the window sits on a page so that a band is in view: centred, kept inside the page. */
export function scrollFor(y, height, pageHeight) {
  const top = height > VIEW_H ? y - 48 : y + height / 2 - VIEW_H / 2;
  return Math.max(0, Math.min(top, Math.max(0, pageHeight - VIEW_H)));
}

/**
 * How close the camera moves to a small change: the scale, and the shift that keeps the
 * page filling the window. A change that already takes a good part of the window stays as
 * it is.
 */
export function closeUp(rect, width, height) {
  const scale = Math.min(1.6, (width * 0.45) / rect.width, (height * 0.45) / rect.height);
  if (scale < 1.15) return { scale: 1, x: 0, y: 0, cx: 0, cy: 0 };
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const within = (wanted, centre, size) => Math.max(-(size - centre) * (scale - 1), Math.min(wanted, centre * (scale - 1)));
  return { scale, cx, cy, x: within(width / 2 - cx, cx, width), y: within(height / 2 - cy, cy, height) };
}

/**
 * Everything about a scene that does not move: where the page is scrolled to, the frame
 * around the change and how close the camera goes. The next scene reads where the page
 * was, to show it for a moment while its own page comes.
 */
export function plan(scene) {
  const scale = WINDOW_W / scene.pageWidth;
  const windowH = VIEW_H * scale;
  const hasBefore = Boolean(scene.before);
  const hasAfter = Boolean(scene.after);
  // Both sides scroll to the band on the side that has it, so the page stands still when
  // the tab is switched and only the change moves. Each side is kept inside its own page.
  const onAfter = scene.type !== "removed";
  const wanted = onAfter
    ? scrollFor(scene.afterY, scene.afterH, scene.afterHeight)
    : scrollFor(scene.beforeY, scene.beforeH, scene.beforeHeight);
  let tops = {
    before: Math.min(wanted, Math.max(0, scene.beforeHeight - VIEW_H)),
    after: Math.min(wanted, Math.max(0, scene.afterHeight - VIEW_H)),
  };
  // When one page is shorter it cannot be scrolled as far, and the page would jump when it
  // changes. Both then stand at the shorter scroll, as long as the change stays in view on
  // both sides there; it sits lower in the window, but nothing around it moves.
  if (tops.before !== tops.after) {
    const common = Math.min(tops.before, tops.after);
    const inView = (which) => {
      const y = scene[`${which}Y`] - common;
      return !scene[`${which}H`] || (y >= 0 && y + Math.min(scene[`${which}H`], VIEW_H / 2) <= VIEW_H);
    };
    if (inView("before") && inView("after")) tops = { before: common, after: common };
  }
  // The place on each side, in the window: around the changed pixels, or around what is
  // drawn in a section that came or went. Each side is measured on its own page, so the
  // mark sits right on the page before as well. Where a side has nothing (a section that
  // is new has no rows before), the place is a slot: a low strip where the rows will be.
  const room = (start, size, least, limit) => {
    const padded = Math.max(size + 16, least);
    const from = Math.max(0, Math.min(start - (padded - size) / 2, limit - padded));
    return [from, Math.min(padded, limit - from)];
  };
  const place = (which, box, span) => {
    const bandY = scene[`${which}Y`] - tops[which];
    const bandH = scene[`${which}H`];
    const at = box
      ? { x: box.x, y: bandY + box.y, w: box.width, h: box.height }
      : { x: span?.x ?? 0, y: bandY, w: span?.width ?? scene.pageWidth, h: bandH };
    const [x, w] = room(at.x, at.w, 72, scene.pageWidth);
    const [y, h] = at.h ? room(Math.max(0, at.y), at.h, 48, VIEW_H) : [Math.max(0, Math.min(at.y - 6, VIEW_H - 12)), 12];
    return { left: x * scale, top: y * scale, width: w * scale, height: h * scale };
  };
  const rects = {
    before: place("before", scene.boxBefore ?? (scene.box && scene.beforeH ? scene.box : null), scene.spanBefore ?? scene.span),
    after: place("after", scene.afterH ? scene.box : null, scene.span),
  };
  // A side is empty when it has no rows there, or nothing drawn in them
  const empty = {
    before: !scene.beforeH || scene.blank === "before",
    after: !scene.afterH || scene.blank === "after",
  };
  // The camera goes to the side that has the change, the larger of the two
  const rect = onAfter ? rects.after : rects.before;
  return { scale, windowH, hasBefore, hasAfter, both: hasBefore && hasAfter, onAfter, wanted, tops, rects, empty, close: closeUp(rect, WINDOW_W, windowH) };
}

