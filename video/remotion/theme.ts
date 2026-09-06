/* The film borrows the site's world rather than inventing a second one. These are the
 * values from web/recorder.css; DESIGN.md is the contract they answer to. The alarm pen
 * is here for completeness and is deliberately unused — it is reserved for a true alarm. */
import { loadFont as loadArchivo } from "@remotion/google-fonts/Archivo";
import { loadFont as loadPlex } from "@remotion/google-fonts/IBMPlexMono";

/* Unrestricted, these two pulled 124 font requests per render tab for weights and scripts
 * the film never sets. Only what is actually used. */
export const { fontFamily: SANS } = loadArchivo("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
});
export const { fontFamily: MONO } = loadPlex("normal", {
  weights: ["400", "600"],
  subsets: ["latin"],
});

export const STOCK = "#F5F1E6";
export const STOCK_SUNK = "#EBE5D5";
export const RULE = "#DFD5BF";
export const CTL_LINE = "#93805E";
export const INK = "#16262B";
export const PENCIL = "#4C5754";
export const PEN_DOWN = "#2A3A6B";

/** The chart's own division, and every vertical rhythm in the film is a multiple of it. */
export const CHART = 22;
