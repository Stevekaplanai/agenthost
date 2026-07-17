// AgentHost mobile app shell, injected into ttyd's page by gate.js.
// v2: segmented terminal|chat nav, font-size controls, status dot, two-row
// touch key bar with sticky Ctrl, reconnect overlay on WebSocket drop.
// Everything is best-effort: if ttyd's DOM shape changes, the chrome still
// renders and the terminal keeps working; only the extras degrade.
//
// Design constraints (docs/design-brief.md + container/theme.css): base
// #0B0D10, single accent #FF6A3D, JetBrains Mono/system mono stack. Glass
// FRAMES the terminal -- the terminal pane is inset below the header and never
// sits under blur. Blur is capped at 12px and limited to the header strip plus
// at most one overlay card at a time. theme.css's VALUES (colors, radii,
// easing, durations) are mirrored here as literals because this script runs on
// ttyd's page, where /theme.css isn't linked and a stylesheet fetch mid-boot
// can't be relied on.
(function () {
  "use strict";

  var ACCENT = "#FF6A3D";
  var BASE = "#0B0D10";
  var SURFACE = "#14171B";
  var SURFACE2 = "#1A1E24"; // theme.css --surface-2
  var TEXT = "#E8ECF0";
  var OK = "#2ECC71";   // theme.css --ok
  var WARN = "#FFB020"; // theme.css --warn
  var ERR = "#FF5A5A";  // theme.css --err
  var EASE = "cubic-bezier(.2,0,.2,1)"; // theme.css --ease
  var DUR = "180ms";                    // theme.css --dur
  var DUR_SLOW = "320ms";               // theme.css --dur-slow
  var HEADER_H = 42;
  var KEYBAR_H = 96; // two rows
  var MONO = "ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace";

  // Coarse-pointer only for the key bar; the header shows everywhere.
  var isTouch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;

  // ---- WebSocket status hook --------------------------------------------
  // Wrap the constructor so we can observe ttyd's terminal socket without
  // touching its protocol. Status drives the header dot + reconnect overlay.
  // This script loads BEFORE ttyd's bundle (gate.js injects it non-deferred),
  // so the wrapper is in place when ttyd connects; state changes that happen
  // before the chrome is built are buffered in lastStatus.
  var lastStatus = null;
  var setStatus = function (state) { lastStatus = state; };
  var pageHiding = false;
  window.addEventListener("pagehide", function () { pageHiding = true; });
  var NativeWS = window.WebSocket;
  function WrappedWS(url, protocols) {
    var ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    setStatus("connecting");
    ws.addEventListener("open", function () { setStatus("connected"); });
    ws.addEventListener("close", function () { if (!pageHiding) setStatus("dropped"); });
    ws.addEventListener("error", function () { if (!pageHiding) setStatus("dropped"); });
    return ws;
  }
  WrappedWS.prototype = NativeWS.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) { WrappedWS[k] = NativeWS[k]; });
  window.WebSocket = WrappedWS;

  function xtermInput() {
    return document.querySelector(".xterm-helper-textarea");
  }

  // Terminal control sequences for the special keys the bar sends. These are
  // the raw bytes a real keyboard would put on the wire; sending them straight
  // to the pty (via ttyd's socket) needs no focus and no synthetic key events.
  var SEQ = {
    Escape: "\x1b", Tab: "\t", Enter: "\r",
    ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D",
  };
  // Retained only for the synthetic fallback path (xterm maps by keyCode).
  var KEYCODES = {
    Escape: 27, Tab: 9, Enter: 13,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  };

  // THE keyboard fix. Send input to the pty through xterm's OWN data pipe --
  // triggerDataEvent is exactly the path ttyd wired to its socket via
  // term.onData, so ttyd frames it correctly and it never touches focus (so the
  // phone keyboard never pops on a key-bar tap). We do NOT write to ttyd's raw
  // socket ourselves: an earlier version guessed the wire frame ('0'+data) and
  // ttyd echoed protocol JSON into the terminal. If xterm's core isn't reachable
  // (unexpected on ttyd's xterm build), return false and the caller falls back
  // to synthetic key events.
  function sendData(data) {
    var t = window.term;
    if (t && t._core && t._core.coreService && typeof t._core.coreService.triggerDataEvent === "function") {
      try { t._core.coreService.triggerDataEvent(data, true); return true; } catch (e) {}
    }
    return false;
  }

  // Fallback focus (only when neither socket nor xterm pipe is reachable). Kept
  // minimal and only touches inputmode when the textarea isn't already focused.
  var quietTimer = null;
  function quietFocus(el) {
    if (document.activeElement === el) return;
    el.setAttribute("inputmode", "none");
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(function () { el.removeAttribute("inputmode"); }, 400);
  }

  // Stop the browser's password/card/location autofill bar from hijacking the
  // strip above the keyboard: the terminal's hidden textarea looks like a plain
  // input to autofill heuristics. These attributes opt it out. Best-effort and
  // idempotent; ttyd recreates the textarea on some resizes, so we (re)apply on
  // first sight from build().
  function tameXtermTextarea() {
    var el = xtermInput();
    if (!el || el.getAttribute("data-ah-tamed")) return;
    el.setAttribute("autocomplete", "off");
    el.setAttribute("autocorrect", "off");
    el.setAttribute("autocapitalize", "none");
    el.setAttribute("spellcheck", "false");
    el.setAttribute("data-form-type", "other"); // Dashlane/1Password opt-out hint
    el.setAttribute("data-ah-tamed", "1");
  }

  function sendKey(key, opts) {
    var data;
    if (opts && opts.ctrlKey && key.length === 1) {
      data = String.fromCharCode(key.toUpperCase().charCodeAt(0) & 0x1f); // Ctrl-<x>
    } else {
      data = SEQ[key] || (key.length === 1 ? key : "");
    }
    if (data && sendData(data)) return;
    // Fallback: synthetic key event on the focused textarea.
    var el = xtermInput();
    if (!el) return;
    quietFocus(el);
    var code = KEYCODES[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    var init = Object.assign(
      { key: key, keyCode: code, which: code, bubbles: true, cancelable: true },
      opts || {}
    );
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  function sendText(text) {
    if (sendData(text)) return;
    // Fallback: keypress path (xterm reads ev.charCode there).
    var el = xtermInput();
    if (!el) return;
    quietFocus(el);
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      var code = ch.charCodeAt(0);
      el.dispatchEvent(new KeyboardEvent("keypress", {
        key: ch, keyCode: code, charCode: code, which: code,
        bubbles: true, cancelable: true,
      }));
    }
  }

  // ---- touch -> wheel bridge (phone scrollback) ---------------------------
  // PROVEN in the sandbox against REAL ttyd 1.7.4 + tmux with `mouse on`
  // (CDP-dispatched touch, tmux #{pane_in_mode} as the measure): a WHEEL event
  // enters tmux copy-mode scrollback, but a TOUCH drag reaches tmux not at all
  // -- ttyd's xterm.js never synthesizes mouse-scroll reports from touch, and
  // on tmux's alt screen xterm has no scrollback of its own to move either.
  // That is why Steve's phone couldn't scroll history even after mouse-on
  // shipped (iOS Safari + Chrome, 2026-07-11). Bridge: turn vertical touch
  // drags over the terminal into synthetic wheel events on .xterm-screen;
  // they bubble to .xterm, where xterm's own wheel path emits the tmux
  // mouse-scroll sequences (and, with mouse tracking off, falls back to
  // xterm's viewport/alt-scroll handling). One wheel event per text-row of
  // finger travel keeps drag distance and lines scrolled ~1:1 at any font
  // size. Direct drag only -- no momentum/flick in v1.
  function wireTouchScroll(mount) {
    var lastY = null, acc = 0;
    function rowPx() {
      var t = window.term;
      var fs = (t && t.options && t.options.fontSize) || 15;
      return Math.max(10, Math.round(fs * 1.2)); // xterm's default lineHeight
    }
    mount.addEventListener("touchstart", function (e) {
      lastY = e.touches.length === 1 ? e.touches[0].clientY : null;
      acc = 0;
    }, { passive: true });
    mount.addEventListener("touchmove", function (e) {
      if (lastY === null || e.touches.length !== 1) return;
      var y = e.touches[0].clientY;
      acc += lastY - y; // finger down = negative = wheel up = into history
      lastY = y;
      // We own this gesture; stop the page from rubber-banding instead.
      if (e.cancelable) e.preventDefault();
      var step = rowPx();
      // Dispatch INSIDE the terminal: .xterm-screen bubbles to .xterm where
      // xterm's listeners live. e.target can be the mount itself (padding
      // strip below the fitted rows), and from there a dispatched event
      // would never reach xterm's child element -- hence the querySelector.
      var tgt = mount.querySelector(".xterm-screen") || e.target || mount;
      while (Math.abs(acc) >= step) {
        var dir = acc > 0 ? 1 : -1;
        acc -= dir * step;
        try {
          tgt.dispatchEvent(new WheelEvent("wheel", {
            bubbles: true, cancelable: true, deltaMode: 0,
            deltaY: dir * step,
            clientX: e.touches[0].clientX, clientY: y,
          }));
        } catch (err) { return; } // ancient WebKit without WheelEvent(): give up quietly
      }
    }, { passive: false });
    mount.addEventListener("touchend", function () { lastY = null; }, { passive: true });
    mount.addEventListener("touchcancel", function () { lastY = null; }, { passive: true });
  }

  // Paste the clipboard into the terminal -- "the v to paste with". The tap is a
  // user gesture, which is what the clipboard read permission needs.
  function pasteFromClipboard() {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (t) { if (t) sendData(t); }).catch(function () {});
    }
  }

  // Tiny toast ("link copied") -- mirrors theme.css .ah-toast. One element,
  // reused; a repeat call restarts the fade rather than stacking toasts.
  var toastEl = null;
  var toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "ah-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.remove("show");
    void toastEl.offsetWidth; // restart the transition if one is mid-flight
    toastEl.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 1800);
  }

  // ttyd 1.7.x exposes its xterm as window.term; font resize is best-effort.
  var FONT_KEY = "agenthost_font_" + location.hostname;
  function setFont(delta) {
    var t = window.term;
    if (!t || !t.options) return;
    var next = Math.min(22, Math.max(11, (t.options.fontSize || 15) + delta));
    t.options.fontSize = next;
    try { localStorage.setItem(FONT_KEY, String(next)); } catch (e) {}
    window.dispatchEvent(new Event("resize")); // ttyd refits on resize
  }
  function restoreFont() {
    var saved = parseInt(localStorage.getItem(FONT_KEY) || "", 10);
    if (saved && window.term && window.term.options) {
      window.term.options.fontSize = saved;
      window.dispatchEvent(new Event("resize"));
    }
  }

  // ---- link grabber -----------------------------------------------------
  // OAuth/login URLs printed in the terminal wrap across rows, so on a phone
  // you can't highlight them and ttyd's clickable-link only opens the first
  // row's fragment. We rebuild the FULL url from xterm's buffer.
  //
  // A wrapped URL -- whether SOFT-wrapped by the terminal at its width, or
  // HARD-wrapped by an app's panel at a NARROWER width with real newlines (which
  // is exactly what `claude` does with its OAuth URL) -- has one signature: each
  // fragment fills to the end of its row (the URL reaches end-of-row after
  // trimRight) and the next fragment starts at column 0. We stitch on THAT, so
  // line.isWrapped and terminal width don't matter. The old isWrapped/width
  // logic missed the hard-wrap case and returned only "...authorize?code=true".
  function extractUrls() {
    var t = window.term;
    if (!t || !t.buffer || !t.buffer.active) return [];
    var buf = t.buffer.active;
    var rows = [];
    for (var i = 0; i < buf.length; i++) {
      var line = buf.getLine(i);
      rows.push(line ? line.translateToString(true) : ""); // trimRight per row
    }
    var URLSAFE = /^[^\s"'<>`]+$/;        // an ENTIRE row of URL-safe chars
    var START = /https?:\/\/[^\s"'<>`]*/; // a URL from its scheme to end of run
    var urls = [];
    for (var r = 0; r < rows.length; r++) {
      var m = rows[r].match(START);
      if (!m) continue;
      var url = m[0];
      var end = m.index + m[0].length; // column where the match ends on this row
      var k = r;
      // Stitch continuation rows while the URL reaches the end of the current
      // row. A continuation fragment is an ENTIRE row of URL-safe characters --
      // no whitespace anywhere. Prose after the URL ("Waiting for auth...",
      // "Paste code here >") contains spaces, so it's never mistaken for the
      // URL's tail; a blank line also ends it. This is what makes both a soft
      // terminal wrap and claude's narrower hard wrap rejoin correctly.
      while (end >= rows[k].length && k + 1 < rows.length) {
        // Strip a leading panel indent: some claude panels (e.g. the /mcp OAuth
        // prompt) indent every wrapped line a couple spaces, so the continuation
        // isn't flush-left. After the indent, a real URL fragment is still one
        // solid run of URL-safe chars; prose still has interior spaces.
        var next = rows[k + 1].replace(/^\s+/, "");
        if (!next.length || !URLSAFE.test(next)) break;
        url += next;
        k++;
        end = rows[k].length; // consumed a full row -> the URL may continue further
      }
      urls.push(url.replace(/[)\].,;:'"]+$/, "")); // drop trailing sentence punctuation
      r = k; // don't re-scan the fragments we just consumed
    }
    // De-dup keeping most-recent-last; return newest first for the picker.
    var seen = {}, out = [];
    for (var n = urls.length - 1; n >= 0; n--) { if (!seen[urls[n]]) { seen[urls[n]] = 1; out.push(urls[n]); } }
    return out;
  }

  // ---- Web Push (feature 3) ---------------------------------------------
  // Register the SW and wire the header bell. Everything is feature-gated:
  // on a browser without SW/PushManager the bell is hidden and nothing throws.
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function () {});
  function u8(b) {
    var pad = "=".repeat((4 - b.length % 4) % 4);
    var s = (b + pad).replace(/-/g, "+").replace(/_/g, "/");
    var raw = atob(s), arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }
  function wirePush(bell) {
    if (!bell) return;
    if (!("serviceWorker" in navigator && "PushManager" in window && "Notification" in window)) {
      bell.style.display = "none";
      return;
    }
    function reflect() {
      bell.classList.toggle("on", Notification.permission === "granted");
      bell.classList.toggle("off", Notification.permission === "denied");
    }
    reflect();
    bell.addEventListener("click", function () {
      Notification.requestPermission().then(function (perm) {
        reflect();
        if (perm !== "granted") return;
        return navigator.serviceWorker.ready.then(function (reg) {
          return fetch("/push/key").then(function (r) { return r.json(); }).then(function (d) {
            if (!d || !d.key) throw new Error("push not configured"); // /push/key 503
            return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8(d.key) });
          }).then(function (sub) {
            return fetch("/push/subscribe", { method: "POST",
              headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub) });
          });
        });
      }).catch(function () {});
    });
  }

  // ---- build ------------------------------------------------------------
  // ttyd builds its terminal container at RUNTIME, so it is NOT in the initial
  // HTML at DOMContentLoaded. The id also varies by ttyd version: 1.7.x uses
  // #terminal-container, older builds used #terminal. build() returns false
  // until the mount appears (startWatch keeps polling); an early one-shot bail
  // is what left the phone staring at bare ttyd with no chrome.
  var TERM_SEL = "#terminal-container, #terminal";
  function terminalEl() { return document.querySelector(TERM_SEL); }

  function build() {
    if (document.getElementById("ah-header")) return true; // already dressed (idempotent)
    // The gate's login screen has its own design -- never dress it. It carries
    // the #k access-key input and no ttyd mount, so this also stops the watcher.
    if (document.getElementById("k")) return true;
    if (!terminalEl()) return false; // ttyd hasn't mounted yet; caller retries
    // Brand: gate.js stamps data-brand="legal" on the body tag of the proxied
    // terminal page for legal deploys (LEGAL_MODE boxes). The terminal chrome
    // stays dark in both brands (glass frames the terminal); legal only
    // re-orders the tabs (chat-first), renames the wordmark, warms the accents.
    // (Comment deliberately avoids the literal open-body-tag string: this file
    // is inlined into a <head> script by the UI rig, and the gate's serve-time
    // stamp must never match a mention instead of the real tag.)
    var brand = document.body.getAttribute("data-brand") === "legal" ? "legal" : "dev";
    var css = document.createElement("style");
    css.textContent = [
      ":root { --ah-header-h: " + HEADER_H + "px; --ah-keybar-h: " + (isTouch ? KEYBAR_H : 0) + "px; --ah-kb-inset: 0px; }",
      // Shared motion vocabulary -- same names and timings as theme.css.
      "@keyframes ah-breathe { 0%,100% { box-shadow: 0 0 0 0 rgba(46,204,113,.5); } 50% { box-shadow: 0 0 0 5px rgba(46,204,113,0); } }",
      "@keyframes ah-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(255,176,32,.55); } 50% { box-shadow: 0 0 0 6px rgba(255,176,32,0); } }",
      "@keyframes ah-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }",
      "@keyframes ah-fade { from { opacity: 0; } to { opacity: 1; } }",
      "@keyframes ah-shimmer { from { background-position: -200% 0; } to { background-position: 200% 0; } }",
      // Inset ttyd's terminal so chrome never covers content (brief rule #1).
      // Cover both ids so whichever ttyd mounts gets inset.
      "#terminal, #terminal-container { position: fixed !important; top: calc(var(--ah-header-h) + env(safe-area-inset-top)) !important;",
      "  bottom: calc(var(--ah-keybar-h) + env(safe-area-inset-bottom) + var(--ah-kb-inset)) !important;",
      "  left: 0 !important; right: 0 !important; width: auto !important; height: auto !important;",
      // Touch: the bridge owns drags (touch->wheel); without touch-action:none
      // iOS can still start a native overscroll/bounce that eats the gesture.
      (isTouch ? "  touch-action: none; " : "") + "}",
      // One glass-card recipe for every floating panel (mirrors .ah-glass). The
      // fill is near-solid on purpose: if backdrop-filter silently no-ops (iOS
      // low-power mode) the card stays legible; blur sits inside the 12px
      // mobile budget, and only one such card is ever up at a time.
      ".ah-card { background: radial-gradient(120% 100% at 50% 0%, rgba(255,255,255,.09), rgba(255,255,255,.01) 48%), rgba(20,23,27,.92);",
      "  border: 1px solid rgba(255,255,255,.16); border-radius: 20px;",
      "  box-shadow: inset 0 1.5px 1px rgba(255,255,255,.5), inset 0 -1px 1px rgba(255,255,255,.1),",
      "    inset 0 0 22px rgba(255,255,255,.045), 0 24px 50px -16px rgba(0,0,0,.72);",
      "  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);",
      "  animation: ah-rise " + DUR_SLOW + " " + EASE + " both; }",
      // Header: the one persistent glass strip. The terminal is inset BELOW it,
      // so the blur frames content without ever sampling it.
      "#ah-header { position: fixed; top: 0; left: 0; right: 0;",
      "  height: calc(var(--ah-header-h) + env(safe-area-inset-top));",
      "  padding-top: env(safe-area-inset-top);",
      "  z-index: 2147483646; display: flex; align-items: center; gap: 8px;",
      "  padding-left: calc(12px + env(safe-area-inset-left));",
      "  padding-right: calc(10px + env(safe-area-inset-right));",
      "  background: rgba(11,13,16,.9); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);",
      "  border-bottom: 1px solid rgba(255,255,255,.10); box-shadow: inset 0 1px 0 rgba(255,255,255,.05);",
      "  font: 600 12px " + MONO + "; color: " + TEXT + "; user-select: none; box-sizing: border-box; }",
      // Status dot: theme.css .ah-dot language -- live = calm green breathing,
      // connecting = amber pulse, dropped = static red.
      "#ah-dot { width: 8px; height: 8px; border-radius: 50%; background: " + WARN + "; flex: none;",
      "  transition: background " + DUR + " " + EASE + "; animation: ah-pulse 1.1s " + EASE + " infinite; }",
      "#ah-dot.connected { background: " + OK + "; animation: ah-breathe 3.2s " + EASE + " infinite; }",
      "#ah-dot.dropped { background: " + ERR + "; animation: none; }",
      // Segmented app switcher -- shared pattern with chat.html. The tab nav is
      // PRIMARY navigation and must stay reachable at every width -- with 6+
      // apps it can't fit a phone, so the bar shrinks (flex: 0 1 auto,
      // min-width: 0) and scrolls horizontally instead of clipping pills off-
      // screen or pushing the header wide. Pills never wrap (flex: none) so
      // each stays a clean tap target; the active one is scrolled into view on
      // render (see NAV_JS in gate.js). Scrollbar chrome is hidden -- a phone
      // header is not where a visible scrollbar track belongs.
      "#ah-tabs { margin-left: auto; display: flex; border: 1px solid rgba(255,255,255,.16);",
      "  border-radius: 999px; flex: 0 1 auto; min-width: 0; overflow-x: auto; overflow-y: hidden;",
      "  scrollbar-width: none; -ms-overflow-style: none; -webkit-overflow-scrolling: touch; }",
      "#ah-tabs::-webkit-scrollbar { display: none; }",
      "#ah-tabs a { flex: none; white-space: nowrap; padding: 4px 13px; font: 600 11px " + MONO + "; text-decoration: none;",
      "  color: " + TEXT + "; opacity: .6; -webkit-tap-highlight-color: transparent;",
      "  transition: background " + DUR + " " + EASE + ", color " + DUR + " " + EASE + ",",
      "    opacity " + DUR + " " + EASE + ", transform 120ms " + EASE + "; }",
      "#ah-tabs a:active { transform: scale(.97); }",
      "#ah-tabs a.on { background: rgba(255,106,61,.16); color: " + ACCENT + "; opacity: 1; }",
      // Header buttons share one geometry + press feedback.
      ".ah-font, #ah-bell, #ah-link, #ah-fsize { flex: none; width: 30px; height: 26px; margin-left: 6px; border-radius: 8px;",
      "  border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.05);",
      "  color: " + TEXT + "; padding: 0; -webkit-tap-highlight-color: transparent;",
      "  transition: background 120ms " + EASE + ", transform 120ms " + EASE + ", border-color " + DUR + " " + EASE + "; }",
      ".ah-font:active, #ah-bell:active, #ah-link:active, #ah-fsize:active { background: rgba(255,255,255,.16); transform: scale(.94); }",
      ".ah-font { font: 600 12px " + MONO + "; }",
      "#ah-bell, #ah-link { font: 13px " + MONO + "; }",
      "#ah-bell.on { color: " + ACCENT + "; border-color: rgba(255,106,61,.5); }",
      "#ah-bell.off { opacity: .45; }",
      // Compact text-size control: at phone widths the inline A-/A+ pair is
      // too wide, so it collapses behind this one button whose popover holds
      // the same two controls plus "boxes" (the fleet switcher lives on even
      // though the host label is dropped). Hidden at desktop widths.
      "#ah-fsize { display: none; font: 600 11px " + MONO + "; }",
      "#ah-fpop { position: fixed; z-index: 2147483647; display: none; flex-direction: column; gap: 8px;",
      "  top: calc(var(--ah-header-h) + env(safe-area-inset-top) + 6px);",
      "  right: calc(8px + env(safe-area-inset-right)); padding: 10px; }",
      "#ah-fpop.show { display: flex; }",
      "#ah-fpop .ah-font { display: block; width: 46px; height: 38px; margin-left: 0; font-size: 14px; }",
      "#ah-fpop .row { display: flex; gap: 10px; }",
      "#ah-fpop #ah-pboxes { border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06);",
      "  color: " + TEXT + "; border-radius: 10px; padding: 8px; font: 600 12px " + MONO + ";",
      "  -webkit-tap-highlight-color: transparent; }",
      // ---- phone-width fit (Steve, 2026-07-11: "the top of the menu is cut
      // off on the right") -- the tab nav is PRIMARY navigation and must stay
      // reachable at EVERY width. Order of sacrifice as the header narrows:
      // host label goes first (fleet stays reachable via Aa > boxes), then
      // A-/A+ collapse behind #ah-fsize, paddings and tab pills tighten, and
      // finally the brand may ellipsize. If the app list still outgrows the
      // bar, the bar scrolls sideways (never clipping a pill unreachable, never
      // h-scrolling the page); the bell and link grabber stay (both functional).
      "@media (max-width: 620px) { #ah-host { display: none; } }",
      "@media (max-width: 520px) {",
      "  #ah-header { gap: 6px; padding-left: calc(10px + env(safe-area-inset-left));",
      "    padding-right: calc(8px + env(safe-area-inset-right)); }",
      "  #ah-brand { font-size: 11px; flex: 0 1 auto; min-width: 0; overflow: hidden;",
      "    text-overflow: ellipsis; white-space: nowrap; }",
      "  #ah-header > .ah-font { display: none; }",
      "  #ah-fsize { display: block; }",
      "  #ah-fsize, #ah-bell, #ah-link { margin-left: 0; width: 28px; }",
      "  #ah-tabs a { padding: 4px 9px; font-size: 10px; }",
      "}",
      "@media (max-width: 385px) { #ah-header { gap: 5px; } #ah-tabs a { padding: 4px 7px; } }",
      // Link picker overlay (same glass chrome as the reconnect card).
      "#ah-links { position: fixed; inset: 0; z-index: 2147483647; display: none;",
      "  align-items: center; justify-content: center; background: rgba(11,13,16,.82);",
      "  padding: calc(16px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom)); }",
      "#ah-links.show { display: flex; animation: ah-fade 240ms " + EASE + " both; }",
      "#ah-links .card { padding: 16px; width: min(440px, 92vw); max-height: 80vh; overflow-y: auto;",
      "  font: 400 13px " + MONO + "; color: " + TEXT + "; }",
      "#ah-links .u { background: " + BASE + "; border: 1px solid rgba(255,255,255,.10);",
      "  border-radius: 10px; padding: 9px 11px; margin: 8px 0; word-break: break-all; user-select: all;",
      "  -webkit-user-select: all; font-size: 12px; }",
      "#ah-links .btns { display: flex; gap: 8px; margin-top: 6px; }",
      "#ah-links .btns a, #ah-links .btns button { flex: 1; text-align: center; text-decoration: none;",
      "  border-radius: 999px; padding: 9px; font: 600 13px " + MONO + "; border: 1px solid rgba(255,255,255,.14);",
      "  background: rgba(255,255,255,.06); color: " + TEXT + "; box-sizing: border-box;",
      "  -webkit-tap-highlight-color: transparent;",
      "  transition: background 120ms " + EASE + ", transform 120ms " + EASE + "; }",
      "#ah-links .btns a:active, #ah-links .btns button:active { transform: scale(.97); background: rgba(255,255,255,.14); }",
      "#ah-links .btns a.open { background: linear-gradient(180deg, rgba(255,255,255,.3), rgba(255,255,255,0) 55%), " + ACCENT + ";",
      "  color: " + BASE + "; border-color: transparent;",
      "  box-shadow: inset 0 1px 0 rgba(255,255,255,.55), inset 0 -1px 1px rgba(0,0,0,.18); }",
      "#ah-links .close { margin-top: 12px; width: 100%; border: 0; border-radius: 999px; padding: 10px;",
      "  background: rgba(255,255,255,.08); color: " + TEXT + "; font: 600 13px " + MONO + ";",
      "  -webkit-tap-highlight-color: transparent;",
      "  transition: background 120ms " + EASE + ", transform 120ms " + EASE + "; }",
      "#ah-links .close:active { transform: scale(.98); background: rgba(255,255,255,.14); }",
      "#ah-links .empty { opacity: .55; text-align: center; padding: 10px 0; }",
      // Key bar: solid paint (brief rule -- never rely on blur for contrast
      // this close to live terminal text).
      "#ah-keybar { position: fixed; left: 0; right: 0; bottom: var(--ah-kb-inset); z-index: 2147483646;",
      "  display: " + (isTouch ? "flex" : "none") + "; flex-direction: column; gap: 6px;",
      "  height: calc(var(--ah-keybar-h) + env(safe-area-inset-bottom));",
      "  padding: 8px calc(8px + env(safe-area-inset-left)) calc(8px + env(safe-area-inset-bottom)) calc(8px + env(safe-area-inset-right));",
      "  box-sizing: border-box; background: " + SURFACE + ";",
      "  border-top: 1px solid rgba(255,255,255,.12); box-shadow: inset 0 1px 0 rgba(255,255,255,.04); }",
      ".ah-row { display: flex; gap: 6px; flex: 1; }",
      ".ah-key { flex: 1; min-width: 0; border-radius: 10px; border: 1px solid rgba(255,255,255,.14);",
      "  background: rgba(255,255,255,.06); color: " + TEXT + ";",
      "  font: 600 13px " + MONO + "; touch-action: manipulation; -webkit-tap-highlight-color: transparent;",
      "  transition: background 120ms " + EASE + ", transform 120ms " + EASE + ",",
      "    border-color " + DUR + " " + EASE + ", box-shadow " + DUR + " " + EASE + ", color " + DUR + " " + EASE + "; }",
      // Press-in is near-instant (40ms), release eases back (120ms).
      ".ah-key:active { background: rgba(255,255,255,.18); transform: scale(.96); transition-duration: 40ms; }",
      // Sticky Ctrl armed: unmistakable accent fill + glow until spent.
      ".ah-key.armed { background: linear-gradient(180deg, rgba(255,255,255,.28), rgba(255,255,255,0) 55%), " + ACCENT + ";",
      "  color: " + BASE + "; border-color: " + ACCENT + ";",
      "  box-shadow: 0 0 14px rgba(255,106,61,.5), inset 0 1px 0 rgba(255,255,255,.5); }",
      // Reconnect overlay: ~300ms fade + card rise. Show/hide is still just the
      // .show class toggled by setStatus -- the trigger logic is unchanged.
      "#ah-overlay { position: fixed; inset: 0; z-index: 2147483647; display: flex;",
      "  align-items: center; justify-content: center; background: rgba(11,13,16,.82);",
      "  opacity: 0; visibility: hidden; pointer-events: none;",
      "  transition: opacity " + DUR_SLOW + " " + EASE + ", visibility 0s linear " + DUR_SLOW + "; }",
      "#ah-overlay.show { opacity: 1; visibility: visible; pointer-events: auto;",
      "  transition: opacity " + DUR_SLOW + " " + EASE + "; }",
      "#ah-overlay .card { padding: 22px; width: min(320px, 84vw); text-align: center;",
      "  font: 400 14px " + MONO + "; color: " + TEXT + "; animation: none;",
      "  transform: translateY(10px) scale(.97); transition: transform " + DUR_SLOW + " " + EASE + "; }",
      "#ah-overlay.show .card { transform: none; }",
      "#ah-overlay .t { font-weight: 600; font-size: 14px; }",
      "#ah-overlay .s { opacity: .55; margin-top: 6px; font-size: 12px; line-height: 1.5; }",
      "#ah-overlay .bar { margin-top: 18px; height: 3px; border-radius: 999px;",
      "  background-image: linear-gradient(100deg, rgba(255,255,255,.07) 30%, rgba(255,106,61,.7) 50%, rgba(255,255,255,.07) 70%);",
      "  background-size: 200% 100%; animation: ah-shimmer 1.6s linear infinite; }",
      "#ah-overlay .re { margin-top: 10px; font-size: 11.5px; letter-spacing: .04em; color: rgba(232,236,240,.55); }",
      "#ah-overlay button { margin-top: 16px; width: 100%; padding: 11px; border: 0; border-radius: 999px;",
      "  background: linear-gradient(180deg, rgba(255,255,255,.3), rgba(255,255,255,0) 55%), " + ACCENT + ";",
      "  color: " + BASE + "; font: 600 14px " + MONO + ";",
      "  box-shadow: inset 0 1px 0 rgba(255,255,255,.55), inset 0 -1px 1px rgba(0,0,0,.18);",
      "  -webkit-tap-highlight-color: transparent; transition: transform 120ms " + EASE + "; }",
      "#ah-overlay button:active { transform: scale(.97); }",
      // Toast ("link copied") -- same look as theme.css .ah-toast, kept clear
      // of the key bar.
      "#ah-toast { position: fixed; left: 50%; bottom: calc(var(--ah-keybar-h) + env(safe-area-inset-bottom) + 18px);",
      "  z-index: 2147483647; transform: translateX(-50%) translateY(8px);",
      "  background: " + SURFACE2 + "; color: " + TEXT + "; border: 1px solid rgba(255,255,255,.16);",
      "  border-radius: 999px; padding: 10px 20px; font: 600 13.5px " + MONO + ";",
      "  box-shadow: 0 12px 32px -8px rgba(0,0,0,.7); opacity: 0; pointer-events: none;",
      "  transition: opacity " + DUR + " " + EASE + ", transform " + DUR + " " + EASE + "; }",
      "#ah-toast.show { opacity: 1; transform: translateX(-50%); }",
      // Fleet menu backdrop fade (its card carries .ah-card).
      "#ah-fleet { animation: ah-fade 240ms " + EASE + " both; }",
      // Reduced motion: keep every state, drop the theatrics (theme.css rule).
      "@media (prefers-reduced-motion: reduce) {",
      "  #ah-dot, #ah-overlay .bar, .ah-card, #ah-links.show, #ah-fleet { animation: none !important; }",
      "  #ah-overlay, #ah-overlay .card, #ah-toast, #ah-tabs a, .ah-key, .ah-font, #ah-bell, #ah-link, #ah-fsize,",
      "  #ah-links .btns a, #ah-links .btns button, #ah-links .close, #ah-overlay button { transition: none !important; }",
      "}",
      // Legal: the active tab pill trades vermilion for a bronze warm on the
      // dark chrome (navy is invisible here; bronze is the legal highlight).
      brand === "legal"
        ? "#ah-tabs a.on { background: rgba(140,106,63,.26); color: #D9B98C; }"
        : "",
    ].join("\n");
    document.head.appendChild(css);

    // The tab bar is populated by the shared /agenthost-nav.js renderer from the
    // gate's single APPS list (one source of truth across terminal/chat/loops,
    // and where the hermes app + any future app is added). We leave the <nav>
    // empty here; nav.js fills every [data-slot="nav"] on the page and marks the
    // active tab by path. (nav.js also re-runs on mutation, so it catches this
    // header being appended asynchronously.)
    var tabsHtml = "";
    var brandMark = brand === "legal"
      ? '<span id="ah-brand">Legal HQ <span style="color:#D9B98C">▎</span></span>'
      : '<span id="ah-brand">agenthost <span style="color:' + ACCENT + '">▎</span></span>';

    // Header: dot · wordmark · host (fleet switcher) · A-/A+ · 🔗 · 🔔 · tabs.
    var header = document.createElement("div");
    header.id = "ah-header";
    header.innerHTML =
      '<span id="ah-dot"></span>' +
      brandMark +
      '<button id="ah-host" data-slot="context" style="opacity:.7;font:inherit;font-weight:400;overflow:hidden;' +
      'text-overflow:ellipsis;white-space:nowrap;background:none;border:0;color:inherit;padding:0;' +
      'flex:1 1 34px;min-width:34px;text-align:left" aria-label="switch box">' + location.hostname + "</button>" +
      '<button class="ah-font" id="ah-fminus" aria-label="smaller text">A−</button>' +
      '<button class="ah-font" id="ah-fplus" aria-label="larger text">A+</button>' +
      '<button id="ah-fsize" aria-label="text size and boxes" title="text size">Aa</button>' +
      '<button id="ah-link" aria-label="grab a link from the terminal" title="grab link">🔗</button>' +
      '<button id="ah-bell" aria-label="enable notifications">🔔</button>' +
      '<nav id="ah-tabs" data-slot="nav">' + tabsHtml + '</nav>';
    document.body.appendChild(header);
    header.querySelector("#ah-fminus").addEventListener("click", function () { setFont(-1); });
    header.querySelector("#ah-fplus").addEventListener("click", function () { setFont(+1); });
    wirePush(header.querySelector("#ah-bell"));

    // Fleet switcher: this phone remembers every AgentHost box it visits
    // (localStorage; each box only knows itself, so the client is the registry).
    // Tapping the host name lists them; tapping one opens that box.
    var FLEET_KEY = "agenthost_fleet";
    var fleet = [];
    try { fleet = JSON.parse(localStorage.getItem(FLEET_KEY) || "[]"); } catch (e) {}
    // JSON.parse can return non-arrays and arrays can hold junk (another script,
    // devtools, a future schema). Unvalidated, either would throw HERE -- inside
    // build() -- and the idempotence guard would then leave the shell half-built
    // (no keybar, no reconnect overlay) on every load until storage is cleared.
    if (!Array.isArray(fleet)) fleet = [];
    fleet = fleet.filter(function (h) { return typeof h === "string" && h; });
    // MRU: revisiting moves this box to the end, so the cap evicts the least
    // recently VISITED box, not the first-ever added (likely the primary one).
    var selfAt = fleet.indexOf(location.hostname);
    if (selfAt !== -1) fleet.splice(selfAt, 1);
    fleet.push(location.hostname);
    fleet = fleet.slice(-12); // cap what we render, not just what we store
    try { localStorage.setItem(FLEET_KEY, JSON.stringify(fleet)); } catch (e) {}
    var fleetMenu = document.createElement("div");
    fleetMenu.id = "ah-fleet";
    fleetMenu.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;background:rgba(11,13,16,.88)";
    fleetMenu.addEventListener("click", function (e) { if (e.target === fleetMenu) fleetMenu.style.display = "none"; });
    document.body.appendChild(fleetMenu);
    header.querySelector("#ah-host").addEventListener("click", function () {
      var rows = "";
      for (var i = 0; i < fleet.length; i++) {
        var h = fleet[i].replace(/[^a-zA-Z0-9.-]/g, ""); // hostnames only; nothing else renders
        var here = h === location.hostname;
        rows += '<a class="ah-fleet-row" href="https://' + h + '/" style="display:block;text-decoration:none;padding:10px 12px;margin:6px 0;' +
          'border-radius:10px;border:1px solid rgba(255,255,255,.1);color:' + TEXT + ';font:12.5px ' + MONO + ';word-break:break-all;' +
          (here ? "background:rgba(255,106,61,.14);border-color:rgba(255,106,61,.4)" : "background:" + BASE) + '">' +
          h + (here ? ' <span style="color:' + ACCENT + '">· here</span>' : "") + "</a>";
      }
      fleetMenu.innerHTML = '<div class="ah-card" style="padding:16px;width:min(360px,90vw);max-height:70vh;overflow-y:auto;' +
        'font:400 13px ' + MONO + ';color:' + TEXT + '">' +
        '<div style="font-weight:600;margin-bottom:4px">your boxes <span style="color:' + ACCENT + '">▮</span> ' +
        '<span style="opacity:.5;font-weight:400">boxes this phone has visited</span></div>' + rows +
        '<button id="ah-fleet-close" style="margin-top:10px;width:100%;border:0;border-radius:999px;padding:10px;' +
        'background:rgba(255,255,255,.08);color:' + TEXT + ';font:600 13px ' + MONO + '">close</button></div>';
      fleetMenu.querySelector("#ah-fleet-close").addEventListener("click", function () { fleetMenu.style.display = "none"; });
      fleetMenu.style.display = "flex";
    });

    // Aa popover (phone widths): the same A-/A+ controls, plus "boxes" so the
    // fleet switcher stays reachable while its host label is display:none.
    // Wired AFTER the fleet block so #ah-host's click handler exists.
    var fpop = document.createElement("div");
    fpop.id = "ah-fpop";
    fpop.className = "ah-card";
    fpop.innerHTML =
      '<div class="row">' +
      '<button class="ah-font" id="ah-pminus" aria-label="smaller text">A−</button>' +
      '<button class="ah-font" id="ah-pplus" aria-label="larger text">A+</button></div>' +
      '<button id="ah-pboxes" aria-label="switch box">boxes</button>';
    document.body.appendChild(fpop);
    header.querySelector("#ah-fsize").addEventListener("click", function (e) {
      e.stopPropagation(); // keep the outside-tap closer below from eating the toggle
      fpop.classList.toggle("show");
    });
    fpop.querySelector("#ah-pminus").addEventListener("click", function () { setFont(-1); });
    fpop.querySelector("#ah-pplus").addEventListener("click", function () { setFont(+1); });
    fpop.querySelector("#ah-pboxes").addEventListener("click", function () {
      fpop.classList.remove("show");
      header.querySelector("#ah-host").click(); // same fleet menu, label hidden or not
    });
    document.addEventListener("click", function (e) {
      if (fpop.classList.contains("show") && !fpop.contains(e.target)) fpop.classList.remove("show");
    });

    // Link picker: rebuild full (dewrapped) URLs from the terminal and let the
    // user OPEN (new tab -> completes OAuth) or COPY them -- the fix for "I
    // can't highlight the auth URL on my phone".
    var links = document.createElement("div");
    links.id = "ah-links";
    links.addEventListener("click", function (e) { if (e.target === links) links.classList.remove("show"); });
    document.body.appendChild(links);
    function openLinkPicker() {
      var urls = extractUrls();
      var html = '<div class="card ah-card"><div style="font-weight:600;margin-bottom:4px">links in the terminal <span style="color:' + ACCENT + '">▮</span></div>';
      if (!urls.length) {
        html += '<div class="empty">no links found on screen or in scrollback</div>';
      } else {
        for (var i = 0; i < Math.min(urls.length, 8); i++) {
          var u = urls[i];
          var esc = u.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
          html += '<div class="u">' + esc + '</div><div class="btns">' +
            '<a class="open" href="' + esc + '" target="_blank" rel="noopener">open</a>' +
            '<button data-copy="' + esc + '">copy</button></div>';
        }
      }
      html += '<button class="close">close</button></div>';
      links.innerHTML = html;
      links.querySelector(".close").addEventListener("click", function () { links.classList.remove("show"); });
      var copyBtns = links.querySelectorAll("button[data-copy]");
      for (var c = 0; c < copyBtns.length; c++) {
        copyBtns[c].addEventListener("click", function (ev) {
          // Capture the button NOW: ev.currentTarget is nulled once dispatch
          // finishes, and `done` runs async after the clipboard promise.
          var btn = ev.currentTarget;
          var val = btn.getAttribute("data-copy");
          var done = function () { btn.textContent = "copied ✓"; toast("link copied"); };
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(val).then(done, done);
          else done();
        });
      }
      // Tapping "open" also closes the picker so the user returns to a clean terminal.
      var opens = links.querySelectorAll("a.open");
      for (var o = 0; o < opens.length; o++) opens[o].addEventListener("click", function () { setTimeout(function () { links.classList.remove("show"); }, 50); });
      links.classList.add("show");
    }
    header.querySelector("#ah-link").addEventListener("click", openLinkPicker);

    // Reconnect overlay
    var overlay = document.createElement("div");
    overlay.id = "ah-overlay";
    overlay.innerHTML =
      '<div class="card ah-card"><div class="t">connection dropped</div>' +
      '<div class="s">the box is still running; this is just the link</div>' +
      '<div class="bar"></div><div class="re">re-establishing session…</div>' +
      "<button>reconnect</button></div>";
    overlay.querySelector("button").addEventListener("click", function () {
      // Presentation only: let the button acknowledge the tap during the
      // beat before the reload tears the page down.
      this.textContent = "re-establishing…";
      location.reload();
    });
    document.body.appendChild(overlay);

    var dot = header.querySelector("#ah-dot");
    setStatus = function (state) {
      dot.className = state;
      overlay.classList.toggle("show", state === "dropped");
      if (state === "connected") restoreFont();
    };
    if (lastStatus) setStatus(lastStatus); // replay pre-build state

    // Key bar (two rows), sticky Ctrl applies to the NEXT letter tapped on the bar.
    if (isTouch) {
      var ctrlArmed = false;
      var shiftArmed = false;
      var keybar = document.createElement("div");
      keybar.id = "ah-keybar";

      function key(label, action, id) {
        var b = document.createElement("button");
        b.className = "ah-key";
        if (id) b.id = id;
        b.textContent = label;
        var fire = function (e) { e.preventDefault(); action(b); };
        b.addEventListener("touchstart", fire, { passive: false });
        b.addEventListener("mousedown", fire);
        return b;
      }

      function disarm(id) {
        keybar.querySelector(id).classList.remove("armed");
      }
      function letterAction(ch) {
        return function () {
          if (ctrlArmed) {
            sendKey(ch, { ctrlKey: true });
            ctrlArmed = false;
            disarm("#ah-ctrl");
          } else if (shiftArmed) {
            sendText(ch.toUpperCase());
            shiftArmed = false;
            disarm("#ah-shift");
          } else {
            sendText(ch);
          }
        };
      }
      // Shift+Tab is how Claude Code cycles permission modes -- the single
      // most-needed chord on a phone (Steve, 2026-07-12). Armed shift turns
      // Tab into back-tab (CSI Z) and bar letters into uppercase.
      function tabAction() {
        if (shiftArmed) {
          sendText("\x1b[Z");
          shiftArmed = false;
          disarm("#ah-shift");
        } else {
          sendKey("Tab");
        }
      }

      var row1 = document.createElement("div");
      row1.className = "ah-row";
      row1.appendChild(key("ctrl", function (b) {
        ctrlArmed = !ctrlArmed;
        b.classList.toggle("armed", ctrlArmed);
      }, "ah-ctrl"));
      row1.appendChild(key("shift", function (b) {
        shiftArmed = !shiftArmed;
        b.classList.toggle("armed", shiftArmed);
      }, "ah-shift"));
      row1.appendChild(key("esc", function () { sendKey("Escape"); }));
      row1.appendChild(key("tab", tabAction));
      row1.appendChild(key("↑", function () { sendKey("ArrowUp"); }));
      row1.appendChild(key("↓", function () { sendKey("ArrowDown"); }));
      row1.appendChild(key("←", function () { sendKey("ArrowLeft"); }));
      row1.appendChild(key("→", function () { sendKey("ArrowRight"); }));

      var row2 = document.createElement("div");
      row2.className = "ah-row";
      // "paste" is the fix for "no v to paste with": it drops the clipboard
      // (an OAuth code, a URL) straight into the terminal. Ctrl-V doesn't reach
      // a pty and the native paste is unreliable over the hidden textarea.
      // "abc" summons the PHONE keyboard: it explicitly focuses xterm's hidden
      // textarea (the one thing key-bar taps deliberately never do). Typing
      // then flows through xterm's normal input path; the visualViewport
      // tracker below lifts this bar to sit on top of the phone keyboard so
      // both keyboards are usable at once (Steve's ask, 2026-07-13: pasting
      // an OAuth code into a terminal prompt was impossible on mobile).
      [["paste", pasteFromClipboard], ["c", letterAction("c")], ["d", letterAction("d")],
       ["/", function () { sendText("/"); }], ["|", function () { sendText("|"); }],
       ["~", function () { sendText("~"); }], ["enter", function () { sendKey("Enter"); }],
       ["abc", function (b) {
         var ta = xtermInput();
         if (!ta) return;
         if (document.activeElement === ta) { ta.blur(); b.classList.remove("armed"); }
         else { ta.focus({ preventScroll: true }); b.classList.add("armed"); }
       }, "ah-abc"]]
        .forEach(function (def) { row2.appendChild(key(def[0], def[1], def[2])); });

      keybar.appendChild(row1);
      keybar.appendChild(row2);
      document.body.appendChild(keybar);

      // Phone-keyboard tracking: when the on-screen keyboard opens, the
      // visualViewport shrinks but fixed elements stay pinned to the LAYOUT
      // viewport -- i.e. behind the keyboard. Mirror the occluded height into
      // --ah-kb-inset so the key bar rides on top of the phone keyboard and
      // the terminal refits above both. Cheap, passive, and a no-op on
      // browsers without visualViewport.
      if (window.visualViewport) {
        var kbRefit = null;
        var syncKbInset = function () {
          var vv = window.visualViewport;
          var occluded = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
          // <60px is browser chrome jitter, not a keyboard.
          var inset = occluded > 60 ? occluded : 0;
          document.documentElement.style.setProperty("--ah-kb-inset", inset + "px");
          if (inset === 0) {
            var abc = document.getElementById("ah-abc");
            if (abc) abc.classList.remove("armed"); // keyboard dismissed by the OS
          }
          clearTimeout(kbRefit);
          kbRefit = setTimeout(function () { window.dispatchEvent(new Event("resize")); }, 120);
        };
        window.visualViewport.addEventListener("resize", syncKbInset);
        window.visualViewport.addEventListener("scroll", syncKbInset);
      }
    }

    // Opt the terminal textarea out of autofill now and whenever ttyd rebuilds
    // it (a resize/reconnect can spawn a fresh one that lost the attributes).
    tameXtermTextarea();
    setInterval(tameXtermTextarea, 2000);

    // Touch-scroll into tmux scrollback (task #31). Listeners sit on the mount
    // (it persists across xterm rebuilds); dispatch targets are queried per
    // gesture, so a reconnect that replaces .xterm-screen keeps working.
    if (isTouch) wireTouchScroll(terminalEl());

    // ttyd sizes the terminal to its container; nudge a refit after inset.
    window.dispatchEvent(new Event("resize"));
    setTimeout(function () { window.dispatchEvent(new Event("resize")); restoreFont(); }, 300);

    // App switcher: a "terminal app" tab links /?window=<name>. Ask the GATE to
    // select that tmux window server-side (tmux select-window on the box) --
    // never by typing into the terminal, which would leak the raw command text
    // into whatever full-screen app (codex login, an editor) currently holds
    // focus. The bare terminal ("/", no ?window) selects window "agent" (index
    // 0), so switching back from codex/ollama returns you to the shell. Fire-
    // and-forget: /switch returns 204 and the terminal just repaints.
    try {
      var wm = (location.search || "").match(/[?&]window=([a-z0-9-]+)/);
      var win = wm ? wm[1] : "0"; // bare terminal = window index 0 (the shell)
      if (!window.__ahWindowSwitched) {
        window.__ahWindowSwitched = true;
        fetch("/switch?window=" + encodeURIComponent(win), { cache: "no-store" }).catch(function () {});
      }
    } catch (e) {}
  }

  // Keep trying until ttyd mounts its terminal container (build() returns true
  // once it dresses the page or recognizes the login screen). Poll + observe so
  // we catch the mount whenever ttyd's bundle finishes, then stop.
  function startWatch() {
    if (build() === true) return;
    var tries = 0;
    var iv = setInterval(function () {
      if (build() === true || ++tries > 80) clearInterval(iv); // ~12s ceiling
    }, 150);
    if (window.MutationObserver) {
      var mo = new MutationObserver(function () {
        if (build() === true) { mo.disconnect(); clearInterval(iv); }
      });
      try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startWatch);
  else startWatch();
})();
