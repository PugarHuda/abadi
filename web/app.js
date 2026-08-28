/*
 * The app: deposit into the vault, take your shares back out, mint test collateral.
 *
 * No wallet library and no ABI library. Every call is a selector plus 32-byte words,
 * built here, so a reader can compare what the page sends with what `cast calldata`
 * prints. Reads go to the public RPC so the page works before a wallet is connected;
 * transactions go through the wallet the visitor already has (EIP-1193).
 *
 * Nothing on this page is a placeholder. A number is read from the chain or the field
 * says it could not be read.
 */
(function () {
  var A = (window.ABADI_APP = {});

  // ---------------------------------------------------------------- encoding
  var SEL = {
    faucet: "0x57915897",        // faucet(uint256)
    approve: "0x095ea7b3",       // approve(address,uint256)
    allowance: "0xdd62ed3e",     // allowance(address,address)
    balanceOf: "0x70a08231",     // balanceOf(address)
    deposit: "0x6e553f65",       // deposit(uint256,address)
    redeem: "0xba087652",        // redeem(uint256,address,address)
    withdraw: "0xb460af94",      // withdraw(uint256,address,address)
    minHandlerBalance: "0x359f27e8", // MIN_HANDLER_BALANCE()
    convertToAssets: "0x07a2d13a",
    totalAssets: "0x01e1d114",
    idleAssets: "0xe16b03a3",
    totalSupply: "0x18160ddd",
    maxSlots: "0xc0f3f2e9",
    slots: "0x387dd9e9"
  };
  A.SEL = SEL;

  function wordU(n) { return BigInt(n).toString(16).padStart(64, "0"); }
  function wordA(addr) { return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0"); }
  function u256(hex, i) { return BigInt("0x" + hex.slice(2 + 64 * (i || 0), 66 + 64 * (i || 0))); }
  A.encode = {
    faucet: function (amount) { return SEL.faucet + wordU(amount); },
    approve: function (spender, amount) { return SEL.approve + wordA(spender) + wordU(amount); },
    allowance: function (owner, spender) { return SEL.allowance + wordA(owner) + wordA(spender); },
    balanceOf: function (owner) { return SEL.balanceOf + wordA(owner); },
    deposit: function (assets, receiver) { return SEL.deposit + wordU(assets) + wordA(receiver); },
    redeem: function (shares, receiver, owner) { return SEL.redeem + wordU(shares) + wordA(receiver) + wordA(owner); },
    withdraw: function (assets, receiver, owner) { return SEL.withdraw + wordU(assets) + wordA(receiver) + wordA(owner); },
    convertToAssets: function (shares) { return SEL.convertToAssets + wordU(shares); },
    slots: function (i) { return SEL.slots + wordU(i); }
  };

  if (!document.getElementById("app")) return;

  var cfg = window.ABADI;
  var RPC = cfg.rpc, VAULT = cfg.vault, EXPLORER = cfg.explorer;
  var USDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
  var CHAIN_ID = "0xc488"; // 50312, Somnia Shannon
  var CHAIN = {
    chainId: CHAIN_ID, chainName: "Somnia Shannon Testnet",
    nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
    rpcUrls: [RPC], blockExplorerUrls: [EXPLORER]
  };

  // ---------------------------------------------------------------- chain reads
  function rpc(method, params) {
    return fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j.error) throw new Error(j.error.message); return j.result; });
  }
  function call(to, data) { return rpc("eth_call", [{ to: to, data: data }, "latest"]); }

  // ---------------------------------------------------------------- state + view
  var state = { account: null, chainOk: false, busy: false, usdc: 0n, stt: 0n, shares: 0n, worth: 0n, confirmAll: null };
  var els = {};
  ["connect", "wallet", "network", "usdc", "stt", "shares", "worth", "nav", "share", "idle",
   "amount", "amountMax", "deposit", "depositForm", "withdrawAmount", "withdrawMax", "withdraw", "withdrawForm",
   "withdrawAll", "allPreview", "faucet", "log", "logEmpty", "slots", "guard", "status", "nowallet", "wake"]
    .forEach(function (id) { els[id] = document.getElementById(id); });
  var wakeStt = els.wake.querySelector("[data-wake=stt]");
  var wakeVerdict = els.wake.querySelector("[data-wake=verdict]");
  var STT_FAUCET = "https://cloud.google.com/application/web3/faucet/somnia/shannon";

  function usd(v) { return (Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function stt(v) { return (Number(v) / 1e18).toFixed(3); }
  function px(v) { return (Number(v) / 1e6).toFixed(3); }
  function short(a) { return a.slice(0, 6) + "…" + a.slice(-4); }

  /** One sentence, in two places: the status strip beside the buttons, and the log. */
  function say(text, href, tone) {
    if (els.logEmpty) { els.logEmpty.remove(); els.logEmpty = null; }
    var li = document.createElement("li");
    var t = document.createElement("time");
    t.textContent = new Date().toISOString().slice(11, 19) + " UTC";
    li.appendChild(t);
    li.appendChild(document.createTextNode(" " + text + " "));
    if (href) {
      var a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener";
      a.textContent = "view " + href.slice(-8) + " on the explorer";
      li.appendChild(a);
    }
    els.log.prepend(li);
    status(text, tone || "info", href);
  }

  function status(text, tone, href) {
    els.status.textContent = text;
    if (href) { var a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = "explorer"; els.status.appendChild(a); }
    els.status.setAttribute("data-tone", tone || "info");
  }

  var pressed = null, pressedLabel = "";
  function setBusy(b, button) {
    state.busy = b;
    var ready = !!state.account && state.chainOk;
    [els.deposit, els.withdraw, els.faucet, els.amountMax, els.withdrawMax].forEach(function (x) { x.disabled = b || !ready; });
    els.withdrawAll.disabled = b || !ready || els.withdrawAll.dataset.blocked === "true";
    document.getElementById("app").setAttribute("data-busy", b ? "true" : "false");
    if (b && button) { pressed = button; pressedLabel = button.textContent; button.textContent = "Waiting for wallet…"; }
    if (!b && pressed) { pressed.textContent = pressedLabel; pressed = null; }
  }

  /** The product's claim, on the page where money changes hands: can the vault wake itself? */
  function loadWake() {
    return Promise.all([rpc("eth_getBalance", [VAULT, "latest"]), call(VAULT, SEL.minHandlerBalance)]).then(function (r) {
      var have = BigInt(r[0]), need = u256(r[1]);
      wakeStt.textContent = stt(have) + " STT";
      wakeVerdict.textContent = have >= need
        ? "Armed wake-ups will settle expired windows with nobody calling."
        : "Below the floor, so the scheduled keeper settles instead; the vault still never needs a trusted key.";
    }).catch(function () { wakeStt.textContent = "unreadable"; wakeVerdict.textContent = ""; });
  }

  function loadVault() {
    return Promise.all([call(VAULT, SEL.totalAssets), call(VAULT, SEL.idleAssets), call(VAULT, SEL.totalSupply), call(VAULT, SEL.maxSlots)])
      .then(function (r) {
        var nav = u256(r[0]), idle = u256(r[1]), supply = u256(r[2]), n = Number(u256(r[3]));
        els.nav.textContent = usd(nav);
        els.idle.textContent = usd(idle);
        els.share.textContent = supply > 0n ? (Number(nav) / Number(supply)).toFixed(6) : "1.000000";
        var reads = [];
        for (var i = 0; i < n; i++) reads.push(call(VAULT, A.encode.slots(i)));
        return Promise.all(reads).then(function (ss) {
          var open = 0;
          els.slots.textContent = "";
          ss.forEach(function (hex, i) {
            if (u256(hex, 10) !== 1n) return;
            open++;
            var tr = document.createElement("tr");
            [String(i), "…" + hex.slice(62, 66), px(u256(hex, 6)) + " / " + px(u256(hex, 7)), usd(u256(hex, 5)) + " a side", usd(u256(hex, 4))]
              .forEach(function (t) { var td = document.createElement("td"); td.textContent = t; tr.appendChild(td); });
            els.slots.appendChild(tr);
          });
          if (open === 0) {
            var tr = document.createElement("tr"); var td = document.createElement("td");
            td.colSpan = 5; td.textContent = "No open quotes right now — all capital is idle."; tr.appendChild(td); els.slots.appendChild(tr);
          }
          state.openSlots = open;
          state.supply = supply;
        });
      });
  }

  function loadAccount() {
    if (!state.account) return Promise.resolve();
    var a = state.account;
    return Promise.all([call(USDC, A.encode.balanceOf(a)), rpc("eth_getBalance", [a, "latest"]), call(VAULT, A.encode.balanceOf(a))])
      .then(function (r) {
        state.usdc = u256(r[0]); state.stt = BigInt(r[1]); state.shares = u256(r[2]);
        els.usdc.textContent = usd(state.usdc);
        els.stt.textContent = stt(state.stt);
        els.shares.textContent = usd(state.shares);
        return call(VAULT, A.encode.convertToAssets(state.shares));
      })
      .then(function (hex) {
        state.worth = u256(hex);
        els.worth.textContent = usd(state.worth);
        var last = state.supply > 0n && state.shares === state.supply;
        var blocked = (last && state.openSlots > 0) || state.shares === 0n;
        els.guard.hidden = !(last && state.openSlots > 0);
        els.withdrawAll.dataset.blocked = blocked ? "true" : "false";
        els.withdrawAll.disabled = state.busy || !state.chainOk || blocked;
        els.allPreview.textContent = state.shares > 0n ? "≈ " + usd(state.worth) + " tUSDC for " + usd(state.shares) + " shares" : "";
        if (!state.busy && state.account && state.chainOk) status("Ready. Balances refresh every 30 seconds.", "info");
      });
  }

  function refresh() {
    if (document.visibilityState === "hidden") return Promise.resolve();
    return loadVault().then(loadWake).then(loadAccount).catch(function (e) {
      status("Could not read the chain (" + e.message + "). Numbers on this page may be stale until the next refresh.", "error");
    });
  }

  // ---------------------------------------------------------------- wallet
  function provider() { return window.ethereum; }

  function ensureChain() {
    var p = provider();
    return p.request({ method: "eth_chainId" }).then(function (id) {
      if (id === CHAIN_ID) return true;
      return p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID }] })
        .then(function () { return true; })
        .catch(function (err) {
          if (err && (err.code === 4902 || /unrecognized|not added/i.test(String(err.message)))) {
            return p.request({ method: "wallet_addEthereumChain", params: [CHAIN] }).then(function () { return true; });
          }
          throw err;
        });
    });
  }

  function paintWallet() {
    if (!state.account) {
      els.wallet.textContent = "Not connected";
      els.network.textContent = "";
      els.connect.textContent = provider() ? "Connect wallet" : "No wallet found";
      els.connect.disabled = !provider();
      els.nowallet.hidden = !!provider();
      status(provider() ? "Connect a wallet to enable these." : "No wallet in this browser, so the actions are off. The numbers are still live.", "info");
      return;
    }
    els.wallet.textContent = short(state.account);
    els.network.textContent = state.chainOk ? "Somnia Shannon · 50312" : "Wrong network — switch to Somnia Shannon";
    els.connect.textContent = state.chainOk ? "Connected" : "Switch network";
    els.connect.disabled = state.chainOk;
    setBusy(false);
  }

  function connect() {
    var p = provider();
    if (!p) { say("No EIP-1193 wallet in this browser. Install one, then reload."); return; }
    p.request({ method: "eth_requestAccounts" })
      .then(function (accs) { state.account = accs[0]; return ensureChain(); })
      .then(function () { state.chainOk = true; paintWallet(); say("Connected " + short(state.account) + " on Somnia Shannon."); return refresh(); })
      .catch(function (e) { state.chainOk = false; paintWallet(); say("Wallet: " + (e && e.message ? e.message : String(e))); });
  }

  function waitFor(hash) {
    return new Promise(function (resolve, reject) {
      var tries = 0;
      (function poll() {
        rpc("eth_getTransactionReceipt", [hash]).then(function (r) {
          if (r) return resolve(r);
          if (++tries > 120) return reject(new Error("no receipt after 2 minutes"));
          setTimeout(poll, 1000);
        }).catch(reject);
      })();
    });
  }

  function send(label, to, data) {
    status(label + ": waiting for your signature in the wallet…", "busy");
    return provider().request({ method: "eth_sendTransaction", params: [{ from: state.account, to: to, data: data }] })
      .then(function (hash) {
        say(label + " sent; waiting for the chain.", EXPLORER + "/tx/" + hash, "busy");
        return waitFor(hash).then(function (r) {
          if (r.status !== "0x1") throw new Error(label + " reverted");
          say(label + " confirmed in block " + Number(BigInt(r.blockNumber)).toLocaleString("en-US") + ".", EXPLORER + "/tx/" + hash);
          return r;
        });
      });
  }

  function amountUsd(input) {
    var raw = String(input.value).trim().replace(/,/g, "");
    if (raw === "") throw new Error("Enter an amount in tUSDC first.");
    var v = Number(raw);
    if (!isFinite(v) || !(v > 0)) throw new Error("Enter an amount above zero, in tUSDC.");
    if (/\.\d{7,}/.test(raw)) throw new Error("tUSDC has six decimals; enter no more than six.");
    return BigInt(Math.round(v * 1e6));
  }

  /** The checks the chain would make, made here first, so a mistake costs no gas. */
  function preflight(kind, amt) {
    if (state.stt === 0n) throw new Error("Your wallet holds no STT for gas. Get 0.5 STT from the Somnia faucet (link in the Gas panel), then try again.");
    if (kind === "deposit" && amt > state.usdc) throw new Error("You have " + usd(state.usdc) + " tUSDC; enter that or less, or mint more from the faucet.");
    if (kind === "withdraw" && amt > state.worth) throw new Error("Your shares are worth " + usd(state.worth) + " tUSDC; enter that or less.");
  }

  function run(fn, button) {
    if (state.busy) return;
    setBusy(true, button);
    Promise.resolve().then(fn)
      .catch(function (e) {
        var m = e && e.message ? e.message : String(e);
        if (/user rejected|denied|4001/i.test(m)) m = "You cancelled in the wallet. Nothing was sent.";
        else if (/insufficient funds/i.test(m)) m = "The wallet has no STT to pay gas. Get some from the Somnia faucet (Gas panel), then try again.";
        say(m, null, "error");
      })
      .then(function () { setBusy(false); return refresh(); });
  }

  // ---------------------------------------------------------------- actions
  els.connect.addEventListener("click", connect);

  els.faucet.addEventListener("click", function () {
    run(function () {
      if (state.stt === 0n) throw new Error("Your wallet holds no STT for gas. Get 0.5 STT from the Somnia faucet (link in the Gas panel), then try again.");
      return send("Mint 10,000 tUSDC", USDC, A.encode.faucet(10_000_000_000n));
    }, els.faucet);
  });

  els.amountMax.addEventListener("click", function () { els.amount.value = (Number(state.usdc) / 1e6).toFixed(6).replace(/\.?0+$/, ""); els.amount.focus(); });
  els.withdrawMax.addEventListener("click", function () { els.withdrawAmount.value = (Number(state.worth) / 1e6).toFixed(6).replace(/\.?0+$/, ""); els.withdrawAmount.focus(); });

  els.depositForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    run(function () {
      var amt = amountUsd(els.amount);
      preflight("deposit", amt);
      return call(USDC, A.encode.allowance(state.account, VAULT)).then(function (hex) {
        if (u256(hex) >= amt) return;
        return send("Approve " + usd(amt) + " tUSDC for the vault", USDC, A.encode.approve(VAULT, amt));
      }).then(function () {
        return send("Deposit " + usd(amt) + " tUSDC", VAULT, A.encode.deposit(amt, state.account));
      }).then(function () { els.amount.value = ""; });
    }, els.deposit);
  });

  els.withdrawForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    run(function () {
      var amt = amountUsd(els.withdrawAmount);
      preflight("withdraw", amt);
      return send("Withdraw " + usd(amt) + " tUSDC", VAULT, A.encode.withdraw(amt, state.account, state.account))
        .then(function () { els.withdrawAmount.value = ""; });
    }, els.withdraw);
  });

  // Redeem all is the one irreversible-feeling action, so it asks twice: the first press
  // shows exactly what will happen and becomes the confirmation; five seconds of silence
  // puts it back.
  els.withdrawAll.addEventListener("click", function () {
    if (state.confirmAll === null) {
      els.withdrawAll.textContent = "Confirm: redeem " + usd(state.shares) + " shares for ≈ " + usd(state.worth) + " tUSDC";
      status("Press again within five seconds to redeem every share you hold.", "busy");
      state.confirmAll = setTimeout(function () { state.confirmAll = null; els.withdrawAll.textContent = "Redeem all shares"; status("Ready.", "info"); }, 5000);
      return;
    }
    clearTimeout(state.confirmAll); state.confirmAll = null;
    els.withdrawAll.textContent = "Redeem all shares";
    run(function () {
      if (state.stt === 0n) throw new Error("Your wallet holds no STT for gas. Get 0.5 STT from the Somnia faucet (link in the Gas panel), then try again.");
      if (!state.shares || state.shares === 0n) throw new Error("No shares to redeem.");
      return send("Redeem all " + usd(state.shares) + " shares", VAULT, A.encode.redeem(state.shares, state.account, state.account));
    }, els.withdrawAll);
  });

  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") refresh(); });

  if (provider()) {
    provider().on && provider().on("accountsChanged", function (accs) { state.account = accs[0] || null; paintWallet(); refresh(); });
    provider().on && provider().on("chainChanged", function (id) { state.chainOk = id === CHAIN_ID; paintWallet(); refresh(); });
  }

  paintWallet();
  refresh();
  setInterval(refresh, 30000);
})();
