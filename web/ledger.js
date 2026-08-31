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
  var COLLATERAL = "0x70a86d8842fb63c4ad2b7cdddf530ebf1bb25d8e";
  // cast sig "totalAssets()" / "totalSupply()"
  var SEL = { totalAssets: "0x01e1d114", totalSupply: "0x18160ddd" };

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

  /* Every tUSDC transfer the vault was party to, oldest first. The four events cannot
     close the books alone: a leg that never filled has its escrow released by the pool,
     silently, with no vault event attached. That release is a plain collateral transfer
     back to the vault, and without it a one-sided episode reads as a total loss of its
     basis and an episode where nothing filled reads the same as one that held the loser. */
  function fetchFlows(address) {
    var out = [];
    function page(params) {
      var p = new URLSearchParams(params || {});
      p.set("type", "ERC-20");
      return fetch(API + "/addresses/" + address + "/token-transfers?" + p.toString()).then(function (r) {
        if (!r.ok) throw new Error("explorer " + r.status);
        return r.json();
      }).then(function (j) {
        (j.items || []).forEach(function (it) {
          if (((it.token && it.token.address_hash) || "").toLowerCase() !== COLLATERAL) return;
          out.push({
            // one sortable position per log; blocks are ~4.7e8 here, so this stays exact
            ord: Number(it.block_number) * 1e4 + Number(it.log_index),
            tx: it.transaction_hash,
            from: it.from.hash.toLowerCase(),
            to: it.to.hash.toLowerCase(),
            value: BigInt(it.total.value)
          });
        });
        return j.next_page_params ? page(j.next_page_params) : out;
      });
    }
    return page(null).then(function (fs) { return fs.sort(function (a, b) { return a.ord - b.ord; }); });
  }

  /* Attach the escrow releases to the episodes that paid them. The quote's own transaction
     says where the money went — two transfers, vault to pool, one per leg — and the pool is
     one per market. Everything that pool later sends back belongs to the most recent episode
     quoted on it; the contract allows only one live slot per market, so there is never a
     second claimant open at the same time. Same rule as scripts/ledger.ts. */
  function attribute(vault, eps, flows) {
    var v = vault.toLowerCase(), byTx = {}, byPool = {};
    flows.forEach(function (f) { (byTx[f.tx] = byTx[f.tx] || []).push(f); });
    eps.forEach(function (ep) {
      var paid = (byTx[ep.tx] || []).filter(function (f) { return f.from === v; });
      if (!paid.length) return; // no escrow left the vault on this quote — nothing to trace
      ep.pool = paid[0].to;
      ep.quoteOrd = paid[0].ord;
      (byPool[ep.pool] = byPool[ep.pool] || []).push(ep);
    });
    Object.keys(byPool).forEach(function (k) { byPool[k].sort(function (a, b) { return a.quoteOrd - b.quoteOrd; }); });
    flows.forEach(function (f) {
      if (f.to !== v) return;
      var list = byPool[f.from];
      if (!list) return; // merges and redemptions arrive from the module, not the pool
      var owner = null;
      for (var i = 0; i < list.length && list[i].quoteOrd <= f.ord; i++) owner = list[i];
      if (owner) owner.refunded += f.value;
    });
    return eps;
  }

  /* What an episode realised. Cash is everything that came back through any door: merged
     pairs, redemption, and the escrow the pool released. Basis is what the quote cost, all
     of it, whether or not it traded — so a losing episode carries its full weight in the
     denominator and its real loss in the numerator.

     The two facts the old reading confused are separated here. Escrow back in full, with
     nothing merged and nothing redeemed, means neither leg ever filled: no fill, no loss,
     and no adverse selection to report. Escrow short of the basis means something filled,
     and what it was worth at the end is the difference. */
  function value(ep) {
    var cash = ep.returned + ep.redeemed + ep.refunded;
    if (ep.closedBy === "open") return { state: "open", pnl: 0n, cash: cash };
    if (!ep.pool || ep.refunded > ep.basis) return { state: "unaccounted", pnl: 0n, cash: cash };
    if (ep.returned === 0n && ep.redeemed === 0n && ep.refunded === ep.basis) {
      return { state: "no fill", pnl: 0n, cash: cash };
    }
    var both = ep.refunded === 0n && (ep.merged === ep.size || ep.redeemed === ep.size);
    return { state: both ? "complete" : "one-sided", pnl: cash - ep.basis, cash: cash };
  }

  /* Cumulative realised across every closed episode, in the order they closed. Losses are
     in it, so the curve can fall. Exported for the browser tests, which feed it a fixture
     rather than waiting on the live vault to lose money on cue. */
  function series(all) {
    var cum = 0n, pts = [];
    all.slice().sort(function (a, b) { return (a.closedAt || a.at) < (b.closedAt || b.at) ? -1 : 1; }).forEach(function (ep) {
      var m = value(ep);
      if (m.state === "open" || m.state === "unaccounted") return;
      cum += m.pnl;
      pts.push({ t: Date.parse(ep.closedAt || ep.at), y: Number(cum) / 1e6, d: Number(m.pnl) / 1e6,
        market: ep.marketId.slice(-4), when: (ep.closedAt || ep.at).slice(0, 16).replace("T", " ") });
    });
    return pts;
  }

  function rpc(data) {
    return fetch(window.ABADI.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: window.ABADI.vault, data: data }, "latest"] })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error.message);
      return BigInt(j.result);
    });
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
          merged: 0n, returned: 0n, redeemed: 0n, cancelled: false, closedBy: "open", tx: e.tx,
          pool: "", quoteOrd: 0, refunded: 0n };
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

  function render(all, chain) {
    var rows = q("[data-ledger=rows]");
    rows.textContent = "";
    var complete = 0, oneSided = 0, noFill = 0, pnl = 0n, basis = 0n;
    all.sort(function (a, b) { return a.at < b.at ? -1 : 1; }).forEach(function (ep) {
      var m = value(ep), result, cls;
      if (m.state === "open") { result = "open"; cls = "open"; }
      else if (m.state === "unaccounted") { basis += ep.basis; result = "? · not determinable"; cls = "open"; }
      else if (m.state === "no fill") { noFill++; basis += ep.basis; result = "0.00 · no fill, escrow back"; cls = "open"; }
      else {
        pnl += m.pnl; basis += ep.basis;
        if (m.state === "complete") complete++; else oneSided++;
        result = (m.pnl >= 0n ? "+" : "") + usd(m.pnl) + " (" + ((Number(m.pnl) / Number(ep.basis)) * 100).toFixed(2) + "%)" +
          (m.state === "one-sided" ? " · one-sided" : "");
        cls = m.pnl >= 0n ? "pos" : "neg";
      }

      var tr = document.createElement("tr");
      [
        short(ep.vault), "…" + ep.marketId.slice(-4), ep.at.slice(5, 16).replace("T", " "),
        px(ep.bid) + " / " + px(ep.ask), usd(ep.basis), usd(m.cash), ep.closedBy + (ep.cancelled ? "+cancel" : ""), result
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
    set("[data-ledger=onesided]", String(oneSided) + (noFill ? " · " + noFill + " no fill" : ""));
    set("[data-ledger=pnl]", (pnl >= 0n ? "+" : "") + usd(pnl) + (basis > 0n ? " on " + usd(basis) : ""));
    // The number a depositor is paid in. Everything else on this page is the account of how
    // it got here; a basis-relative figure that never meets it is how a loss stays invisible.
    if (chain && chain.supply > 0n) {
      set("[data-ledger=share]", (Number(chain.assets) / Number(chain.supply)).toFixed(6));
      var d = chain.assets - chain.supply;
      set("[data-ledger=depositors]", (d >= 0n ? "+" : "") + usd(d) + " (" +
        (((Number(chain.assets) / Number(chain.supply)) - 1) * 100).toFixed(2) + "%)");
    }
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

  /* One series: cumulative realised across every closed episode, in the order they closed.
     Marks per the chart spec — 2px line, 10% wash, end dot with a surface ring, one direct
     label at the end, hairline grid, a crosshair tooltip that snaps to the nearest close.
     Text wears text tokens; only the marks carry a pen colour. */
  function chart(all) {
    var fig = document.getElementById("pnlChart");
    if (!fig) return;
    var pts = series(all);
    var svg = fig.querySelector("svg");
    svg.textContent = "";
    if (pts.length < 2) { fig.setAttribute("data-state", "live"); return; }

    var W = 720, H = 220, L = 44, R = 64, T = 12, B = 24;
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    // Zero is always on the scale, above the curve as readily as below it: a series that
    // only ever fell still has to be read against the line it fell from.
    var ys = pts.map(function (p) { return p.y; });
    var yMin = Math.min(0, Math.min.apply(null, ys)), yMax = Math.max(0, Math.max.apply(null, ys));
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

  // The valuation, exported so the browser tests can run it over a fixture instead of
  // waiting on the live vault to produce a loss on cue.
  window.ABADI_LEDGER = { value: value, series: series };

  var vaults = window.ABADI.vaults.map(function (v) { return v.address; });
  if (vaults.map(function (a) { return a.toLowerCase(); }).indexOf(window.ABADI.vault.toLowerCase()) < 0) vaults.push(window.ABADI.vault);

  Promise.all([
    Promise.all(vaults.map(function (a) {
      return Promise.all([fetchLogs(a), fetchFlows(a)]).then(function (r) { return attribute(a, episodes(a, r[0]), r[1]); });
    })),
    // The share price is the headline; a failure to read it must not blank the ledger.
    Promise.all([rpc(SEL.totalAssets), rpc(SEL.totalSupply)])
      .then(function (r) { return { assets: r[0], supply: r[1] }; })
      .catch(function () { return null; })
  ])
    .then(function (r) { render([].concat.apply([], r[0]), r[1]); })
    .catch(function (err) {
      root.setAttribute("data-state", "unreachable");
      set("[data-ledger=error]", "Could not read the explorer (" + (err && err.message ? err.message : "no response") + "). Nothing is shown rather than something stale.");
    });
})();
