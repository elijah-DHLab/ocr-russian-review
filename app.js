(function () {
  "use strict";
  var KEY = "ocr-review-v1";
  var PAGES = window.PAGES || [];
  var state = { reviewer: "", marks: {} };   // marks[id] = {choice, correction, ts}
  var current = 0;
  var activeId = null;
  var DIFFS = {};                              // id -> {page, claude, kraken}
  PAGES.forEach(function (p) {
    p.items.forEach(function (it) {
      if (typeof it === "object") DIFFS[it.id] = { page: p.page, claude: it.claude, kraken: it.kraken };
    });
  });

  var $ = function (id) { return document.getElementById(id); };
  var pop = $("pop"), corr = $("corr"), textView = $("text-view");

  // ------------------------------------------------------------ storage
  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || "null");
      if (s && s.marks) state = s;
      var pg = parseInt(localStorage.getItem(KEY + ":page") || "0", 10);
      if (pg >= 0 && pg < PAGES.length) current = pg;
      if (localStorage.getItem(KEY + ":help") === "closed") $("help").open = false;
    } catch (e) { /* storage unavailable */ }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }
  function savePref(k, v) { try { localStorage.setItem(KEY + ":" + k, v); } catch (e) { } }

  // ------------------------------------------------------------ rendering
  function diffIds(p) { return p.items.filter(function (i) { return typeof i === "object"; }).map(function (i) { return i.id; }); }
  function markedCount(p) { return diffIds(p).filter(function (id) { return state.marks[id]; }).length; }

  function renderTabs() {
    var tabs = $("tabs");
    tabs.innerHTML = "";
    var tot = 0, done = 0;
    PAGES.forEach(function (p, i) {
      var n = diffIds(p).length, m = markedCount(p);
      tot += n; done += m;
      var b = document.createElement("button");
      b.className = "tab" + (m === n ? " done" : "");
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", i === current ? "true" : "false");
      b.innerHTML = p.page + '<span class="cnt">' + m + "/" + n + "</span>";
      b.onclick = function () { showPage(i); };
      tabs.appendChild(b);
    });
    $("overall").textContent = done + " / " + tot;
    var p = PAGES[current];
    if (p) $("page-progress").textContent = markedCount(p) + " of " + diffIds(p).length + " marked on this page";
  }

  function span(cls, text) {
    var s = document.createElement("span");
    s.className = cls;
    if (text) { s.textContent = text; } else { s.textContent = "∅"; s.classList.add("empty"); }
    return s;
  }

  function fillChip(btn, it) {
    var m = state.marks[it.id];
    btn.className = "chip" + (m ? " m-" + m.choice : "") + (it.id === activeId ? " active" : "");
    btn.innerHTML = "";
    if (!m) {
      btn.appendChild(span("c", it.claude));
      btn.appendChild(span("k", it.kraken));
      btn.title = "Claude: " + (it.claude || "∅") + "\nKraken: " + (it.kraken || "∅");
      return;
    }
    if (m.choice === "claude") btn.appendChild(span("c", it.claude));
    else if (m.choice === "kraken") btn.appendChild(span("k", it.kraken));
    else {
      var n = document.createElement("span");
      n.className = "n";
      if (m.correction) { n.textContent = m.correction; }
      else { var s = document.createElement("s"); s.textContent = (it.claude || "∅") + " / " + (it.kraken || "∅"); n.appendChild(s); }
      btn.appendChild(n);
    }
    if (m.correction && m.choice !== "neither") {
      var f = document.createElement("span"); f.className = "fix"; f.textContent = "→ " + m.correction; btn.appendChild(f);
    }
    btn.title = "Marked: " + m.choice + (m.correction ? " (" + m.correction + ")" : "") +
      "\nClaude: " + (it.claude || "∅") + "\nKraken: " + (it.kraken || "∅");
  }

  function showPage(i) {
    closePop();
    current = i;
    savePref("page", String(i));
    var p = PAGES[i];
    $("scan").src = p.image;
    $("scan").alt = "Scan of page " + p.page;
    textView.innerHTML = "";
    var frag = document.createDocumentFragment();
    p.items.forEach(function (it) {
      if (typeof it === "string") { frag.appendChild(document.createTextNode(it)); return; }
      var b = document.createElement("button");
      b.type = "button";
      b.dataset.id = it.id;
      fillChip(b, it);
      b.onclick = function (e) { e.stopPropagation(); openPop(it.id); };
      b.onfocus = function () { setActive(it.id); };
      frag.appendChild(b);
    });
    textView.appendChild(frag);
    textView.scrollTop = 0;
    $("scan-view").scrollTop = 0;
    renderTabs();
  }

  function chipEl(id) { return textView.querySelector('.chip[data-id="' + id + '"]'); }
  function refreshChip(id) {
    var b = chipEl(id);
    if (b) { var d = DIFFS[id]; fillChip(b, { id: id, claude: d.claude, kraken: d.kraken }); }
  }
  function setActive(id) {
    var prev = activeId;
    activeId = id;
    if (prev) refreshChip(prev);
    if (id) refreshChip(id);
  }

  // ------------------------------------------------------------ marking
  function mark(id, choice) {
    if (!choice) { delete state.marks[id]; }
    else {
      var old = state.marks[id] || {};
      state.marks[id] = { choice: choice, correction: old.correction || "", ts: new Date().toISOString() };
    }
    save(); refreshChip(id); renderTabs();
  }

  function chipsOnPage() { return Array.prototype.slice.call(textView.querySelectorAll(".chip")); }
  function move(delta, unmarkedOnly) {
    var chips = chipsOnPage();
    if (!chips.length) return;
    var idx = chips.findIndex(function (c) { return c.dataset.id === activeId; });
    for (var step = 1; step <= chips.length; step++) {
      var j = idx + delta * step;
      if (j < 0 || j >= chips.length) {
        if (!unmarkedOnly) return;
        j = ((j % chips.length) + chips.length) % chips.length;
      }
      var c = chips[j];
      if (!unmarkedOnly || !state.marks[c.dataset.id]) { focusChip(c); return; }
    }
    if (unmarkedOnly) {
      // page finished: go to the next page with unmarked items
      for (var k = 1; k < PAGES.length; k++) {
        var pi = (current + k) % PAGES.length;
        if (markedCount(PAGES[pi]) < diffIds(PAGES[pi]).length) {
          showPage(pi);
          move(1, true);
          return;
        }
      }
    }
  }
  function focusChip(c) {
    c.focus({ preventScroll: true });
    c.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // ------------------------------------------------------------ popover
  function openPop(id) {
    setActive(id);
    var d = DIFFS[id], m = state.marks[id];
    pop.querySelector(".opt.c .val").textContent = d.claude || "∅";
    pop.querySelector(".opt.k .val").textContent = d.kraken || "∅";
    pop.querySelectorAll(".opt").forEach(function (o) { o.classList.toggle("sel", !!m && o.dataset.choice === m.choice); });
    corr.value = m ? m.correction : "";
    pop.hidden = false;
    var r = chipEl(id).getBoundingClientRect();
    var pw = pop.offsetWidth, ph = pop.offsetHeight;
    var left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
    var top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    pop.querySelector(".opt.c").focus();
  }
  function closePop(refocus) {
    if (pop.hidden) return;
    pop.hidden = true;
    if (refocus && activeId) { var c = chipEl(activeId); if (c) c.focus({ preventScroll: true }); }
  }
  pop.addEventListener("click", function (e) { e.stopPropagation(); });
  pop.querySelectorAll(".opt").forEach(function (o) {
    o.onclick = function () {
      mark(activeId, o.dataset.choice);
      pop.querySelectorAll(".opt").forEach(function (x) { x.classList.toggle("sel", x === o); });
      if (o.dataset.choice === "neither") { corr.focus(); return; }
      closePop(true); move(1, true);
    };
  });
  corr.addEventListener("input", function () {
    if (!activeId) return;
    if (!state.marks[activeId]) state.marks[activeId] = { choice: "neither", correction: "", ts: "" };
    state.marks[activeId].correction = corr.value.trim();
    state.marks[activeId].ts = new Date().toISOString();
    save(); refreshChip(activeId); renderTabs();
  });
  corr.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); closePop(true); move(1, true); }
    e.stopPropagation();
  });
  $("clear").onclick = function () { mark(activeId, null); corr.value = ""; closePop(true); };
  $("close").onclick = function () { closePop(true); };
  document.addEventListener("click", function () { closePop(); });

  // ------------------------------------------------------------ keyboard
  document.addEventListener("keydown", function (e) {
    if (e.target.tagName === "INPUT") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var map = { "1": "claude", "2": "kraken", "3": "neither" };
    if (e.key === "Escape") { closePop(true); return; }
    if (!activeId) {
      if (e.key === "ArrowRight" || e.key in map) { e.preventDefault(); move(1, true); }
      return;
    }
    if (e.key in map) {
      e.preventDefault();
      mark(activeId, map[e.key]);
      if (map[e.key] === "neither") { openPop(activeId); corr.focus(); return; }
      closePop(); move(1, true);
    } else if (e.key === "0" || e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault(); mark(activeId, null);
    } else if (e.key === "ArrowRight" && pop.hidden) { e.preventDefault(); move(1, false); }
    else if (e.key === "ArrowLeft" && pop.hidden) { e.preventDefault(); move(-1, false); }
  });

  // ------------------------------------------------------------ export / import
  function download(name, text, type) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function stamp() { return new Date().toISOString().slice(0, 10); }
  function who() { return (state.reviewer || "reviewer").replace(/[^\wЀ-ӿ֐-׿-]+/g, "_"); }
  function csvCell(v) { v = String(v == null ? "" : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

  $("dl-csv").onclick = function () {
    var rows = [["page", "id", "claude", "kraken", "choice", "correction", "reviewer", "timestamp"]];
    Object.keys(DIFFS).forEach(function (id) {
      var d = DIFFS[id], m = state.marks[id] || {};
      rows.push([d.page, id, d.claude, d.kraken, m.choice || "", m.correction || "", state.reviewer, m.ts || ""]);
    });
    download("ocr_review_" + who() + "_" + stamp() + ".csv",
      "﻿" + rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n"), "text/csv;charset=utf-8");
  };
  $("dl-json").onclick = function () {
    var out = { reviewer: state.reviewer, exported: new Date().toISOString(), marks: {} };
    Object.keys(state.marks).forEach(function (id) {
      if (DIFFS[id]) out.marks[id] = Object.assign({ page: DIFFS[id].page, claude: DIFFS[id].claude, kraken: DIFFS[id].kraken }, state.marks[id]);
    });
    download("ocr_review_" + who() + "_" + stamp() + ".json", JSON.stringify(out, null, 1), "application/json");
  };
  $("import").onchange = function (e) {
    var f = e.target.files[0];
    if (!f) return;
    f.text().then(function (txt) {
      var data = JSON.parse(txt), n = 0;
      Object.keys(data.marks || {}).forEach(function (id) {
        var m = data.marks[id];
        if (DIFFS[id] && m.choice) { state.marks[id] = { choice: m.choice, correction: m.correction || "", ts: m.ts || "" }; n++; }
      });
      if (data.reviewer && !state.reviewer) { state.reviewer = data.reviewer; $("reviewer").value = data.reviewer; }
      save(); showPage(current);
      alert("Imported " + n + " marks.");
    }).catch(function () { alert("Could not read that file."); });
    e.target.value = "";
  };
  $("reset").onclick = function () {
    if (!confirm("Delete ALL marks in this browser? Download a backup first if you need one.")) return;
    state.marks = {}; save(); showPage(current);
  };
  $("reviewer").addEventListener("input", function (e) { state.reviewer = e.target.value.trim(); save(); });
  $("next-unmarked").onclick = function (e) { e.stopPropagation(); move(1, true); };
  $("help").addEventListener("toggle", function () { savePref("help", $("help").open ? "open" : "closed"); });

  // ------------------------------------------------------------ zoom
  var zoom = $("zoom"), scan = $("scan");
  function setZoom(v) {
    zoom.value = v; scan.style.width = v + "%"; $("zoom-val").textContent = v + "%";
    scan.style.cursor = v >= 200 ? "zoom-out" : "zoom-in";
  }
  zoom.oninput = function () { setZoom(+zoom.value); };
  scan.onclick = function (e) {
    var view = $("scan-view"), r = scan.getBoundingClientRect();
    var fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    setZoom(+zoom.value >= 200 ? 100 : 200);
    view.scrollLeft = fx * scan.offsetWidth - view.clientWidth / 2;
    view.scrollTop = fy * scan.offsetHeight - view.clientHeight / 2;
  };

  // ------------------------------------------------------------ init
  load();
  $("reviewer").value = state.reviewer || "";
  if (PAGES.length) showPage(current);
  else textView.textContent = "No pages found (data.js missing).";
})();
