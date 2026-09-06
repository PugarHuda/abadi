/* The film: footage, voice, captions, laid on one timeline.
 *
 * Every duration comes from assets/timing.json, which is derived from how long the voice
 * actually took. Nothing is hand-timed, so retiming the film means re-speaking a line and
 * re-rendering — never nudging a number in here. */
import React from "react";
import {
  AbsoluteFill,
  Audio,
  interpolate,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Captions, type Caption } from "./Captions";
import { Terminal } from "./Terminal";
import { CHART, INK, PENCIL, RULE, SANS, STOCK } from "./theme";

export type Scene = {
  id: string;
  chapter: string | null;
  audio: string;
  durationInFrames: number;
  captions: Caption[];
  shot: { type: string; lines?: string[] };
};

export type Timing = { fps: number; durationInFrames: number; scenes: Scene[] };

/* Frames of overlap between one shot and the next. The picture crossfades; the voice
 * does not, because a voice fading into another voice sounds like a mistake. */
const OVERLAP = 7;

/** A slow drift across the still, so a held shot is never quite frozen. */
const Shot: React.FC<{ scene: Scene; fade: boolean }> = ({ scene, fade }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const opacity = fade
    ? interpolate(frame, [0, OVERLAP], [0, 1], { extrapolateRight: "clamp" })
    : 1;
  const scale = interpolate(frame, [0, durationInFrames], [1, 1.022]);

  return (
    <AbsoluteFill style={{ opacity, backgroundColor: STOCK, overflow: "hidden" }}>
      {scene.shot.type === "terminal" ? (
        <Terminal lines={scene.shot.lines ?? []} />
      ) : (
        <OffthreadVideo
          src={staticFile(`shot-${scene.id}.mp4`)}
          muted
          style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})` }}
        />
      )}
    </AbsoluteFill>
  );
};

/** A chapter marker, stated once and withdrawn. It is navigation, not a headline. */
const Chapter: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(
    frame,
    [0, fps * 0.4, fps * 2.6, fps * 3.2],
    [0, 1, 1, 0],
    { extrapolateRight: "clamp" },
  );
  return (
    <div
      style={{
        position: "absolute",
        top: CHART * 2,
        left: CHART * 3,
        opacity,
        fontFamily: SANS,
        fontSize: 26,
        color: PENCIL,
        letterSpacing: "0.01em",
      }}
    >
      {text}
    </div>
  );
};

/** How far through the roll we are. scaleX, not width — the site bans animating width. */
const Feed: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 3, background: RULE }}>
      <div
        style={{
          height: "100%",
          background: INK,
          transformOrigin: "left center",
          transform: `scaleX(${frame / durationInFrames})`,
        }}
      />
    </div>
  );
};

export const Film: React.FC<{ timing: Timing }> = ({ timing }) => {
  const starts: number[] = [];
  let at = 0;
  for (const s of timing.scenes) {
    starts.push(at);
    at += s.durationInFrames;
  }

  return (
    <AbsoluteFill style={{ backgroundColor: STOCK }}>
      {/* Pictures first, then the word layer, so a caption is never covered by the
          incoming shot during a crossfade. */}
      {timing.scenes.map((scene, i) => (
        <Sequence
          key={`shot-${scene.id}`}
          from={Math.max(0, starts[i] - OVERLAP)}
          durationInFrames={scene.durationInFrames + (i === 0 ? 0 : OVERLAP)}
        >
          <Shot scene={scene} fade={i > 0} />
        </Sequence>
      ))}

      {timing.scenes.map((scene, i) => (
        <Sequence key={`vo-${scene.id}`} from={starts[i]} durationInFrames={scene.durationInFrames}>
          <Audio src={staticFile(scene.audio)} />
          {scene.chapter ? <Chapter text={scene.chapter} /> : null}
          <Captions captions={scene.captions} />
        </Sequence>
      ))}

      <Feed />
    </AbsoluteFill>
  );
};
