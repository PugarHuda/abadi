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
        open[slot] = { vault: vault, slot: slot, marketId: marketId, at: e.at, bid: bid, ask: ask, size: size,
          basis: (size * bid) / ONE + (size * (ONE - ask)) / ONE,
          merged: 0n, returned: 0n, redeemed: 0n, cancelled: false, closedBy: "open", tx: e.tx };
        return;
      }
      var ep = open[slot];
      if (!ep) return;
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
