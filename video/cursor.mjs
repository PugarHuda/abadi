/**
 * A pointer the camera can see.
 *
 * Playwright's recorder films the page, not the operator: `page.mouse.move` and `page.click`
 * dispatch real events and leave no trace on screen, so every shot in this film showed a deck
 * advancing and a panel scrolling with nothing visibly doing it. A demo of software somebody
 * operates should show it being operated.
 *
 * So the page draws its own cursor. `install()` injects an element and a `mousemove` listener
 * before any page script runs; `moveTo()` and `clickOn()` drive the real mouse and the drawn
 * one follows, because it is listening to the same events a user would generate. Nothing is
 * faked except the picture of the pointer — the clicks are Playwright's own.
 *
 * It is deliberately not a screenshot of a system cursor. A recorded film is scaled and
 * re-encoded, and a 32px OS bitmap turns to mush; this is a vector drawn at the size the
 * frame needs, in the film's own ink.
 */

/** Injected before the page's own scripts, so it survives navigation within a context. */
export async function install(page) {
  await page.addInitScript(() => {
    const draw = () => {
      if (document.getElementById("__cursor")) return;
      const el = document.createElement("div");
      el.id = "__cursor";
      el.setAttribute("aria-hidden", "true");
      /* Fixed, above everything, and never a pointer target itself — a cursor that can be
       * hovered would change the page it is supposed to be observing. */
      el.style.cssText = [
        "position:fixed", "left:0", "top:0", "z-index:2147483647",
        "pointer-events:none", "width:28px", "height:28px",
        "transform:translate(-2px,-2px)", "will-change:transform",
        "transition:transform 40ms linear",
      ].join(";");
      el.innerHTML =
        '<svg viewBox="0 0 28 28" width="28" height="28">' +
        // A drop shadow, so the pointer stays readable over ink as well as paper.
        '<path d="M4 2 L4 22 L9.2 17.2 L12.4 24 L15.6 22.4 L12.5 16 L19 15.6 Z"' +
        ' fill="rgba(22,38,43,.35)" transform="translate(1.5,1.5)"/>' +
        '<path d="M4 2 L4 22 L9.2 17.2 L12.4 24 L15.6 22.4 L12.5 16 L19 15.6 Z"' +
        ' fill="#F5F1E6" stroke="#16262B" stroke-width="1.6" stroke-linejoin="round"/>' +
        "</svg>";
      (document.body || document.documentElement).appendChild(el);
    };

    const place = (x, y) => {
      const el = document.getElementById("__cursor");
      if (el) el.style.transform = `translate(${x - 2}px, ${y - 2}px)`;
    };

    /* The page is scaled with CSS `zoom` for filming, which scales fixed-position elements
     * too — so a pointer placed at the event's client coordinates would sit at the wrong
     * spot by exactly the zoom factor. Divide it back out. */
    const zoomed = (v) => v / (Number(getComputedStyle(document.documentElement).zoom) || 1);

    addEventListener("mousemove", (e) => place(zoomed(e.clientX), zoomed(e.clientY)), true);

    // A click the eye can catch: one ring, gone in a third of a second.
    addEventListener(
      "mousedown",
      (e) => {
        const r = document.createElement("div");
        r.style.cssText = [
          "position:fixed", `left:${zoomed(e.clientX)}px`, `top:${zoomed(e.clientY)}px`,
          "width:0", "height:0", "z-index:2147483646", "pointer-events:none",
          "border:2px solid #B4331C", "border-radius:50%",
          "transform:translate(-50%,-50%)", "opacity:.9",
          "transition:width .32s ease-out,height .32s ease-out,opacity .32s ease-out",
        ].join(";");
        (document.body || document.documentElement).appendChild(r);
        requestAnimationFrame(() => {
          r.style.width = "46px";
          r.style.height = "46px";
          r.style.opacity = "0";
        });
        setTimeout(() => r.remove(), 400);
      },
      true,
    );

    if (document.readyState === "loading") addEventListener("DOMContentLoaded", draw);
    else draw();
  });
}

/** Park the pointer somewhere sensible before the shot starts, with no visible travel. */
export async function park(page, x, y) {
  await page.mouse.move(x, y);
}

/**
 * Glide to a point over `ms`, easing at both ends. Playwright's own `steps` option moves in
 * equal jumps with no timing control, which reads as a machine; a hand slows into a target.
 */
export async function moveTo(page, x, y, ms = 700) {
  const frames = Math.max(2, Math.round((ms / 1000) * 60));
  const start = await page.evaluate(() => {
    const el = document.getElementById("__cursor");
    if (!el) return { x: 0, y: 0 };
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform);
    return m ? { x: Number(m[1]) + 2, y: Number(m[2]) + 2 } : { x: 0, y: 0 };
  });
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  for (let i = 1; i <= frames; i++) {
    const t = ease(i / frames);
    await page.mouse.move(start.x + (x - start.x) * t, start.y + (y - start.y) * t);
    await new Promise((r) => setTimeout(r, ms / frames));
  }
}

/** Move onto an element, pause the way a hand does, then click it. */
export async function clickOn(page, selector, ms = 700) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) return false;
  /* No zoom correction here, and that is the tested answer rather than the obvious one.
   * `getBoundingClientRect` already reports in the zoomed space — the same fact the camera
   * move in capture.mjs has a paragraph about — so the box is where the mouse should go.
   * Scaling it by the zoom sent the click past the button and the deck never advanced. */
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await moveTo(page, x, y, ms);
  await new Promise((r) => setTimeout(r, 180));
  await page.mouse.click(x, y);
  return true;
}
