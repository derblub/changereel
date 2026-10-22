/**
 * The video: an opening card, one scene per change, a closing card.
 *
 * The scenes are made like one screen recording of the page, with nothing of a browser
 * around it and no pointer on it: rounded corners and a soft shadow. The page is scrolled
 * to the place and the camera goes to the change on a spring. There the page before stands
 * still with the place marked, then the change happens as it would on the page (a section
 * opens, things in a row move aside, a changed place is wiped over), and the mark moves and
 * grows into the place there. Each scene shows its one change only. A sign in the corner says which side it is. The recording stays through
 * all scenes. Above it a line says which scene this is, under it the sentence runs as the
 * subtitle.
 *
 * Nothing in it is a brand.
 */
import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  Composition,
  Easing,
  Img,
  Sequence,
  continueRender,
  delayRender,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { kindOf, stopLine, textsFor } from "../src/texts.mjs";
import {
  END,
  FPS,
  HEIGHT,
  MARGIN,
  SCENE,
  TITLE,
  VOICE_FROM,
  VIEW_H,
  WIDTH,
  WINDOW_W,
  WINDOW_X,
  WINDOW_Y,
  duration,
  plan,
  sceneFrames,
  sceneStarts,
} from "./geometry.mjs";

export { FPS, duration, sceneFrames };


const INK = "#1d1d20";
const INK_DEEP = "#131315";
const INK_RAISED = "#27272b";
const WHITE = "#ffffff";
const GRAY = "#a1a1aa";
const TEAL = "#2dd4bf";
const SANS = '"Google Sans Flex", sans-serif';
const MONO = "ui-monospace, monospace";
// The curves of the line: content that arrives, and colour and the push
const reveal = Easing.bezier(0.22, 1, 0.36, 1);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" };

function useFonts() {
  const [handle] = useState(() => delayRender("fonts"));
  useEffect(() => {
    const faces = [
      ["fonts/google-sans-flex-latin-wght-normal.woff2", "U+0000-00FF, U+2013-2014, U+2018-201E, U+2039-203A, U+2190-2199"],
      ["fonts/google-sans-flex-latin-ext-wght-normal.woff2", "U+0100-024F, U+1E00-1EFF"],
    ].map(
      ([file, unicodeRange]) =>
        new FontFace("Google Sans Flex", `url(${staticFile(file)}) format("woff2")`, { weight: "1 1000", unicodeRange }),
    );
    Promise.all(faces.map((face) => face.load()))
      .then((loaded) => loaded.forEach((face) => document.fonts.add(face)))
      .finally(() => continueRender(handle));
  }, [handle]);
}

const label = { fontFamily: SANS, fontSize: 18, lineHeight: "24px", fontWeight: 550, letterSpacing: "0.2em", textTransform: "uppercase", color: GRAY };

/** Content that arrives: it rises once and stays. */
const rise = (frame, from = 0, distance = 24, length = 36) => ({
  opacity: interpolate(frame, [from, from + 14], [0, 1], clamp),
  transform: `translateY(${interpolate(frame, [from, from + length], [distance, 0], { ...clamp, easing: reveal })}px)`,
});

/**
 * A word of a spoken sentence: grey until the voice reaches it, white once it is said. The
 * white runs through the word with a soft edge while it is spoken, so the eye is led along
 * and not called.
 */
const Word = ({ word, seconds }) => {
  const length = Math.max(word.end - word.start, 0.08);
  const said = interpolate(seconds, [word.start, word.start + length], [0, 1], clamp);
  return (
    <>
      <span
        style={{
          backgroundImage: `linear-gradient(90deg, ${WHITE} ${said * 140 - 40}%, ${GRAY} ${said * 140}%)`,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
        }}
      >
        {word.text}
      </span>{" "}
    </>
  );
};

/** A fact of the opening card: what it is, and its value. */
const Fact = ({ name, value }) => (
  <div>
    <div style={label}>{name}</div>
    <div style={{ fontFamily: SANS, fontSize: 36, lineHeight: "48px", fontWeight: 500, color: WHITE, marginTop: 8 }}>{value}</div>
  </div>
);

