(function () {
  var track = document.getElementById("track");
  var knob  = document.getElementById("knob");
  var els = {
    pUp: document.getElementById("pUp"), pDown: document.getElementById("pDown"),
    pSum: document.getElementById("pSum"),
    bUp: document.getElementById("bUp"), bDown: document.getElementById("bDown"),
    wUp: document.getElementById("wUp"), wDown: document.getElementById("wDown")
  };

  // The venue's grid is three decimals, so the readout is too — a price off the grid
  // is rejected by the pool, and showing one here would be showing an impossible order.
  var STEP = 0.001, MIN = 0.010, MAX = 0.990;
  var p = 0.620;

  function fmt(v) { return v.toFixed(3); }

  function render() {
    var up = p, down = 1 - p;
    var pct = (p * 100).toFixed(1) + "%", inv = ((1 - p) * 100).toFixed(1) + "%";
    knob.style.left = pct;
    els.bUp.style.width = pct;   els.bDown.style.width = inv;
    els.wUp.style.width = pct;   els.wDown.style.width = inv;
    els.pUp.textContent = fmt(up);
    els.pDown.textContent = fmt(down);
    // Written out rather than hard-coded: a hard-coded 1.000 would be a claim, and the
    // whole point of this control is that you can check it.
    els.pSum.textContent = fmt(up + down);
    track.setAttribute("aria-valuenow", fmt(p));
    track.setAttribute("aria-valuetext", fmt(p));
  }

  function set(v) {
    p = Math.min(MAX, Math.max(MIN, Math.round(v / STEP) * STEP));
    render();
  }

  function fromEvent(e) {
    var r = track.getBoundingClientRect();
    if (r.width > 0) set((e.clientX - r.left) / r.width);
  }

  var dragging = false;
  track.addEventListener("pointerdown", function (e) {
    dragging = true;
    track.setPointerCapture(e.pointerId);
    fromEvent(e);
    track.focus();
  });
  track.addEventListener("pointermove", function (e) { if (dragging) fromEvent(e); });
  function stop(e) {
    if (!dragging) return;
    dragging = false;
    try { track.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  track.addEventListener("pointerup", stop);
  track.addEventListener("pointercancel", stop);

  track.addEventListener("keydown", function (e) {
    var big = 0.05;
    var moves = {
      ArrowLeft: -STEP, ArrowRight: STEP, ArrowDown: -STEP, ArrowUp: STEP,
      PageDown: -big, PageUp: big
    };
    if (e.key in moves) { set(p + moves[e.key]); e.preventDefault(); return; }
    if (e.key === "Home") { set(MIN); e.preventDefault(); return; }
    if (e.key === "End") { set(MAX); e.preventDefault(); }
  });

  render();
})();
