/*
 * Reads the vault straight off the chain, in the reader's own browser, with nothing in
 * between. No snapshot, no indexer, no server of ours: five eth_calls to the public RPC plus one per slot
 * and the numbers on screen are the numbers on chain at that block.
 *
 * When the RPC cannot be reached the strip says so and shows nothing. A stale number
 * dressed as a live one is the one thing this file must never produce.
 */
(function () {
  var root = document.getElementById("live");
  if (!root || !window.ABADI) return;

  var RPC = window.ABADI.rpc;
  var VAULT = window.ABADI.vault;
  var EXPLORER = "https://shannon-explorer.somnia.network";

  // Function selectors, computed once with `cast sig` and pinned here.
  var SEL = {
    totalAssets:   "0x01e1d114",
    idleAssets:    "0xe16b03a3",
    totalEscrowed: "0xf9168231",
    totalSupply:   "0x18160ddd",
    maxSlots:      "0xc0f3f2e9",
    slots:         "0x387dd9e9"
  };

  function word(n) { return n.toString(16).padStart(64, "0"); }

  /* A host that hangs never rejects. `fetch` only fails on a refused connection or a
     response; against an endpoint that accepts the socket and then says nothing, the
     promise stays pending until the browser's own timeout, which is minutes.

     That is how the ledger came to sit on "loading" with an empty error message while
     the Shannon explorer was unreachable for twenty seconds a request — the catch below
     was correct and simply never ran. This turns a hang into a rejection, so the failure
     state that already exists is the one the reader sees. */
  function fetchIn(url, opts, ms) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, ms || 12000);
    var o = {};
    if (opts) Object.keys(opts).forEach(function (k) { o[k] = opts[k]; });
    o.signal = ctl.signal;
    return fetch(url, o)
      .catch(function (e) {
        throw new Error(ctl.signal.aborted ? "no answer in " + ((ms || 12000) / 1000) + "s" : e.message);
      })
      .then(function (r) { clearTimeout(timer); return r; }, function (e) { clearTimeout(timer); throw e; });
  }

  function rpc(method, params) {
    return fetchIn(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error.message);
      return j.result;
    });
  }

  function call(data) { return rpc("eth_call", [{ to: VAULT, data: data }, "latest"]); }
  function u256(hex, i) { return BigInt("0x" + hex.slice(2 + 64 * (i || 0), 66 + 64 * (i || 0))); }
  function usd(v) { return (Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function px(v) { return (Number(v) / 1e6).toFixed(3); }

  function q(sel) { return root.querySelector(sel); }
  function set(sel, text) { var el = q(sel); if (el) el.textContent = text; }

  function render(d) {
    set("[data-live=nav]", usd(d.nav));
    set("[data-live=idle]", usd(d.idle));
    set("[data-live=resting]", usd(d.resting));
    set("[data-live=share]", d.supply > 0n ? (Number(d.nav) / Number(d.supply)).toFixed(6) : "—");
    set("[data-live=block]", d.block.toLocaleString("en-US"));

    var list = q("[data-live=slots]");
    if (list) {
      list.textContent = "";
      if (d.slots.length === 0) {
        var li = document.createElement("li");
        li.textContent = "no open quotes — all capital idle";
        list.appendChild(li);
      }
      d.slots.forEach(function (s) {
        var li = document.createElement("li");
        var b = document.createElement("b");
        b.textContent = "slot " + s.i;
        li.appendChild(b);
        li.appendChild(document.createTextNode(
          " · market …" + s.marketId.slice(-4) +
          " · " + px(s.bid) + " / " + px(s.ask) +
          " · " + usd(s.size) + " a side · basis " + usd(s.basis)));
        list.appendChild(li);
      });
    }
    var a = q("[data-live=explorer]");
    if (a) a.href = EXPLORER + "/address/" + VAULT;
    root.setAttribute("data-state", "live");
  }

  function fail(err) {
    root.setAttribute("data-state", "unreachable");
    set("[data-live=error]", "Chain read failed (" + (err && err.message ? err.message : "no response") + "). Nothing is shown rather than something stale.");
  }

  function load() {
    root.setAttribute("data-state", "loading");
    var block;
    return rpc("eth_blockNumber", [])
      .then(function (b) {
        block = Number(BigInt(b));
        return Promise.all([
          call(SEL.totalAssets), call(SEL.idleAssets), call(SEL.totalEscrowed), call(SEL.totalSupply), call(SEL.maxSlots)
        ]);
      })
      .then(function (r) {
        var d = { block: block, nav: u256(r[0]), idle: u256(r[1]), resting: u256(r[2]), supply: u256(r[3]), slots: [] };
        var n = Number(u256(r[4]));
        var reads = [];
        for (var i = 0; i < n; i++) reads.push(call(SEL.slots + word(i)));
        return Promise.all(reads).then(function (ss) {
          ss.forEach(function (hex, i) {
            // Slot(bytes32 marketId, address pool, uint128 yes, uint128 no, uint256 basis,
            //      uint256 size, uint256 bid, uint256 ask, uint256 yesId, uint256 noId, bool active)
            var active = u256(hex, 10) === 1n;
            if (!active) return;
            d.slots.push({
              i: i,
              marketId: "0x" + hex.slice(2, 66),
              basis: u256(hex, 4), size: u256(hex, 5), bid: u256(hex, 6), ask: u256(hex, 7)
            });
          });
          render(d);
        });
      })
      .catch(fail);
  }

  load();
  // The chain moves; so should this. Once a minute is honest without being a poll storm.
  setInterval(load, 60000);
})();
