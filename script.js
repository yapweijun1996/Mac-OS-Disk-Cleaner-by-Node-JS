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
    exportCsvBtn: document.getElementById("exportCsvBtn"),
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
    olderDays: 0,
    categoriesEnabled: new Set(["user-caches","browsers","dev","pkg"]),
    search: "",
    topN: 0,
    applyMode: "trash",
    lastPlanFileName: "disk_cleaner_plan.json",
    // Charts
    catChart: null,
    // Backend
    backendOnline: false,
    backendBase: "" // "" = same-origin; or "http://localhost:8765"
  };

  // One-time guard for row click delegation
  let rowDelegationWired = false;

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
    const olderDays = Number(state.olderDays || 0);
    const cutoff = olderDays > 0 ? (Math.floor(Date.now() / 1000) - olderDays * 86400) : null;
    const search = state.search;
    const searchParts = search.toLowerCase().split(/\s+/).filter(Boolean);
    const cats = state.categoriesEnabled;

    const out = [];
    for (const it of state.items) {
      // Category gating
      if (!cats.has(it.category)) continue;
      // Min size
      const b = Number(it.bytes) || 0;
      if (b < minBytes) continue;
      // Older-than gating (only include items older than N days)
      if (cutoff && (Number(it.mtime) || 0) > cutoff) continue;
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
      const classes = [];
      if (isDisabled) classes.push("disabled");
      if (selected && !isDisabled) classes.push("selected");
      const trClass = classes.length ? ` class="${classes.join(' ')}"` : "";
      const checkedAttr = selected && !isDisabled ? " checked" : "";
      const disableAttr = isDisabled ? " disabled" : "";

      visibleBytes += Number(it.bytes) || 0;

      const trTitleAttr = isDisabled ? ' title="Read-only item: cannot be selected or applied (not trashable)"' : '';
      rows.push(
        `<tr${trClass}${trTitleAttr} data-path="${escapeHtmlAttr(it.path)}">
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

    // Update sort indicators, titles, and selection button labels, and chart
    try { refreshSortIndicators(); } catch {}
    try { refreshSortTitles(); } catch {}
    try { refreshSelectionButtons(); } catch {}
    try { updateCategoryChart(); } catch {}
  }

  function refreshToggleAllCheckbox() {
    const allVisible = [...el.tableBody.querySelectorAll("input.row-select:not(:disabled)")];
    const selectedVisible = allVisible.filter(cb => cb.checked);
    if (!allVisible.length) {
      el.toggleAll.indeterminate = false;
      el.toggleAll.checked = false;
      el.toggleAll.disabled = true;
      el.toggleAll.title = "No visible selectable rows";
      return;
    }
    el.toggleAll.disabled = false;
    if (selectedVisible.length === 0) {
      el.toggleAll.indeterminate = false;
      el.toggleAll.checked = false;
      el.toggleAll.title = "Select all visible rows";
    } else if (selectedVisible.length === allVisible.length) {
      el.toggleAll.indeterminate = false;
      el.toggleAll.checked = true;
      el.toggleAll.title = "Deselect all visible rows";
    } else {
      el.toggleAll.indeterminate = true;
      el.toggleAll.checked = false;
      el.toggleAll.title = "Partially selected — click to select/deselect all visible";
    }
  }

  function setControlsEnabled(enabled) {
    const selCount = state.selectedPaths.size;
    const needSel = selCount === 0;

    if (el.exportPlanBtn) el.exportPlanBtn.disabled = !enabled || needSel;
    if (el.exportCsvBtn) el.exportCsvBtn.disabled = !enabled || needSel;
    if (el.copyCmdBtn) el.copyCmdBtn.disabled = !enabled || needSel;
    if (el.selectAllBtn) el.selectAllBtn.disabled = !enabled;
    if (el.clearSelBtn) el.clearSelBtn.disabled = !enabled || needSel;
    if (el.toggleAll) el.toggleAll.disabled = !enabled || state.sorted.length === 0;

    // Titles for clarity when disabled
    const needDataMsg = 'Load a report or run a scan to enable';
    const needSelMsg = 'Select at least one row to enable';

    if (el.exportPlanBtn) {
      el.exportPlanBtn.title = !enabled ? needDataMsg : (needSel ? 'Select at least one row to export a plan' : 'Export selected items as a cleanup plan (JSON)');
    }
    if (el.exportCsvBtn) {
      el.exportCsvBtn.title = !enabled ? needDataMsg : (needSel ? 'Select at least one row to export CSV' : 'Export selected rows to CSV');
    }
    if (el.copyCmdBtn) {
      el.copyCmdBtn.title = !enabled ? needDataMsg : (needSel ? needSelMsg : 'Copy terminal commands to apply selected paths');
    }
    if (el.selectAllBtn) {
      el.selectAllBtn.title = !enabled ? needDataMsg : 'Select all visible rows';
    }
    if (el.clearSelBtn) {
      el.clearSelBtn.title = !enabled ? needDataMsg : (needSel ? 'No rows selected' : `Clear all (${selCount}) selected`);
    }
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
    const noData = state.items.length === 0;
    if (el.exportPlanBtn) el.exportPlanBtn.disabled = noData || count === 0;
    if (el.exportCsvBtn) el.exportCsvBtn.disabled = noData || count === 0;
    if (el.copyCmdBtn) el.copyCmdBtn.disabled = noData || count === 0;
    if (el.clearSelBtn) el.clearSelBtn.disabled = count === 0;

    // Titles reflecting current state
    if (el.exportPlanBtn) el.exportPlanBtn.title = (noData ? 'Load a report or run a scan to enable' : (count === 0 ? 'Select at least one row to export a plan' : 'Export selected items as a cleanup plan (JSON)'));
    if (el.exportCsvBtn) el.exportCsvBtn.title = (noData ? 'Load a report or run a scan to enable' : (count === 0 ? 'Select at least one row to export CSV' : 'Export selected rows to CSV'));
    if (el.copyCmdBtn) el.copyCmdBtn.title = (noData ? 'Load a report or run a scan to enable' : (count === 0 ? 'Select at least one row to enable' : 'Copy terminal commands to apply selected paths'));

    try { refreshSelectionButtons(); } catch {}
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
      tr.classList.add("selected");
      setRowSelected(path, true);
    }
    updateSelectedSummary();
    refreshToggleAllCheckbox();
    try { refreshSelectionButtons(); } catch {}
  }

  function clearSelection() {
    state.selectedPaths.clear();
    // Uncheck visible
    for (const cb of el.tableBody.querySelectorAll("input.row-select")) {
      cb.checked = false;
      const tr = cb.closest("tr");
      if (tr) tr.classList.remove("selected");
    }
    updateSelectedSummary();
    refreshToggleAllCheckbox();
    try { refreshSelectionButtons(); } catch {}
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
        state.olderDays = Number(el.olderThanUi.value || 0) || 0;
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

    // Older-than (days)
    el.olderThanUi.addEventListener("change", () => {
      const v = Number(el.olderThanUi.value || 0);
      state.olderDays = Number.isFinite(v) && v >= 0 ? v : 0;
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
          tr.classList.remove("selected");
          setRowSelected(path, false);
        }
        updateSelectedSummary();
        refreshToggleAllCheckbox();
        try { refreshSelectionButtons(); } catch {}
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


    // Export CSV (selected rows)
    if (el.exportCsvBtn) {
      el.exportCsvBtn.addEventListener("click", () => {
        if (!state.report) return;
        const lines = ['path,category,bytes,mtime'];
        for (const it of state.items) {
          if (state.selectedPaths.has(it.path)) {
            const pathCsv = '"' + String(it.path).replaceAll('"','""') + '"';
            const catCsv = '"' + String(it.category || '').replaceAll('"','""') + '"';
            const bytes = Number(it.bytes) || 0;
            const mtime = Number(it.mtime) || 0;
            lines.push([pathCsv, catCsv, String(bytes), String(mtime)].join(','));
          }
        }
        if (lines.length <= 1) { try { toast("No selected items"); } catch {} return; }
        const blob = new Blob([lines.join('\n')], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        // Dynamic filename: include row count and timestamp
        const selCount = state.selectedPaths ? state.selectedPaths.size : 0;
        const ts = new Date().toISOString().replace(/[-:T]/g,'').slice(0,15);
        a.download = `disk_cleaner_selection_${selCount}rows_${ts}.csv`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 0);
      });
    }

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

    // Row click toggles selection (event delegation, one-time)
    if (!rowDelegationWired && el.tableBody) {
      el.tableBody.addEventListener("click", (e) => {
        // Ignore native interactive controls
        const ignore = e.target.closest("input,button,a,select,label,textarea");
        if (ignore) return;
        const tr = e.target.closest("tr");
        if (!tr || tr.classList.contains("disabled")) return;
        const cb = tr.querySelector("input.row-select");
        if (!cb) return;
        cb.checked = !cb.checked;
        const path = tr.getAttribute("data-path");
        setRowSelected(path, cb.checked);
        tr.classList.toggle("selected", cb.checked);
        updateSelectedSummary();
        refreshToggleAllCheckbox();
        try { refreshSelectionButtons(); } catch {}
      });
      rowDelegationWired = true;
    }

    // Keyboard shortcuts: Cmd/Ctrl+A select all visible, Esc clear selection
    document.addEventListener('keydown', (e) => {
      const inInput = e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
      if (inInput) return;
      // Select all visible
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAllVisible();
        try { toast('Selected all visible'); } catch {}
      }
      // Clear selection
      if (e.key === 'Escape') {
        clearSelection();
        try { toast('Selection cleared'); } catch {}
      }
    });
  }

  function wireRowCheckboxEvents() {
    for (const cb of el.tableBody.querySelectorAll("input.row-select")) {
      cb.addEventListener("change", (e) => {
        const tr = e.target.closest("tr");
        const path = tr.getAttribute("data-path");
        setRowSelected(path, e.target.checked);
        if (e.target.checked) tr.classList.add("selected"); else tr.classList.remove("selected");
        updateSelectedSummary();
        refreshToggleAllCheckbox();
        try { refreshSelectionButtons(); } catch {}
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


  function buildCopyApplyCommand() {
    // Build a self-contained snippet that writes selected paths to a temp file and applies it.
    const paths = [];
    for (const it of state.items) {
      if (state.selectedPaths.has(it.path)) paths.push(it.path);
    }
    if (paths.length === 0) {
      return "# No selected items. Select rows in the UI to generate apply commands.";
    }
    const ts = new Date().toISOString().replace(/[-:T]/g,'').slice(0,15);
    const tmpName = `disk_cleaner_paths_${ts}.txt`;
    const trashFlag = state.applyMode === 'delete' ? '--no-trash' : '--trash';
    const lines = [];
    lines.push('# Save selected paths to a temporary file and apply via disk_cleaner.sh');
    lines.push(`TMP="/tmp/${tmpName}"`);
    lines.push("cat > \"$TMP\" << 'EOF_DC_PATHS'");
    for (const p of paths) {
      lines.push(p);
    }
    lines.push("EOF_DC_PATHS");
    lines.push("");
    lines.push("# Preview (dry-run)");
    lines.push('./disk_cleaner.sh --apply-from "$TMP" --dry-run');
    lines.push("");
    lines.push(`# Apply (${trashFlag === '--trash' ? 'moves to Trash' : 'permanent delete — DANGEROUS'})`);
    lines.push(`./disk_cleaner.sh --apply-from "$TMP" --apply ${trashFlag} --yes`);
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

  // Loading overlay helpers + UI indicators
  function overlayShow(message = "Working…") {
    try {
      const ov = document.getElementById("loadingOverlay");
      if (!ov) return;
      ov.classList.remove("hidden");
      const m = ov.querySelector(".msg");
      if (m) m.textContent = message;
    } catch {}
  }
  function overlayHide() {
    try {
      const ov = document.getElementById("loadingOverlay");
      if (!ov) return;
      ov.classList.add("hidden");
    } catch {}
  }

  function refreshSortIndicators() {
    try {
      const ths = document.querySelectorAll("thead th[data-sort]");
      for (const th of ths) {
        const key = th.getAttribute("data-sort");
        if (key === state.sortKey) th.setAttribute("data-dir", state.sortDir);
        else th.removeAttribute("data-dir");
      }
    } catch {}
  }

  function refreshSortTitles() {
    try {
      const labels = { path: 'Path', bytes: 'Size', mtime: 'Modified', category: 'Category' };
      const ths = document.querySelectorAll("thead th[data-sort]");
      for (const th of ths) {
        const key = th.getAttribute('data-sort');
        const is = key === state.sortKey;
        const dir = is ? state.sortDir : null;
        const label = labels[key] || key;
        th.title = is
          ? `Sorted by ${label} (${dir === 'asc' ? 'ascending' : 'descending'}) — click to toggle`
          : `Sort by ${label}`;
      }
    } catch {}
  }

  function refreshSelectionButtons() {
    try {
      const vis = state.sorted ? state.sorted.length : 0;
      const sel = state.selectedPaths ? state.selectedPaths.size : 0;
      if (el.selectAllBtn) {
        el.selectAllBtn.textContent = vis > 0 ? `Select All (${vis} visible)` : "Select All (visible)";
      }
      if (el.clearSelBtn) {
        el.clearSelBtn.textContent = sel > 0 ? `Clear Selection (${sel})` : "Clear Selection";
      }
    } catch {}
  }
// Compute totals by category for currently visible items (state.sorted)
function computeVisibleCategoryTotals() {
  try {
    const totals = new Map();
    for (const it of (state.sorted || [])) {
      const cat = String(it.category || '-');
      const b = Number(it.bytes) || 0;
      if (!totals.has(cat)) totals.set(cat, 0);
      totals.set(cat, totals.get(cat) + b);
    }
    // Sort categories by bytes desc for stable chart order
    const entries = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const labels = entries.map(e => e[0]);
    const data = entries.map(e => e[1]);
    return { labels, data };
  } catch {
    return { labels: [], data: [] };
  }
}

// Create or update the Category Distribution chart (uses Chart.js if present)
// This reflects the currently visible (filtered + sorted + topN) items.
function updateCategoryChart() {
  try {
    const canvas = document.getElementById('catChart');
    if (!canvas) return; // chart area not present in DOM
    // Constrain canvas to a stable size to prevent runaway growth
    try {
      canvas.style.maxWidth = '640px';
      canvas.style.width = '100%';
      canvas.style.height = '240px';
    } catch {}
    // Chart.js availability guard
    if (typeof window.Chart === 'undefined') return;

    const { labels, data } = computeVisibleCategoryTotals();

    // No data: destroy chart if exists and clear the canvas
    if (!labels.length || !data.length || data.every(v => v <= 0)) {
      if (state.catChart && typeof state.catChart.destroy === 'function') {
        state.catChart.destroy();
      }
      state.catChart = null;
      const ctx = canvas.getContext('2d');
      if (ctx) { try { ctx.clearRect(0, 0, canvas.width, canvas.height); } catch {} }
      return;
    }

    // Build colors deterministically based on index
    const baseColors = [
      '#62a0ff','#7bd389','#ffcf40','#ff6b6b','#a78bfa','#f472b6','#34d399',
      '#f59e0b','#60a5fa','#22d3ee','#fb7185','#84cc16','#eab308'
    ];
    const bgColors = labels.map((_, i) => baseColors[i % baseColors.length]);

    // Create or update chart
    if (!state.catChart) {
      const ctx = canvas.getContext('2d');
      state.catChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels,
          datasets: [{
            label: 'Bytes',
            data,
            backgroundColor: bgColors,
            borderColor: '#0b1020',
            borderWidth: 1
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          aspectRatio: 2,
          plugins: {
            legend: {
              position: 'right',
              labels: { color: '#e6eaf2', boxWidth: 12, boxHeight: 12 }
            },
            title: {
              display: true,
              text: 'Category Distribution (visible)',
              color: '#e6eaf2',
              font: { weight: '600' }
            },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const bytes = ctx.parsed || 0;
                  // Reuse UI humanizer if present
                  try {
                    return `${ctx.label}: ${humanizeBytes(bytes)}`;
                  } catch {
                    return `${ctx.label}: ${bytes} B`;
                  }
                }
              }
            }
          },
          layout: { padding: 4 }
        }
      });
    } else {
      state.catChart.data.labels = labels;
      state.catChart.data.datasets[0].data = data;
      state.catChart.data.datasets[0].backgroundColor = bgColors;
      state.catChart.update('none');
      try { state.catChart.resize(); } catch {}
    }
  } catch (e) {
    // Non-fatal: chart is optional
    try { console.warn('updateCategoryChart failed', e); } catch {}
  }
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
      getApplyMode,
      overlayShow,
      overlayHide,
      refreshSortIndicators,
      refreshSortTitles,
      refreshSelectionButtons
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
    state.olderDays = Number(el.olderThanUi.value || 0) || 0;
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
        if (EL.scanServerBtn) EL.scanServerBtn.title = 'Run a scan via backend server (online)';
      } else {
        EL.backendStatus.textContent = 'backend: offline';
        EL.backendStatus.style.background = '#3a1e28';
        EL.backendStatus.style.color = '#ffc1c1';
        if (EL.scanServerBtn) EL.scanServerBtn.title = 'Backend offline. Start: node server.js (http://localhost:8765)';
      }
    }

    function refreshApplyBtn() {
      if (!EL.applyServerBtn) return;
      const n = (STATE.selectedPaths && STATE.selectedPaths.size) || 0;
      EL.applyServerBtn.disabled = n === 0;
      EL.applyServerBtn.title = n > 0 ? `Apply ${n} selected item(s) via backend` : 'Select rows to enable apply';
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

      // Confirm for potentially heavy 'full' scans when not auto
      if (!auto && p.include && p.include.split(',').includes('full')) {
        const proceed = window.confirm('Full scan will traverse your entire Home folder (depth-limited). This may be slower. Continue?');
        if (!proceed) { return; }
      }

      try {
        try { if (window.DC && window.DC.overlayShow) window.DC.overlayShow('Scanning…'); } catch {}
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
      } finally {
        try { if (window.DC && window.DC.overlayHide) window.DC.overlayHide(); } catch {}
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
        if (mode === 'delete' && !dry) {
          if (!window.confirm('Permanently delete selected items? This cannot be undone. Continue?')) { return; }
        }
        try { if (window.DC && window.DC.overlayShow) window.DC.overlayShow(dry ? 'Simulating (dry run)…' : 'Applying…'); } catch {}
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
      } finally {
        try { if (window.DC && window.DC.overlayHide) window.DC.overlayHide(); } catch {}
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