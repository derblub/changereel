/**
 * The video: an opening card, one scene per change, a closing card.
 *
 * The scenes are made like one screen recording of the page, with nothing of a browser
 * around it and no pointer on it: rounded corners and a soft shadow. The page is scrolled
 * to the place and the camera goes to the change on a spring. There the page before stands
 * still with the place marked, then changes to the page after, and the mark moves and grows
 * into the place there. A sign in the corner says which side it is. The recording stays through
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
import { textsFor } from "../src/texts.mjs";
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
      ["fonts/google-sans-flex-latin-wght-normal.woff2", "U+0000-00FF, U+2013-2014, U+2190-2199"],
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
  const after = !hasBefore ? 1 : !hasAfter ? 0 : interpolate(frame, [change, change + 6], [0, 1], clamp);
  const side = after >= 0.5 ? "after" : "before";
  const lead = leadFor(side);

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
  const morph = both ? interpolate(frame, [change, change + 14], [0, 1], { ...clamp, easing: reveal }) : hasAfter ? 1 : 0;
  const mix = (name) => rects.before[name] + (rects.after[name] - rects.before[name]) * morph;
  const mark = { left: mix("left"), top: mix("top") + lead * scale, width: mix("width"), height: mix("height") };
  const looks = {
    was: empty.before ? 0 : 1 - morph,
    slot: (empty.before ? 1 - morph : 0) + (empty.after ? morph : 0),
    now: empty.after ? 0 : morph,
  };
  // What is new lights up for a moment as it comes
  const flash = empty.after ? 0 : interpolate(frame, [change, change + 8, change + 36], [0, 0.26, 0], clamp);

  const page = (which, at) => (
    <Img src={staticFile(scene[which])} style={{ position: "absolute", left: 0, top: -at * scale, width: WINDOW_W }} />
  );
  const kind = scene.page ? texts.page(texts.kind[scene.type]) : texts.kind[scene.type];
  const size = scene.text && scene.text.length > 170 ? 28 : 32;
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
        <span style={{ fontFamily: MONO, fontSize: 20, color: GRAY }}>{scene.route}</span>
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
            {/* The page of the scene before stays for a moment: a page takes a moment to load */}
            {previous && frame < 8 && (
              <Img
                src={staticFile(previous[previous.type === "removed" ? "before" : "after"])}
                style={{ position: "absolute", left: 0, top: -plan(previous).tops[previous.type === "removed" ? "before" : "after"] * scale, width: WINDOW_W }}
              />
            )}
            <div style={{ position: "absolute", inset: 0, opacity: previous ? interpolate(frame, [3, 8], [0, 1], clamp) : 1 }}>
              {hasBefore && page("before", tops.before - leadFor("before"))}
              {hasAfter && (
                <div style={{ position: "absolute", inset: 0, opacity: after }}>
                  {page("after", tops.after - leadFor("after"))}
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

      {/* The sentence, as the subtitle of the recording */}
      {scene.text && (
        <p
          style={{
            position: "absolute",
            left: WINDOW_X,
            width: WINDOW_W,
            top: WINDOW_Y + windowH + 12,
            height: HEIGHT - WINDOW_Y - windowH - 28,
            margin: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            ...rise(frame, 10, 12),
          }}
        >
          <span style={{ fontFamily: SANS, fontSize: size, lineHeight: `${size + 10}px`, fontWeight: 350, color: WHITE, textAlign: "center", textWrap: "balance", maxWidth: 1240 }}>
            {scene.words?.length
              ? scene.words.map((word, at) => <Word key={at} word={word} seconds={(frame - VOICE_FROM) / FPS} />)
              : scene.text}
          </span>
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
              {scene.page ? texts.page(texts.kind[scene.type]) : texts.kind[scene.type]}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 22, color: GRAY, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {scene.route}
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
  const starts = [];
  let at = TITLE;
  for (const scene of scenes) {
    starts.push(at);
    at += sceneFrames(scene);
  }
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
