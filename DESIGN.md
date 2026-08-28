---
name: Abadi
description: One contract split by a price. Ink ground, cotton text, turmeric for Up and teal for Down; numbers in mono, everything else in a humanist sans, headings in a grotesque with character.
colors:
  ink: "#14203A"
  ink-raised: "#1B2A48"
  ink-line: "#2A3B5E"
  cotton: "#EAE4D6"
  cotton-dim: "#8D97AE"
  turmeric: "#E0A045"
  teal: "#4FA396"
typography:
  display:
    fontFamily: "Bricolage Grotesque, system-ui, sans-serif"
    fontSize: "clamp(26px, 4.4vw, 44px)"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  wordmark:
    fontFamily: "Bricolage Grotesque, system-ui, sans-serif"
    fontSize: "clamp(32px, 5.4vw, 46px)"
    fontWeight: 800
    lineHeight: 0.9
    letterSpacing: "-0.045em"
  heading:
    fontFamily: "Bricolage Grotesque, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Public Sans, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  subheading:
    fontFamily: "Bricolage Grotesque, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  control:
    fontFamily: "Public Sans, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "Public Sans, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  secondary:
    fontFamily: "Public Sans, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  data:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  figure:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "clamp(15px, 2vw, 20px)"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "normal"
rounded:
  none: "0px"
  knob: "50%"
spacing:
  xs: "6px"
  sm: "12px"
  md: "22px"
  lg: "44px"
  xl: "76px"
  gutter: "24px"
  measure: "1000px"
components:
  button-primary:
    backgroundColor: "transparent"
    textColor: "{colors.turmeric}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "12px 18px"
  button-primary-hover:
    backgroundColor: "{colors.turmeric}"
    textColor: "{colors.ink}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.cotton}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "12px 18px"
  button-secondary-hover:
    textColor: "{colors.turmeric}"
  panel:
    backgroundColor: "{colors.ink-raised}"
    rounded: "{rounded.none}"
    padding: "22px 26px"
  input-text:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.cotton}"
    typography: "{typography.data}"
    rounded: "{rounded.none}"
    padding: "11px 12px"
  heading-section:
    textColor: "{colors.cotton}"
    typography: "{typography.heading}"
    padding: "0 0 12px"
---

# Abadi

## Overview

