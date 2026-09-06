/* The one scene that is drawn rather than filmed.
 *
 * Its text is the real output of the two commands it names, captured into
 * assets/forge-test.txt by video/capture-tests. Nothing here is typed by hand, and the
 * lines arrive in the order the runs printed them.
 *
 * No green ticks: in this world the alarm pen is the only hue and it is reserved for an
 * actual alarm. A passing suite is stated, not celebrated. */
import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { CHART, CTL_LINE, INK, MONO, PENCIL, STOCK_SUNK } from "./theme";

/** Lines land over the first stretch of the scene, then the whole block holds. */
const REVEAL_SECONDS = 4.5;

export const Terminal: React.FC<{ lines: string[] }> = ({ lines }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const per = (REVEAL_SECONDS * fps) / lines.length;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 1360,
          padding: `${CHART * 2}px ${CHART * 2}px`,
          background: STOCK_SUNK,
          borderTop: `1px solid ${CTL_LINE}`,
          borderBottom: `1px solid ${CTL_LINE}`,
          fontFamily: MONO,
          fontSize: 25,
          lineHeight: `${CHART * 1.72}px`,
        }}
      >
        {lines.map((line, i) => {
          const at = i * per;
          const shown = interpolate(frame, [at, at + 4], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const isCommand = line.startsWith("$");
          // A blank line in the capture is the gap between the two runs. Keep the rhythm.
          if (!line.trim()) return <div key={i} style={{ height: CHART }} />;
          return (
            <div
              key={i}
              style={{
                opacity: shown,
                color: isCommand ? INK : PENCIL,
                fontWeight: isCommand ? 600 : 400,
                whiteSpace: "pre",
              }}
            >
              {line}
            </div>
          );
        })}
        <span
          style={{
            display: "inline-block",
            width: 13,
            height: 26,
            marginTop: 8,
            background: INK,
            // Half a second on, half off — a cursor, not a strobe.
            opacity: Math.floor(frame / (fps / 2)) % 2 === 0 ? 1 : 0,
          }}
        />
      </div>
    </div>
  );
};
