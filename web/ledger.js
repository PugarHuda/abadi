/*
 * The track record, computed in the reader's browser from the chain's own logs.
 *
 * Same method as scripts/ledger.ts: every Quoted / Flattened / Settled / Cancelled
 * the vaults ever emitted, off the explorer's log API, decoded here against the vault's
 * event layout, cut into episodes. Nothing is precomputed by us; a reader who doubts a
 * number can fetch the same URL.
 */
(function () {
  var root = document.getElementById("ledger");
  if (!root || !window.ABADI || !window.ABADI.vaults) return;

  var API = window.ABADI.explorer + "/api/v2";
  var ONE = 1000000n;

  // keccak256 of the event signatures, pinned; see `cast keccak "Quoted(uint256,bytes32,uint256,uint256,uint256)"`
  var TOPIC = {
    "0xc45b59478953ba73f9754d36be911593276d3b368ecf15c35a4cb46ccfd235a1": "Quoted",
    "0x4fd20c1bd025107be37e523e1171bdc1c5a5f76d26ec9bff0d09aa53c637a3df": "Flattened",
    "0x23a327ca5a8ed82563c64164ff358b70fd7eb246d17852940bcdb3146cbd4a70": "Settled",
    "0x04dde94bb87efaf575f3ce9227258b233abedab77b1ba7d9326410cc4f63207d": "Cancelled"
  };

  function word(hex, i) { return BigInt("0x" + hex.slice(2 + 64 * i, 66 + 64 * i)); }
  function usd(v) { return (Number(v) / 1e6).toFixed(2); }
  function px(v) { return (Number(v) / 1e6).toFixed(3); }
  function short(a) { return a.slice(0, 10) + "…" + a.slice(-4); }
  function q(sel) { return root.querySelector(sel); }
  function set(sel, text) { var el = q(sel); if (el) el.textContent = text; }

  function fetchLogs(address) {
    var out = [];
    function page(params) {
      var qs = params ? "?" + new URLSearchParams(params).toString() : "";
      return fetch(API + "/addresses/" + address + "/logs" + qs).then(function (r) {
        if (!r.ok) throw new Error("explorer " + r.status);
        return r.json();
      }).then(function (j) {
        j.items.forEach(function (it) {
          var name = TOPIC[it.topics[0]];
          if (!name) return;
          out.push({ name: name, topics: it.topics, data: it.data, block: Number(it.block_number), at: it.block_timestamp, tx: it.transaction_hash });
        });
        return j.next_page_params ? page(j.next_page_params) : out;
      });
    }
    return page(null).then(function (evs) { return evs.sort(function (a, b) { return a.block - b.block; }); });
  }

  // Same cut as scripts/ledger.ts. Settled always frees a slot; Flattened/Cancelled free it
  // only when nothing is left, which from events alone is known by what comes next.
  function episodes(vault, evs) {
    var open = {}, done = [];
    evs.forEach(function (e) {
      var slot = Number(word("0x" + e.topics[1].slice(2), 0));
      var marketId = e.topics[2];
      if (e.name === "Quoted") {
        if (open[slot]) done.push(open[slot]);
        var bid = word(e.data, 0), ask = word(e.data, 1), size = word(e.data, 2);
        open[slot] = { vault: vault, slot: slot, marketId: marketId, at: e.at, lastAt: e.at, closedAt: null, bid: bid, ask: ask, size: size,
          basis: (size * bid) / ONE + (size * (ONE - ask)) / ONE,
          merged: 0n, returned: 0n, redeemed: 0n, cancelled: false, closedBy: "open", tx: e.tx };
        return;
      }
      var ep = open[slot];
      if (!ep) return;
      ep.lastAt = e.at; ep.closedAt = e.at;
      if (e.name === "Flattened") { ep.merged += word(e.data, 0); ep.returned += word(e.data, 1); ep.closedBy = "flatten"; }
      else if (e.name === "Settled") { ep.redeemed += word(e.data, 0); ep.closedBy = "settle"; delete open[slot]; done.push(ep); }
      else if (e.name === "Cancelled") { ep.cancelled = true; if (ep.closedBy === "open") ep.closedBy = "cancel"; }
    });
    Object.keys(open).forEach(function (k) { done.push(open[k]); });
    return done;
  }

  function render(all) {
    var rows = q("[data-ledger=rows]");
    rows.textContent = "";
    var complete = 0, oneSided = 0, pnl = 0n, basis = 0n;
    all.sort(function (a, b) { return a.at < b.at ? -1 : 1; }).forEach(function (ep) {
      var cash = ep.returned + ep.redeemed;
      var isComplete = ep.merged === ep.size || (ep.closedBy === "settle" && ep.redeemed === ep.size);
      var result, cls;
      if (ep.closedBy === "open") { result = "open"; cls = "open"; }
      else if (ep.closedBy === "cancel" && cash === 0n) { result = "no fill, escrow back"; cls = "open"; }
      else if (isComplete) {
        var p = cash - ep.basis; pnl += p; basis += ep.basis; complete++;
        result = (p >= 0n ? "+" : "") + usd(p) + " (" + ((Number(p) / Number(ep.basis)) * 100).toFixed(2) + "%)";
        cls = p >= 0n ? "pos" : "neg";
      } else { oneSided++; result = ep.redeemed === 0n && ep.closedBy === "settle" ? "one-sided, lost" : "one-sided"; cls = "neg"; }

      var tr = document.createElement("tr");
      [
        short(ep.vault), "…" + ep.marketId.slice(-4), ep.at.slice(5, 16).replace("T", " "),
        px(ep.bid) + " / " + px(ep.ask), usd(ep.basis), usd(cash), ep.closedBy + (ep.cancelled ? "+cancel" : ""), result
      ].forEach(function (text, i) {
        var td = document.createElement("td");
        if (i === 7) td.className = cls;
        if (i === 0) {
          var a = document.createElement("a");
          a.href = window.ABADI.explorer + "/tx/" + ep.tx; a.textContent = text; td.appendChild(a);
        } else td.textContent = text;
        tr.appendChild(td);
      });
      rows.appendChild(tr);
    });
    set("[data-ledger=episodes]", String(all.length));
    set("[data-ledger=complete]", String(complete));
    set("[data-ledger=onesided]", String(oneSided));
    set("[data-ledger=pnl]", (pnl >= 0n ? "+" : "") + usd(pnl) + (basis > 0n ? " on " + usd(basis) : ""));
    set("[data-ledger=count]", window.ABADI.vaults.length + 1 + " vaults, oldest first");
    root.setAttribute("data-state", "live");
    heartbeat(all);
    chart(all);
  }

  /* How long since the vaults last did anything. A keeper that stopped is invisible
     from a page full of true numbers; this is the one line that would say so. */
  function heartbeat(all) {
    var last = 0;
    all.forEach(function (ep) { var t = Date.parse(ep.lastAt || ep.at); if (t > last) last = t; });
    var el = root.querySelector("[data-ledger=last]");
    if (!el || !last) return;
    var mins = Math.round((Date.now() - last) / 60000);
    el.textContent = "last activity " + (mins < 1 ? "under a minute" : mins < 90 ? mins + " min" : Math.round(mins / 60) + " h") + " ago";
  }

  /* One series: cumulative realised spread across every closed complete set, in the
     order they closed. Marks per the chart spec — 2px line, 10% wash, end dot with a
     surface ring, one direct label at the end, hairline grid, a crosshair tooltip that
     snaps to the nearest close. Text wears text tokens; only the marks are turmeric. */
  function chart(all) {
    var fig = document.getElementById("pnlChart");
    if (!fig) return;
    var pts = [];
    var cum = 0n;
    all.slice().sort(function (a, b) { return (a.closedAt || a.at) < (b.closedAt || b.at) ? -1 : 1; }).forEach(function (ep) {
      var cash = ep.returned + ep.redeemed;
      var isComplete = ep.merged === ep.size || (ep.closedBy === "settle" && ep.redeemed === ep.size);
      if (ep.closedBy === "open" || (ep.closedBy === "cancel" && cash === 0n) || !isComplete) return;
      cum += cash - ep.basis;
      pts.push({ t: Date.parse(ep.closedAt || ep.at), y: Number(cum) / 1e6, d: Number(cash - ep.basis) / 1e6, market: ep.marketId.slice(-4), when: (ep.closedAt || ep.at).slice(0, 16).replace("T", " ") });
    });
    var svg = fig.querySelector("svg");
    svg.textContent = "";
    if (pts.length < 2) { fig.setAttribute("data-state", "live"); return; }

    var W = 720, H = 220, L = 44, R = 64, T = 12, B = 24;
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    var ys = pts.map(function (p) { return p.y; }); var yMin = Math.min(0, Math.min.apply(null, ys)), yMax = Math.max.apply(null, ys);
    if (yMax === yMin) yMax = yMin + 1;
    var x = function (t) { return L + (W - L - R) * (t1 === t0 ? 1 : (t - t0) / (t1 - t0)); };
    var y = function (v) { return T + (H - T - B) * (1 - (v - yMin) / (yMax - yMin)); };
    var NS = "http://www.w3.org/2000/svg";
    function el(name, attrs, text) { var e = document.createElementNS(NS, name); Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); }); if (text != null) e.textContent = text; return e; }

    // clean ticks: 0 and two round steps
    var step = Math.pow(10, Math.floor(Math.log10(yMax - yMin))); if ((yMax - yMin) / step < 3) step /= 2;
    for (var v = Math.ceil(yMin / step) * step; v <= yMax + 1e-9; v += step) {
      svg.appendChild(el("line", { class: "grid", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
      svg.appendChild(el("text", { class: "axis", x: L - 6, y: y(v) + 4, "text-anchor": "end" }, v.toLocaleString("en-US")));
    }
    svg.appendChild(el("text", { class: "axis", x: L, y: H - 6 }, pts[0].when.slice(5, 10)));
    svg.appendChild(el("text", { class: "axis", x: W - R, y: H - 6, "text-anchor": "end" }, pts[pts.length - 1].when.slice(5, 10)));

    var d = pts.map(function (p, i) { return (i ? "L" : "M") + x(p.t).toFixed(1) + " " + y(p.y).toFixed(1); }).join(" ");
    svg.appendChild(el("path", { class: "wash", d: d + " L" + x(t1).toFixed(1) + " " + y(yMin).toFixed(1) + " L" + x(t0).toFixed(1) + " " + y(yMin).toFixed(1) + " Z" }));
    svg.appendChild(el("path", { class: "line", d: d }));
    var last = pts[pts.length - 1];
    svg.appendChild(el("circle", { class: "end", cx: x(last.t), cy: y(last.y), r: 4.5 }));
    svg.appendChild(el("text", { class: "endlabel", x: x(last.t) + 10, y: y(last.y) + 4 }, (last.y >= 0 ? "+" : "") + last.y.toFixed(2)));

    // hover: the crosshair finds the X; the tooltip reads value first, then the close it belongs to
    var plot = fig.querySelector(".chart-plot"), xhair = fig.querySelector(".xhair"), tip = fig.querySelector(".tip");
    var hot = el("circle", { class: "dot", cx: 0, cy: 0, r: 4.5, visibility: "hidden" }); svg.appendChild(hot);
    function show(clientX) {
      var r = plot.getBoundingClientRect();
      var fx = (clientX - r.left) / r.width * W;
      var best = 0, bd = Infinity;
      pts.forEach(function (p, i) { var dd = Math.abs(x(p.t) - fx); if (dd < bd) { bd = dd; best = i; } });
      var p = pts[best];
      var px = x(p.t) / W * r.width;
      xhair.style.left = px + "px"; xhair.hidden = false;
      hot.setAttribute("cx", x(p.t)); hot.setAttribute("cy", y(p.y)); hot.setAttribute("visibility", "visible"); hot.setAttribute("class", "dot" + (p.d < 0 ? " neg" : ""));
      tip.textContent = "";
      var b = document.createElement("b"); b.textContent = (p.y >= 0 ? "+" : "") + p.y.toFixed(2) + " tUSDC cumulative"; tip.appendChild(b);
      tip.appendChild(document.createTextNode((p.d >= 0 ? "+" : "") + p.d.toFixed(2) + " on market …" + p.market + " · " + p.when + " UTC"));
      tip.hidden = false;
      tip.style.left = (px + 12 + 260 > r.width ? px - 272 : px + 12) + "px";
    }
    function hide() { xhair.hidden = true; tip.hidden = true; hot.setAttribute("visibility", "hidden"); }
    plot.addEventListener("pointermove", function (e) { show(e.clientX); });
    plot.addEventListener("pointerleave", hide);
    plot.tabIndex = 0;
    plot.addEventListener("focus", function () { var r = plot.getBoundingClientRect(); show(r.left + x(last.t) / W * r.width); });
    plot.addEventListener("blur", hide);
    fig.setAttribute("data-state", "live");
  }

  var vaults = window.ABADI.vaults.map(function (v) { return v.address; });
  if (vaults.map(function (a) { return a.toLowerCase(); }).indexOf(window.ABADI.vault.toLowerCase()) < 0) vaults.push(window.ABADI.vault);

  Promise.all(vaults.map(function (a) { return fetchLogs(a).then(function (evs) { return episodes(a, evs); }); }))
    .then(function (per) { render([].concat.apply([], per)); })
    .catch(function (err) {
      root.setAttribute("data-state", "unreachable");
      set("[data-ledger=error]", "Could not read the explorer (" + (err && err.message ? err.message : "no response") + "). Nothing is shown rather than something stale.");
    });
})();