Abadi is a market-making vault for short-lived binary windows. The visual system is built
from the trade itself: one contract split by a price into an Up side and a Down side that
never equal each other and always add to the whole. Everything on the page is either a
measurement (set in mono, read from the chain) or a sentence (set in a humanist sans, in
the product's own voice). Headings are the one place the type has personality.

Surfaces are dark by use scene — this is read at a desk or on a phone by someone checking
a position, not by someone being sold to — and the ground is a deep ink, not black, so the
two accent hues sit on it without glowing.

## Colors

### Primary

- **turmeric `#E0A045`** is Up, and it is the one action colour. Primary buttons, the
  current-page link, the selected price, the wordmark's second half. Never a fill behind
  body text.

### Secondary

- **teal `#4FA396`** is Down. It lives on bars, fills and swatches, where colour carries
  the Up/Down meaning. It is not a text colour on the ink ground: at 16px it reads as neon
  and fails 4.5:1 against `ink-raised`; numbers that mean Down are set in cotton beside a
  teal bar instead.

### Neutral

- **ink `#14203A`** page ground. **ink-raised `#1B2A48`** panels and instruments.
  **ink-line `#2A3B5E`** hairlines, borders, disabled outlines — never text.
- **cotton `#EAE4D6`** all primary text and figures. **cotton-dim `#8D97AE`** secondary
  text, labels, asides; 5.3:1 on ink, 4.9:1 on ink-raised, so it may carry 14px text but
  nothing smaller.

### Named Rules

- Colour means something or it is not used: turmeric = Up / action, teal = Down. There is
  no decorative accent.
- Text is cotton or cotton-dim. The two hues are for marks, bars and one primary action.
- Selection is turmeric on ink; the caret is turmeric.

## Typography

Three faces, three jobs. **Bricolage Grotesque** for the wordmark, the thesis and section
headings — its width axis gives the display weight character without a second display
face. **Public Sans** for every sentence, label, button and aside. **Martian Mono** for
anything that is a number, an address, a hash, a price or a table cell, and for nothing
else: monospace is a measurement, not a costume for "technical".

### Hierarchy

- Wordmark: Bricolage 800, `clamp(32px, 5.4vw, 46px)`, tracking −0.045em, leading 0.9.
- Thesis (one per page, at most): Bricolage 600, `clamp(26px, 4.4vw, 44px)`, tracking
  −0.025em, the second clause in turmeric.
- Section heading: Bricolage 600, 21px, tracking −0.015em, with a hairline beneath it and
  an optional aside on the same baseline in Public Sans 14px cotton-dim. A heading names
  its section; nothing sits above it.
- Body: Public Sans 400, 16px, leading 1.6, measure 62–68ch.
- Card heading: Bricolage 600, 18px.
- Controls (buttons, nav, notes): Public Sans 500, 15px.
- Secondary / labels / asides: Public Sans 400–500, 13–14px, cotton-dim.
- Figures: Martian Mono 600, `clamp(15px, 2vw, 20px)`, tabular numerals, units in 12px
  cotton-dim 300 beside them.
- Data: Martian Mono 400, 12–13px, tables and addresses.

### Named Rules

- No text under 12px. No uppercase transforms. No letter-spacing above 0 except the
  negative tracking on display sizes.
- Numbers get tabular numerals and never wrap.
- A heading carries its own weight. No eyebrow, kicker, or numbered label above it.

## Layout

One column, `max-width: 1000px`, 24px gutters, sections separated by 76px above a heading
and 22px below it. Instruments (the price slider, the live strip, the ledger) sit in a
panel on `ink-raised` with a hairline border and 22–26px padding. Grids inside panels are
`repeat(auto-fit, minmax(180px, 1fr))` with 16–22px gaps. The deck is the one exception:
full-viewport slides, 940px measure, one visible at a time.

Responsive behaviour is structural — grids collapse, tables scroll inside their own
container — never fluid type below the 12px floor. The page body never scrolls sideways.

## Elevation & Depth

There is none. Depth is a border and a slightly raised ground (`ink-raised` on `ink`).
No shadows, no blur, no glass. Focus is a 2px turmeric outline offset 3px.

## Shapes

Square. `border-radius: 0` on panels, buttons, inputs and bars. The only circle is the
slider knob (13px) and the only curve is the mark's price hairline. Icons are drawn SVG,
1px stroke, cotton at 50%.

## Components

### Buttons

- Primary: transparent, 1px turmeric border, turmeric text, Public Sans 500 15px,
  12×18px padding; hover fills turmeric with ink text; focus-visible turmeric outline;
  disabled at 45% opacity with `not-allowed`. 150ms ease-out on colour only.
- Secondary: same shape with `ink-line` border and cotton text; hover turns border and
  text turmeric.
- One primary per panel.

### Inputs / Fields

Text inputs on `ink` with a hairline border, Martian Mono 16px (16px so mobile Safari
does not zoom), 11×12px padding, turmeric caret, turmeric border on focus. A persistent
label in 13px cotton-dim sits above; the placeholder is an example, never the label.

### Cards / Containers

A panel is a hairline border on `ink-raised`. Panels do not nest.

### Tables

Mono 12–13px, hairline row rules, headers in Public Sans 500 13px cotton-dim, numbers
right-aligned where they are compared, the whole table inside an `overflow-x: auto`
wrapper.

### Live data

A live figure shows an ellipsis while loading, the number when read, and an explicit
sentence when the read failed. It never shows a stale value dressed as a live one.

## Do's and Don'ts

- Do read every number from the chain in the reader's browser; do say so next to it.
- Do state the failure before the fix, in the product's own voice, with units.
- Do keep teal on fills and turmeric on the one action.
- Don't put a label above a heading, a number beside a heading, or a chip anywhere.
- Don't set labels in mono, uppercase, or under 12px.
- Don't animate `width`, `left`, or anything else that forces layout; and don't animate
  a direct-manipulation control at all.
- Don't invent testimonials, customers, benchmarks, or a mainnet.
