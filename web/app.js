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
      .then(function (j) {
        // The revert bytes ride in `error.data`, and that is the only place the reason
        // for a failed transaction can still be found, so the Error carries it along.
        if (j.error) { var e = new Error(j.error.message); e.data = j.error.data; throw e; }
        return j.result;
      });
  }
  function call(to, data) { return rpc("eth_call", [{ to: to, data: data }, "latest"]); }

  // ---------------------------------------------------------------- state + view
  var state = {
    account: null, chainOk: false, busy: false, usdc: 0n, stt: 0n, shares: 0n, worth: 0n, idle: 0n,
    confirmAll: null, confirmShares: 0n, confirmAt: 0, readAt: null
  };
  var els = {};
  ["app", "connect", "wallet", "network", "usdc", "stt", "shares", "worth", "nav", "share", "idle",
   "amount", "amountMax", "deposit", "depositForm", "withdrawAmount", "withdrawMax", "withdraw", "withdrawForm",
   "withdrawAll", "allPreview", "faucet", "log", "logEmpty", "slots", "guard", "status", "nowallet", "wake",
   "freshness", "vaultAddr", "usdcAddr"]
    .forEach(function (id) { els[id] = document.getElementById(id); });
  var wakeStt = els.wake.querySelector("[data-wake=stt]");
  var wakeVerdict = els.wake.querySelector("[data-wake=verdict]");
  var STT_FAUCET = "https://cloud.google.com/application/web3/faucet/somnia/shannon";

  function usd(v) { return (Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  /** usd() rounds to cents, which is right for a balance and wrong for an amount about
   *  to be signed: 100.123456 must not be announced as 100.12. Every sentence that
   *  names what is being sent uses this instead — all six decimals, none invented. */
  function exact(v) {
    var s = (v < 0n ? -v : v).toString().padStart(7, "0");
    var frac = s.slice(-6).replace(/0+$/, "");
    return (v < 0n ? "-" : "") + BigInt(s.slice(0, -6)).toLocaleString("en-US") + (frac ? "." + frac : "");
  }
  function stt(v) { return (Number(v) / 1e18).toFixed(3); }
  function px(v) { return (Number(v) / 1e6).toFixed(3); }
  function short(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
  function clock(d) { return d.toISOString().slice(11, 19) + " UTC"; }
  /** What a withdrawal can actually take: the vault pays out of its token balance. */
  function available() { return state.worth < state.idle ? state.worth : state.idle; }

  /** One sentence, in two places: the status strip beside the buttons, and the log. */
  function say(text, href, tone) {
    if (els.logEmpty) { els.logEmpty.remove(); els.logEmpty = null; }
    var li = document.createElement("li");
    var t = document.createElement("time");
    t.textContent = clock(new Date());
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
    els.app.setAttribute("data-busy", b ? "true" : "false");
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
        state.idle = idle;
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
        els.allPreview.textContent = state.shares > 0n
          ? "≈ " + usd(state.worth) + " tUSDC for " + usd(state.shares) + " shares"
            + (state.worth > state.idle ? " — only " + usd(state.idle) + " of that is available now" : "")
          : "";
        if (!state.busy && state.account && state.chainOk) status("Ready. Balances refresh every 30 seconds.", "info");
      });
  }

  /* A read that fails leaves the last numbers on the page. They are still worth showing —
   * they were true once — but not as if they were true now, so they are struck through
   * and the heading says when they were read. */
  function refresh() {
    if (document.visibilityState === "hidden") return Promise.resolve();
    return loadVault().then(loadWake).then(loadAccount).then(function () {
      state.readAt = new Date();
      els.app.setAttribute("data-stale", "false");
      els.freshness.textContent = "read from the chain every 30 seconds";
    }).catch(function (e) {
      var when = state.readAt ? clock(state.readAt) : null;
      els.app.setAttribute("data-stale", "true");
      els.freshness.textContent = when ? "stale — last read at " + when : "never read";
      status("Could not read the chain (" + e.message + "). Every number below is struck through because it is "
        + (when ? "from " + when + ", not from now." : "not there: nothing has read yet."), "error");
    });
  }

  // ---------------------------------------------------------------- wallet
  function provider() { return window.ethereum; }

  /* Adding a chain is not switching to it, and some wallets return from a switch with
   * the user still on the old one. Only the wallet's own answer to eth_chainId, read
   * again afterwards, says where a transaction would actually go. */
  function chainId() { return provider().request({ method: "eth_chainId" }).then(function (id) { return String(id).toLowerCase(); }); }

  function ensureChain() {
    var p = provider();
    return chainId().then(function (id) {
      if (id === CHAIN_ID) return true;
      return p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID }] })
        .catch(function (err) {
          if (err && (err.code === 4902 || /unrecognized|not added/i.test(String(err.message)))) {
            return p.request({ method: "wallet_addEthereumChain", params: [CHAIN] });
          }
          throw err;
        })
        .then(chainId)
        .then(function (now) {
          if (now !== CHAIN_ID) {
            throw new Error("the wallet is still on chain " + now + ". Switch it to Somnia Shannon (50312) and press Connect again — nothing was sent.");
          }
          return true;
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

  // ---------------------------------------------------------------- revert reasons
  /*
   * A failed receipt carries a status bit and nothing else. The reason is still in the
   * call, so a failure replays it with eth_call at the block it failed in and decodes
   * what comes back: four bytes of keccak over the error signature, then its arguments,
   * ABI-encoded. The selectors below are those four bytes for the errors this vault and
   * this token can throw; qa/app.spec.ts checks every one against the compiler's.
   */
  function argAddr(a, i) { return "0x" + a.slice(26 + 64 * i, 66 + 64 * i); }
  function argString(a) {
    var at = 2 + Number(u256(a, 0)) * 2, len = Number(BigInt("0x" + a.slice(at, at + 64))), s = "";
    for (var i = 0; i < len * 2; i += 2) s += "%" + a.substr(at + 64 + i, 2);
    try { return decodeURIComponent(s); } catch (e) { return a.slice(at + 64); }
  }
  var REVERTS = {
    "0x71ca2b95": function (a) { return "you hold the last share and slot " + u256(a) + " is still open. Emptying the vault now would hand that quote's proceeds to nobody, so leave a little in, or wait for the slot to close."; }, // LastShareWhileOpen(uint256)
    "0x7962023c": function (a) { return "slot " + u256(a) + " is outside the range of slots the vault has."; }, // SlotOutOfRange(uint256)
    "0x5aa26fac": function (a) { return "slot " + u256(a) + " holds no quote."; },                              // SlotIdle(uint256)
    "0x76c6c93a": function () { return "only the operator key may do that, and this wallet is not it."; },      // NotOperator(address)
    "0x43b8915b": function (a) { return "the venue rejected the order (kind " + u256(a) + ")."; },              // OrderRejected(uint8)
    "0xc8564bd3": function (a) { return "the vault needs " + usd(u256(a, 0)) + " tUSDC idle and has " + usd(u256(a, 1)) + "."; }, // InsufficientIdle(uint256,uint256)
    "0x097ffe96": function (a) { return "that market is not trading (venue status " + u256(a, 1) + ")."; },     // MarketNotTrading(bytes32,uint8)
    "0xe450d38c": function (a) { return "the token refused: " + short(argAddr(a, 0)) + " holds " + usd(u256(a, 1)) + " and " + usd(u256(a, 2)) + " is needed. On a withdrawal that address is the vault, which pays only out of idle collateral — the rest is working in open quotes."; }, // ERC20InsufficientBalance(address,uint256,uint256)
    "0xfb8f41b2": function (a) { return "the token refused: " + short(argAddr(a, 0)) + " is approved for " + usd(u256(a, 1)) + " and " + usd(u256(a, 2)) + " is needed. Approve again."; }, // ERC20InsufficientAllowance(address,uint256,uint256)
    "0x08c379a0": function (a) { return argString(a); },                                                       // Error(string)
    "0x4e487b71": function (a) { return "the contract hit a panic (code " + u256(a) + ")."; }                   // Panic(uint256)
  };
  A.REVERTS = REVERTS;

  /** Revert bytes to one sentence. Null when there are no bytes to read. */
  function revertReason(hex) {
    if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{8}/.test(hex)) return null;
    var sel = hex.slice(0, 10).toLowerCase(), f = REVERTS[sel];
    if (!f) return "the call reverted with an error this page cannot name (" + sel + ").";
    try { return f("0x" + hex.slice(10)); } catch (e) { return "the call reverted with " + sel + ", and its arguments did not decode."; }
  }
  A.revertReason = revertReason;

  /** Replay a failed call where it failed, and say why. */
  function whyReverted(to, data, block) {
    return rpc("eth_call", [{ from: state.account, to: to, data: data }, block])
      .then(function () { return "replaying the call at that block did not fail, so the chain kept the reason to itself."; })
      .catch(function (e) {
        var hex = e && e.data;
        if (hex && typeof hex === "object") hex = hex.data || hex.originalError && hex.originalError.data;
        if (typeof hex !== "string") { var m = /0x[0-9a-fA-F]{8,}/.exec(String(e && e.message)); hex = m && m[0]; }
        return revertReason(hex) || "the chain gave no reason (" + (e && e.message ? e.message : String(e)) + ").";
      });
  }

  function send(label, to, data) {
    status(label + ": waiting for your signature in the wallet…", "busy");
    return provider().request({ method: "eth_sendTransaction", params: [{ from: state.account, to: to, data: data }] })
      .then(function (hash) {
        say(label + " sent; waiting for the chain.", EXPLORER + "/tx/" + hash, "busy");
        return waitFor(hash).then(function (r) {
          if (r.status !== "0x1") {
            return whyReverted(to, data, r.blockNumber).then(function (why) { throw new Error(label + " reverted: " + why); });
          }
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

  /* The checks the chain would make, made here first, so a mistake costs no gas.
   *
   * A withdrawal is paid out of the vault's own token balance, not out of NAV: shares
   * worth 900 against 5 idle send a transaction that reverts with ERC20InsufficientBalance
   * and costs gas for nothing. Both ceilings apply, and the lower one is the real one. */
  function preflight(kind, amt) {
    if (state.stt === 0n) throw new Error("Your wallet holds no STT for gas. Get 0.5 STT from the Somnia faucet (link in the Gas panel), then try again.");
    if (kind === "deposit" && amt > state.usdc) throw new Error("You have " + usd(state.usdc) + " tUSDC; enter that or less, or mint more from the faucet.");
    if (kind === "withdraw") {
      if (amt > state.worth) throw new Error("Your shares are worth " + usd(state.worth) + " tUSDC; enter that or less.");
      if (amt > state.idle) throw new Error(usd(state.idle) + " tUSDC is available now — the rest is working in open quotes and comes back as they close. Withdraw that or less, or wait.");
    }
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
  els.withdrawMax.addEventListener("click", function () {
    els.withdrawAmount.value = (Number(available()) / 1e6).toFixed(6).replace(/\.?0+$/, "");
    els.withdrawAmount.focus();
    if (state.worth > state.idle) status(usd(state.idle) + " tUSDC is available now — the rest is working in open quotes, and comes back as they close.", "info");
  });

  els.depositForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    run(function () {
      var amt = amountUsd(els.amount);
      preflight("deposit", amt);
      return call(USDC, A.encode.allowance(state.account, VAULT)).then(function (hex) {
        if (u256(hex) >= amt) return;
        return send("Approve " + exact(amt) + " tUSDC for the vault", USDC, A.encode.approve(VAULT, amt));
      }).then(function () {
        return send("Deposit " + exact(amt) + " tUSDC", VAULT, A.encode.deposit(amt, state.account));
      }).then(function () { els.amount.value = ""; });
    }, els.deposit);
  });

  els.withdrawForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    run(function () {
      var amt = amountUsd(els.withdrawAmount);
      preflight("withdraw", amt);
      return send("Withdraw " + exact(amt) + " tUSDC", VAULT, A.encode.withdraw(amt, state.account, state.account))
        .then(function () { els.withdrawAmount.value = ""; });
    }, els.withdraw);
  });

  // Redeem all is the one irreversible-feeling action, so it asks twice: the first press
  // shows exactly what will happen and becomes the confirmation; five seconds of silence
  // puts it back. Two presses inside 700ms are one accidental double-click, not two
  // decisions, and the number the confirmation showed is the number that gets sent —
  // a refresh landing in between must not change what the second press means.
  var DOUBLE_CLICK = 700;
  els.withdrawAll.addEventListener("click", function () {
    if (state.worth > state.idle) {
      say("Redeeming every share needs " + usd(state.worth) + " tUSDC and " + usd(state.idle) + " is available now — the rest is working in open quotes. "
        + "Withdraw up to " + usd(state.idle) + " with the field above, or come back once the quotes close. Nothing was sent.", null, "error");
      return;
    }
    if (state.confirmAll === null) {
      state.confirmShares = state.shares;
      state.confirmAt = Date.now();
      els.withdrawAll.textContent = "Confirm: redeem " + exact(state.confirmShares) + " shares for ≈ " + exact(state.worth) + " tUSDC";
      status("Press again within five seconds to redeem every share you hold.", "busy");
      state.confirmAll = setTimeout(function () { state.confirmAll = null; els.withdrawAll.textContent = "Redeem all shares"; status("Ready.", "info"); }, 5000);
      return;
    }
    if (Date.now() - state.confirmAt < DOUBLE_CLICK) return;
    var shares = state.confirmShares;
    clearTimeout(state.confirmAll); state.confirmAll = null;
    els.withdrawAll.textContent = "Redeem all shares";
    run(function () {
      if (state.stt === 0n) throw new Error("Your wallet holds no STT for gas. Get 0.5 STT from the Somnia faucet (link in the Gas panel), then try again.");
      if (!shares || shares === 0n) throw new Error("No shares to redeem.");
      return send("Redeem all " + exact(shares) + " shares", VAULT, A.encode.redeem(shares, state.account, state.account));
    }, els.withdrawAll);
  });

  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") refresh(); });

  if (provider()) {
    provider().on && provider().on("accountsChanged", function (accs) { state.account = accs[0] || null; paintWallet(); refresh(); });
    provider().on && provider().on("chainChanged", function (id) { state.chainOk = String(id).toLowerCase() === CHAIN_ID; paintWallet(); refresh(); });
  }

  // Nobody should approve a contract they cannot name. Both addresses, in full, linked.
  [[els.vaultAddr, VAULT], [els.usdcAddr, USDC]].forEach(function (p) {
    p[0].textContent = p[1];
    p[0].href = EXPLORER + "/address/" + p[1];
  });

  paintWallet();
  refresh();
  setInterval(refresh, 30000);
})();
