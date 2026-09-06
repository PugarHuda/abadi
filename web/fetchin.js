/* One timeout, for every third-party read this site makes.
 *
 * `fetch` only rejects on a refused connection or on a response. Against a host that
 * accepts the socket and then says nothing, the promise stays pending until the browser's
 * own timeout, which is minutes. Every `catch` downstream is correct and simply never runs,
 * so the page keeps whatever it was showing — usually the word "loading" — and keeps
 * asserting the numbers beside it are live.
 *
 * That is not hypothetical here. It is what the dashboard's ledger did for twenty seconds a
 * request while the Shannon explorer was unreachable, and it is the reason this function
 * exists at all.
 *
 * It existed three times, though: `live.js`, `book.js` and `ledger.js` each carried their
 * own byte-identical copy, and the two files that never got one were `ledger.js`'s own
 * `eth_call` path and the whole of `app.js` — the page where money moves. A guard that has
 * to be remembered per call site is a guard that will be missed, so it lives in one file
 * now and every reader on the site routes through it.
 *
 * Loaded before the others on each page: plain <script defer> tags run in document order,
 * and `window.ABADI` is written by an inline script during parsing, so it is always here.
 */
(function () {
  "use strict";

  /** Long enough for a slow indexer, short enough that a reader does not wait on a corpse.
   *  The explorer answers in about a second when it is well; twelve is not a tight budget. */
  var DEFAULT_MS = 12000;

  window.ABADI = window.ABADI || {};

  /**
   * fetch, with an upper bound on how long silence is tolerated.
   * @param {string} url
   * @param {object} [opts]  the usual fetch init; a `signal` of your own is overwritten
   * @param {number} [ms]    default 12000
   * @returns {Promise<Response>} rejecting with "no answer in Ns" if the host went quiet
   */
  window.ABADI.fetchIn = function (url, opts, ms) {
    var wait = ms || DEFAULT_MS;
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, wait);
    var o = {};
    if (opts) Object.keys(opts).forEach(function (k) { o[k] = opts[k]; });
    o.signal = ctl.signal;
    return fetch(url, o)
      .catch(function (e) {
        // Distinguish our own abort from a network error, because "no answer in 12s" is a
        // different thing for the reader to know than "connection refused".
        throw new Error(ctl.signal.aborted ? "no answer in " + (wait / 1000) + "s" : e.message);
      })
      .then(
        function (r) { clearTimeout(timer); return r; },
        function (e) { clearTimeout(timer); throw e; }
      );
  };
}());
