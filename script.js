/* Disk Cleaner UI logic
   Loads scan report JSON produced by disk_cleaner.sh,
   lets user filter/sort/select, and exports a cleanup plan.

   Report JSON schema (simplified):
   {
     "generatedAt": "ISO8601",
     "home": "/Users/you",
     "totals": { "count": N, "bytes": M },
     "categories": ["user-caches", ...],
     "items": [
        { "path": "...", "bytes": 123, "mtime": 1710000000, "category": "dev", "reason": "Developer cache", "trashable": true }
     ]
   }

   Plan JSON schema (exported by UI):
   {
     "generatedAt": "ISO8601",
     "home": "<from report>",
     "applyMode": "trash" | "delete",
     "items": [ { "path": "...", "category": "..." }, ... ]
   }
*/

(() => {
  "use strict";

  // Elements
  const el = {
    reportFile: document.getElementById("reportFile"),
    exportPlanBtn: document.getElementById("exportPlanBtn"),
    copyCmdBtn: document.getElementById("copyCmdBtn"),
    search: document.getElementById("search"),
    minSizeUi: document.getElementById("minSizeUi"),
    olderThanUi: document.getElementById("olderThanUi"),
    categoryFilter: document.getElementById("categoryFilter"),
    applyModeRadios: document.querySelectorAll("input[name='applyMode']"),
    topN: document.getElementById("topN"),
    selectAllBtn: document.getElementById("selectAllBtn"),
    clearSelBtn: document.getElementById("clearSelBtn"),
    toggleAll: document.getElementById("toggleAll"),

    // Server integration
    scanServerBtn: document.getElementById("scanServerBtn"),
    applyServerBtn: document.getElementById("applyServerBtn"),
    dryRunCheck: document.getElementById("dryRunCheck"),
    backendStatus: document.getElementById("backendStatus"),

    totalCount: document.getElementById("totalCount"),
    totalSize: document.getElementById("totalSize"),
    visibleCount: document.getElementById("visibleCount"),
    visibleSize: document.getElementById("visibleSize"),
    selectedCount: document.getElementById("selectedCount"),
    selectedSize: document.getElementById("selectedSize"),
    homePath: document.getElementById("homePath"),
    generatedAt: document.getElementById("generatedAt"),

    tableBody: document.getElementById("tableBody"),
    table: document.getElementById("itemsTable")
  };

  // State
  const state = {
    report: null,
    items: [],
    filtered: [],
    sorted: [],
    selectedPaths: new Set(),
    sortKey: "bytes",
    sortDir: "desc",
    minBytes: 0,
    categoriesEnabled: new Set(["user-caches","browsers","dev","pkg"]),
    search: "",
    topN: 0,
    applyMode: "trash",
    lastPlanFileName: "disk_cleaner_plan.json",
    // Backend
    backendOnline: false,
    backendBase: "" // "" = same-origin; or "http://localhost:8765"
  };

  // Utilities
  const clampInt = (n, min, max) => Math.max(min, Math.min(max, n));

  function humanizeBytes(bytes) {
    if (!Number.isFinite(bytes)) return "0 B";
    const units = ["B","KB","MB","GB","TB","PB"];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    const fixed = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    return `${fixed} ${units[i]}`;
  }

  function formatMtime(mtimeEpoch) {
    if (!mtimeEpoch || !Number.isFinite(mtimeEpoch)) return "-";
    try {
      const d = new Date(mtimeEpoch * 1000);
      return d.toLocaleString();
    } catch {
      return "-";
    }
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsText(file);
    });
  }

  function computeTotals(items) {
    let count = 0;
    let bytes = 0;
    for (const it of items) {
      count++;
      const b = Number(it.bytes) || 0;
      if (b > 0) bytes += b;
    }
    return { count, bytes };
  }

  function updateHeader(report) {
    if (!report) return;
    const totals = report.totals || computeTotals(report.items || []);
    el.totalCount.textContent = String(totals.count || 0);
    el.totalSize.textContent = humanizeBytes(Number(totals.bytes || 0));
    el.homePath.textContent = `home: ${report.home || "-"}`;
    el.generatedAt.textContent = `generated: ${report.generatedAt || "-"}`;
  }

  function getApplyMode() {
    const checked = document.querySelector("input[name='applyMode']:checked");
    return checked ? checked.value : "trash";
  }

  function applyFilters() {
    const minBytes = state.minBytes;
    const search = state.search;
    const searchParts = search.toLowerCase().split(/\s+/).filter(Boolean);
    const cats = state.categoriesEnabled;

    const out = [];
    for (const it of state.items) {
      // Category gating
      if (!cats.has(it.category)) continue;
      // Trashable gating in UI: We still show non-trashable but disabled selection
      // Min size
      const b = Number(it.bytes) || 0;
      if (b < minBytes) continue;
      // Search matches path or reason
      if (searchParts.length) {
        const hay = `${it.path} ${it.reason || ""}`.toLowerCase();
        let ok = true;
        for (const part of searchParts) {
          if (!hay.includes(part)) { ok = false; break; }
        }
        if (!ok) continue;
      }
      out.push(it);
    }
    state.filtered = out;
  }

  function doSort() {
    const arr = [...state.filtered];
    const key = state.sortKey;
    const dir = state.sortDir;

    arr.sort((a, b) => {
      let av, bv;
      switch (key) {
        case "bytes":
          av = Number(a.bytes) || 0;
          bv = Number(b.bytes) || 0;
          break;
        case "mtime":
          av = Number(a.mtime) || 0;
          bv = Number(b.mtime) || 0;
          break;
        case "category":
          av = (a.category || "").localeCompare ? a.category : String(a.category || "");
          bv = (b.category || "").localeCompare ? b.category : String(b.category || "");
          return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
        case "path":
        default:
          av = a.path || "";
          bv = b.path || "";
          return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      // numeric compare
      if (av === bv) {
        // tie-break by path
        return (dir === "asc" ? 1 : -1) * (a.path || "").localeCompare(b.path || "");
      }
      return dir === "asc" ? av - bv : bv - av;
    });

    let top = Number(state.topN || 0);
    if (Number.isFinite(top) && top > 0) {
      state.sorted = arr.slice(0, top);
    } else {
      state.sorted = arr;
    }
  }

  function renderTable() {
    const rows = [];
    let visibleBytes = 0;

    for (const it of state.sorted) {
      const selected = state.selectedPaths.has(it.path);
      const isDisabled = it.trashable === false;
      const trClass = isDisabled ? " class=\"disabled\"" : "";
      const checkedAttr = selected && !isDisabled ? " checked" : "";
      const disableAttr = isDisabled ? " disabled" : "";

      visibleBytes += Number(it.bytes) || 0;

      rows.push(
        `<tr${trClass} data-path="${escapeHtmlAttr(it.path)}">
          <td class="w-select"><input type="checkbox" class="row-select"${checkedAttr}${disableAttr}></td>
          <td class="path">${escapeHtml(it.path)}</td>
          <td class="bytes w-size" data-bytes="${Number(it.bytes) || 0}">${humanizeBytes(Number(it.bytes)||0)}</td>
          <td class="mtime w-time" data-mtime="${Number(it.mtime) || 0}">${formatMtime(Number(it.mtime)||0)}</td>
          <td class="category w-cat">${escapeHtml(it.category || "-")}</td>
          <td class="reason w-reason">${escapeHtml(it.reason || "-")}${isDisabled ? ' <span class="badge-warn">read-only</span>' : ''}</td>
        </tr>`
      );
    }

    el.tableBody.innerHTML = rows.join("");
    const visibleTotals = { count: state.sorted.length, bytes: visibleBytes };
    el.visibleCount.textContent = String(visibleTotals.count);
    el.visibleSize.textContent = humanizeBytes(visibleTotals.bytes);

    // Update selected summary
    updateSelectedSummary();

    // Enable controls if data is loaded
    const hasData = state.items.length > 0;
    setControlsEnabled(hasData);

    // ToggleAll checkbox reflects visible selection state
    refreshToggleAllCheckbox();

    // Wire row checkbox listeners
    wireRowCheckboxEvents();
  }

  function refreshToggleAllCheckbox() {
    const allVisible = [...el.tableBody.querySelectorAll("input.row-select:not(:disabled)")];
    const selectedVisible = allVisible.filter(cb => cb.checked);
    if (!allVisible.length) {
      el.toggleAll.indeterminate = false;
      el.toggleAll.checked = false;
      el.toggleAll.disabled = true;
      return;
    }
    el.toggleAll.disabled = false;
    if (selectedVisible.length === 0) {
      el.toggleAll.indeterminate = false;
      el.toggleAll.checked = false;
    } else if (selectedVisible.length === allVisible.length) {
      el.toggleAll.indeterminate = false;
      el.toggleAll.checked = true;
    } else {
      el.toggleAll.indeterminate = true;
      el.toggleAll.checked = false;
    }
  }

  function setControlsEnabled(enabled) {
    el.exportPlanBtn.disabled = !enabled || state.selectedPaths.size === 0;
    el.copyCmdBtn.disabled = !enabled || state.selectedPaths.size === 0;
    el.selectAllBtn.disabled = !enabled;
    el.clearSelBtn.disabled = !enabled || state.selectedPaths.size === 0;
    el.toggleAll.disabled = !enabled || state.sorted.length === 0;
  }

  function updateSelectedSummary() {
    let bytes = 0;
    let count = 0;
    const selected = state.selectedPaths;
    for (const it of state.items) {
      if (selected.has(it.path)) {
        bytes += Number(it.bytes) || 0;
        count++;
      }
    }
    el.selectedCount.textContent = String(count);
    el.selectedSize.textContent = humanizeBytes(bytes);

    // Button enablement tied to selection
    el.exportPlanBtn.disabled = state.items.length === 0 || count === 0;
    el.copyCmdBtn.disabled = state.items.length === 0 || count === 0;
    el.clearSelBtn.disabled = count === 0;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
  function escapeHtmlAttr(s) { return escapeHtml(s); }

  // Selection helpers
  function setRowSelected(path, selected) {
    if (selected) state.selectedPaths.add(path);
    else state.selectedPaths.delete(path);
  }

  function selectAllVisible() {
    const rows = [...el.tableBody.querySelectorAll("tr")];
    for (const tr of rows) {
      const cb = tr.querySelector("input.row-select");
      if (!cb || cb.disabled) continue;
      const path = tr.getAttribute("data-path");
      cb.checked = true;
      setRowSelected(path, true);
    }
    updateSelectedSummary();
    refreshToggleAllCheckbox();
  }

  function clearSelection() {
    state.selectedPaths.clear();
    // Uncheck visible
    for (const cb of el.tableBody.querySelectorAll("input.row-select")) {
      cb.checked = false;
    }
    updateSelectedSummary();
    refreshToggleAllCheckbox();
  }

  // Event wiring
  function wireEvents() {
    // Load report file
    el.reportFile.addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const txt = await readFileAsText(f);
        const data = JSON.parse(txt);

        if (!data || !Array.isArray(data.items)) {
          alert("Invalid report file format. Expecting a JSON with an 'items' array.");
          return;
        }

        state.report = data;
        state.items = normalizeItems(data.items);
        state.selectedPaths.clear();

        // Initialize category checkboxes visibility based on presence, but keep defaults checked for 4 base cats
        initCategoryChipsFromData(state.report.categories || []);

        // Populate top header
        updateHeader(state.report);

        // Reset filters to defaults, then render
        state.minBytes = Number(el.minSizeUi.value || 0) || 0;
        state.search = "";
        el.search.value = "";
        const tn = Number(el.topN.value || 0);
        state.topN = Number.isFinite(tn) && tn >= 0 ? tn : 0;
        state.applyMode = getApplyMode();

        applyFilters();
        doSort();
        renderTable();
      } catch (err) {
        console.error(err);
        alert("Failed to load or parse the report JSON.");
      } finally {
        el.reportFile.value = ""; // let user reselect same file if needed
      }
    });

    // Search/filter handlers
    el.search.addEventListener("input", debounce(() => {
      state.search = (el.search.value || "").trim();
      applyFilters(); doSort(); renderTable();
    }, 150));

    el.minSizeUi.addEventListener("change", () => {
      const v = Number(el.minSizeUi.value || 0);
      state.minBytes = Number.isFinite(v) ? v : 0;
      applyFilters(); doSort(); renderTable();
    });

    // Category chips
    el.categoryFilter.addEventListener("change", (e) => {
      if (e.target && e.target.type === "checkbox") {
        const cat = e.target.value;
        if (e.target.checked) state.categoriesEnabled.add(cat);
        else state.categoriesEnabled.delete(cat);
        applyFilters(); doSort(); renderTable();
      }
    });

    // Apply mode radios
    for (const r of el.applyModeRadios) {
      r.addEventListener("change", () => {
        state.applyMode = getApplyMode();
      });
    }

    // TopN
    el.topN.addEventListener("input", () => {
      const n = clampInt(Number(el.topN.value || 0) || 0, 0, 1000000);
      state.topN = n;
      doSort(); renderTable();
    });

    // Select all visible
    el.selectAllBtn.addEventListener("click", () => {
      selectAllVisible();
    });

    // Clear selection (all)
    el.clearSelBtn.addEventListener("click", () => {
      clearSelection();
    });

    // Toggle all visible via checkbox
    el.toggleAll.addEventListener("change", () => {
      if (el.toggleAll.checked) selectAllVisible();
      else {
        // Unselect only visible
        const rows = [...el.tableBody.querySelectorAll("tr")];
        for (const tr of rows) {
          const cb = tr.querySelector("input.row-select");
          if (!cb || cb.disabled) continue;
          const path = tr.getAttribute("data-path");
          cb.checked = false;
          setRowSelected(path, false);
        }
        updateSelectedSummary();
        refreshToggleAllCheckbox();
      }
    });

    // Sorting handlers on table header
    const theadCells = document.querySelectorAll("thead th[data-sort]");
    for (const th of theadCells) {
      th.addEventListener("click", () => {
        const key = th.getAttribute("data-sort");
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortKey = key;
          // default dir: numeric desc, text asc
          state.sortDir = (key === "path" || key === "category") ? "asc" : "desc";
        }
        doSort(); renderTable();
      });
    }

    // Export plan
    el.exportPlanBtn.addEventListener("click", () => {
      if (!state.report) return;
      const plan = buildPlan();
      const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = state.lastPlanFileName;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 0);
    });

    // Copy commands to clipboard
    el.copyCmdBtn.addEventListener("click", async () => {
      const cmd = buildCopyApplyCommand();
      try {
        await navigator.clipboard.writeText(cmd);
        toast("Apply commands copied to clipboard");
      } catch {
        // Fallback: show prompt
        window.prompt("Copy these commands:", cmd);
      }
    });
  }

  function wireRowCheckboxEvents() {
    for (const cb of el.tableBody.querySelectorAll("input.row-select")) {
      cb.addEventListener("change", (e) => {
        const tr = e.target.closest("tr");
        const path = tr.getAttribute("data-path");
        setRowSelected(path, e.target.checked);
        updateSelectedSummary();
        refreshToggleAllCheckbox();
      });
    }
  }

  function normalizeItems(items) {
    // Ensure expected fields exist, coerce types
    return items.map(it => ({
      path: String(it.path || ""),
      bytes: Number(it.bytes || 0),
      mtime: Number(it.mtime || 0),
      category: it.category ? String(it.category) : "-",
      reason: it.reason ? String(it.reason) : "",
      trashable: it.trashable !== false // default to true if missing
    }));
  }

  function initCategoryChipsFromData(categories) {
    // Show all chips; only check defaults are already set in HTML
    // If a category exists in data but not in chips, we could add dynamically, but our known set is fixed.
    // Sync checkboxes to state.categoriesEnabled
    for (const input of el.categoryFilter.querySelectorAll("input[type='checkbox']")) {
      input.checked = state.categoriesEnabled.has(input.value);
    }
  }

  function buildPlan() {
    const items = [];
    const selected = state.selectedPaths;
    for (const it of state.items) {
      if (selected.has(it.path)) {
        items.push({ path: it.path, category: it.category });
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      home: state.report?.home || "",
      applyMode: state.applyMode,
      items
    };
  }

  function buildCopyApplyCommand() {
    const placeholder = "PATH_TO_PLAN.json";
    // Two-step: dry run first, then apply to Trash
    const lines = [
      "# Preview (dry-run): replace PATH_TO_PLAN.json with the saved plan path",
      `./disk_cleaner.sh --apply-from ${placeholder} --dry-run`,
      "",
      "# Apply safely (moves to Trash):",
      `./disk_cleaner.sh --apply-from ${placeholder} --apply --trash --yes`,
      "",
      "# Apply permanently (dangerous; not recommended):",
      `./disk_cleaner.sh --apply-from ${placeholder} --apply --no-trash --yes`
    ];
    return lines.join("\n");
  }

  function toast(message) {
    // Minimal toast using alert-like bar
    const div = document.createElement("div");
    div.textContent = message;
    div.style.position = "fixed";
    div.style.left = "50%";
    div.style.bottom = "24px";
    div.style.transform = "translateX(-50%)";
    div.style.background = "#22314d";
    div.style.color = "#e6eaf2";
    div.style.border = "1px solid #2c3750";
    div.style.padding = "10px 14px";
    div.style.borderRadius = "10px";
    div.style.boxShadow = "0 6px 24px rgba(0,0,0,0.35)";
    div.style.zIndex = "9999";
    document.body.appendChild(div);
    setTimeout(() => {
      div.style.opacity = "0";
      div.style.transition = "opacity .3s ease";
      setTimeout(() => document.body.removeChild(div), 350);
    }, 1200);
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // Init
  wireEvents();

  // Expose key objects/functions for server integration outside the IIFE
  try {
    window.DC = {
      el,
      state,
      applyFilters,
      doSort,
      renderTable,
      updateSelectedSummary,
      normalizeItems,
      initCategoryChipsFromData,
      updateHeader,
      getApplyMode
    };
  } catch (e) {}

// Auto-load report.json when the page is served with ?auto=1 (from --serve mode)
async function autoLoadReport() {
  try {
    const res = await fetch('./report.json', { cache: 'no-store' });
    if (!res.ok) {
      console.warn('autoLoadReport: report.json not found at server root');
      return;
    }
    const data = await res.json();
    if (!data || !Array.isArray(data.items)) {
      console.warn('autoLoadReport: invalid report.json format');
      return;
    }

    // Reuse the same flow as manual file load
    state.report = data;
    state.items = normalizeItems(data.items);
    state.selectedPaths.clear();

    initCategoryChipsFromData(state.report.categories || []);
    updateHeader(state.report);

    state.minBytes = Number(el.minSizeUi.value || 0) || 0;
    state.search = "";
    el.search.value = "";
    const tn = Number(el.topN.value || 0);
    state.topN = Number.isFinite(tn) && tn >= 0 ? tn : 0;
    state.applyMode = getApplyMode();

    applyFilters();
    doSort();
    renderTable();

    try { toast("Loaded report.json"); } catch {}
  } catch (e) {
    console.warn('autoLoadReport failed', e);
  }
}

// Kick off auto-load if URL param is present
(function () {
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('auto') === '1') {
      autoLoadReport();
    }
  } catch (e) {
    // no-op
  }
})();
})();
// Server integration helpers (auto-detect backend and auto-scan)
(function () {
  function ready(fn) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(fn, 0);
    } else {
      document.addEventListener('DOMContentLoaded', fn);
    }
  }

  function initIntegration() {
    const DC = (typeof window !== 'undefined' && window.DC) ? window.DC : null;
    if (!DC) {
      // If DC isn't ready yet, retry shortly (the UI IIFE sets window.DC after wireEvents runs)
      setTimeout(initIntegration, 50);
      return;
    }

    const EL = DC.el;
    const STATE = DC.state;
    const {
      applyFilters,
      doSort,
      renderTable,
      normalizeItems,
      initCategoryChipsFromData,
      updateHeader,
      getApplyMode
    } = DC;

    async function pingBackend(candidates) {
      for (const base of candidates) {
        try {
          const r = await fetch(base + '/api/ping', { method: 'GET', cache: 'no-store' });
          if (r.ok) return base;
        } catch {}
      }
      return null;
    }

    function getScanParamsFromUI() {
      const minBytes = Number(EL.minSizeUi?.value || 0) || 0;
      const olderDays = Number(EL.olderThanUi?.value || 0) || 0;
      const cats = [];
      if (EL.categoryFilter) {
        for (const c of EL.categoryFilter.querySelectorAll('input[type="checkbox"]')) {
          if (c.checked) cats.push(c.value);
        }
      }
      const include = cats.length ? cats.join(',') : undefined;
      return { minSize: minBytes, olderThan: olderDays, include };
    }

    function updateBackendStatusBadge() {
      if (!EL.backendStatus) return;
      if (STATE.backendOnline) {
        EL.backendStatus.textContent = 'backend: online';
        EL.backendStatus.style.background = '#1e2b46';
        EL.backendStatus.style.color = '#9fd6ff';
      } else {
        EL.backendStatus.textContent = 'backend: offline';
        EL.backendStatus.style.background = '#3a1e28';
        EL.backendStatus.style.color = '#ffc1c1';
      }
    }

    function refreshApplyBtn() {
      if (EL.applyServerBtn) {
        EL.applyServerBtn.disabled = !(STATE.selectedPaths && STATE.selectedPaths.size > 0);
      }
    }

    async function doServerScan(auto = false) {
      if (!STATE.backendOnline || !STATE.backendBase) {
        await detectBackendAndMaybeAutoScan();
        if (!STATE.backendOnline || !STATE.backendBase) {
          if (!auto) alert('Backend is offline. Start it with: node server.js (http://localhost:8765)');
          return;
        }
      }
      const p = getScanParamsFromUI();
      const qs = new URLSearchParams();
      if (p.minSize) qs.set('minSize', String(p.minSize));
      if (p.olderThan) qs.set('olderThan', String(p.olderThan));
      if (p.include) qs.set('include', p.include);
      if (p.include && p.include.split(',').includes('downloads')) qs.set('downloads', '1');

      try {
        const r = await fetch(`${STATE.backendBase}/api/scan?${qs.toString()}`, { method: 'GET', cache: 'no-store' });
        if (!r.ok) throw new Error(`scan http ${r.status}`);
        const data = await r.json();

        STATE.report = data;
        STATE.items = normalizeItems(data.items || []);
        STATE.selectedPaths.clear();

        initCategoryChipsFromData(data.categories || []);
        updateHeader(data);

        applyFilters();
        doSort();
        renderTable();
        refreshApplyBtn();
        if (!auto) {
          try { const t = (window.toast || (()=>{})); t('Scan complete'); } catch {}
        }
      } catch (e) {
        console.warn('Scan failed', e);
        if (!auto) alert('Scan failed. Check server log. Ensure: node server.js');
      }
    }

    async function doServerApply() {
      if (!STATE.backendOnline || !STATE.backendBase) {
        alert('Backend is offline. Start it with: node server.js');
        return;
      }
      const dry = !!EL.dryRunCheck?.checked;
      const mode = getApplyMode(); // 'trash' | 'delete'
      const items = [];
      for (const it of STATE.items) {
        if (STATE.selectedPaths.has(it.path)) items.push({ path: it.path, category: it.category });
      }
      if (!items.length) { alert('No items selected.'); return; }

      try {
        const r = await fetch(`${STATE.backendBase}/api/apply?dryRun=${dry ? '1' : '0'}&mode=${encodeURIComponent(mode)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items })
        });
        if (!r.ok) throw new Error(`apply http ${r.status}`);
        const resp = await r.json();
        const summary = resp?.summary;
        if (summary) {
          alert(`${dry ? '[DRY RUN]\n' : ''}Applied ${summary.count} items, total ${summary.human || (summary.bytes + ' B')} (mode: ${summary.mode})`);
        } else {
          alert('Apply finished.');
        }
      } catch (e) {
        console.warn('Apply failed', e);
        alert('Apply failed. See console for details.');
      }
    }

    async function detectBackendAndMaybeAutoScan() {
      const candidates = [];
      try {
        const origin = location.origin;
        if (origin && origin.startsWith('http')) candidates.push(origin);
      } catch {}
      candidates.push('http://localhost:8765');

      const base = await pingBackend(candidates);
      STATE.backendOnline = !!base;
      STATE.backendBase = base || '';
      updateBackendStatusBadge();

      if (STATE.backendOnline) {
        await doServerScan(true);
      }
    }

    function wireServerIntegration() {
      if (EL.scanServerBtn) {
        EL.scanServerBtn.addEventListener('click', () => doServerScan(false));
      }
      if (EL.applyServerBtn) {
        EL.applyServerBtn.addEventListener('click', () => doServerApply());
      }
      // Reflect selection changes on apply button
      if (EL.tableBody) {
        EL.tableBody.addEventListener('change', (e) => {
          const t = e.target;
          if (t && t.classList && t.classList.contains('row-select')) {
            refreshApplyBtn();
          }
        });
      }

      // Backend detection + auto-scan
      detectBackendAndMaybeAutoScan();
      updateBackendStatusBadge();
      refreshApplyBtn();
    }

    wireServerIntegration();
  }

  ready(initIntegration);
})();