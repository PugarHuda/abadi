/* Subtitles, on the word.
 *
 * The timings in `captions` are not estimated from the audio and were never aligned after
 * the fact — edge-tts reports a WordBoundary per word as it synthesises, and video/tts.mjs
 * groups those into cards. So a card appears exactly when its first word is spoken.
 *
 * The plate hugs its text rather than running the full width: a caption should cover as
 * little of the footage as it can get away with. */
import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { CHART, CTL_LINE, INK, SANS, STOCK } from "./theme";

export type Caption = { text: string; start: number; end: number };

const FADE = 3; // frames

export const Captions: React.FC<{ captions: Caption[] }> = ({ captions }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  // The card whose window contains now; otherwise the one just gone, so a gap between
  // words does not blink the plate out and back in mid-sentence.
  const i = captions.findIndex((c) => t >= c.start && t < c.end + 0.28);
  const active = i >= 0 ? captions[i] : null;
  if (!active) return null;

  const inAt = active.start * fps;
  const opacity = interpolate(frame, [inAt, inAt + FADE], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: CHART * 3,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          opacity,
          maxWidth: 1500,
          padding: `${CHART * 0.7}px ${CHART * 1.5}px`,
          background: STOCK,
          borderTop: `1px solid ${CTL_LINE}`,
          color: INK,
          fontFamily: SANS,
          fontSize: 42,
          fontWeight: 500,
          lineHeight: 1.32,
          textAlign: "center",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {active.text}
      </div>
    </div>
  );
};