const Title = ({ title, summary, facts }) => {
  const frame = useCurrentFrame();
  const out = interpolate(frame, [TITLE - 12, TITLE], [1, 0], clamp);
  // The heading gains weight as it arrives, as the headings of the site do while they scroll
  const weight = interpolate(frame, [0, 60], [500, 800], { ...clamp, easing: reveal });
  return (
    <AbsoluteFill style={{ opacity: out }}>
      <div style={{ position: "absolute", left: MARGIN, top: 72, ...label, ...rise(frame, 0, 12) }}>changereel</div>
      <div style={{ position: "absolute", left: MARGIN, right: MARGIN, top: 300 }}>
        <h1
          style={{
            fontFamily: SANS,
            fontSize: 152,
            lineHeight: 1,
            fontWeight: weight,
            margin: "0 0 0 -0.05em",
            color: WHITE,
            textTransform: "uppercase",
            ...rise(frame, 4, 32, 44),
          }}
        >
          {title}
        </h1>
        <p style={{ fontFamily: SANS, fontSize: 40, lineHeight: "52px", fontWeight: 300, color: GRAY, margin: "40px 0 0", ...rise(frame, 12) }}>
          {summary}
        </p>
        {facts.length > 0 && (
          <div style={{ display: "flex", gap: 96, marginTop: 120, paddingTop: 40, borderTop: `1px solid ${INK_RAISED}`, ...rise(frame, 20) }}>
            {facts.map(([name, value]) => (
              <Fact key={name} name={name} value={value} />
            ))}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

/** How long the things of a row take to make room, or to close up. */
const SLIDE = 20;

/**
 * Something put into a row of things, or taken out, as it happened: the things beside it
 * move aside and the new one comes up in the gap, or it fades and they close up. Drawn over
 * the page before, in the rows of the change only; `p` runs from 0 to 1.
 */
const Slide = ({ scene, at, scale, p }) => {
  const { slide, beforeY, beforeH, afterY } = scene;
  const added = scene.blank === "before";
  // The new thing where it ends up, or the one that goes where it was
  const thing = added ? scene.box : scene.boxBefore;
  const ends = [thing.x, thing.x + thing.width];
  for (const move of slide.moves) ends.push(move.x, move.x + move.dx, move.x + move.width, move.x + move.width + move.dx);
  const left = Math.min(...ends);
  const right = Math.max(...ends);
  // The thing shows only as far as the things beside it have made room, or still leave
  let from = thing.x;
  let to = thing.x + thing.width;
  for (const move of slide.moves) {
    const now = move.x + move.dx * p;
    // Which side of the thing it is on, measured on the side the thing is drawn on
    const beside = added ? move.x + move.dx : move.x;
    if (beside < thing.x) from = Math.max(from, now + move.width);
    else to = Math.min(to, now);
  }
  // A piece of a page: the rows of the change, from `x` and `width` wide
  const piece = (which, x, width, y, style) => (
    <div style={{ position: "absolute", top: 0, left: (x - left) * scale, width: width * scale, height: beforeH * scale, overflow: "hidden", ...style }}>
      <Img src={staticFile(scene[which])} style={{ position: "absolute", left: -x * scale, top: -y * scale, width: WINDOW_W }} />
    </div>
  );
  const shown = added ? interpolate(p, [0.1, 0.7], [0, 1], clamp) : interpolate(p, [0.3, 0.9], [1, 0], clamp);
  const cut = `inset(0 ${Math.max(0, thing.x + thing.width - to) * scale}px 0 ${Math.max(0, from - thing.x) * scale}px)`;
  return (
    <div
      style={{
        position: "absolute",
        left: left * scale,
        top: (beforeY - at) * scale,
        width: (right - left) * scale,
        height: beforeH * scale,
        overflow: "hidden",
        background: slide.ground,
      }}
    >
      {piece(added ? "after" : "before", thing.x, thing.width, added ? afterY : beforeY, { opacity: shown, clipPath: cut })}
      {slide.moves.map((move) => piece("before", move.x, move.width, beforeY, { transform: `translateX(${move.dx * p * scale}px)` }))}
    </div>
  );
};

/**
 * A section that came or went, as it happened: on the page before the section opens at its
 * place and pushes what is below it down, or folds shut and lets what is below come up.
 * Where the page before could not be scrolled as far as the page after is shown, it pushes
 * what is above it up by `lift` as it opens, so that the view needs no scroll after it.
 */
const Grow = ({ scene, at, scale, p, lift }) => {
  const added = scene.type === "added";
  const up = lift * p * scale;
  const top = (scene.beforeY - at) * scale - up;
  const open = (added ? scene.afterH * p : scene.beforeH * (1 - p)) * scale;
  // The page under the section: from the page after when it came, which is long enough to
  // fill the view while the page moves up
  const below = added ? scene.afterY + scene.afterH : scene.beforeY + scene.beforeH;
  const strip = (which, y, style) => (
    <div style={{ position: "absolute", left: 0, width: WINDOW_W, overflow: "hidden", ...style }}>
      <Img src={staticFile(scene[which])} style={{ position: "absolute", left: 0, top: -y * scale, width: WINDOW_W }} />
    </div>
  );
  return (
    <>
      {up > 0 && strip("before", at + lift * p, { top: 0, height: Math.max(0, top) })}
      {strip(added ? "after" : "before", added ? scene.afterY : scene.beforeY, { top, height: open })}
      {strip(added ? "after" : "before", below, { top: top + open, height: VIEW_H * scale })}
    </>
  );
};

/** A place that changed, as a wipe: the page after is drawn over the place from left to right. */
const Wipe = ({ rect, windowH, p, children }) => {
  const front = rect.left + rect.width * p;
  return (
    <>
      <div
        style={{
          position: "absolute",
          inset: 0,
          clipPath: `inset(${Math.max(0, rect.top)}px ${Math.max(0, WINDOW_W - front)}px ${Math.max(0, windowH - rect.top - rect.height)}px ${Math.max(0, rect.left)}px)`,
        }}
      >
        {children}
      </div>
      <div
        style={{
          position: "absolute",
          left: front - 1,
          top: rect.top,
          width: 2,
          height: rect.height,
          background: WHITE,
          boxShadow: "0 0 14px rgba(255,255,255,0.7)",
          opacity: interpolate(p, [0, 0.08, 0.92, 1], [0, 0.9, 0.9, 0], clamp),
        }}
      />
    </>
  );
};

/** How long another page takes to push the one before out of the recording. */
const PUSH = 18;

/** How long each way of changing takes. */
const MOVES = { slide: SLIDE, grow: 24, wipe: 24 };

const Scene = ({ scene, index, count, texts, previous }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const length = sceneFrames(scene);
  const { scale, windowH, hasBefore, hasAfter, both, wanted, tops, rects, empty, close } = plan(scene);

  // As in a recording, the page is scrolled to the place: two pushes of the wheel, each
  // running out, from further up and not from so far that it races
  const flick = (from, to) => interpolate(frame, [from, to], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const flicked = 1 - 0.62 * flick(10, 30) - 0.38 * flick(27, 52);
  // Each side from no further up than its own top: a shorter page has less to scroll
  const leadFor = (which) => Math.min(tops[which], 520) * flicked;

  // Once the page has come to rest the camera goes to the change. There the page before
  // stands still for a good second, the place marked with a dashed line, so that one has
  // seen it; then it changes to the page after in place.
  const depart = 46;
  const marked = depart + 34;
  const change = both ? marked + 44 : marked;
  // The change happens as it would on the page: something put into a row moves the things
  // beside it, a section opens or folds shut, and a place that changed is wiped over. What
  // is there then is the page before with this one change, and it stays: the page after
  // may hold other changes as well, and they have scenes of their own
  const motion = !both || scene.page ? null : scene.slide ? "slide" : scene.type === "changed" ? "wipe" : "grow";
  const moved = motion
    ? interpolate(frame, [change, change + MOVES[motion]], [0, 1], { ...clamp, easing: motion === "wipe" ? Easing.inOut(Easing.cubic) : reveal })
    : null;
  const after = !hasBefore ? 1 : !hasAfter || motion ? 0 : interpolate(frame, [change, change + 6], [0, 1], clamp);
  const side = (motion ? frame >= change : after >= 0.5) ? "after" : "before";
  const lead = leadFor(side);
  // A section that came at the end of what the page before could show pushes the page up
  // as it opens, so that it ends up where it stands in the view after. What changed above it
  // on the same page put it a little lower there
  const grows = motion === "grow" && scene.type === "added";
  const lift = grows ? Math.max(0, tops.after - tops.before - (scene.afterY - scene.beforeY)) : 0;
  // Where the page after is laid over the page before: its band on the band before
  const afterTop = !motion ? tops.after : grows ? tops.after : tops.before + (scene.afterY - scene.beforeY);
  // How far the place after is from where it is in its own view, in the window
  const behind = (tops.after - afterTop) * scale;

  // The camera goes to a small change on a spring, and comes back before the scene ends
  const settle = { damping: 200, mass: 1, stiffness: 90 };
  const near =
    spring({ frame: frame - (depart + 4), fps, config: settle }) -
    spring({ frame: frame - (length - 44), fps, config: settle });
  const zoom = 1 + (close.scale - 1) * near;
  // The mark: it shows on the page before, and when the page changes it moves and grows
  // into the place on the page after. How it looks says what the place is: a dashed line
  // around what was, hatched where there is nothing, a solid line in the accent around what
  // is now. Around it the page is dimmed a little, so the eye goes to the place at once.
  // A whole page that came or went needs no mark: it would only line the window
  const shown = scene.page ? 0 : interpolate(frame, [marked, marked + 12], [0, 1], clamp) - interpolate(frame, [length - 40, length - 24], [0, 1], clamp);
  const morph = moved ?? (both ? interpolate(frame, [change, change + 14], [0, 1], { ...clamp, easing: reveal }) : hasAfter ? 1 : 0);
  const mix = (name) => rects.before[name] + (rects.after[name] - rects.before[name]) * morph;
  const mark = { left: mix("left"), top: mix("top") + lead * scale + behind * morph, width: mix("width"), height: mix("height") };
  const looks = {
    was: empty.before ? 0 : 1 - morph,
    slot: (empty.before ? 1 - morph : 0) + (empty.after ? morph : 0),
    now: empty.after ? 0 : morph,
  };
  // What is new lights up for a moment as it comes
  const flash = empty.after ? 0 : interpolate(frame, [change, change + 8, change + 36], [0, 0.26, 0], clamp);

  // The place a wipe runs over: what it was and what it is, together, where the page after
  // stands while it runs
  const was = rects.before;
  const now = { ...rects.after, top: rects.after.top + behind };
  const wiped = {
    left: Math.min(was.left, now.left),
    top: Math.min(was.top, now.top),
    width: Math.max(was.left + was.width, now.left + now.width) - Math.min(was.left, now.left),
    height: Math.max(was.top + was.height, now.top + now.height) - Math.min(was.top, now.top),
  };
  // To another page the recording moves on sideways; on the same page it stays
  const away = Boolean(previous && previous.route !== scene.route);
  const pushed = interpolate(frame, [0, PUSH], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });

  const page = (which, at) => (
    <Img src={staticFile(scene[which])} style={{ position: "absolute", left: 0, top: -at * scale, width: WINDOW_W }} />
  );
  const kind = kindOf(scene, texts);
  // Where the steps of a state or the login stopped: a line of its own under the recording
  const stop = stopLine(scene, texts);
  const size = scene.text && (scene.text.length > 170 || stop) ? 28 : 32;
  // The first scene brings the window in, the last takes it out; between them it stays
  const first = index === 0;
  const last = index === count - 1;
  const appear = first ? rise(frame, 0, 40, 44) : {};
  const out = last ? interpolate(frame, [length - 12, length], [1, 0], clamp) : 1;

  return (
    <AbsoluteFill style={{ opacity: out }}>
      {/* What this scene is, above the recording: a number, the kind of change, on how many pages */}
      <div style={{ position: "absolute", left: WINDOW_X, top: 30, height: 40, display: "flex", alignItems: "center", gap: 20, ...rise(frame, 0, 12) }}>
        <span style={{ ...label, fontVariantNumeric: "tabular-nums" }}>
          {String(index + 1).padStart(2, "0")} / {String(count).padStart(2, "0")}
        </span>
        <span style={{ width: 10, height: 10, borderRadius: 1, background: TEAL }} />
        <span style={{ ...label, color: WHITE }}>{kind}</span>
        <span style={{ fontFamily: MONO, fontSize: 20, color: GRAY }}>
          {scene.route}
          {scene.state && <span style={{ fontFamily: SANS, fontWeight: 400 }}> › {scene.state}</span>}
        </span>
        {scene.routes > 1 && <span style={{ fontFamily: SANS, fontSize: 20, fontWeight: 300, color: GRAY }}>{texts.more(scene.routes - 1)}</span>}
      </div>

      <div
        style={{
          position: "absolute",
          left: WINDOW_X,
          top: WINDOW_Y,
          width: WINDOW_W,
          borderRadius: 14,
          overflow: "hidden",
          // A line lighter than the stage, so a page in its colours still reads as a page
          boxShadow: "0 0 0 1px rgba(255,255,255,0.2), 0 40px 120px rgba(0,0,0,0.55), 0 12px 32px rgba(0,0,0,0.35)",
          ...appear,
        }}
      >
        <div style={{ position: "relative", width: WINDOW_W, height: windowH, overflow: "hidden", background: INK_DEEP }}>
          <div
            style={{
              position: "absolute",
              inset: 0,
              transformOrigin: `${close.cx}px ${close.cy}px`,
              transform: `translate(${close.x * near}px, ${close.y * near}px) scale(${zoom})`,
            }}
          >
            {/* The page of the scene before stays for a moment: a page takes a moment to load.
                Another page comes in from the side and pushes it out */}
            {previous && frame < (away ? PUSH : 8) && (
              <Img
                src={staticFile(previous[previous.type === "removed" ? "before" : "after"])}
                style={{
                  position: "absolute",
                  left: 0,
                  top: -plan(previous).tops[previous.type === "removed" ? "before" : "after"] * scale,
                  width: WINDOW_W,
                  transform: `translateX(${-pushed * WINDOW_W}px)`,
                }}
              />
            )}
            <div
              style={{
                position: "absolute",
                inset: 0,
                opacity: previous && !away ? interpolate(frame, [3, 8], [0, 1], clamp) : 1,
                transform: away ? `translateX(${(1 - pushed) * WINDOW_W}px)` : undefined,
                background: away ? INK_DEEP : undefined,
              }}
            >
              {hasBefore && page("before", tops.before - leadFor("before"))}
              {motion === "slide" && frame >= change && (
                <Slide scene={scene} at={tops.before - leadFor("before")} scale={scale} p={moved} />
              )}
              {motion === "grow" && frame >= change && (
                <Grow scene={scene} at={tops.before - leadFor("before")} scale={scale} p={moved} lift={lift} />
              )}
              {motion === "wipe" && frame >= change && (
                <Wipe rect={wiped} windowH={windowH} p={moved}>
                  {page("after", afterTop - leadFor("after"))}
                </Wipe>
              )}
              {hasAfter && (
                <div style={{ position: "absolute", inset: 0, opacity: after }}>
                  {page("after", afterTop - leadFor("after"))}
                </div>
              )}
            </div>
            <div
              style={{
                position: "absolute",
                ...mark,
                borderRadius: 6 / zoom,
                opacity: shown,
                boxShadow: "0 0 0 4000px rgba(0,0,0,0.18)",
              }}
            >
              {[
                ["was", { border: `${3 / zoom}px dashed #85858f` }],
                [
                  "slot",
                  {
                    border: `${3 / zoom}px dashed #85858f`,
                    background: "repeating-linear-gradient(135deg, rgba(133,133,143,0.34) 0 2px, rgba(133,133,143,0.08) 2px 9px)",
                  },
                ],
                ["now", { border: `${3 / zoom}px solid ${TEAL}`, background: `rgba(45,212,191,${flash})` }],
              ].map(([name, look]) => (
                <span key={name} style={{ position: "absolute", inset: 0, boxSizing: "border-box", borderRadius: 6 / zoom, opacity: looks[name], ...look }} />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Which side this is: a tab on the top edge of the recording, half on the stage and
          half on the page, where a page keeps little but the ground of its header */}
      <span
        style={{
          position: "absolute",
          left: WINDOW_X + WINDOW_W / 2,
          top: WINDOW_Y,
          transform: "translate(-50%, -50%)",
          padding: "7px 16px 7px 18px",
          borderRadius: 8,
          ...label,
          fontSize: 16,
          lineHeight: "20px",
          color: side === "after" ? INK_DEEP : WHITE,
          background: side === "after" ? TEAL : "#3f3f46",
          boxShadow: "0 0 0 1px rgba(255,255,255,0.22), 0 8px 24px rgba(0,0,0,0.45)",
          opacity: appear.opacity ?? 1,
        }}
      >
        {side === "after" ? texts.after : texts.before}
      </span>

      {/* The sentence, as the subtitle of the recording, and above it where the steps stopped */}
      {(scene.text || stop) && (
        <p
          style={{
            position: "absolute",
            left: WINDOW_X,
            width: WINDOW_W,
            top: WINDOW_Y + windowH + 12,
            height: HEIGHT - WINDOW_Y - windowH - 28,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            ...rise(frame, 10, 12),
          }}
        >
          {stop && (
            <span style={{ display: "flex", alignItems: "center", gap: 14, fontFamily: SANS, fontSize: 24, lineHeight: "32px", fontWeight: 400, color: GRAY, maxWidth: 1400 }}>
              <span style={{ width: 10, height: 10, borderRadius: 1, flex: "none", border: `2px solid ${GRAY}`, boxSizing: "border-box" }} />
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{stop}</span>
            </span>
          )}
          {scene.text && (
            <span style={{ fontFamily: SANS, fontSize: size, lineHeight: `${size + 10}px`, fontWeight: 350, color: WHITE, textAlign: "center", textWrap: "balance", maxWidth: 1240 }}>
              {scene.words?.length
                ? scene.words.map((word, at) => <Word key={at} word={word} seconds={(frame - VOICE_FROM) / FPS} />)
                : scene.text}
            </span>
          )}
        </p>
      )}
      {scene.audio && (
        <Sequence from={VOICE_FROM}>
          <Audio src={staticFile(scene.audio)} />
        </Sequence>
      )}
    </AbsoluteFill>
  );
};

/** The row of cells above the recording: one per scene, the current one lit. */
const Progress = ({ count, current, within }) => (
  <div style={{ position: "absolute", right: WINDOW_X, top: 40, display: "flex", gap: 8, alignItems: "center" }}>
    {Array.from({ length: count }, (_, index) => (
      <span key={index} style={{ position: "relative", width: 20, height: 20, borderRadius: 2, background: index < current ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.12)" }}>
        {index === current && (
          <span style={{ position: "absolute", inset: 0, borderRadius: 2, background: TEAL, opacity: interpolate(within, [0, 0.08], [0, 1], clamp) }} />
        )}
      </span>
    ))}
  </div>
);

const End = ({ summary, texts, scenes }) => {
  const frame = useCurrentFrame();
  const rows = scenes.slice(0, 6);
  return (
    <AbsoluteFill style={{ opacity: interpolate(frame, [0, 12], [0, 1], clamp) }}>
      <div style={{ position: "absolute", left: MARGIN, top: 72, ...label }}>changereel</div>
      <div style={{ position: "absolute", left: MARGIN, top: 328 }}>
        <h1
          style={{
            fontFamily: SANS,
            fontSize: 80,
            lineHeight: 1.05,
            fontWeight: 650,
            color: WHITE,
            textTransform: "uppercase",
            margin: "0 0 0 -0.05em",
            width: 760,
            ...rise(frame, 8, 32, 44),
          }}
        >
          {summary}
        </h1>
        <p style={{ fontFamily: SANS, fontSize: 24, lineHeight: "32px", fontWeight: 300, color: GRAY, margin: "40px 0 0", ...rise(frame, 18) }}>
          {texts.madeWith}
        </p>
      </div>
      <div style={{ position: "absolute", left: 1000, top: 336, width: 840 }}>
        {rows.map((scene, index) => (
          <div
            key={index}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 24,
              padding: "20px 0",
              borderTop: `1px solid ${INK_RAISED}`,
              ...(index === rows.length - 1 ? { borderBottom: `1px solid ${INK_RAISED}` } : {}),
              ...rise(frame, 14 + index * 4, 16),
            }}
          >
            <span style={{ ...label, width: 44, fontVariantNumeric: "tabular-nums" }}>{String(index + 1).padStart(2, "0")}</span>
            <span style={{ width: 10, height: 10, borderRadius: 1, background: TEAL, flex: "none", transform: "translateY(-2px)" }} />
            <span style={{ fontFamily: SANS, fontSize: 28, lineHeight: "36px", fontWeight: 500, color: WHITE, width: 300, flex: "none" }}>
              {kindOf(scene, texts)}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 22, color: GRAY, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {scene.route}
              {scene.state && <span style={{ fontFamily: SANS, fontWeight: 400 }}> › {scene.state}</span>}
              {scene.routes > 1 ? ` +${scene.routes - 1}` : ""}
            </span>
          </div>
        ))}
        {scenes.length > rows.length && (
          <p style={{ ...label, margin: "24px 0 0", ...rise(frame, 40, 16) }}>+ {scenes.length - rows.length}</p>
        )}
      </div>
    </AbsoluteFill>
  );
};

export const Reel = ({ title, summary, scenes, language, facts = [] }) => {
  useFonts();
  const frame = useCurrentFrame();
  const texts = textsFor(language);
  const starts = sceneStarts(scenes);
  // Where the closing card starts
  const at = duration(scenes) - END;
  const current = starts.findLastIndex((start) => frame >= start);
  return (
    <AbsoluteFill style={{ background: INK }}>
      <Sequence durationInFrames={TITLE}>
        <Title title={title} summary={summary} facts={facts} />
      </Sequence>
      {current >= 0 && frame < at && (
        <Progress count={scenes.length} current={current} within={(frame - starts[current]) / sceneFrames(scenes[current])} />
      )}
      {scenes.map((scene, index) => (
        <Sequence key={index} from={starts[index]} durationInFrames={sceneFrames(scene)}>
          <Scene scene={scene} index={index} count={scenes.length} texts={texts} previous={scenes[index - 1]} />
        </Sequence>
      ))}
      <Sequence from={at} durationInFrames={END}>
        <End summary={summary} texts={texts} scenes={scenes} />
      </Sequence>
    </AbsoluteFill>
  );
};

export const Root = () => (
  <Composition
    id="Reel"
    component={Reel}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
    durationInFrames={duration([])}
    defaultProps={{ title: "What changed", summary: "", scenes: [], facts: [] }}
    calculateMetadata={({ props }) => ({ durationInFrames: duration(props.scenes) })}
  />
);
