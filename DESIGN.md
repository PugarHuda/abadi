---
name: Abadi
description: A strip-chart recorder. Warm chart stock under a printed time grid, one pen ink for every mark and letter, a second pen for the Down channel, and a red event pen reserved for a true alarm. Figures in mono because they are measurements; everything else in one variable grotesque whose width axis does the instrument's own work.
colors:
  stock: "#F5F1E6"
  stock-sunk: "#EBE5D5"
  rule: "#DFD5BF"
  rule-major: "#C3B392"
  ctl-line: "#93805E"
  ink: "#16262B"
  pencil: "#5A6663"
  pen-down: "#2A3A6B"
  alarm: "#B4331C"
typography:
  wordmark:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "clamp(30px, 5vw, 44px)"
    fontWeight: 700
    fontStretch: "112%"
    lineHeight: 0.92
    letterSpacing: "-0.03em"
  display:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "clamp(28px, 4.6vw, 46px)"
    fontWeight: 600
    fontStretch: "100%"
    lineHeight: 1.12
    letterSpacing: "-0.022em"
  heading:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.012em"
  subheading:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.008em"
  channel:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    fontStretch: "80%"
    lineHeight: 1.35
    letterSpacing: "0"
  body:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.62
    letterSpacing: "0"
  control:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0"
  label:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  secondary:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0"
  data:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  figure:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "clamp(16px, 2.1vw, 21px)"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "-0.01em"
rounded:
  none: "0px"
  knob: "50%"
spacing:
  xs: "6px"
  sm: "12px"
  md: "20px"
  lg: "40px"
  xl: "72px"
  gutter: "24px"
  rail: "72px"
  measure: "1020px"
  chart: "22px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.stock}"
    typography: "{typography.control}"
    rounded: "{rounded.none}"
    padding: "11px 18px"
  button-primary-hover:
    backgroundColor: "{colors.alarm}"
    textColor: "{colors.stock}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.none}"
    padding: "11px 18px"
  button-secondary-hover:
    backgroundColor: "{colors.stock-sunk}"
  channel:
    backgroundColor: "{colors.stock-sunk}"
    rounded: "{rounded.none}"
    padding: "20px 22px"
  input-text:
    backgroundColor: "{colors.stock}"
    textColor: "{colors.ink}"
    typography: "{typography.data}"
    rounded: "{rounded.none}"
    padding: "11px 12px"
  heading-section:
    textColor: "{colors.ink}"
    typography: "{typography.heading}"
    padding: "0 0 10px"
---

# Abadi

## Overview

Abadi is a strip-chart recorder. A roll of gridded paper feeds at a constant rate under a
fixed pen arm; the pen writes whatever the input is, and the paper keeps it. That is the
whole system, and it was chosen because it is the one visual world that makes this
product's central honesty structural rather than stated: **an instrument cannot flatter
its subject.** The vault writes a line every fifteen minutes forever, its trace is allowed
to go down, and the project's worst defect to date was a ledger that drew only the
winners — a recorder with a broken pen.

The page is paper, not a screen pretending to be one. Light, because the use scene is a
judge or a depositor reading at a desk on a laptop, checking figures against an explorer
in another tab — not a trading desk at night.

## Colors

### Primary

- **ink `#16262B`** is the pen. Every letter, every rule that means something, every trace
  in channel one, the Up side. It is the only colour that carries body text.

### Secondary

- **pen-down `#2A3A6B`** is the recorder's second pen: the Down channel. It marks traces,
  bars, swatches and channel keys. It measures 9.7:1 on stock, so unlike the world it
  replaces it *may* carry text — but it does so only where the text itself means Down.
- **alarm `#B4331C`** is the event pen, and it is **reserved**. It appears when a read
  failed, a transaction reverted, a keeper is silent, or a figure is a correction of a
  published one. Nothing decorative is ever this colour. If red is on the page, something
  happened.

### Neutral

- **stock `#F5F1E6`** the chart paper, the page ground. **stock-sunk `#EBE5D5`** channel
  gutters and instrument beds.
- **rule `#DFD5BF`** the fine time rules of the printed grid. **rule-major `#C3B392`**
  the heavy rules and every hairline border — decorative only, 1.8:1, never a control edge.
- **ctl-line `#93805E`** the boundary of anything interactive: 3.4:1 on stock, which is
  what WCAG 1.4.11 asks of a control and what `rule-major` cannot give.
- **pencil `#5A6663`** the operator's annotation — secondary text, asides, units, captions.
  5.3:1 on stock, so it may carry 13px and up, and nothing smaller.

### Named Rules

- Up and Down are told apart by **channel, weight and dash before hue**: channel one is a
  solid ink trace, channel two a dashed pen-down trace. Colour is never the only signal.
- One ink on one paper. The page has exactly one hue beyond the pens, and it is the alarm.
- Selection is ink on `rule`; the caret is ink; focus is a 2px ink outline offset 3px.

## Typography

Two families, and the first one has a width axis that does the instrument's own work.
**Archivo** — a grotesque drawn for signage and dense technical setting — is the wordmark,
the thesis, every heading, every sentence, and, narrowed to 80%, the chart-margin lettering
on channel keys and table headers. **IBM Plex Mono** is every number, address, hash, price
and table cell, and nothing else: mono is a measurement here, never a costume for
"technical".

