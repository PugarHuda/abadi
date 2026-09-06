import React from "react";
import { Composition } from "remotion";
import { Film, type Timing } from "./Film";
import timing from "../assets/timing.json";

const t = timing as Timing;

export const Root: React.FC = () => (
  <Composition
    id="abadi-demo"
    component={Film}
    durationInFrames={t.durationInFrames}
    fps={t.fps}
    width={1920}
    height={1080}
    defaultProps={{ timing: t }}
  />
);
