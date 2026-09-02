/*
 * The live order book, with Abadi's own quote marked inside it.
 *
 * This section used to be hand-written HTML from a fill on 27 August. It sat under a
 * heading that said "as read back" on a page whose first principle is that a number is
 * read from the chain in the reader's browser or it is not shown — the loudest rule this
 * project has, broken on its own evidence page.
 *
 * Two sources, both public, neither ours:
 *   the vault      eth_call to the public RPC for which window it is quoting right now
 *   the book       the venue's own indexer for every open order on that window
 *
 * A row is Abadi's when the order's owner IS the vault address. Nothing is highlighted
 * on trust; the marker is the same field the venue uses to decide whose order it is.
 *
 * When either read fails the section says which one and shows nothing. When the vault
 * holds no quote there is no book worth showing and it says that too — an empty state is
 * a true statement about a market maker that is between quotes.
 */
(function () {
  var root = document.getElementById("book");
  if (!root || !window.ABADI) return;

  var RPC = window.ABADI.rpc;
  var VAULT = window.ABADI.vault;
  var INDEXER = "https://dev.smk.somnia.host/v1/graphql";

  var SEL = { maxSlots: "0xc0f3f2e9", slots: "0x387dd9e9" };
  var LEVELS = 5;

  function word(n) { return n.toString(16).padStart(64, "0"); }
  function u256(hex, i) { return BigInt("0x" + hex.slice(2 + 64 * i, 66 + 64 * i)); }
  function px(v) { return (Number(v) / 1e6).toFixed(3); }
  function qty(v) { return (Number(v) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 }); }

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

  function call(data) {
    return fetchIn(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: VAULT, data: data }, "latest"] })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error.message);
      return j.result;
    });
  }

  /** The market this vault is quoting right now, or null when it is between quotes. */
  function quotedMarket() {
    return call(SEL.maxSlots).then(function (n) {
      var max = Number(u256(n, 0));
      var reads = [];
      for (var i = 0; i < max; i++) reads.push(call(SEL.slots + word(i)));
      return Promise.all(reads);
    }).then(function (raw) {
      for (var i = 0; i < raw.length; i++) {
        // The struct's last word is `active`; the first is the market id.
        var active = u256(raw[i], 10) === 1n;
        if (active) {
          return {
            marketId: "0x" + raw[i].slice(2, 66),
            bid: u256(raw[i], 6),
            ask: u256(raw[i], 7)
          };
        }
      }
      return null;
    });
  }

  function book(marketId) {
    var query =
      "query B($m: String!) { Order(where: {market_id: {_eq: $m}, status: {_eq: \"Open\"}}) " +
      "{ isBid price quantityRemaining owner } }";
    return fetchIn(INDEXER, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: query, variables: { m: marketId } })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.errors) throw new Error(j.errors[0].message);
      return j.data.Order;
    });
  }

  /** One side, aggregated per price level, deepest first, ours flagged. */
  function side(orders, isBid) {
    var byPrice = {};
    orders.forEach(function (o) {
      if (o.isBid !== isBid) return;
      var k = o.price;
      if (!byPrice[k]) byPrice[k] = { price: BigInt(k), size: 0n, mine: false };
      byPrice[k].size += BigInt(o.quantityRemaining);
      if (String(o.owner).toLowerCase() === VAULT.toLowerCase()) byPrice[k].mine = true;
    });
    var rows = Object.keys(byPrice).map(function (k) { return byPrice[k]; });
    // Bids read down from the touch, asks read up from it.
    rows.sort(function (a, b) { return isBid ? Number(b.price - a.price) : Number(a.price - b.price); });
    return rows.slice(0, LEVELS);
  }

  function draw(el, rows, isBid) {
    el.textContent = "";
    var head = document.createElement("div");
    head.className = "col-head";
    head.textContent = isBid ? "bids · buying up" : "asks · buying down";
    el.appendChild(head);
    if (rows.length === 0) {
      var none = document.createElement("div");
      none.className = "lvl";
      none.textContent = "nothing resting on this side";
      el.appendChild(none);
      return;
    }
    var deepest = rows.reduce(function (m, r) { return r.size > m ? r.size : m; }, 1n);
    rows.forEach(function (r) {
      var lvl = document.createElement("div");
      lvl.className = "lvl" + (r.mine ? " mine" : "");
      var depth = document.createElement("div");
      depth.className = "depth";
      depth.style.width = (Number(r.size) / Number(deepest) * 100).toFixed(1) + "%";
      var p = document.createElement("span");
      p.className = "px";
      p.textContent = px(r.price);
      if (r.mine) {
        var tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "ABADI";
        p.appendChild(tag);
      }
      var s = document.createElement("span");
      s.className = "sz";
      s.textContent = qty(r.size);
      lvl.appendChild(depth);
      lvl.appendChild(p);
      lvl.appendChild(s);
      el.appendChild(lvl);
    });
  }

  function say(state, message) {
    root.setAttribute("data-state", state);
    // The note is a sibling of the ladder, not a child of it: scoping this read to the
    // ladder is why the first version left "Reading the book..." on screen forever.
    var el = document.querySelector("[data-book=note]");
    if (el) el.textContent = message;
  }

  function load() {
    quotedMarket().then(function (slot) {
      if (!slot) {
        root.querySelector("[data-book=bids]").textContent = "";
        root.querySelector("[data-book=asks]").textContent = "";
        say("idle", "No quote resting right now — the vault is between windows. This fills in as soon as it quotes.");
        return;
      }
      return book(slot.marketId).then(function (orders) {
        draw(root.querySelector("[data-book=bids]"), side(orders, true), true);
        draw(root.querySelector("[data-book=asks]"), side(orders, false), false);
        say(
          "live",
          "Window " + slot.marketId.slice(-6) + " · Abadi is resting " + px(slot.bid) + " / " + px(slot.ask) +
            " · levels aggregated from every open order the venue's indexer has, ours marked by owner address."
        );
      });
    }).catch(function (e) {
      say("error", "Could not read the book: " + e.message);
    });
  }

  load();
  setInterval(load, 30000);
})();