### Hierarchy

- Wordmark: Archivo 700 at 112% width, `clamp(30px, 5vw, 44px)`, tracking −0.03em.
- Thesis, one per page at most: Archivo 600, `clamp(28px, 4.6vw, 46px)`, tracking −0.022em.
- Section heading: Archivo 600, 20px, sitting on the section's calibration band with an
  optional aside on the same baseline in 14px pencil. Nothing sits above a heading.
- Body: Archivo 400, 16px, leading 1.62, measure 65–72ch.
- Channel key / table header: Archivo 500 at 80% width, 13px.
- Figures: IBM Plex Mono 500, `clamp(16px, 2.1vw, 21px)`, tabular, units in 12.5px pencil.
- Data: IBM Plex Mono 400, 12.5px.

### Named Rules

- No text under 12px. No uppercase transforms anywhere. No positive letter-spacing.
- Numbers are tabular and never wrap. A figure that has been superseded is struck in
  pencil with its correction beside it; it is not deleted.
- A heading carries its own weight. No eyebrow, kicker, or numbered label above it.

## Layout

The page is a roll of paper feeding under a fixed rail.

- A **calibration rail** 72px wide runs down the left edge, carrying each section's mark
  and staying put while the paper scrolls past it — the one thing on the page that never
  moves, so there is always something to read against. Below 900px it lays down and
  becomes a band above each section.
- Content sits in **channels** between rules, not in cards. A channel is `stock-sunk` with
  a `rule-major` hairline top and bottom and no side borders, because the paper continues.
  Channels do not nest.
- The ground carries the printed time grid: a fine rule every 22px and a heavy one every
  fifth, drawn with `repeating-linear-gradient` so it costs nothing and survives any
  viewport.
- One column, `max-width: 1020px`, 24px gutters. 72px above a heading, 20px below it.
- Responsive behaviour is structural: grids collapse, tables scroll inside their own
  `overflow-x: auto`. The body never scrolls sideways.

## Elevation & Depth

None. Depth is a rule and a sunk ground. No shadows, no blur, no glass. Paper has no
z-axis; a recorder's only relief is the ink sitting on the fibre.

## Shapes

Square. `border-radius: 0` everywhere. The only circle is the pen carriage knob. Icons are
authored SVG at a 1.25px stroke in ink — never a Unicode glyph or an emoji.

## Components

### The pen carriage

The price control is a pen on a carriage. Dragging it moves the pen across the chart and
redraws both channels live. The carriage never animates while it is being dragged; easing
a direct-manipulation control reads as lag.

### Buttons

- Primary: solid ink, stock text, 11×18px, one per channel. Hover swaps to the alarm pen —
  the one place a hue appears on an ordinary control, because pressing it does something.
- Secondary: transparent with a `ctl-line` hairline and ink text; hover sinks to
  `stock-sunk`.
- Disabled at 45% with `not-allowed`. 140ms ease-out, colour only.

### Channels

`stock-sunk` between two `rule-major` hairlines, 20–22px padding, full bleed to the
gutters. Grids inside are `repeat(auto-fit, minmax(180px, 1fr))`.

### Tables

Plex Mono 12.5px, hairline row rules, headers in Archivo 500 at 80% width, numbers
right-aligned where they are compared, wrapped in `overflow-x: auto`.

### Live data

A live figure shows a pen that has not drawn yet — an ellipsis — then the number. A failed
read is stated in a sentence in the alarm pen with a pip in the margin channel. It never
shows a stale value dressed as a live one.

### Traces

A trace is an inline SVG polyline: channel one solid ink at 1.5px, channel two dashed
pen-down at 1.25px. It draws on once with `stroke-dashoffset` when the data lands, and
renders already drawn under `prefers-reduced-motion`. Nothing else on the page animates.

## Two detector rules this world waives, and why

`.impeccable/config.json` ignores exactly two rules site-wide. Both describe the ground
the world stands on, so waiving them per-value would mean waiving them on every page
anyway, and pretending otherwise would be bookkeeping rather than judgement.

- **`cream-palette`** — the rule exists because a warm off-white is the surface AI
  interfaces reach for by reflex. This one is not reached for: it is chart stock, the
  material the direction was chosen for, and it carries a printed grid, two pen inks and
  a reserved event pen that a "tasteful neutral" background does not.
- **`repeating-stripes-gradient`** — the rule exists because gradient stripes are a
  generated-UI signature used as decoration. Here the repeating gradient *is* the printed
  time grid and the second pen's hatch: it is the texture the world is made of, and it
  carries the Up/Down distinction that colour alone is not allowed to carry.

Everything else the detector found was fixed rather than waived, including three
`border-left: 3px` rails, a carriage that animated `width` and `left` against this file's
own rule, and an order-book depth bar dark enough to fail 4.5:1 under its own price.

## Do's and Don'ts

- Do read every number from the chain in the reader's browser, and say so beside it.
- Do let the trace go down. The chart is the argument.
- Do keep the alarm pen for events. A red thing on this page means something happened.
- Do show a superseded figure struck in pencil next to its correction.
- Don't put a label above a heading, or set anything in uppercase.
- Don't use a card where a channel will do, and never nest either.
- Don't animate `width`, `left`, or the pen carriage.
- Don't invent testimonials, customers, benchmarks, or a mainnet.
