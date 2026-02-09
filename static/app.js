const INITIAL_PREFETCH_GROUPS = 2;
const GROUP_BATCH_SIZE = 3;
const SUBGROUP_BATCH_SIZE = 6;
const THUMBNAILS_PER_GROUP = 20;
const RANDOM_POOL_LIMIT = 2000;
const SEARCH_HISTORY_LIMIT = 8;

const urlParams = new URLSearchParams(window.location.search);
const initialOrder = urlParams.get("order") === "asc" ? "asc" : "desc";
const initialImageParam = urlParams.get("image");

const MONTH_NAMES = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_ABBREVIATIONS = [
  "",
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const CONTROL_TABS = ["search", "year", "random"];
const STORAGE_KEYS = {
  semanticScoreCutoff: "barryImageViewer.semanticScoreCutoff",
};
const STORAGE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
let semanticScoreSyncTimer = null;

const state = {
  order: initialOrder,
  orderVersion: 0,
  activeControlTab: "search",
  databaseMode: false,
  topGroups: [],
  topGroupIndex: 0,
  topGroupStatus: new Map(),
  topGroupOptions: [],
  combobox: {
    open: false,
    activeIndex: -1,
    filtered: [],
  },
  groups: new Map(),
  groupSequence: [],
  groupIndexMap: new Map(),
  imagesByGroup: new Map(),
  pathToImage: new Map(),
  detailsCache: new Map(),
  viewer: {
    open: false,
    mode: null,
    groupKey: null,
    index: -1,
    vectorPaths: [],
    pendingBlend: 0,
    detailsOpen: false,
    detailsPath: null,
    detailsLoading: false,
    detailsRequestToken: null,
  },
  initialImagePath: initialImageParam,
  activeThumb: null,
  controlOpen: false,
  download: {
    items: new Map(),
    perGroupCounts: new Map(),
    groupSelections: new Set(),
    inProgress: false,
  },
  randomViewer: {
    enabled: false,
    running: false,
    timerId: null,
    duration: 10,
    blend: 1,
    lastPath: null,
    nextChoice: null,
    pool: [],
    queue: [],
    filter: {
      start: null,
      end: null,
      specificMap: new Map(),
      specificList: [],
    },
  },
  searchHistory: {
    items: [],
    cursor: -1,
    limit: SEARCH_HISTORY_LIMIT,
  },
  appConfig: {
    semanticScoreDefault: 0.75,
  },
  vectorView: {
    active: false,
    root: null,
    title: null,
    count: null,
    grid: null,
    query: "",
    results: [],
    sort: "score",
    sortButtons: null,
  },
  flyoutPinned: false,
  suppressThumbnailOpenUntil: 0,
};

const elements = {
  timeline: document.getElementById("timeline"),
  timelineSections: document.getElementById("timelineSections"),
  timelineLoader: document.getElementById("timelineLoader"),
  flyoutHandle: document.getElementById("flyoutHandle"),
  flyoutBackdrop: document.getElementById("flyoutBackdrop"),
  viewerOverlay: document.getElementById("viewerOverlay"),
  viewerContainer: document.getElementById("viewerContainer"),
  viewerImage: document.getElementById("viewerImage"),
  viewerImageOverlay: document.getElementById("viewerImageOverlay"),
  viewerInfoTop: document.getElementById("viewerInfoTop"),
  viewerInfoBottom: document.getElementById("viewerInfoBottom"),
  viewerInfoLeft: document.getElementById("viewerInfoLeft"),
  viewerInfoRight: document.getElementById("viewerInfoRight"),
  viewerPrev: document.getElementById("viewerPrev"),
  viewerNext: document.getElementById("viewerNext"),
  viewerClose: document.getElementById("viewerClose"),
  viewerDetailsPanel: document.getElementById("viewerDetailsPanel"),
  viewerDetailsStatus: document.getElementById("viewerDetailsStatus"),
  viewerLocationSection: document.getElementById("viewerLocationSection"),
  viewerLocationTable: document.getElementById("viewerLocationTable"),
  viewerLocationTableBody: document.getElementById("viewerLocationTableBody"),
  viewerExifSection: document.getElementById("viewerExifSection"),
  viewerExifTable: document.getElementById("viewerExifTable"),
  viewerExifTableBody: document.getElementById("viewerExifTableBody"),
  header: document.getElementById("appHeader"),
  controlContent: document.getElementById("controlContent"),
  controlTabButtons: Array.from(document.querySelectorAll(".control-tab")),
  controlPanels: {
    search: document.getElementById("controlPanelSearch"),
    year: document.getElementById("controlPanelYear"),
    random: document.getElementById("controlPanelRandom"),
  },
  searchForm: document.getElementById("searchForm"),
  searchInput: document.getElementById("searchInput"),
  searchCombobox: document.getElementById("searchCombobox"),
  searchSuggestions: document.getElementById("searchSuggestions"),
  searchResults: document.getElementById("searchResults"),
  searchHistoryBack: document.getElementById("searchHistoryBack"),
  searchHistoryForward: document.getElementById("searchHistoryForward"),
  searchScoreInput: document.getElementById("searchScoreInput"),
  searchScoreValue: document.getElementById("searchScoreValue"),
  orderSwitch: document.getElementById("orderSwitch"),
  orderButtons: Array.from(document.querySelectorAll(".order-option")),
  yearNavigation: document.getElementById("yearNavigation"),
  yearNavigationButtons: document.getElementById("yearNavigationButtons"),
  yearNavigationSelect: document.getElementById("yearNavigationSelect"),
  downloadControls: document.getElementById("downloadControls"),
  downloadCount: document.getElementById("downloadCount"),
  downloadButton: document.getElementById("downloadButton"),
  downloadClear: document.getElementById("downloadClear"),
  randomViewerSection: document.getElementById("randomViewerSection"),
  randomViewerToggle: document.getElementById("randomViewerToggle"),
  randomViewerSettings: document.getElementById("randomViewerSettings"),
  randomViewerDuration: document.getElementById("randomViewerDuration"),
  randomViewerBlend: document.getElementById("randomViewerBlend"),
  randomViewerStart: document.getElementById("randomViewerStart"),
  randomViewerEnd: document.getElementById("randomViewerEnd"),
  randomViewerSpecificInput: document.getElementById("randomViewerSpecificInput"),
  randomViewerAddDate: document.getElementById("randomViewerAddDate"),
  randomViewerDateChips: document.getElementById("randomViewerDateChips"),
  flyoutPin: document.getElementById("flyoutPin"),
};

function ensureFlyoutBackdrop() {
  if (!elements.flyoutBackdrop) {
    const existing = document.getElementById("flyoutBackdrop");
    if (existing) {
      elements.flyoutBackdrop = existing;
    }
  }
  if (!elements.flyoutBackdrop) {
    const backdrop = document.createElement("div");
    backdrop.id = "flyoutBackdrop";
    backdrop.className = "flyout-backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    document.body.appendChild(backdrop);
    elements.flyoutBackdrop = backdrop;
  }
  if (!elements.flyoutBackdrop.__flyoutCloseBound) {
    elements.flyoutBackdrop.addEventListener("pointerdown", (event) => {
      consumeInteractionEvent(event);
    });
    elements.flyoutBackdrop.addEventListener("click", (event) => {
      consumeInteractionEvent(event);
      const flyoutVisible = Boolean(
        elements.header
          && !elements.header.classList.contains("collapsed")
          && !state.flyoutPinned,
      );
      if (flyoutVisible) {
        suppressViewerOpen();
        closeControlPanel();
        setHeaderCollapsed(true);
      }
    });
    elements.flyoutBackdrop.__flyoutCloseBound = true;
  }
  if (elements.flyoutBackdrop.hasAttribute("hidden")) {
    elements.flyoutBackdrop.removeAttribute("hidden");
  }
}

function removeFlyoutBackdrop() {
  if (!elements.flyoutBackdrop) {
    return;
  }
  elements.flyoutBackdrop.remove();
  elements.flyoutBackdrop = null;
}

function fetchJson(url) {
  return fetch(url).then((response) => {
    if (!response.ok) {
      return response.text().then((message) => {
        throw new Error(message || `${response.status} ${response.statusText}`);
      });
    }
    return response.json();
  });
}

async function fetchVectorSearch(query, { limit = 30, candidates = 200 } = {}) {
  const params = new URLSearchParams();
  params.set("query", query);
  params.set("limit", String(limit));
  params.set("candidates", String(candidates));
  const minScore = getSemanticScoreCutoff();
  params.set("min_score", minScore.toFixed(2));
  const response = await fetchJson(`/api/search-vector?${params.toString()}`);
  return Array.isArray(response.results) ? response.results : [];
}

function getSemanticScoreDefault() {
  const fallback = 0.75;
  if (!state.appConfig || typeof state.appConfig.semanticScoreDefault !== "number") {
    return fallback;
  }
  return Math.max(0, Math.min(1, state.appConfig.semanticScoreDefault));
}

function getPersistedSemanticScoreCutoff() {
  let storageValue = null;
  const cookiePrefix = `${encodeURIComponent(STORAGE_KEYS.semanticScoreCutoff)}=`;
  const cookieValue = document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(cookiePrefix));
  if (cookieValue) {
    storageValue = decodeURIComponent(cookieValue.slice(cookiePrefix.length));
  }

  try {
    const localValue = window.localStorage.getItem(STORAGE_KEYS.semanticScoreCutoff);
    if (storageValue === null && localValue !== null) {
      storageValue = localValue;
    }
  } catch (error) {
    // Continue with cookie value if localStorage is unavailable.
  }

  if (storageValue === null) {
    return null;
  }
  const parsed = Number.parseFloat(storageValue);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.max(0, Math.min(1, parsed));
}

function persistSemanticScoreCutoff(value) {
  const normalized = Math.max(0, Math.min(1, value)).toFixed(2);
  try {
    window.localStorage.setItem(
      STORAGE_KEYS.semanticScoreCutoff,
      normalized,
    );
  } catch (error) {
    // Fall back to cookie-based persistence if localStorage is blocked.
  }
  document.cookie = `${encodeURIComponent(STORAGE_KEYS.semanticScoreCutoff)}=${encodeURIComponent(normalized)}; path=/; max-age=${STORAGE_COOKIE_MAX_AGE}; samesite=lax`;
}

async function saveSemanticScoreCutoffToServer(value) {
  const normalized = Math.max(0, Math.min(1, value));
  const response = await fetch("/api/ui-state", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ semantic_score_cutoff: normalized }),
  });
  if (!response.ok) {
    throw new Error(`Failed to persist slider value (${response.status})`);
  }
}

function queueSemanticScoreCutoffSync(value) {
  if (semanticScoreSyncTimer) {
    clearTimeout(semanticScoreSyncTimer);
  }
  semanticScoreSyncTimer = setTimeout(() => {
    saveSemanticScoreCutoffToServer(value).catch((error) => {
      console.error("Failed to sync semantic score cutoff", error);
    });
    semanticScoreSyncTimer = null;
  }, 250);
}

function flushSemanticScoreCutoffToServer(value) {
  const normalized = Math.max(0, Math.min(1, value));
  const payload = JSON.stringify({ semantic_score_cutoff: normalized });
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    const blob = new Blob([payload], { type: "application/json" });
    navigator.sendBeacon("/api/ui-state", blob);
    return;
  }
  saveSemanticScoreCutoffToServer(normalized).catch(() => {});
}

function getSemanticScoreCutoff() {
  const fallback = getSemanticScoreDefault();
  if (!elements.searchScoreInput) {
    return fallback;
  }
  const raw = Number.parseFloat(elements.searchScoreInput.value);
  if (Number.isNaN(raw)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, raw));
}

function updateSemanticScoreLabel() {
  if (!elements.searchScoreValue) {
    return;
  }
  const value = getSemanticScoreCutoff();
  elements.searchScoreValue.textContent = value.toFixed(2);
}

function applySemanticScoreDefault() {
  if (!elements.searchScoreInput) {
    return;
  }
  const persisted = getPersistedSemanticScoreCutoff();
  const value = typeof persisted === "number" ? persisted : getSemanticScoreDefault();
  elements.searchScoreInput.value = value.toFixed(2);
  persistSemanticScoreCutoff(value);
  updateSemanticScoreLabel();
}

async function loadAppConfigDefaults() {
  try {
    const config = await fetchJson("/api/config");
    if (config && typeof config.semantic_score_default === "number") {
      state.appConfig.semanticScoreDefault = config.semantic_score_default;
    }
  } catch (error) {
    return;
  }
  applySemanticScoreDefault();
}

async function loadSemanticScoreCutoffFromServer() {
  if (!elements.searchScoreInput) {
    return;
  }
  try {
    const payload = await fetchJson("/api/ui-state");
    const raw = payload ? Number.parseFloat(payload.semantic_score_cutoff) : Number.NaN;
    if (Number.isNaN(raw)) {
      return;
    }
    const normalized = Math.max(0, Math.min(1, raw));
    elements.searchScoreInput.value = normalized.toFixed(2);
    persistSemanticScoreCutoff(normalized);
    updateSemanticScoreLabel();
  } catch (error) {
    // Non-fatal; local defaults are already applied.
  }
}

function setGlobalLoaderVisible(visible) {
  elements.timelineLoader.classList.toggle("visible", visible);
}

function isGroupLoadingSuspended() {
  return Boolean(state.viewer.open || state.vectorView.active);
}

function showTimelineView() {
  if (state.vectorView && state.vectorView.root) {
    state.vectorView.root.hidden = true;
  }
  state.vectorView.active = false;
  if (elements.timelineSections) {
    elements.timelineSections.hidden = false;
  }
}

function ensureVectorViewContainer() {
  if (state.vectorView && state.vectorView.root) {
    return state.vectorView;
  }
  if (!elements.timeline) {
    return state.vectorView;
  }
  const root = document.createElement("section");
  root.className = "top-group vector-view";
  root.hidden = true;

  const heading = document.createElement("h2");
  heading.textContent = "Search results";
  root.appendChild(heading);

  const panel = document.createElement("div");
  panel.className = "subgroup-section";
  root.appendChild(panel);

  const header = document.createElement("div");
  header.className = "subgroup-header";
  panel.appendChild(header);

  const headingText = document.createElement("div");
  headingText.className = "subgroup-heading-text";
  header.appendChild(headingText);

  const title = document.createElement("h3");
  title.className = "subgroup-title";
  title.textContent = "Most relevant";
  headingText.appendChild(title);

  const metaRow = document.createElement("div");
  metaRow.className = "subgroup-meta";
  headingText.appendChild(metaRow);

  const countLabel = document.createElement("span");
  countLabel.className = "subgroup-count";
  metaRow.appendChild(countLabel);

  const sortControls = document.createElement("div");
  sortControls.className = "vector-sort";
  const scoreButton = document.createElement("button");
  scoreButton.type = "button";
  scoreButton.className = "vector-sort-button";
  scoreButton.dataset.sort = "score";
  scoreButton.textContent = "Sort by score";
  const dateButton = document.createElement("button");
  dateButton.type = "button";
  dateButton.className = "vector-sort-button";
  dateButton.dataset.sort = "date";
  dateButton.textContent = "Sort by date";
  sortControls.appendChild(scoreButton);
  sortControls.appendChild(dateButton);
  metaRow.appendChild(sortControls);

  const grid = document.createElement("div");
  grid.className = "thumb-grid";
  panel.appendChild(grid);

  elements.timeline.insertBefore(root, elements.timelineSections || null);

  state.vectorView = {
    active: false,
    root,
    title,
    count: countLabel,
    grid,
    query: "",
    results: [],
    sort: "score",
    sortButtons: { score: scoreButton, date: dateButton },
  };
  sortControls.addEventListener("click", (event) => {
    const button = event.target.closest(".vector-sort-button");
    if (!button) {
      return;
    }
    const sort = button.dataset.sort;
    if (sort !== "score" && sort !== "date") {
      return;
    }
    if (state.vectorView.sort === sort) {
      return;
    }
    state.vectorView.sort = sort;
    updateVectorSortButtons();
    renderVectorResultsGrid();
  });
  updateVectorSortButtons();
  return state.vectorView;
}

function updateVectorSortButtons() {
  const buttons = state.vectorView && state.vectorView.sortButtons;
  if (!buttons) {
    return;
  }
  const activeSort = state.vectorView.sort || "score";
  Object.entries(buttons).forEach(([key, button]) => {
    if (!button) {
      return;
    }
    const isActive = key === activeSort;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function renderVectorResultsSummary(results) {
  if (!elements.searchResults) {
    return;
  }
  elements.searchResults.innerHTML = "";
  const info = document.createElement("span");
  info.className = "search-result empty";
  if (!results.length) {
    info.textContent = "No matches";
  } else {
    const total = results.length;
    info.textContent = `${total} result${total === 1 ? "" : "s"} shown below`;
  }
  elements.searchResults.appendChild(info);
}

function renderVectorResultsGrid() {
  const view = ensureVectorViewContainer();
  if (!view || !view.root || !view.grid) {
    return;
  }
  const results = Array.isArray(view.results) ? view.results : [];
  view.grid.innerHTML = "";

  const sorted = results.slice().sort((a, b) => {
    if (view.sort === "date") {
      const dateA = Number.isFinite(a.dateValue) ? a.dateValue : 0;
      const dateB = Number.isFinite(b.dateValue) ? b.dateValue : 0;
      const direction = state.order === "asc" ? 1 : -1;
      if (dateA !== dateB) {
        return direction * (dateA - dateB);
      }
      const scoreA = typeof a.score === "number" ? a.score : 0;
      const scoreB = typeof b.score === "number" ? b.score : 0;
      return scoreB - scoreA;
    }
    const scoreA = typeof a.score === "number" ? a.score : 0;
    const scoreB = typeof b.score === "number" ? b.score : 0;
    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }
    const dateA = Number.isFinite(a.dateValue) ? a.dateValue : 0;
    const dateB = Number.isFinite(b.dateValue) ? b.dateValue : 0;
    return dateB - dateA;
  });

  if (!sorted.length) {
    const empty = document.createElement("p");
    empty.className = "group-loader";
    empty.textContent = "No matches.";
    view.grid.appendChild(empty);
    return;
  }

  sorted.forEach((match) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thumbnail-button";
    if (match.path) {
      button.dataset.path = match.path;
    } else {
      button.disabled = true;
    }
    button.addEventListener("click", () => {
      if (match.path) {
        openVectorImage(match.path);
      }
    });

    const tile = document.createElement("div");
    tile.className = "thumbnail-tile";
    if (match.path) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = match.path.split("/").pop() || "";
      img.src = `/api/thumbnail?path=${encodeURIComponent(match.path)}`;
      img.addEventListener("error", () => {
        if (!img.dataset.retried) {
          img.dataset.retried = "true";
          img.src = "/thumbnail-placeholder.svg";
        }
      });
      tile.appendChild(img);
    }

    const caption = document.createElement("div");
    caption.className = "thumbnail-caption";
    const label = formatVectorResultLabel(match);
    const parts = [];
    if (label) {
      parts.push(label);
    }
    if (typeof match.score === "number") {
      parts.push(`Score ${match.score.toFixed(3)}`);
    }
    caption.textContent = parts.join(" • ") || (match.path || "");

    button.appendChild(tile);
    button.appendChild(caption);
    view.grid.appendChild(button);
  });
}

function showVectorResultsView(results, query) {
  const view = ensureVectorViewContainer();
  if (!view || !view.root || !view.grid) {
    return;
  }
  if (imageObserver) {
    imageObserver.disconnect();
    imageObserver = null;
  }
  state.vectorView.active = true;
  state.vectorView.query = query || "";
  state.vectorView.results = Array.isArray(results) ? results : [];
  if (elements.timelineSections) {
    elements.timelineSections.hidden = true;
  }
  view.root.hidden = false;
  if (view.title) {
    const trimmed = (query || "").trim();
    view.title.textContent = trimmed ? `Results for "${trimmed}"` : "Search results";
  }
  if (view.count) {
    view.count.textContent = formatPhotoCount(state.vectorView.results.length);
  }
  updateVectorSortButtons();
  renderVectorResultsGrid();
}

function openVectorImage(path) {
  if (!path) {
    return;
  }
  const results = Array.isArray(state.vectorView.results) ? state.vectorView.results : [];
  const index = results.findIndex((item) => item && item.path === path);
  if (index === -1) {
    openImageByPath(path);
    return;
  }
  state.viewer.pendingBlend = state.randomViewer.running ? state.randomViewer.blend : 0;
  openVectorViewerAt(index);
}

function formatPhotoCount(count) {
  const value = Number.isFinite(count) ? Math.max(0, count) : 0;
  const formatted = value.toLocaleString();
  return `${formatted} photo${value === 1 ? "" : "s"}`;
}

const holidayDateCache = new Map();

function getAvailableYears() {
  const years = new Set();
  if (Array.isArray(state.topGroups)) {
    state.topGroups.forEach((topGroup) => {
      if (typeof topGroup.dateValue === "number" && topGroup.dateValue > 0) {
        years.add(Math.floor(topGroup.dateValue / 10000));
      }
      const subgroups = Array.isArray(topGroup.subgroups) ? topGroup.subgroups : [];
      subgroups.forEach((subgroup) => {
        if (typeof subgroup.dateValue === "number" && subgroup.dateValue > 0) {
          years.add(Math.floor(subgroup.dateValue / 10000));
        }
      });
    });
  }
  return years;
}

async function fetchHolidayDates(names) {
  const prepared = Array.from(new Set((Array.isArray(names) ? names : [])
    .map((name) => (typeof name === "string" ? name.trim() : ""))
    .filter(Boolean)));
  if (!prepared.length) {
    return [];
  }
  const cacheKey = prepared.join("|").toLowerCase();
  if (holidayDateCache.has(cacheKey)) {
    return holidayDateCache.get(cacheKey);
  }
  const params = new URLSearchParams();
  prepared.forEach((name) => params.append("name", name));
  let response = { results: [] };
  try {
    response = await fetchJson(`/api/holiday-dates?${params.toString()}`);
  } catch (error) {
    console.error("Failed to resolve holiday dates", error);
    holidayDateCache.set(cacheKey, []);
    return [];
  }
  const availableYears = getAvailableYears();
  const items = Array.isArray(response.results) ? response.results : [];
  const aggregated = new Map();
  items.forEach((item) => {
    if (!item) {
      return;
    }
    const value = Number.parseInt(item.dateValue, 10);
    if (!Number.isFinite(value) || value <= 0) {
      return;
    }
    const year = Math.floor(value / 10000);
    if (availableYears.size && !availableYears.has(year)) {
      return;
    }
    const iso = typeof item.iso === "string" && item.iso
      ? item.iso
      : formatValueToDateString(value);
    if (!iso) {
      return;
    }
    const isoLower = iso.toLowerCase();
    const entry = aggregated.get(isoLower) || {
      iso,
      dateValue: value,
      names: new Set(),
      friendly: typeof item.friendly === "string" && item.friendly ? item.friendly : formatIsoDateFriendly(iso),
    };
    if (item.name) {
      entry.names.add(String(item.name));
    }
    aggregated.set(isoLower, entry);
  });

  const resolved = Array.from(aggregated.values()).map((entry) => {
    const names = Array.from(entry.names);
    return {
      iso: entry.iso,
      dateValue: entry.dateValue,
      name: names[0] || entry.iso,
      names,
      friendly: entry.friendly,
    };
  });
  holidayDateCache.set(cacheKey, resolved);
  return resolved;
}

async function fetchImagesByFilters({ dateEntries = [], startValue = null, endValue = null } = {}) {
  const payload = {
    dateValues: [],
    isoDates: [],
  };
  dateEntries.forEach((entry) => {
    if (!entry) {
      return;
    }
    if (typeof entry.dateValue === "number" && entry.dateValue > 0) {
      payload.dateValues.push(entry.dateValue);
    } else if (entry.iso) {
      payload.isoDates.push(entry.iso);
    }
  });
  if (startValue) {
    payload.start = formatValueToDateString(startValue);
  }
  if (endValue) {
    payload.end = formatValueToDateString(endValue);
  }

  if (
    !payload.dateValues.length &&
    !payload.isoDates.length &&
    !payload.start &&
    !payload.end
  ) {
    return [];
  }

  const response = await fetch("/api/images-by-dates", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Failed to fetch images by dates (${response.status})`);
  }
  const data = await response.json();
  return Array.isArray(data.images) ? data.images : [];
}

function setActiveControlTab(tab) {
  const target = CONTROL_TABS.includes(tab) ? tab : "search";
  state.activeControlTab = target;
  if (Array.isArray(elements.controlTabButtons)) {
    elements.controlTabButtons.forEach((button) => {
      const buttonTab = button.dataset.tab;
      const isActive = buttonTab === target;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-selected", isActive ? "true" : "false");
      button.setAttribute("tabindex", isActive ? "0" : "-1");
    });
  }
  const panels = elements.controlPanels || {};
  Object.entries(panels).forEach(([key, panel]) => {
    if (panel) {
      panel.hidden = key !== target;
      panel.setAttribute("aria-hidden", key === target ? "false" : "true");
    }
  });
  if (target !== "search") {
    closeCombobox();
  }
}

function normalizeSearchText(text) {
  if (text === null || text === undefined) {
    return "";
  }
  return text
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchHaystack(topGroup, subgroup) {
  const parts = [];
  const topLabel = topGroup ? (topGroup.formattedLabel || topGroup.label || "") : "";
  const subgroupLabel = subgroup ? (subgroup.formattedLabel || subgroup.label || "") : "";
  const subgroupKey = subgroup ? subgroup.key || "" : "";
  const subgroupRawLabel = subgroup ? subgroup.label || "" : "";
  const location = subgroup && typeof subgroup.location === "string" ? subgroup.location : "";

  [topLabel, subgroupLabel, subgroupRawLabel, subgroupKey, location]
    .filter((value) => value)
    .forEach((value) => parts.push(value));

  const dateValueRaw = subgroup && subgroup.dateValue !== undefined ? Number(subgroup.dateValue) : NaN;
  if (Number.isFinite(dateValueRaw) && dateValueRaw > 0) {
    const year = Math.floor(dateValueRaw / 10000);
    const month = Math.floor((dateValueRaw % 10000) / 100);
    const day = dateValueRaw % 100;
    if (year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const paddedMonth = String(month).padStart(2, "0");
      const paddedDay = String(day).padStart(2, "0");
      parts.push(
        `${year}${paddedMonth}${paddedDay}`,
        `${year} ${paddedMonth} ${paddedDay}`,
        `${paddedMonth} ${paddedDay} ${year}`,
        `${paddedDay} ${paddedMonth} ${year}`,
      );
      const monthName = MONTH_NAMES[month] || "";
      const monthAbbr = MONTH_ABBREVIATIONS[month] || "";
      if (monthName) {
        parts.push(
          `${monthName} ${day} ${year}`,
          `${day} ${monthName} ${year}`,
        );
      }
      if (monthAbbr) {
        parts.push(
          `${monthAbbr} ${day} ${year}`,
          `${day} ${monthAbbr} ${year}`,
        );
      }
    }
  }

  return normalizeSearchText(parts.join(" "));
}

function updateComboboxAria() {
  if (!elements.searchCombobox) {
    return;
  }
  const expanded = state.combobox.open && state.combobox.filtered.length > 0;
  elements.searchCombobox.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function renderComboboxOptions() {
  const list = elements.searchSuggestions;
  if (!list) {
    return;
  }
  const options = state.combobox.filtered || [];
  list.innerHTML = "";

  if (!state.combobox.open || !options.length) {
    list.hidden = true;
    elements.searchInput.removeAttribute("aria-activedescendant");
    updateComboboxAria();
    return;
  }

  options.forEach((option, index) => {
    const item = document.createElement("li");
    const safeId = `suggestion-${option.key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    item.id = safeId;
    item.className = "search-suggestion";
    item.setAttribute("role", "option");
    item.dataset.key = option.key;
    if (option.count !== undefined) {
      item.innerHTML = `<span>${option.label}</span><small>${option.count.toLocaleString()} photos</small>`;
    } else {
      item.textContent = option.label;
    }
    if (index === state.combobox.activeIndex) {
      item.setAttribute("aria-selected", "true");
      elements.searchInput.setAttribute("aria-activedescendant", safeId);
    }
    item.addEventListener("click", () => {
      selectComboboxOption(option);
    });
    list.appendChild(item);
  });

  if (state.combobox.activeIndex === -1) {
    elements.searchInput.removeAttribute("aria-activedescendant");
  }

  list.hidden = false;
  updateComboboxAria();
}

function renderYearNavigation(options = []) {
  const nav = elements.yearNavigation;
  const buttonsContainer = elements.yearNavigationButtons;
  const selectElement = elements.yearNavigationSelect;
  if (!nav) {
    return;
  }

  if (buttonsContainer) {
    buttonsContainer.innerHTML = "";
  }

  if (selectElement) {
    selectElement.innerHTML = "";
  }

  const items = Array.isArray(options) ? options.filter((item) => item && item.key) : [];
  const order = state.order === "asc" ? "asc" : "desc";
  items.sort((a, b) => compareGroupOptions(a, b, order));
  if (!items.length) {
    nav.hidden = true;
    return;
  }

  nav.hidden = false;

  if (buttonsContainer) {
    items.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "year-navigation-button";
      button.dataset.topKey = item.key;
      button.textContent = item.label;
      if (typeof item.count === "number") {
        button.title = `${item.label} (${item.count.toLocaleString()} photos)`;
      }
      buttonsContainer.appendChild(button);
    });
  }

  if (selectElement) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a year";
    placeholder.disabled = true;
    placeholder.selected = true;
    selectElement.appendChild(placeholder);

    items.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.key;
      const countText = typeof item.count === "number" && item.count > 0 ? ` (${item.count.toLocaleString()})` : "";
      option.textContent = `${item.label}${countText}`;
      selectElement.appendChild(option);
    });
  }
}

function buildTopGroupOptions(groups) {
  const options = (Array.isArray(groups) ? groups : []).map((group) => ({
    key: group.key,
    label: group.formattedLabel || group.label,
    normalizedLabel: normalizeSearchText(group.formattedLabel || group.label || ""),
    count: group.count || 0,
    dateValue: typeof group.dateValue === "number" ? group.dateValue : 0,
  }));
  const order = state.order === "asc" ? "asc" : "desc";
  options.sort((a, b) => compareGroupOptions(a, b, order));
  state.topGroupOptions = options;
  state.combobox.filtered = options.slice();
  renderYearNavigation(options);
  renderComboboxOptions();
}

function shuffleArray(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const temp = items[index];
    items[index] = items[swapIndex];
    items[swapIndex] = temp;
  }
  return items;
}

function compareGroupOptions(a, b, order = "desc") {
  const normalized = order === "asc" ? "asc" : "desc";
  const aValue = typeof a.dateValue === "number" ? a.dateValue : 0;
  const bValue = typeof b.dateValue === "number" ? b.dateValue : 0;
  const aHasDate = aValue > 0;
  const bHasDate = bValue > 0;
  if (aHasDate !== bHasDate) {
    return aHasDate ? -1 : 1;
  }
  if (aHasDate && aValue !== bValue) {
    return normalized === "asc" ? aValue - bValue : bValue - aValue;
  }
  const aLabel = (a.label || "").toString();
  const bLabel = (b.label || "").toString();
  const labelCompare = aLabel.localeCompare(bLabel, undefined, { numeric: true, sensitivity: "base" });
  if (labelCompare !== 0) {
    return normalized === "asc" ? labelCompare : -labelCompare;
  }
  return 0;
}

function openCombobox() {
  if (!state.topGroupOptions.length) {
    return;
  }
  state.combobox.open = true;
  state.combobox.filtered = [...state.topGroupOptions];
  state.combobox.activeIndex = -1;
  renderComboboxOptions();
}

function closeCombobox() {
  state.combobox.open = false;
  state.combobox.activeIndex = -1;
  state.combobox.filtered = state.topGroupOptions.slice();
  const list = elements.searchSuggestions;
  if (list) {
    list.hidden = true;
    list.innerHTML = "";
  }
  elements.searchInput.removeAttribute("aria-activedescendant");
  updateComboboxAria();
}

function filterComboboxOptions(query) {
  if (!state.topGroupOptions.length) {
    state.combobox.filtered = [];
    renderComboboxOptions();
    return;
  }
  const normalized = normalizeSearchText(query);
  const tokens = normalized ? normalized.split(" ").filter(Boolean) : [];
  const filtered = tokens.length
    ? state.topGroupOptions.filter((option) => {
        const labelText = option.normalizedLabel || normalizeSearchText(option.label || "");
        return tokens.every((token) => labelText.includes(token));
      })
    : [...state.topGroupOptions];
  state.combobox.filtered = filtered;
  state.combobox.activeIndex = -1;
  renderComboboxOptions();
}

function navigateToTopGroup(topKey) {
  if (!topKey) {
    return;
  }
  ensureTopGroupRendered(topKey);
  requestAnimationFrame(() => {
    const selector = `.top-group[data-top-key="${CSS.escape(topKey)}"]`;
    const section = document.querySelector(selector);
    if (!section) {
      return;
    }
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    scheduleViewportLoading();
  });
}

function setThumbnailSelectionState(element, selected) {
  if (!element) {
    return;
  }
  element.classList.toggle("selected", Boolean(selected));
  element.setAttribute("aria-checked", selected ? "true" : "false");
  const indicator = element.querySelector(".thumbnail-select-indicator");
  if (indicator) {
    indicator.setAttribute("aria-checked", selected ? "true" : "false");
    indicator.setAttribute("aria-label", selected ? "Deselect" : "Select for download");
  }
}

function updateThumbnailSelectionVisual(path, selected) {
  if (!path) {
    return;
  }
  const meta = state.pathToImage.get(path);
  if (!meta) {
    return;
  }
  const groupState = state.groups.get(meta.groupKey);
  if (!groupState) {
    return;
  }
  const entry = groupState.images[meta.index];
  if (!entry || !entry.element) {
    return;
  }
  setThumbnailSelectionState(entry.element, selected);
}

async function fetchGroupImages(groupKey, { cursor = null, limit = THUMBNAILS_PER_GROUP } = {}) {
  if (!groupKey) {
    return { images: [], nextCursor: null };
  }
  const params = new URLSearchParams({ group: groupKey, order: state.order, limit: String(limit) });
  if (cursor) {
    params.set("cursor", cursor);
  }
  return fetchJson(`/api/group-images?${params.toString()}`);
}

function appendGroupImages(groupState, images) {
  if (!groupState || !Array.isArray(images) || !images.length) {
    return;
  }
  const manifest = groupState.manifest || [];
  images.forEach((item) => {
    if (!item || !item.path) {
      return;
    }
    const existing = manifest.find((entry) => entry && entry.path === item.path);
    if (existing) {
      return;
    }
    const normalized = {
      name: item.name || item.path.split("/").pop() || item.path,
      path: item.path,
      dateHint: item.dateHint || null,
      dateValue: typeof item.dateValue === "number" ? item.dateValue : null,
    };
    const index = manifest.length;
    manifest.push(normalized);
    groupState.manifest = manifest;
    groupState.images[index] = groupState.images[index] || null;
    state.pathToImage.set(normalized.path, { groupKey: groupState.key, index });
  });
  if (groupState.total) {
    groupState.total = Math.max(groupState.total, manifest.length);
  } else {
    groupState.total = manifest.length;
  }
  if (groupState.total > 0 && manifest.length >= groupState.total) {
    groupState.fullyLoaded = true;
    groupState.nextCursor = null;
  }
}

async function ensureGroupManifestCount(groupState, minCount = THUMBNAILS_PER_GROUP, options = {}) {
  if (!groupState || groupState.total === 0) {
    return;
  }
  if (!options.force && isGroupLoadingSuspended()) {
    return;
  }
  if (!state.imagesByGroup.has(groupState.key)) {
    state.imagesByGroup.set(groupState.key, []);
  }
  groupState.manifest = state.imagesByGroup.get(groupState.key) || [];
  const manifest = groupState.manifest;
  if (groupState.total > 0 && manifest.length >= groupState.total) {
    groupState.fullyLoaded = true;
    return;
  }
  const target = Math.min(groupState.total, Math.max(minCount, 0));

  while (manifest.length < target) {
    if (groupState.fullyLoaded) {
      break;
    }
    if (groupState.loading) {
      try {
        await groupState.loading;
      } catch (error) {
        console.error("Failed to load group images", error);
        break;
      }
      continue;
    }
    const fetchLimit = Math.max(THUMBNAILS_PER_GROUP, target - manifest.length);
    groupState.loading = fetchGroupImages(groupState.key, {
      limit: fetchLimit,
      cursor: groupState.nextCursor || undefined,
    })
      .then((data) => {
        const images = Array.isArray(data.images) ? data.images : [];
        appendGroupImages(groupState, images);
        state.imagesByGroup.set(groupState.key, groupState.manifest);
        groupState.nextCursor = data.nextCursor || null;
        if (!data.nextCursor) {
          groupState.fullyLoaded = true;
        }
      })
      .catch((error) => {
        console.error(`Failed to fetch images for group ${groupState.key}`, error);
        groupState.fullyLoaded = true;
      })
      .finally(() => {
        groupState.loading = null;
      });
    try {
      await groupState.loading;
    } catch (_error) {
      break;
    }
  }
}
function adjustGroupSelectedCount(groupKey, delta) {
  if (!groupKey) {
    return 0;
  }
  const current = state.download.perGroupCounts.get(groupKey) || 0;
  let next = current + delta;
  if (!Number.isFinite(next)) {
    next = 0;
  }
  next = Math.max(0, next);
  if (next === 0) {
    state.download.perGroupCounts.delete(groupKey);
  } else {
    state.download.perGroupCounts.set(groupKey, next);
  }
  const groupState = state.groups.get(groupKey);
  if (groupState) {
    groupState.selectedCount = next;
  }
  return next;
}

function updateGroupSelectionStatus(groupKey) {
  const groupState = state.groups.get(groupKey);
  if (!groupState) {
    return;
  }
  const count = state.download.perGroupCounts.get(groupKey) || 0;
  groupState.selectedCount = count;
  const fullySelected = count > 0 && count >= groupState.total;
  if (fullySelected) {
    state.download.groupSelections.add(groupKey);
  } else {
    state.download.groupSelections.delete(groupKey);
  }
  if (groupState.selectButton) {
    groupState.selectButton.classList.toggle("selected", fullySelected);
    groupState.selectButton.setAttribute("aria-pressed", fullySelected ? "true" : "false");
    if (!groupState.selectButton.disabled) {
      groupState.selectButton.textContent = fullySelected ? "Clear Selection" : "Select All";
    }
    groupState.selectButton.setAttribute(
      "aria-label",
      fullySelected ? "Clear selection for this group" : "Select all images in this group",
    );
  }
  if (groupState.container) {
    groupState.container.classList.toggle("group-selected", count > 0);
  }
  if (groupState.selectedCountElement) {
    if (count > 0) {
      groupState.selectedCountElement.hidden = false;
      groupState.selectedCountElement.textContent = `${count.toLocaleString()} selected`;
    } else {
      groupState.selectedCountElement.hidden = true;
      groupState.selectedCountElement.textContent = "";
    }
  }
}

function updateDownloadControls() {
  const selectedCount = state.download.items.size;
  if (elements.downloadCount) {
    if (selectedCount > 0) {
      elements.downloadCount.textContent = `${selectedCount.toLocaleString()} selected`;
      elements.downloadCount.hidden = false;
    } else {
      elements.downloadCount.hidden = true;
      elements.downloadCount.textContent = "";
    }
  }
  if (elements.downloadControls) {
    elements.downloadControls.classList.toggle("download-bar-hidden", selectedCount === 0);
  }
  if (elements.downloadButton) {
    elements.downloadButton.disabled = selectedCount === 0 || state.download.inProgress;
    elements.downloadButton.textContent = state.download.inProgress ? "Preparing…" : "Download";
  }
  if (elements.downloadClear) {
    elements.downloadClear.disabled = selectedCount === 0 || state.download.inProgress;
  }
}

function resetDownloadState() {
  state.download.items.clear();
  state.download.perGroupCounts.clear();
  state.download.groupSelections.clear();
  state.download.inProgress = false;
  document.querySelectorAll(".thumbnail-button.selected").forEach((button) => {
    setThumbnailSelectionState(button, false);
  });
  state.groups.forEach((groupState) => {
    if (!groupState) {
      return;
    }
    groupState.selectedCount = 0;
    if (groupState.container) {
      groupState.container.classList.remove("group-selected");
    }
    if (groupState.selectButton) {
      groupState.selectButton.classList.remove("selected");
      groupState.selectButton.setAttribute("aria-pressed", "false");
      if (!groupState.selectButton.disabled) {
        groupState.selectButton.textContent = "Select All";
      }
    }
    if (groupState.selectedCountElement) {
      groupState.selectedCountElement.hidden = true;
      groupState.selectedCountElement.textContent = "";
    }
  });
  updateDownloadControls();
}

function toggleImageSelection(path, groupKey, forceSelected, options = {}) {
  if (!path) {
    return false;
  }
  const normalizedPath = path;
  const currentlySelected = state.download.items.has(normalizedPath);
  const desiredState = typeof forceSelected === "boolean" ? forceSelected : !currentlySelected;
  if (currentlySelected === desiredState) {
    return false;
  }
  if (desiredState) {
    state.download.items.set(normalizedPath, groupKey);
    adjustGroupSelectedCount(groupKey, 1);
  } else {
    state.download.items.delete(normalizedPath);
    adjustGroupSelectedCount(groupKey, -1);
  }
  updateThumbnailSelectionVisual(normalizedPath, desiredState);
  if (!options.silent) {
    updateGroupSelectionStatus(groupKey);
    updateDownloadControls();
  }
  return true;
}

async function toggleGroupDownloadSelection(groupKey, desiredState) {
  if (state.download.inProgress) {
    return;
  }
  const groupState = state.groups.get(groupKey);
  if (!groupState) {
    return;
  }
  await ensureGroupManifestCount(groupState, groupState.total, { force: true });
  const manifest = Array.isArray(groupState.manifest) ? groupState.manifest : [];
  const paths = manifest.map((item) => (item && item.path ? item.path : null)).filter(Boolean);
  if (!paths.length) {
    return;
  }
  const currentlySelected = state.download.perGroupCounts.get(groupKey) || 0;
  const shouldSelect = typeof desiredState === "boolean" ? desiredState : currentlySelected < paths.length;
  let changed = false;
  paths.forEach((itemPath) => {
    if (toggleImageSelection(itemPath, groupKey, shouldSelect, { silent: true })) {
      changed = true;
    }
  });
  if (changed || !shouldSelect) {
    updateGroupSelectionStatus(groupKey);
    updateDownloadControls();
  }
}

function handleThumbnailClick(event, groupKey, index) {
  const button = event.currentTarget;
  if (!button) {
    return;
  }
  const flyoutVisible = Boolean(
    elements.header
      && !elements.header.classList.contains("collapsed")
      && !state.flyoutPinned,
  );
  if (Date.now() < state.suppressThumbnailOpenUntil) {
    consumeInteractionEvent(event);
    return;
  }
  if (flyoutVisible) {
    consumeInteractionEvent(event);
    suppressViewerOpen();
    closeControlPanel();
    return;
  }
  const path = button.dataset.path;
  const wantsSelection = (event.metaKey || event.ctrlKey) && path;
  if (wantsSelection) {
    event.preventDefault();
    event.stopPropagation();
    if (state.download.inProgress) {
      return;
    }
    toggleImageSelection(path, groupKey);
    return;
  }
  if (button.disabled) {
    event.preventDefault();
    return;
  }
  state.viewer.pendingBlend = 0;
  openViewerAt(groupKey, index);
}

function suppressViewerOpen(durationMs = 700) {
  state.suppressThumbnailOpenUntil = Date.now() + Math.max(0, durationMs);
}

function consumeInteractionEvent(event) {
  if (!event) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === "function") {
    event.stopImmediatePropagation();
  }
}

function clearDownloadSelection() {
  resetDownloadState();
}

function extractFilenameFromDisposition(header) {
  if (!header) {
    return null;
  }
  const filenameStarMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (filenameStarMatch && filenameStarMatch[1]) {
    try {
      return decodeURIComponent(filenameStarMatch[1]);
    } catch (_error) {
      // ignore decoding issues
    }
  }
  const filenameMatch = header.match(/filename="?([^";]+)"?/i);
  if (filenameMatch && filenameMatch[1]) {
    return filenameMatch[1];
  }
  return null;
}

async function initiateDownload() {
  const paths = Array.from(state.download.items.keys());
  if (!paths.length || state.download.inProgress) {
    return;
  }
  state.download.inProgress = true;
  updateDownloadControls();
  try {
    const response = await fetch("/api/download", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ paths }),
    });
    if (!response.ok) {
      let message = `Unable to download images (${response.status})`;
      try {
        const data = await response.json();
        if (data && data.error) {
          message = data.error;
        }
      } catch (_jsonError) {
        try {
          const text = await response.text();
          if (text) {
            message = text;
          }
        } catch (_textError) {
          // ignore secondary errors
        }
      }
      alert(message);
      return;
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition");
    const suggestedName = extractFilenameFromDisposition(disposition);
    const fallbackName = paths.length === 1 ? paths[0].split("/").pop() || "image" : "selected-images.zip";
    const filename = suggestedName || fallbackName;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    clearDownloadSelection();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    alert(`Unable to download images: ${message}`);
  } finally {
    state.download.inProgress = false;
    updateDownloadControls();
  }
}

function handleDownloadClearClick(event) {
  event.preventDefault();
  clearDownloadSelection();
}

async function handleDownloadButtonClick(event) {
  event.preventDefault();
  await initiateDownload();
}

function updateFlyoutPinUI() {
  if (!elements.flyoutPin) {
    return;
  }
  elements.flyoutPin.classList.toggle("active", state.flyoutPinned);
  elements.flyoutPin.setAttribute("aria-pressed", state.flyoutPinned ? "true" : "false");
  elements.flyoutPin.setAttribute(
    "aria-label",
    state.flyoutPinned ? "Unpin controls" : "Pin controls",
  );
  const textSpan = elements.flyoutPin.querySelector(".pin-text");
  if (textSpan) {
    textSpan.textContent = state.flyoutPinned ? "Pinned" : "Auto";
  }
}

function setFlyoutPinned(pinned) {
  const normalized = Boolean(pinned);
  if (state.flyoutPinned === normalized) {
    if (normalized) {
      setHeaderCollapsed(false);
      if (!state.controlOpen) {
        openControlPanel();
      }
    }
    updateFlyoutBackdropState();
    return;
  }
  state.flyoutPinned = normalized;
  updateFlyoutPinUI();
  if (normalized) {
    if (!state.controlOpen) {
      openControlPanel();
    }
    setHeaderCollapsed(false);
  } else if (!state.controlOpen && !headerHover) {
    setHeaderCollapsed(true);
  }
  updateFlyoutBackdropState();
}

function toggleFlyoutPin() {
  setFlyoutPinned(!state.flyoutPinned);
}

function parseDateToValue(dateString) {
  if (!dateString) {
    return null;
  }
  const normalized = dateString.trim();
  if (!normalized) {
    return null;
  }
  const replaced = normalized.replace(/[_.]/g, "-");
  const parts = replaced.split("-");
  if (parts.length === 3 && parts[0].length === 4) {
    const [yearRaw, monthRaw, dayRaw] = parts;
    const year = Number.parseInt(yearRaw, 10);
    const month = Number.parseInt(monthRaw, 10);
    const day = Number.parseInt(dayRaw, 10);
    if (
      Number.isInteger(year) &&
      Number.isInteger(month) &&
      Number.isInteger(day) &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31
    ) {
      return year * 10000 + month * 100 + day;
    }
  }
  const parsedDate = new Date(normalized);
  if (!Number.isNaN(parsedDate.getTime())) {
    return (
      parsedDate.getUTCFullYear() * 10000 +
      (parsedDate.getUTCMonth() + 1) * 100 +
      parsedDate.getUTCDate()
    );
  }
  const digits = normalized.replace(/\D/g, "");
  if (digits.length >= 8) {
    const year = Number.parseInt(digits.slice(0, 4), 10);
    const month = Number.parseInt(digits.slice(4, 6), 10);
    const day = Number.parseInt(digits.slice(6, 8), 10);
    if (
      Number.isInteger(year) &&
      Number.isInteger(month) &&
      Number.isInteger(day) &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31
    ) {
      return year * 10000 + month * 100 + day;
    }
  }
  return null;
}

function isDateLikeQuery(query) {
  if (!query) {
    return false;
  }
  const normalized = query.trim();
  if (!normalized) {
    return false;
  }
  if (parseDateToValue(normalized)) {
    return true;
  }
  return /^\d{4}$/.test(normalized);
}

function formatValueToDateString(value) {
  if (!Number.isInteger(value) || value <= 0) {
    return "";
  }
  const year = Math.floor(value / 10000);
  const month = Math.floor((value % 10000) / 100);
  const day = value % 100;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

function formatIsoDateFriendly(iso) {
  if (!iso) {
    return "";
  }
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatVectorResultLabel(result) {
  const dateValue = Number.isFinite(result.dateValue) ? Number(result.dateValue) : null;
  const iso = result.iso || (dateValue ? formatValueToDateString(dateValue) : "");
  const friendlyDate = iso ? formatIsoDateFriendly(iso) : "";
  const location = result.location && result.location.address
    ? Object.values(result.location.address)
      .filter((value) => typeof value === "string" && value.trim())
      .slice(0, 2)
      .join(", ")
    : "";
  const parts = [];
  if (friendlyDate) {
    parts.push(friendlyDate);
  }
  if (location) {
    parts.push(location);
  }
  return parts.join(" • ");
}

function createSpecificEntry(rawValue) {
  const raw = rawValue.trim();
  if (!raw) {
    return null;
  }
  if (/^\d{4}$/.test(raw)) {
    const year = Number.parseInt(raw, 10);
    if (year >= 0) {
      return {
        key: `year:${year}`,
        type: "year",
        year,
        label: `Year ${year}`,
        raw,
        text: String(year).toLowerCase(),
      };
    }
  }
  const dateValue = parseDateToValue(raw);
  if (dateValue) {
    const iso = formatValueToDateString(dateValue);
    return {
      key: `date:${iso}`,
      type: "date",
      iso,
      label: formatIsoDateFriendly(iso),
      text: iso.toLowerCase(),
      raw,
      dateValue,
    };
  }
  const text = raw.toLowerCase();
  return {
    key: `text:${text}`,
    type: "text",
    text,
    raw,
    label: raw,
  };
}

function normalizeRandomViewerFilters() {
  if (!state.randomViewer) {
    state.randomViewer = {
      enabled: false,
      running: false,
      timerId: null,
      duration: 10,
      blend: 1,
      lastPath: null,
      nextChoice: null,
      pool: [],
      queue: [],
      filter: {
        start: null,
        end: null,
        specificMap: new Map(),
        specificList: [],
      },
    };
  }
  const filter = state.randomViewer.filter || {
    start: null,
    end: null,
    specificMap: new Map(),
    specificList: [],
  };
  if (!(filter.specificMap instanceof Map)) {
    filter.specificMap = new Map();
  }
  const aggregate = [];
  if (Array.isArray(filter.specificList)) {
    aggregate.push(...filter.specificList);
  } else if (filter.specificList) {
    aggregate.push(filter.specificList);
  }
  filter.specificMap.forEach((entry) => aggregate.push(entry));

  const map = new Map();
  const normalized = [];
  aggregate.forEach((item) => {
    let entry = item;
    if (typeof entry === "string") {
      entry = createSpecificEntry(entry);
    } else if (entry && typeof entry === "object" && entry.key) {
      if (entry.type === "date" && entry.iso) {
        entry.label = formatIsoDateFriendly(entry.iso);
        entry.text = entry.text || entry.iso.toLowerCase();
        if (!entry.dateValue) {
          entry.dateValue = parseDateToValue(entry.iso);
        }
      } else if (entry.type === "year" && entry.year !== undefined) {
        entry.label = entry.label || `Year ${entry.year}`;
        entry.text = entry.text || String(entry.year).toLowerCase();
      } else if (entry.type === "text") {
        entry.text = entry.text || (entry.raw ? entry.raw.toLowerCase() : "");
        entry.label = entry.label || entry.raw || entry.text;
      }
      entry.raw = entry.raw || (entry.label || "");
    } else {
      entry = createSpecificEntry(String(item));
    }
    if (entry && entry.key && !map.has(entry.key)) {
      map.set(entry.key, entry);
      normalized.push(entry);
    }
  });

  normalized.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  filter.specificMap = map;
  filter.specificList = normalized;
  state.randomViewer.filter = filter;
  return filter;
}

function deriveDateValueFromItem(item) {
  if (!item) {
    return null;
  }
  const candidates = [];
  if (typeof item.dateHint === "string") {
    candidates.push(item.dateHint);
  }
  if (typeof item.path === "string") {
    const segments = item.path.split("/");
    segments.forEach((segment) => candidates.push(segment));
    candidates.push(item.path);
  }
  if (typeof item.name === "string") {
    candidates.push(item.name);
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const value = parseDateToValue(candidate);
    if (value) {
      return value;
    }
  }
  return null;
}

function clearRandomViewerTimer() {
  if (state.randomViewer.timerId) {
    clearTimeout(state.randomViewer.timerId);
    state.randomViewer.timerId = null;
  }
}

function prepareViewerTransition(blendDuration) {
  if (!elements.viewerImage || !elements.viewerImageOverlay) {
    return;
  }
  const overlay = elements.viewerImageOverlay;
  const main = elements.viewerImage;
  if (blendDuration > 0 && main.src) {
    overlay.src = main.src;
    overlay.alt = main.alt || "";
    overlay.style.transition = "";
    overlay.style.opacity = "1";
    overlay.hidden = false;
  } else {
    overlay.style.opacity = "0";
    overlay.hidden = true;
  }
  main.style.transition = "";
}

function setViewerNavDisabled(disabled) {
  if (elements.viewerPrev) {
    elements.viewerPrev.disabled = Boolean(disabled);
    elements.viewerPrev.classList.toggle("disabled", Boolean(disabled));
    elements.viewerPrev.tabIndex = disabled ? -1 : 0;
  }
  if (elements.viewerNext) {
    elements.viewerNext.disabled = Boolean(disabled);
    elements.viewerNext.classList.toggle("disabled", Boolean(disabled));
    elements.viewerNext.tabIndex = disabled ? -1 : 0;
  }
}

function displayRandomViewerImage(choice) {
  if (!choice || !choice.path) {
    return;
  }
  const blendDuration = Math.max(0, Number(state.viewer.pendingBlend) || 0);
  state.viewer.pendingBlend = 0;
  state.viewer.open = true;
  state.viewer.mode = "random";
  state.viewer.groupKey = null;
  state.viewer.index = -1;
  state.viewer.detailsPath = choice.path;
  elements.viewerOverlay.hidden = false;
  document.body.classList.add("viewer-open");
  if (elements.header) {
    elements.header.classList.add("viewer-hidden");
  }
  prepareViewerTransition(blendDuration);
  showViewerLoading(blendDuration);
  setViewerNavDisabled(true);
  updateUrlWithImage(choice.path);

  const item = {
    path: choice.path,
    name: choice.name || (choice.path.split("/").pop() || choice.path),
    dateHint: choice.isoValue || choice.dateHint || "",
  };

  updateViewerDetails(item);

  const mainImage = elements.viewerImage;
  const overlayImage = elements.viewerImageOverlay;
  const finalize = () => {
    updateViewerMetadata(null, item);
    highlightActiveThumbnail(null);
    if (mainImage) {
      if (blendDuration > 0 && overlayImage && overlayImage.src) {
        overlayImage.style.transition = `opacity ${blendDuration}s ease`;
        overlayImage.hidden = false;
        requestAnimationFrame(() => {
          mainImage.style.opacity = "1";
          overlayImage.style.opacity = "0";
        });
        setTimeout(() => {
          overlayImage.style.transition = "";
          overlayImage.style.opacity = "0";
          overlayImage.hidden = true;
          mainImage.style.transition = "";
        }, blendDuration * 1000 + 60);
      } else {
        requestAnimationFrame(() => {
          mainImage.style.opacity = "1";
        });
        if (overlayImage) {
          overlayImage.style.opacity = "0";
          overlayImage.hidden = true;
        }
        mainImage.style.transition = "";
      }
      mainImage.removeEventListener("load", finalize);
      mainImage.removeEventListener("error", handleError);
    }
  };
  const handleError = () => {
    setInfoBar(elements.viewerInfoTop, "Failed to load image", "block");
    setInfoBar(elements.viewerInfoBottom, item.name || "", item.name ? "block" : "none");
    setInfoBar(elements.viewerInfoLeft, "", "block");
    setInfoBar(elements.viewerInfoRight, "", "block");
    updateViewerDetails(null);
    if (overlayImage) {
      overlayImage.style.opacity = "0";
      overlayImage.hidden = true;
    }
    if (mainImage) {
      mainImage.style.opacity = "1";
      mainImage.removeEventListener("load", finalize);
      mainImage.removeEventListener("error", handleError);
    }
  };

  if (mainImage) {
    mainImage.addEventListener("load", finalize);
    mainImage.addEventListener("error", handleError);
    mainImage.src = `/api/image?path=${encodeURIComponent(choice.path)}`;
    mainImage.alt = item.name || "";
  }
}

function stopRandomViewer({ resetToggle = true } = {}) {
  clearRandomViewerTimer();
  state.randomViewer.running = false;
  state.randomViewer.enabled = false;
  state.randomViewer.lastPath = null;
  state.randomViewer.pool = [];
  state.randomViewer.queue = [];
  state.randomViewer.nextChoice = null;
  if (resetToggle && elements.randomViewerToggle) {
    elements.randomViewerToggle.checked = false;
  }
  if (state.viewer.mode === "group") {
    setViewerNavDisabled(false);
  }
  state.viewer.pendingBlend = 0;
  if (elements.viewerImageOverlay) {
    elements.viewerImageOverlay.style.opacity = "0";
    elements.viewerImageOverlay.hidden = true;
  }
  updateRandomViewerSettingsAvailability();
}

function updateRandomViewerSettingsAvailability() {
  if (!elements.randomViewerSettings) {
    return;
  }
  normalizeRandomViewerFilters();
  elements.randomViewerSettings.removeAttribute("aria-hidden");
  if (elements.randomViewerSection) {
    elements.randomViewerSection.classList.toggle("random-viewer-active", state.randomViewer.running);
  }
  if (elements.randomViewerDuration) {
    elements.randomViewerDuration.value = String(state.randomViewer.duration);
  }
  if (elements.randomViewerBlend) {
    elements.randomViewerBlend.value = String(state.randomViewer.blend);
  }
}

async function buildRandomViewerPool() {
  const filter = normalizeRandomViewerFilters();
  const specificEntries = filter.specificList || [];
  const hasSpecific = specificEntries.length > 0;
  const hasRange = filter.start !== null || filter.end !== null;

  const mapToPoolEntry = (item) => {
    if (!item || !item.path) {
      return null;
    }
    const fallbackName = item.path.split("/").pop() || item.path;
    let dateValue = Number.isFinite(item.dateValue) ? Number(item.dateValue) : null;
    if (!dateValue && item.iso) {
      dateValue = parseDateToValue(item.iso);
    }
    if (!dateValue && item.dateHint) {
      dateValue = parseDateToValue(item.dateHint);
    }
    const isoValue = item.iso || (dateValue ? formatValueToDateString(dateValue) : null);
    return {
      path: item.path,
      name: item.name || fallbackName,
      dateValue: Number.isFinite(dateValue) ? dateValue : null,
      isoValue,
      dateHint: item.dateHint || isoValue || null,
      groupKey: item.groupKey || deriveGroupKey(item.path),
    };
  };

  const collectFromFilters = async () => {
    try {
      const images = await fetchImagesByFilters({
        dateEntries: specificEntries,
        startValue: filter.start,
        endValue: filter.end,
      });
      const seen = new Set();
      return images
        .map(mapToPoolEntry)
        .filter((entry) => {
          if (!entry || !entry.path) {
            return false;
          }
          if (seen.has(entry.path)) {
            return false;
          }
          seen.add(entry.path);
          if (!hasRange) {
            return true;
          }
          if (filter.start !== null && entry.dateValue !== null && entry.dateValue < filter.start) {
            return false;
          }
          if (filter.end !== null && entry.dateValue !== null && entry.dateValue > filter.end) {
            return false;
          }
          return true;
        });
    } catch (error) {
      console.error("Failed to fetch images by filters", error);
      return [];
    }
  };

  const collectFromRandomPool = async () => {
    try {
      const params = new URLSearchParams({
        order: state.order,
        limit: String(RANDOM_POOL_LIMIT),
      });
      if (filter.start !== null) {
        params.set("start", String(filter.start));
      }
      if (filter.end !== null) {
        params.set("end", String(filter.end));
      }
      const data = await fetchJson(`/api/random-pool?${params.toString()}`);
      const images = Array.isArray(data.images) ? data.images : [];
      const seen = new Set();
      return images
        .map(mapToPoolEntry)
        .filter((entry) => {
          if (!entry || !entry.path) {
            return false;
          }
          if (seen.has(entry.path)) {
            return false;
          }
          seen.add(entry.path);
          return true;
        });
    } catch (error) {
      console.error("Failed to fetch random image pool", error);
      return [];
    }
  };

  let pool = [];
  if (hasSpecific || hasRange) {
    pool = await collectFromFilters();
  }
  if (!pool.length) {
    pool = await collectFromRandomPool();
  }

  const matchesRange = (entry) => {
    if (!entry || entry.dateValue === null) {
      return false;
    }
    if (filter.start !== null && entry.dateValue < filter.start) {
      return false;
    }
    if (filter.end !== null && entry.dateValue > filter.end) {
      return false;
    }
    return true;
  };

  const matchesSpecificEntry = (entry, spec) => {
    if (!entry || !spec) {
      return false;
    }
    if (spec.type === "date" && spec.iso) {
      const isoLower = spec.iso.toLowerCase();
      const entryIso = entry.isoValue ? entry.isoValue.toLowerCase() : "";
      return entryIso === isoLower;
    }
    if (spec.type === "year" && Number.isFinite(spec.year)) {
      if (!Number.isFinite(entry.dateValue)) {
        return false;
      }
      return Math.floor(entry.dateValue / 10000) === Number(spec.year);
    }
    if (spec.type === "text") {
      const needle = (spec.text || "").toLowerCase();
      if (!needle) {
        return false;
      }
      const haystacks = [
        entry.name,
        entry.path,
        entry.isoValue,
        entry.dateHint,
      ]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());
      return haystacks.some((value) => value.includes(needle));
    }
    return false;
  };

  if (pool.length && (hasSpecific || hasRange)) {
    pool = pool.filter((entry) => {
      const inRange = !hasRange || matchesRange(entry);
      if (!hasSpecific) {
        return inRange;
      }
      const specificMatch = specificEntries.some((spec) => matchesSpecificEntry(entry, spec));
      return specificMatch || (hasRange ? inRange : false);
    });
  }

  state.randomViewer.pool = pool;
  return pool;
}

async function refreshRandomViewerPool() {
  state.randomViewer.nextChoice = null;
  const pool = await buildRandomViewerPool();
  rebuildRandomViewerQueue(state.randomViewer.lastPath);
  return pool;
}

function scheduleRandomViewerTick() {
  clearRandomViewerTimer();
  if (!state.randomViewer.running) {
    return;
  }
  const waitSeconds = Math.max(1, Number(state.randomViewer.duration) || 1) + Math.max(0, Number(state.randomViewer.blend) || 0);
  state.randomViewer.timerId = setTimeout(() => {
    runRandomViewerCycle();
  }, waitSeconds * 1000);
}

function rebuildRandomViewerQueue(excludePath = null) {
  const pool = state.randomViewer.pool || [];
  if (!Array.isArray(pool) || !pool.length) {
    state.randomViewer.queue = [];
    return;
  }
  const items = shuffleArray(pool.slice());
  if (excludePath && items.length > 1 && items[0].path === excludePath) {
    const alternateIndex = items.findIndex((entry) => entry.path !== excludePath);
    if (alternateIndex > 0) {
      const [alternate] = items.splice(alternateIndex, 1);
      items.unshift(alternate);
    }
  }
  state.randomViewer.queue = items;
}

function drawNextRandomEntry(excludePath = null) {
  let queue = state.randomViewer.queue || [];
  if (!queue.length) {
    rebuildRandomViewerQueue(excludePath);
    queue = state.randomViewer.queue || [];
  }
  if (!queue.length) {
    return null;
  }
  let entry = queue.shift();
  if (excludePath && entry && entry.path === excludePath && queue.length) {
    queue.push(entry);
    entry = queue.shift();
  }
  state.randomViewer.queue = queue;
  if (!entry) {
    return null;
  }
  return { ...entry };
}

function preloadRandomChoice(excludePath = null) {
  const choice = drawNextRandomEntry(excludePath);
  if (!choice) {
    state.randomViewer.nextChoice = null;
    return null;
  }
  const src = `/api/image?path=${encodeURIComponent(choice.path)}`;
  const preloader = new Image();
  const ready = new Promise((resolve, reject) => {
    preloader.onload = () => resolve(preloader);
    preloader.onerror = reject;
  });
  preloader.src = src;
  ready.catch(() => {});
  choice.src = src;
  choice.preloader = preloader;
  choice.ready = ready;
  state.randomViewer.nextChoice = choice;
  return choice;
}

async function runRandomViewerCycle() {
  if (!state.randomViewer.running) {
    return;
  }
  if (!state.randomViewer.pool.length) {
    let pool;
    try {
      pool = await refreshRandomViewerPool();
    } catch (error) {
      console.error("Failed to refresh random viewer pool", error);
      stopRandomViewer();
      return;
    }
    if (!pool.length) {
      alert("No images match the current random viewer filters.");
      stopRandomViewer();
      return;
    }
  }
  let choice = state.randomViewer.nextChoice;
  if (!choice) {
    choice = preloadRandomChoice(state.randomViewer.lastPath);
  }
  state.randomViewer.nextChoice = null;
  if (!choice) {
    stopRandomViewer();
    return;
  }
  if (choice.ready) {
    choice.ready.catch((error) => {
      console.warn("Random viewer preload failed", error);
    });
  }
  if (!state.randomViewer.running) {
    return;
  }
  try {
    state.viewer.pendingBlend = state.randomViewer.blend;
    displayRandomViewerImage(choice);
    state.randomViewer.lastPath = choice.path;
  } catch (error) {
    console.error("Random viewer failed to open image", error);
  }

  if (state.randomViewer.running) {
    preloadRandomChoice(choice.path);
    scheduleRandomViewerTick();
  }
}

async function startRandomViewer() {
  normalizeRandomViewerFilters();
  if (elements.randomViewerDuration) {
    const currentValue = Number.parseInt(elements.randomViewerDuration.value, 10);
    if (Number.isFinite(currentValue) && currentValue >= 1) {
      state.randomViewer.duration = currentValue;
    }
  }
  if (elements.randomViewerBlend) {
    const blendValue = Number.parseFloat(elements.randomViewerBlend.value);
    if (Number.isFinite(blendValue) && blendValue >= 0) {
      state.randomViewer.blend = blendValue;
    }
  }
  if (state.flyoutPinned) {
    setFlyoutPinned(false);
  }
  if (state.controlOpen) {
    closeControlPanel();
  }
  let pool;
  try {
    pool = await refreshRandomViewerPool();
  } catch (error) {
    console.error("Failed to build random viewer pool", error);
    alert("Unable to prepare the random viewer just yet.");
    stopRandomViewer({ resetToggle: true });
    return;
  }
  if (!pool.length) {
    alert("No images match the current filters for the random viewer.");
    stopRandomViewer({ resetToggle: true });
    return;
  }
  state.randomViewer.enabled = true;
  state.randomViewer.running = true;
  state.randomViewer.lastPath = null;
  rebuildRandomViewerQueue(null);
  preloadRandomChoice(null);
  updateRandomViewerSettingsAvailability();
  setViewerNavDisabled(true);
  runRandomViewerCycle();
}

function handleRandomViewerToggle(event) {
  const enabled = Boolean(event.target.checked);
  if (enabled) {
    startRandomViewer().catch((error) => console.error(error));
  } else {
    stopRandomViewer({ resetToggle: false });
  }
}

function updateRandomViewerDuration(event) {
  const value = Number.parseInt(event.target.value, 10);
  if (!Number.isFinite(value) || value < 1) {
    return;
  }
  state.randomViewer.duration = value;
  if (state.randomViewer.running) {
    scheduleRandomViewerTick();
  }
}

async function updateRandomViewerRange() {
  let startValue = parseDateToValue(elements.randomViewerStart ? elements.randomViewerStart.value : "");
  let endValue = parseDateToValue(elements.randomViewerEnd ? elements.randomViewerEnd.value : "");
  if (startValue && endValue && endValue < startValue) {
    const temp = startValue;
    startValue = endValue;
    endValue = temp;
    if (elements.randomViewerStart) {
      elements.randomViewerStart.value = formatValueToDateString(startValue);
    }
    if (elements.randomViewerEnd) {
      elements.randomViewerEnd.value = formatValueToDateString(endValue);
    }
  }
  state.randomViewer.filter.start = startValue;
  state.randomViewer.filter.end = endValue;
  if (state.randomViewer.running) {
    try {
      await refreshRandomViewerPool();
    } catch (error) {
      console.error("Failed to refresh random viewer pool", error);
      return;
    }
    preloadRandomChoice(state.randomViewer.lastPath);
    scheduleRandomViewerTick();
  } else {
    state.randomViewer.pool = [];
    state.randomViewer.queue = [];
    state.randomViewer.nextChoice = null;
  }
}

function renderRandomViewerChips() {
  if (!elements.randomViewerDateChips) {
    return;
  }
  const filter = normalizeRandomViewerFilters();
  const container = elements.randomViewerDateChips;
  container.innerHTML = "";
  const list = filter.specificList || [];
  if (!list.length) {
    return;
  }
  list.forEach((entry) => {
    if (!entry) {
      return;
    }
    const wrapper = document.createElement("span");
    wrapper.className = "date-chip";
    wrapper.dataset.value = entry.key;
    const label = document.createElement("span");
    label.textContent = entry.label;
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.setAttribute("aria-label", `Remove ${label.textContent}`);
    removeButton.textContent = "×";
    removeButton.addEventListener("click", () => {
      removeRandomViewerSpecificDate(entry.key);
    });
    wrapper.append(label, removeButton);
    container.appendChild(wrapper);
  });
}

async function removeRandomViewerSpecificDate(key) {
  const filter = normalizeRandomViewerFilters();
  if (!filter || !filter.specificMap) {
    return;
  }
  if (!filter.specificMap.has(key)) {
    return;
  }
  filter.specificMap.delete(key);
  filter.specificList = filter.specificList.filter((entry) => entry && entry.key !== key);
  renderRandomViewerChips();
  if (state.randomViewer.running) {
    try {
      await refreshRandomViewerPool();
    } catch (error) {
      console.error("Failed to refresh random viewer pool", error);
      return;
    }
    preloadRandomChoice(state.randomViewer.lastPath);
    scheduleRandomViewerTick();
  } else {
    state.randomViewer.pool = [];
    state.randomViewer.queue = [];
    state.randomViewer.nextChoice = null;
  }
}

async function addRandomViewerSpecificDate() {
  const input = elements.randomViewerSpecificInput;
  if (!input) {
    return;
  }
  const raw = input.value.trim();
  if (!raw) {
    return;
  }
  const entry = createSpecificEntry(raw);
  if (!entry) {
    alert("Please enter a valid value (date, year, or text).");
    return;
  }
  let entriesToAdd = [entry];
  if (entry.type === "text") {
    try {
      const holidayMatches = await fetchHolidayDates([entry.raw || entry.text || raw]);
      if (holidayMatches.length) {
        const unique = new Map();
        holidayMatches.forEach((match) => {
          if (!match || !match.iso) {
            return;
          }
          const iso = match.iso;
          const isoLower = iso.toLowerCase();
          if (!unique.has(isoLower)) {
            const labelName = Array.isArray(match.names) && match.names.length
              ? match.names[0]
              : match.name || raw;
            const friendly = match.friendly || formatIsoDateFriendly(iso);
            unique.set(isoLower, {
              key: `date:${iso}`,
              type: "date",
              iso,
              dateValue: match.dateValue || parseDateToValue(iso),
              label: labelName ? `${labelName} (${friendly})` : friendly,
              text: isoLower,
              raw: labelName || friendly,
              holidayNames: Array.isArray(match.names) && match.names.length ? match.names : (match.name ? [match.name] : []),
            });
          }
        });
        const expanded = Array.from(unique.values());
        if (expanded.length) {
          entriesToAdd = expanded;
        }
      }
    } catch (error) {
      console.error("Failed to expand holiday name", error);
    }
  }

  const filter = normalizeRandomViewerFilters();
  let added = false;
  entriesToAdd.forEach((item) => {
    if (!item || !item.key) {
      return;
    }
    if (filter.specificMap.has(item.key)) {
      return;
    }
    filter.specificMap.set(item.key, item);
    filter.specificList.push(item);
    added = true;
  });
  if (!added) {
    input.value = "";
    return;
  }
  filter.specificList.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  input.value = "";
  renderRandomViewerChips();
  if (state.randomViewer.running) {
    try {
      await refreshRandomViewerPool();
    } catch (error) {
      console.error("Failed to refresh random viewer pool", error);
      return;
    }
    preloadRandomChoice(state.randomViewer.lastPath);
    scheduleRandomViewerTick();
  } else {
    state.randomViewer.pool = [];
    state.randomViewer.queue = [];
    state.randomViewer.nextChoice = null;
  }
}

function selectComboboxOption(option) {
  if (!option) {
    return;
  }
  elements.searchInput.value = option.label;
  navigateToTopGroup(option.key);
  closeCombobox();
  elements.searchResults.innerHTML = "";
  elements.searchInput.focus();
}

function moveComboboxHighlight(direction) {
  if (!state.combobox.open) {
    openCombobox();
  }
  const options = state.combobox.filtered;
  if (!options.length) {
    return;
  }
  let index = state.combobox.activeIndex;
  if (index === -1) {
    index = direction > 0 ? 0 : options.length - 1;
  } else {
    index = (index + direction + options.length) % options.length;
  }
  state.combobox.activeIndex = index;
  renderComboboxOptions();
}

function handleSearchInputFocus() {
  if (!state.topGroupOptions.length) {
    return;
  }
  openCombobox();
}

function handleSearchInputInput(event) {
  if (!state.topGroupOptions.length) {
    return;
  }
  if (!state.combobox.open) {
    openCombobox();
  }
  filterComboboxOptions(event.target.value);
}

function handleSearchInputKeyDown(event) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveComboboxHighlight(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveComboboxHighlight(-1);
  } else if (event.key === "Enter") {
    if (state.combobox.open && state.combobox.activeIndex >= 0) {
      event.preventDefault();
      const option = state.combobox.filtered[state.combobox.activeIndex];
      selectComboboxOption(option);
    } else {
      closeCombobox();
    }
  } else if (event.key === "Escape") {
    if (state.combobox.open) {
      event.preventDefault();
      closeCombobox();
    }
  } else if (event.key === "Tab") {
    closeCombobox();
  }
}

let comboboxBlurTimeout = null;

function handleSearchInputBlur() {
  comboboxBlurTimeout = setTimeout(() => {
    closeCombobox();
  }, 120);
}

function handleSuggestionMouseDown(event) {
  event.preventDefault();
  if (comboboxBlurTimeout) {
    clearTimeout(comboboxBlurTimeout);
    comboboxBlurTimeout = null;
  }
}

function handleDocumentClick(event) {
  if (!elements.searchCombobox) {
    return;
  }
  if (!elements.searchCombobox.contains(event.target)) {
    closeCombobox();
  }
}


function openControlPanel() {
  if (!elements.header || !elements.controlContent) {
    return;
  }
  elements.header.classList.remove("viewer-hidden");
  if (state.controlOpen) {
    elements.controlContent.setAttribute("aria-hidden", "false");
    if (!state.flyoutPinned) {
      setHeaderCollapsed(false);
    }
    if (!state.flyoutPinned) {
      ensureFlyoutBackdrop();
    } else {
      removeFlyoutBackdrop();
    }
    return;
  }
  state.controlOpen = true;
  setHeaderCollapsed(false);
  elements.controlContent.setAttribute("aria-hidden", "false");
  if (!state.flyoutPinned) {
    ensureFlyoutBackdrop();
  } else {
    removeFlyoutBackdrop();
  }
  document.addEventListener("mousemove", (event) => {
  if (state.controlOpen || headerHover) {
    return;
  }
  if (event.clientY <= 18) {
    setHeaderCollapsed(false);
  } else {
    setHeaderCollapsed(true);
  }
});

document.addEventListener("touchstart", (event) => {
  if (!event.touches || !event.touches.length) {
    return;
  }
  if (event.touches[0].clientY <= 40) {
    setHeaderCollapsed(false);
  }
});

  if (elements.searchInput) {
    setTimeout(() => elements.searchInput.focus(), 0);
  }
  if (elements.searchResults && elements.searchResults.children.length === 0) {
    const entry = state.searchHistory.items[state.searchHistory.cursor];
    if (entry && (!elements.searchInput || !elements.searchInput.value)) {
      applySearchHistoryIndex(state.searchHistory.cursor);
    }
  }
}

function closeControlPanel() {
  if (!state.controlOpen || !elements.header || !elements.controlContent) {
    return;
  }
  if (state.flyoutPinned) {
    return;
  }
  if (shouldUseFlyoutBackdrop()) {
    suppressViewerOpen(1200);
  }
  state.controlOpen = false;
  setHeaderCollapsed(!headerHover);
  removeFlyoutBackdrop();
  if (state.viewer.open && !headerHover) {
    elements.header.classList.add("viewer-hidden");
  }
  elements.controlContent.setAttribute("aria-hidden", "true");
  if (elements.searchInput) {
    elements.searchInput.value = "";
  }
  if (elements.searchResults) {
    elements.searchResults.innerHTML = "";
  }
}

function updateOrderUI() {
  if (!elements.orderSwitch) {
    return;
  }
  elements.orderSwitch.classList.toggle("asc", state.order === "asc");
  if (Array.isArray(elements.orderButtons)) {
    elements.orderButtons.forEach((button) => {
      const buttonOrder = button.dataset.order === "asc" ? "asc" : "desc";
      const isActive = buttonOrder === state.order;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
      button.tabIndex = isActive ? 0 : -1;
    });
  }
}

function resetStateForOrder() {
  resetDownloadState();
  stopRandomViewer({ resetToggle: true });
  state.groups.clear();
  state.groupSequence = [];
  state.groupIndexMap.clear();
  state.imagesByGroup = new Map();
  state.pathToImage = new Map();
  state.topGroups = [];
  state.topGroupIndex = 0;
  state.topGroupStatus = new Map();
  state.topGroupOptions = [];
  state.combobox = {
    open: false,
    activeIndex: -1,
    filtered: [],
  };
  state.viewer = {
    open: false,
    groupKey: null,
    index: -1,
    pendingBlend: 0,
    detailsOpen: false,
    detailsPath: null,
    detailsLoading: false,
    detailsRequestToken: null,
  };
  state.randomViewer.filter = {
    start: null,
    end: null,
    specificMap: new Map(),
    specificList: [],
  };
  elements.timelineSections.innerHTML = "";
  if (elements.searchSuggestions) {
    elements.searchSuggestions.hidden = true;
    elements.searchSuggestions.innerHTML = "";
  }
  if (elements.yearNavigationButtons) {
    elements.yearNavigationButtons.innerHTML = "";
  }
  if (elements.yearNavigationSelect) {
    elements.yearNavigationSelect.innerHTML = "";
  }
  if (elements.yearNavigation) {
    elements.yearNavigation.hidden = true;
  }
  setActiveControlTab(state.activeControlTab);
  renderRandomViewerChips();
  updateRandomViewerSettingsAvailability();
  if (elements.searchCombobox) {
    elements.searchCombobox.setAttribute("aria-expanded", "false");
  }
  if (imageObserver) {
    imageObserver.disconnect();
    imageObserver = null;
  }
}

function deriveGroupKey(path) {
  const parts = path.split("/");
  if (parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

async function fetchHierarchy() {
  setGlobalLoaderVisible(true);
  try {
    const data = await fetchJson(`/api/groups?order=${state.order}`);
    resetStateForOrder();
    state.databaseMode = Boolean(data.database);
    state.topGroups = Array.isArray(data.groups) ? data.groups : [];
    buildTopGroupOptions(state.topGroups);
    renderNextTopGroups(GROUP_BATCH_SIZE);
  } catch (error) {
    console.error(error);
    alert(`Unable to load hierarchy: ${error.message}`);
  } finally {
    setGlobalLoaderVisible(false);
  }
}

function renderNextTopGroups(limit = GROUP_BATCH_SIZE) {
  if (!elements.timelineSections || !state.topGroups.length) {
    return;
  }
  const fragment = document.createDocumentFragment();
  let appended = 0;
  while (state.topGroupIndex < state.topGroups.length && appended < limit) {
    const topGroup = state.topGroups[state.topGroupIndex];
    const section = buildTopGroup(topGroup);
    fragment.appendChild(section);
    state.topGroupIndex += 1;
    appended += 1;
  }
  if (fragment.childNodes.length) {
    elements.timelineSections.appendChild(fragment);
    updateGroupIndexMap();
    scheduleViewportLoading();
  }
}

function buildTopGroup(topGroup) {
  const section = document.createElement("section");
  section.className = "top-group";
  section.dataset.topKey = topGroup.key;

  const heading = document.createElement("h2");
  heading.textContent = topGroup.formattedLabel || topGroup.label;
  section.appendChild(heading);

  const subgroups = Array.isArray(topGroup.subgroups) ? topGroup.subgroups : [];
  const meta = {
    key: topGroup.key,
    topGroup,
    subgroups,
    rendered: 0,
    section,
  };
  state.topGroupStatus.set(topGroup.key, meta);
  renderNextSubgroups(meta, SUBGROUP_BATCH_SIZE);

  return section;
}

function renderNextSubgroups(meta, batchSize = SUBGROUP_BATCH_SIZE) {
  if (!meta || !meta.subgroups || !meta.subgroups.length) {
    return;
  }
  const { subgroups, topGroup, section } = meta;
  const shouldUpdateImmediately = section.isConnected;
  let appended = 0;
  while (meta.rendered < subgroups.length && appended < batchSize) {
    const subgroup = subgroups[meta.rendered];
    const subgroupEntry = createSubgroup(topGroup, subgroup);
    section.appendChild(subgroupEntry.container);
    meta.rendered += 1;
    appended += 1;
  }
  if (appended > 0 && shouldUpdateImmediately) {
    updateGroupIndexMap();
    scheduleViewportLoading();
  }
}

function createSubgroup(topGroup, subgroup) {
  const container = document.createElement("section");
  container.className = "subgroup-section";
  container.dataset.groupKey = subgroup.key;

  let manifest = state.imagesByGroup.get(subgroup.key);
  if (!manifest) {
    manifest = [];
    state.imagesByGroup.set(subgroup.key, manifest);
  }
  const totalCount = typeof subgroup.count === "number" ? subgroup.count : manifest.length;

  if (totalCount > 0) {
    container.classList.add("pending-hydration");
  }

  const displayLabel = subgroup.formattedLabel || subgroup.label;

  const header = document.createElement("div");
  header.className = "subgroup-header";

  const headingText = document.createElement("div");
  headingText.className = "subgroup-heading-text";

  const title = document.createElement("h3");
  title.className = "subgroup-title";
  title.textContent = displayLabel;
  headingText.appendChild(title);

  const metaRow = document.createElement("div");
  metaRow.className = "subgroup-meta";

  const countLabel = document.createElement("span");
  countLabel.className = "subgroup-count";
  countLabel.textContent = formatPhotoCount(totalCount);
  metaRow.appendChild(countLabel);

  let locationElement = null;
  if (subgroup.location) {
    locationElement = document.createElement("span");
    locationElement.className = "subgroup-location";
    locationElement.textContent = subgroup.location;
  }

  const selectedCountElement = document.createElement("span");
  selectedCountElement.className = "subgroup-selected-count";
  selectedCountElement.hidden = true;
  metaRow.appendChild(selectedCountElement);

  const selectButton = document.createElement("button");
  selectButton.type = "button";
  selectButton.className = "group-select-toggle";
  selectButton.dataset.groupKey = subgroup.key;
  selectButton.setAttribute("aria-pressed", "false");
  if (totalCount === 0) {
    selectButton.textContent = "No photos";
    selectButton.disabled = true;
  } else {
    selectButton.textContent = "Select All";
  }
  metaRow.appendChild(selectButton);
  if (locationElement) {
    metaRow.appendChild(locationElement);
  }

  headingText.appendChild(metaRow);
  header.appendChild(headingText);

  container.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "thumb-grid";
  container.appendChild(grid);

  const existingSelected = state.download.perGroupCounts.get(subgroup.key) || 0;

  const groupState = {
    key: subgroup.key,
    label: subgroup.label,
    displayLabel,
    topKey: topGroup.key,
    topLabel: topGroup.label,
    location: subgroup.location || null,
    count: totalCount,
    total: totalCount,
    dateValue: subgroup.dateValue || 0,
    container,
    header,
    selectButton: totalCount > 0 ? selectButton : null,
    selectedCountElement,
    countLabel,
    locationElement,
    grid,
    manifest,
    images: [],
    renderedCount: 0,
    pendingHydration: totalCount > 0,
    selectedCount: existingSelected,
    nextCursor: null,
    loading: null,
    fullyLoaded: manifest.length >= totalCount && totalCount > 0,
  };

  state.groups.set(subgroup.key, groupState);
  state.groupSequence.push(subgroup.key);

  if (groupState.selectButton) {
    groupState.selectButton.addEventListener("click", async () => {
      try {
        await toggleGroupDownloadSelection(groupState.key);
      } catch (error) {
        console.error(`Failed to toggle selection for group ${groupState.key}`, error);
      }
    });
  }

  updateGroupSelectionStatus(groupState.key);

  return groupState;
}

function updateGroupIndexMap() {
  state.groupIndexMap.clear();
  state.groupSequence.forEach((key, index) => {
    state.groupIndexMap.set(key, index);
  });
}

function renderNextThumbnails(groupState, batchSize = THUMBNAILS_PER_GROUP) {
  if (!groupState) {
    return;
  }
  groupState.manifest = state.imagesByGroup.get(groupState.key) || groupState.manifest || [];
  const manifest = groupState.manifest;
  if (!Array.isArray(manifest) || !manifest.length) {
    return;
  }
  const startIndex = groupState.renderedCount || 0;
  const total = manifest.length;
  if (startIndex >= total) {
    return;
  }
  const endIndex = Math.min(total, startIndex + batchSize);
  const fragment = document.createDocumentFragment();

  for (let index = startIndex; index < endIndex; index += 1) {
    const meta = manifest[index] || {};
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thumbnail-button placeholder";
    button.classList.add("downloadable");
    button.disabled = true;
    button.tabIndex = -1;
    button.setAttribute("aria-hidden", "true");
    button.setAttribute("aria-checked", "false");
    button.dataset.groupKey = groupState.key;
    button.dataset.index = String(index);
    if (meta.path) {
      button.dataset.path = meta.path;
    }

    button.addEventListener("click", (event) => {
      handleThumbnailClick(event, groupState.key, index);
    });

    let entryRef = null;
    const indicator = document.createElement("span");
    indicator.className = "thumbnail-select-indicator";
    indicator.setAttribute("role", "checkbox");
    indicator.setAttribute("aria-checked", "false");
    indicator.setAttribute("aria-label", "Select for download");
    indicator.setAttribute("tabindex", "0");
    indicator.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!entryRef || !entryRef.path || state.download.inProgress) {
        return;
      }
      toggleImageSelection(entryRef.path, groupState.key);
    });
    indicator.addEventListener("keydown", (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (!entryRef || !entryRef.path || state.download.inProgress) {
          return;
        }
        toggleImageSelection(entryRef.path, groupState.key);
      }
    });
    button.appendChild(indicator);

    const tile = document.createElement("div");
    tile.className = "thumbnail-tile placeholder";
    button.appendChild(tile);

    const caption = document.createElement("div");
    caption.className = "thumbnail-caption placeholder";
    button.appendChild(caption);

    const entry = {
      name: typeof meta.name === "string" ? meta.name : `Image ${index + 1}`,
      path: typeof meta.path === "string" ? meta.path : null,
      dateHint: meta.dateHint || null,
      element: button,
      loaded: false,
      loading: false,
    };
    entryRef = entry;
    groupState.images[index] = entry;
    if (entry.path) {
      state.pathToImage.set(entry.path, { groupKey: groupState.key, index });
    }

    if (entry.path && state.download.items.has(entry.path)) {
      setThumbnailSelectionState(button, true);
    }

    fragment.appendChild(button);
  }

  if (fragment.childNodes.length) {
    groupState.grid.appendChild(fragment);
    for (let index = startIndex; index < endIndex; index += 1) {
      const entry = groupState.images[index];
      if (entry && entry.element) {
        observePlaceholder(groupState, index, entry.element);
      }
    }
  }

  if (groupState.pendingHydration) {
    groupState.pendingHydration = false;
    groupState.container.classList.remove("pending-hydration");
  }

  groupState.renderedCount = endIndex;
  updateGroupSelectionStatus(groupState.key);
}

function maybeRenderMoreThumbnails(groupState, viewport, margin) {
  if (!groupState) {
    return;
  }
  groupState.manifest = state.imagesByGroup.get(groupState.key) || groupState.manifest || [];
  const manifestLength = Array.isArray(groupState.manifest) ? groupState.manifest.length : 0;
  if (groupState.renderedCount >= manifestLength) {
    if (!groupState.fullyLoaded) {
      ensureGroupManifestCount(groupState, groupState.renderedCount + THUMBNAILS_PER_GROUP)
        .then(() => {
          const updatedManifest = state.imagesByGroup.get(groupState.key) || [];
          if (groupState.renderedCount < updatedManifest.length) {
            renderNextThumbnails(groupState, THUMBNAILS_PER_GROUP);
          }
        })
        .catch((error) => console.error(error));
    }
    return;
  }
  const lastElement = groupState.grid.lastElementChild;
  if (!lastElement) {
    renderNextThumbnails(groupState, THUMBNAILS_PER_GROUP);
    return;
  }
  const rect = lastElement.getBoundingClientRect();
  if (rect.top < viewport.bottom + margin) {
    renderNextThumbnails(groupState, THUMBNAILS_PER_GROUP);
  }
}

function maybeRenderMoreTopGroups() {
  if (!elements.timeline) {
    return;
  }
  if (state.topGroupIndex >= state.topGroups.length) {
    return;
  }
  const { scrollTop, clientHeight, scrollHeight } = elements.timeline;
  if (scrollTop + clientHeight + 400 >= scrollHeight) {
    renderNextTopGroups(GROUP_BATCH_SIZE);
  }
}

function ensureSubgroupRendered(groupKey) {
  if (state.groups.has(groupKey)) {
    return;
  }
  if (!state.topGroups.length) {
    return;
  }
  const targetIndex = state.topGroups.findIndex((group) =>
    Array.isArray(group.subgroups) && group.subgroups.some((subgroup) => subgroup.key === groupKey),
  );
  if (targetIndex === -1) {
    return;
  }
  while (state.topGroupIndex <= targetIndex) {
    renderNextTopGroups(GROUP_BATCH_SIZE);
  }
  const topGroup = state.topGroups[targetIndex];
  const meta = state.topGroupStatus.get(topGroup.key);
  if (!meta) {
    return;
  }
  const subgroupIndex = meta.subgroups.findIndex((subgroup) => subgroup.key === groupKey);
  if (subgroupIndex === -1) {
    return;
  }
  while (meta.rendered <= subgroupIndex) {
    renderNextSubgroups(meta, SUBGROUP_BATCH_SIZE);
  }
}

function ensureTopGroupRendered(topKey) {
  if (!state.topGroups.length) {
    return;
  }
  const targetIndex = state.topGroups.findIndex((group) => group.key === topKey);
  if (targetIndex === -1) {
    return;
  }
  while (state.topGroupIndex <= targetIndex) {
    renderNextTopGroups(GROUP_BATCH_SIZE);
  }
}

function maybeRenderMoreSubgroups(meta, viewport, margin) {
  if (!meta || !meta.section || !meta.section.isConnected || !meta.subgroups || meta.rendered >= meta.subgroups.length) {
    return;
  }
  const lastChild = meta.section.lastElementChild;
  if (!lastChild || !lastChild.classList || !lastChild.classList.contains("subgroup-section")) {
    renderNextSubgroups(meta, SUBGROUP_BATCH_SIZE);
    return;
  }
  const rect = lastChild.getBoundingClientRect();
  if (rect.top < viewport.bottom + margin) {
    renderNextSubgroups(meta, SUBGROUP_BATCH_SIZE);
  }
}

let imageObserver = null;

function handlePlaceholderEntries(entries) {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) {
      return;
    }
    const button = entry.target;
    const groupKey = button.dataset.groupKey;
    const index = Number(button.dataset.index);
    const groupState = state.groups.get(groupKey);
    if (groupState && Number.isInteger(index) && index >= 0) {
      loadImageEntry(groupState, index);
    }
    const observerInstance = ensureImageObserver();
    if (observerInstance) {
      observerInstance.unobserve(button);
    }
  });
}

function ensureImageObserver() {
  if (imageObserver) {
    return imageObserver;
  }
  if (typeof IntersectionObserver === "undefined") {
    return null;
  }
  imageObserver = new IntersectionObserver(handlePlaceholderEntries, {
    root: elements.timeline || null,
    rootMargin: "200px 0px",
    threshold: 0.1,
  });
  return imageObserver;
}

function observePlaceholder(groupState, index, element) {
  element.dataset.groupKey = groupState.key;
  element.dataset.index = String(index);
  const observer = ensureImageObserver();
  if (observer) {
    observer.observe(element);
  } else {
    loadImageEntry(groupState, index);
  }
}

function loadImageEntry(groupState, index) {
  const entry = groupState.images[index];
  if (!entry || entry.loaded || entry.loading) {
    return;
  }
  const button = entry.element;
  if (!button) {
    return;
  }
  entry.loading = true;
  button.classList.remove("placeholder");
  button.disabled = false;
  button.tabIndex = 0;
  button.removeAttribute("aria-hidden");
  button.dataset.groupKey = groupState.key;
  button.dataset.index = String(index);
  if (entry.path) {
    button.dataset.path = entry.path;
  } else {
    delete button.dataset.path;
  }

  const tile = document.createElement("div");
  tile.className = "thumbnail-tile";

  let img = null;
  if (entry.path) {
    img = document.createElement("img");
    img.loading = "lazy";
    img.alt = entry.name || "";
    img.src = `/api/thumbnail?path=${encodeURIComponent(entry.path)}`;
    img.addEventListener("error", () => {
      if (!img.dataset.retried) {
        img.dataset.retried = "true";
        img.src = "/thumbnail-placeholder.svg";
      }
    });
    tile.appendChild(img);
  }

  const caption = document.createElement("div");
  caption.className = "thumbnail-caption";
  caption.textContent = entry.name || "";

  const indicator = button.querySelector(".thumbnail-select-indicator");
  if (indicator) {
    button.replaceChildren(indicator, tile, caption);
  } else {
    button.replaceChildren(tile, caption);
  }
  entry.element = button;

  if (entry.path && state.download.items.has(entry.path)) {
    setThumbnailSelectionState(button, true);
  }

  entry.loaded = true;
  entry.loading = false;
}

async function ensureGroupLoaded(groupKey, options = {}) {
  const groupState = state.groups.get(groupKey);
  if (!groupState || groupState.total === 0) {
    return;
  }
  const force = options.force === true;
  if (!force && isGroupLoadingSuspended()) {
    return;
  }
  const desiredCount = Math.max(options.minCount || THUMBNAILS_PER_GROUP, THUMBNAILS_PER_GROUP);
  await ensureGroupManifestCount(groupState, desiredCount, { force });
  if (groupState.renderedCount === 0 && groupState.manifest.length) {
    renderNextThumbnails(groupState, Math.min(THUMBNAILS_PER_GROUP, groupState.manifest.length));
  }
}

let scrollIdleHandle = null;

function loadVisibleGroups() {
  if (!elements.timeline) {
    return;
  }
  if (state.viewer.open) {
    return;
  }
  if (state.vectorView.active) {
    return;
  }
  const observer = ensureImageObserver();
  const viewport = elements.timeline.getBoundingClientRect();
  const margin = 150;
  const visibleKeys = [];
  state.groupSequence.forEach((key) => {
    const entry = state.groups.get(key);
    if (!entry || !entry.container) {
      return;
    }
    const rect = entry.container.getBoundingClientRect();
    if (rect.bottom < viewport.top - margin || rect.top > viewport.bottom + margin) {
      return;
    }
    visibleKeys.push(key);
  });
  if (!visibleKeys.length) {
    maybeRenderMoreTopGroups();
    return;
  }
  visibleKeys.forEach((key) => {
    ensureGroupLoaded(key).catch((error) => console.error(error));
    const groupState = state.groups.get(key);
    if (!groupState) {
      return;
    }
    maybeRenderMoreThumbnails(groupState, viewport, margin);
    if (!observer) {
      groupState.images.forEach((imageEntry, index) => {
        if (!imageEntry || !imageEntry.element || imageEntry.loaded) {
          return;
        }
        const element = imageEntry.element;
        const rect = element.getBoundingClientRect();
        if (rect.bottom < viewport.top - margin || rect.top > viewport.bottom + margin) {
          return;
        }
        loadImageEntry(groupState, index);
      });
    }
  });
  const firstIndex = state.groupIndexMap.get(visibleKeys[0]);
  const lastIndex = state.groupIndexMap.get(visibleKeys[visibleKeys.length - 1]);
  if (firstIndex !== undefined && firstIndex > 0) {
    ensureGroupLoaded(state.groupSequence[firstIndex - 1]).catch((error) => console.error(error));
  }
  if (lastIndex !== undefined && lastIndex + 1 < state.groupSequence.length) {
    ensureGroupLoaded(state.groupSequence[lastIndex + 1]).catch((error) => console.error(error));
  }
  state.topGroupStatus.forEach((meta) => {
    if (!meta || !meta.section) {
      return;
    }
    const rect = meta.section.getBoundingClientRect();
    if (rect.bottom < viewport.top - margin || rect.top > viewport.bottom + margin) {
      return;
    }
    maybeRenderMoreSubgroups(meta, viewport, margin);
  });
  maybeRenderMoreTopGroups();
}

function scheduleViewportLoading() {
  if (state.viewer.open) {
    return;
  }
  if (state.vectorView.active) {
    return;
  }
  if (scrollIdleHandle) {
    clearTimeout(scrollIdleHandle);
  }
  scrollIdleHandle = setTimeout(() => {
    loadVisibleGroups();
  }, 400);
}

async function ensureImageLoaded(path, groupKey) {
  const existing = state.pathToImage.get(path);
  if (existing && existing.groupKey === groupKey) {
    return existing.index;
  }

  ensureSubgroupRendered(groupKey);
  const groupState = state.groups.get(groupKey);
  if (!groupState) {
    return -1;
  }
  let manifest = groupState.manifest || state.imagesByGroup.get(groupKey) || [];
  let targetIndex = manifest.findIndex((item) => item && item.path === path);
  while (targetIndex === -1 && !groupState.fullyLoaded) {
    const previousLength = manifest.length;
    const nextTarget = previousLength + THUMBNAILS_PER_GROUP;
    await ensureGroupManifestCount(groupState, nextTarget, { force: true });
    manifest = groupState.manifest || state.imagesByGroup.get(groupKey) || [];
    targetIndex = manifest.findIndex((item) => item && item.path === path);
    if (manifest.length === previousLength) {
      break;
    }
  }
  if (targetIndex === -1) {
    return -1;
  }
  while (groupState.renderedCount <= targetIndex) {
    renderNextThumbnails(groupState, THUMBNAILS_PER_GROUP);
  }
  const resolved = state.pathToImage.get(path);
  return resolved && resolved.groupKey === groupKey ? resolved.index : targetIndex;
}

function getAdjacentGroupKey(currentKey, direction) {
  const index = state.groupIndexMap.get(currentKey);
  if (index === undefined) {
    return null;
  }
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= state.groupSequence.length) {
    return null;
  }
  return state.groupSequence[nextIndex];
}

function updateUrlWithImage(path) {
  const params = new URLSearchParams(window.location.search);
  if (path) {
    params.set("image", path);
  } else {
    params.delete("image");
  }
  params.set("order", state.order);
  const newUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
  history.replaceState(null, "", newUrl);
}

function openViewerAt(groupKey, index) {
  if (Date.now() < state.suppressThumbnailOpenUntil) {
    return;
  }
  const groupState = state.groups.get(groupKey);
  if (!groupState || index < 0 || index >= groupState.images.length) {
    return;
  }
  const targetItem = groupState.images[index];
  if (!targetItem || !targetItem.element) {
    return;
  }
  if (imageObserver) {
    imageObserver.disconnect();
    imageObserver = null;
  }
  state.viewer.open = true;
  state.viewer.mode = "group";
  state.viewer.groupKey = groupKey;
  state.viewer.index = index;
  state.viewer.vectorPaths = [];
  elements.viewerOverlay.hidden = false;
  document.body.classList.add("viewer-open");
  if (elements.header) {
    elements.header.classList.add("viewer-hidden");
  }
  const blendDuration = Math.max(0, Number(state.viewer.pendingBlend) || 0);
  showViewerLoading(blendDuration);
  updateUrlWithImage(targetItem.path);
  renderViewer();
}

function openVectorViewerAt(index) {
  if (Date.now() < state.suppressThumbnailOpenUntil) {
    return;
  }
  const results = Array.isArray(state.vectorView.results) ? state.vectorView.results : [];
  if (index < 0 || index >= results.length) {
    return;
  }
  const item = results[index] || {};
  const path = item.path || null;
  if (!path) {
    return;
  }
  if (imageObserver) {
    imageObserver.disconnect();
    imageObserver = null;
  }
  state.viewer.open = true;
  state.viewer.mode = "vector";
  state.viewer.groupKey = null;
  state.viewer.index = index;
  state.viewer.vectorPaths = results.map((entry) => entry && entry.path).filter(Boolean);
  elements.viewerOverlay.hidden = false;
  document.body.classList.add("viewer-open");
  if (elements.header) {
    elements.header.classList.add("viewer-hidden");
  }
  const blendDuration = Math.max(0, Number(state.viewer.pendingBlend) || 0);
  showViewerLoading(blendDuration);
  updateUrlWithImage(path);
  renderViewer();
}

function closeViewer() {
  state.viewer.open = false;
  state.viewer.mode = null;
  state.viewer.groupKey = null;
  state.viewer.index = -1;
  state.viewer.vectorPaths = [];
  state.viewer.detailsPath = null;
  elements.viewerOverlay.hidden = true;
  document.body.classList.remove("viewer-open");
  if (elements.header) {
    elements.header.classList.remove("viewer-hidden");
    if (!state.controlOpen && !headerHover) {
      setHeaderCollapsed(true);
    }
  }
  if (state.randomViewer.running) {
    stopRandomViewer({ resetToggle: true });
  }
  setViewerDetailsVisibility(false);
  updateUrlWithImage(null);
  if (state.activeThumb) {
    state.activeThumb.classList.remove("active");
    state.activeThumb = null;
  }
  showViewerLoading();
  setViewerNavDisabled(false);
  if (!state.vectorView.active) {
    scheduleViewportLoading();
  }
}

function renderViewer() {
  if (!state.viewer.open) {
    return;
  }
  if (state.viewer.mode !== "group" && state.viewer.mode !== "vector") {
    return;
  }
  const isVector = state.viewer.mode === "vector";
  let groupState = null;
  let item = null;
  let path = null;
  let nameText = "";
  let labelText = "";
  if (isVector) {
    const results = Array.isArray(state.vectorView.results) ? state.vectorView.results : [];
    item = results[state.viewer.index] || null;
    path = item && item.path ? item.path : null;
    nameText = path ? path.split("/").pop() || path : "";
    labelText = item ? formatVectorResultLabel(item) : "";
  } else {
    groupState = state.groups.get(state.viewer.groupKey);
    if (!groupState) {
      return;
    }
    item = groupState.images[state.viewer.index];
    if (!item) {
      return;
    }
    path = item.path;
    nameText = item.name || "";
  }
  if (!path) {
    return;
  }
  const blendDuration = Math.max(0, Number(state.viewer.pendingBlend) || 0);
  state.viewer.pendingBlend = 0;
  prepareViewerTransition(blendDuration);
  const mainImage = elements.viewerImage;
  const overlayImage = elements.viewerImageOverlay;
  if (mainImage) {
    mainImage.style.opacity = "0";
    if (blendDuration > 0) {
      mainImage.style.transition = `opacity ${blendDuration}s ease`;
    }
    mainImage.src = `/api/image?path=${encodeURIComponent(path)}`;
    mainImage.alt = nameText;
  }
  updateViewerDetails(isVector ? null : item);
  const finalize = () => {
    if (!isVector && groupState && item) {
      updateViewerMetadata(groupState, item);
      highlightActiveThumbnail(item);
    }
    if (mainImage) {
      if (blendDuration > 0 && overlayImage && overlayImage.src) {
        overlayImage.style.transition = `opacity ${blendDuration}s ease`;
        overlayImage.hidden = false;
        requestAnimationFrame(() => {
          mainImage.style.opacity = "1";
          overlayImage.style.opacity = "0";
        });
        setTimeout(() => {
          overlayImage.style.transition = "";
          overlayImage.style.opacity = "0";
          overlayImage.hidden = true;
          mainImage.style.transition = "";
        }, blendDuration * 1000 + 60);
      } else {
        requestAnimationFrame(() => {
          mainImage.style.opacity = "1";
        });
        if (overlayImage) {
          overlayImage.style.opacity = "0";
          overlayImage.hidden = true;
        }
        mainImage.style.transition = "";
      }
    }
    if (mainImage) {
      mainImage.removeEventListener("load", finalize);
      mainImage.removeEventListener("error", handleError);
    }
  };
  const handleError = () => {
    setInfoBar(elements.viewerInfoTop, "Failed to load image", "block");
    setInfoBar(elements.viewerInfoBottom, nameText || "", nameText ? "block" : "none");
    setInfoBar(elements.viewerInfoLeft, "", "block");
    setInfoBar(elements.viewerInfoRight, "", "block");
    if (!isVector) {
      highlightActiveThumbnail(item);
      updateViewerDetails(null);
    }
    if (elements.viewerContainer) {
      elements.viewerContainer.classList.remove("portrait");
    }
    if (mainImage) {
      mainImage.style.opacity = "1";
      mainImage.removeEventListener("load", finalize);
      mainImage.removeEventListener("error", handleError);
    }
    if (overlayImage) {
      overlayImage.style.opacity = "0";
      overlayImage.hidden = true;
    }
  };
  if (mainImage) {
    mainImage.addEventListener("load", finalize);
    mainImage.addEventListener("error", handleError);
  }
  if (isVector) {
    const topText = labelText || nameText;
    setInfoBar(elements.viewerInfoTop, topText, topText ? "block" : "none");
    setInfoBar(elements.viewerInfoBottom, nameText, nameText ? "block" : "none");
    setInfoBar(elements.viewerInfoLeft, "", "block");
    setInfoBar(elements.viewerInfoRight, "", "block");
  }
}

function highlightActiveThumbnail(item) {
  if (state.activeThumb) {
    state.activeThumb.classList.remove("active");
  }
  if (item && item.element) {
    item.element.classList.add("active");
    state.activeThumb = item.element;
  }
}

function setInfoBar(element, text, displayStyle) {
  if (!element) {
    return;
  }
  if (text) {
    element.textContent = text;
    element.style.display = displayStyle;
  } else {
    element.textContent = "";
    element.style.display = "none";
  }
}

function clearViewerDetailsContent() {
  if (elements.viewerLocationTableBody) {
    elements.viewerLocationTableBody.innerHTML = "";
  }
  if (elements.viewerExifTableBody) {
    elements.viewerExifTableBody.innerHTML = "";
  }
  if (elements.viewerLocationTable) {
    elements.viewerLocationTable.hidden = true;
  }
  if (elements.viewerExifTable) {
    elements.viewerExifTable.hidden = true;
  }
  if (elements.viewerLocationSection) {
    elements.viewerLocationSection.hidden = true;
  }
  if (elements.viewerExifSection) {
    elements.viewerExifSection.hidden = true;
  }
  if (elements.viewerDetailsStatus) {
    elements.viewerDetailsStatus.textContent = "";
    elements.viewerDetailsStatus.hidden = true;
    elements.viewerDetailsStatus.classList.remove("error");
  }
}

function showViewerDetailsMessage(message, variant = "info") {
  if (!elements.viewerDetailsStatus) {
    return;
  }
  clearViewerDetailsContent();
  elements.viewerDetailsStatus.textContent = message || "";
  elements.viewerDetailsStatus.hidden = !message;
  elements.viewerDetailsStatus.classList.toggle("error", variant === "error");
}

function appendViewerDetailsRow(tableBody, label, value, link) {
  if (!tableBody || !label || value === null || value === undefined) {
    return;
  }
  const row = document.createElement("tr");
  const keyCell = document.createElement("th");
  keyCell.scope = "row";
  keyCell.textContent = label;
  const valueCell = document.createElement("td");
  if (link) {
    const anchor = document.createElement("a");
    anchor.href = link;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    anchor.textContent = String(value);
    valueCell.appendChild(anchor);
  } else {
    valueCell.textContent = String(value);
  }
  row.appendChild(keyCell);
  row.appendChild(valueCell);
  tableBody.appendChild(row);
}

function formatDetailKey(key) {
  return String(key || "")
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function renderLocationDetails(location) {
  if (!elements.viewerLocationSection || !elements.viewerLocationTable || !elements.viewerLocationTableBody) {
    return false;
  }
  const raw = location && typeof location === "object" ? location.raw : null;
  const address = raw && typeof raw.address === "object" ? raw.address : null;
  const poi = location && typeof location === "object" ? location.poi : null;

  const lat = raw && raw.lat !== undefined ? raw.lat : null;
  const lon = raw && raw.lon !== undefined ? raw.lon : null;
  const mapLink = lat !== null && lon !== null
    ? `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lon}`)}`
    : null;

  if (lat !== null) {
    appendViewerDetailsRow(elements.viewerLocationTableBody, "Latitude", lat, mapLink);
  }
  if (lon !== null) {
    appendViewerDetailsRow(elements.viewerLocationTableBody, "Longitude", lon, mapLink);
  }
  if (raw && raw.class !== undefined) {
    appendViewerDetailsRow(elements.viewerLocationTableBody, "Class", raw.class);
  }
  if (raw && raw.type !== undefined) {
    appendViewerDetailsRow(elements.viewerLocationTableBody, "Type", raw.type);
  }
  if (raw && raw.display_name) {
    appendViewerDetailsRow(elements.viewerLocationTableBody, "Display name", raw.display_name);
  }
  if (address) {
    Object.entries(address).forEach(([key, value]) => {
      appendViewerDetailsRow(
        elements.viewerLocationTableBody,
        `Address ${formatDetailKey(key)}`,
        value
      );
    });
  }
  if (poi && typeof poi === "object") {
    Object.entries(poi).forEach(([key, value]) => {
      appendViewerDetailsRow(
        elements.viewerLocationTableBody,
        `POI ${formatDetailKey(key)}`,
        value
      );
    });
  }

  if (!elements.viewerLocationTableBody.childElementCount) {
    appendViewerDetailsRow(
      elements.viewerLocationTableBody,
      "Location",
      "No location data found for this image."
    );
  }
  elements.viewerLocationSection.hidden = false;
  elements.viewerLocationTable.hidden = false;
  return true;
}

function renderExifDetails(fields) {
  if (!elements.viewerExifSection || !elements.viewerExifTable || !elements.viewerExifTableBody) {
    return false;
  }
  const rows = Array.isArray(fields) ? fields : [];
  rows.forEach((entry) => {
    const label = entry && entry.label ? String(entry.label) : "";
    const value = entry && entry.value ? String(entry.value) : "";
    if (!label || !value) {
      return;
    }
    appendViewerDetailsRow(elements.viewerExifTableBody, label, value);
  });
  if (!elements.viewerExifTableBody.childElementCount) {
    appendViewerDetailsRow(
      elements.viewerExifTableBody,
      "EXIF",
      "No EXIF data found for this image."
    );
  }
  elements.viewerExifSection.hidden = false;
  elements.viewerExifTable.hidden = false;
  return true;
}

function renderViewerDetails(details) {
  clearViewerDetailsContent();
  const location = details ? details.location : null;
  const exifFields = details ? details.exif : null;
  const hasLocation = renderLocationDetails(location);
  const hasExif = renderExifDetails(exifFields);
  if (!hasLocation && !hasExif) {
    showViewerDetailsMessage("No details found for this image.");
  }
}

function showViewerDetailsLoading() {
  clearViewerDetailsContent();
  showViewerDetailsMessage("Loading details…");
}

function showViewerDetailsError(message) {
  clearViewerDetailsContent();
  showViewerDetailsMessage(message || "Unable to load details.", "error");
}

async function loadViewerDetails(path) {
  if (!state.viewer.detailsOpen || !path) {
    return;
  }
  const cached = state.detailsCache.get(path);
  if (cached) {
    renderViewerDetails(cached);
    return;
  }
  showViewerDetailsLoading();
  const requestToken = Symbol("exifRequest");
  state.viewer.detailsLoading = true;
  state.viewer.detailsRequestToken = requestToken;
  try {
    const response = await fetchJson(`/api/exif?path=${encodeURIComponent(path)}`);
    const rawFields = Array.isArray(response.fields) ? response.fields : [];
    const normalized = rawFields
      .map((entry) => ({
        label: entry && entry.label ? String(entry.label).trim() : "",
        value: entry && entry.value ? String(entry.value).trim() : "",
      }))
      .filter((entry) => entry.label && entry.value);
    const details = {
      exif: normalized,
      location: response && response.location ? response.location : null,
    };
    state.detailsCache.set(path, details);
    if (state.viewer.detailsRequestToken !== requestToken || state.viewer.detailsPath !== path) {
      return;
    }
    renderViewerDetails(details);
  } catch (error) {
    if (state.viewer.detailsRequestToken !== requestToken || state.viewer.detailsPath !== path) {
      return;
    }
    const message = error && error.message ? String(error.message) : "Unable to load details.";
    showViewerDetailsError(message);
  } finally {
    if (state.viewer.detailsRequestToken === requestToken) {
      state.viewer.detailsLoading = false;
      state.viewer.detailsRequestToken = null;
    }
  }
}

function updateViewerDetails(item) {
  const path = item && item.path ? item.path : null;
  state.viewer.detailsPath = path;
  if (!state.viewer.detailsOpen) {
    return;
  }
  if (!path) {
    clearViewerDetailsContent();
    showViewerDetailsMessage("No image selected.");
    return;
  }
  const cached = state.detailsCache.get(path);
  if (cached) {
    renderViewerDetails(cached);
    return;
  }
  loadViewerDetails(path);
}

function setViewerDetailsVisibility(open) {
  state.viewer.detailsOpen = Boolean(open);
  if (elements.viewerDetailsPanel) {
    elements.viewerDetailsPanel.hidden = !state.viewer.detailsOpen;
  }
  if (!state.viewer.detailsOpen) {
    state.viewer.detailsLoading = false;
    state.viewer.detailsRequestToken = null;
    clearViewerDetailsContent();
    return;
  }
  updateViewerDetails({ path: state.viewer.detailsPath });
}

function handleViewerDoubleClick(event) {
  if (!state.viewer.open) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  setViewerDetailsVisibility(true);
}

function handleViewerContainerClick(event) {
  if (!state.viewer.detailsOpen) {
    return;
  }
  const panel = elements.viewerDetailsPanel;
  if (panel && panel.contains(event.target)) {
    return;
  }
  setViewerDetailsVisibility(false);
}

function showViewerLoading(blendDuration = 0) {
  if (elements.viewerContainer) {
    elements.viewerContainer.classList.remove("portrait");
  }
  resetViewerTransform();
  if (elements.viewerImage) {
    if (blendDuration > 0) {
      elements.viewerImage.style.transition = `opacity ${blendDuration}s ease`;
    } else {
      elements.viewerImage.style.transition = "";
    }
    elements.viewerImage.style.opacity = "0";
  }
  if (blendDuration <= 0 && elements.viewerImageOverlay) {
    elements.viewerImageOverlay.style.opacity = "0";
    elements.viewerImageOverlay.hidden = true;
  }
  setInfoBar(elements.viewerInfoTop, "Loading image…", "block");
  setInfoBar(elements.viewerInfoBottom, "", "block");
  setInfoBar(elements.viewerInfoLeft, "", "block");
  setInfoBar(elements.viewerInfoRight, "", "block");
  if (state.viewer.detailsOpen) {
    showViewerDetailsLoading();
  }
}

function updateViewerMetadata(groupState, item) {
  const fallbackDate = item.dateHint || (groupState ? groupState.label : "");
  const dateText = fallbackDate || "";
  const nameText = item.name || "";
  const location = item.path ? item.path.split("/").slice(0, -1).join("/") : "";
  const image = elements.viewerImage;
  resetViewerTransform();
  if (!image || !elements.viewerContainer) {
    setInfoBar(elements.viewerInfoTop, dateText, dateText ? "block" : "none");
    setInfoBar(elements.viewerInfoBottom, nameText, nameText ? "block" : "none");
    setInfoBar(elements.viewerInfoLeft, "", "block");
    setInfoBar(elements.viewerInfoRight, "", "block");
    return;
  }
  const isPortrait = image.naturalHeight > image.naturalWidth;
  elements.viewerContainer.classList.toggle("portrait", isPortrait);
  if (isPortrait) {
    setInfoBar(elements.viewerInfoTop, "", "block");
    setInfoBar(elements.viewerInfoBottom, "", "block");
    setInfoBar(elements.viewerInfoLeft, dateText, dateText ? "block" : "none");
    const rightText = nameText || location;
    setInfoBar(elements.viewerInfoRight, rightText, rightText ? "block" : "none");
  } else {
    const topText = dateText || location;
    setInfoBar(elements.viewerInfoTop, topText, topText ? "block" : "none");
    setInfoBar(elements.viewerInfoBottom, nameText, nameText ? "block" : "none");
    setInfoBar(elements.viewerInfoLeft, "", "block");
    setInfoBar(elements.viewerInfoRight, "", "block");
  }
}

async function showNext() {
  if (!state.viewer.open) {
    return;
  }
  if (state.viewer.mode === "vector") {
    const results = Array.isArray(state.vectorView.results) ? state.vectorView.results : [];
    const nextIndex = state.viewer.index + 1;
    if (nextIndex < results.length) {
      state.viewer.pendingBlend = 0;
      openVectorViewerAt(nextIndex);
    }
    return;
  }
  if (state.viewer.mode !== "group") {
    return;
  }
  const currentGroup = state.groups.get(state.viewer.groupKey);
  if (!currentGroup) {
    return;
  }
  const nextIndex = state.viewer.index + 1;
  const currentManifest = currentGroup.manifest || state.imagesByGroup.get(currentGroup.key) || [];
  if (nextIndex < currentGroup.images.length) {
    const entry = currentGroup.images[nextIndex];
    if (entry && entry.element) {
      state.viewer.pendingBlend = 0;
      openViewerAt(currentGroup.key, nextIndex);
      return;
    }
    const manifestItem = currentManifest[nextIndex];
    if (manifestItem && manifestItem.path) {
      const resolvedIndex = await ensureImageLoaded(manifestItem.path, currentGroup.key);
      if (resolvedIndex !== -1) {
        state.viewer.pendingBlend = 0;
        openViewerAt(currentGroup.key, resolvedIndex);
        return;
      }
    }
  }
  const nextGroupKey = getAdjacentGroupKey(currentGroup.key, 1);
  if (!nextGroupKey) {
    return;
  }
  await ensureGroupLoaded(nextGroupKey, { force: true });
  const nextGroup = state.groups.get(nextGroupKey);
  if (!nextGroup) {
    return;
  }
  const nextManifest = nextGroup.manifest || state.imagesByGroup.get(nextGroupKey) || [];
  const target = nextManifest[0];
  if (target && target.path) {
    const resolvedIndex = await ensureImageLoaded(target.path, nextGroupKey);
    if (resolvedIndex !== -1) {
      state.viewer.pendingBlend = 0;
      openViewerAt(nextGroupKey, resolvedIndex);
    }
  }
}

async function showPrevious() {
  if (!state.viewer.open) {
    return;
  }
  if (state.viewer.mode === "vector") {
    const prevIndex = state.viewer.index - 1;
    if (prevIndex >= 0) {
      state.viewer.pendingBlend = 0;
      openVectorViewerAt(prevIndex);
    }
    return;
  }
  if (state.viewer.mode !== "group") {
    return;
  }
  const currentGroup = state.groups.get(state.viewer.groupKey);
  if (!currentGroup) {
    return;
  }
  if (state.viewer.index > 0) {
    const prevIndex = state.viewer.index - 1;
    const entry = currentGroup.images[prevIndex];
    if (entry && entry.element) {
      state.viewer.pendingBlend = 0;
      openViewerAt(currentGroup.key, prevIndex);
      return;
    }
    const manifest = currentGroup.manifest || state.imagesByGroup.get(currentGroup.key) || [];
    const manifestItem = manifest[prevIndex];
    if (manifestItem && manifestItem.path) {
      const resolvedIndex = await ensureImageLoaded(manifestItem.path, currentGroup.key);
      if (resolvedIndex !== -1) {
        state.viewer.pendingBlend = 0;
        openViewerAt(currentGroup.key, resolvedIndex);
        return;
      }
    }
  }
  const prevGroupKey = getAdjacentGroupKey(currentGroup.key, -1);
  if (!prevGroupKey) {
    return;
  }
  await ensureGroupLoaded(prevGroupKey, { force: true });
  const prevGroup = state.groups.get(prevGroupKey);
  if (!prevGroup) {
    return;
  }
  const prevManifest = prevGroup.manifest || state.imagesByGroup.get(prevGroupKey) || [];
  const lastIndex = prevManifest.length - 1;
  if (lastIndex >= 0) {
    const manifestItem = prevManifest[lastIndex];
    if (manifestItem && manifestItem.path) {
      const resolvedIndex = await ensureImageLoaded(manifestItem.path, prevGroupKey);
      if (resolvedIndex !== -1) {
        state.viewer.pendingBlend = 0;
        openViewerAt(prevGroupKey, resolvedIndex);
      }
    }
  }
}

async function openImageByPath(path) {
  const groupKey = deriveGroupKey(path);
  if (!state.groups.has(groupKey) && state.topGroups.length === 0) {
    await fetchHierarchy();
  }
  const topKey = groupKey.split("/")[0];
  ensureTopGroupRendered(topKey);
  ensureSubgroupRendered(groupKey);
  if (!state.groups.has(groupKey)) {
    ensureTopGroupRendered(topKey);
    ensureSubgroupRendered(groupKey);
  }
  const groupState = state.groups.get(groupKey);
  if (!groupState) {
    alert("Unable to locate the requested folder.");
    return;
  }
  await ensureGroupLoaded(groupKey, { force: true });
  const index = await ensureImageLoaded(path, groupKey);
  if (index === -1) {
    alert("Unable to locate the requested image.");
    return;
  }
  state.viewer.pendingBlend = state.randomViewer.running ? state.randomViewer.blend : 0;
  openViewerAt(groupKey, index);
}

function applyOrder(order, { updateUrl = false } = {}) {
  const normalized = order === "asc" ? "asc" : "desc";
  if (state.order === normalized && !updateUrl) {
    return;
  }
  if (state.viewer.open) {
    closeViewer();
  }
  state.order = normalized;
  state.orderVersion += 1;
  updateOrderUI();
  if (elements.timeline) {
    elements.timeline.scrollTop = 0;
  }
  closeControlPanel();
  if (updateUrl) {
    const params = new URLSearchParams(window.location.search);
    params.set("order", state.order);
    const newUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
    history.replaceState(null, "", newUrl);
  }
  fetchHierarchy().then(() => {
    preloadInitialGroups();
    if (state.initialImagePath) {
      openImageByPath(state.initialImagePath);
      state.initialImagePath = null;
    }
  });
}

function preloadInitialGroups() {
  const keys = state.groupSequence.slice(0, INITIAL_PREFETCH_GROUPS);
  keys.forEach((key) => {
    ensureGroupLoaded(key).catch((error) => console.error(error));
  });
  scheduleViewportLoading();
}

function updateSearchHistoryControls() {
  if (!elements.searchHistoryBack || !elements.searchHistoryForward) {
    return;
  }
  const canBack = state.searchHistory.cursor > 0;
  const canForward = state.searchHistory.cursor >= 0 && state.searchHistory.cursor < state.searchHistory.items.length - 1;
  elements.searchHistoryBack.disabled = !canBack;
  elements.searchHistoryForward.disabled = !canForward;
}

function pushSearchHistory(query, results, kind) {
  const trimmedQuery = (query || "").trim();
  let items = state.searchHistory.items.slice();
  if (state.searchHistory.cursor < items.length - 1) {
    items = items.slice(0, state.searchHistory.cursor + 1);
  }
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    query: trimmedQuery,
    results,
    kind,
    createdAt: Date.now(),
  };
  if (items.length && items[items.length - 1].query === trimmedQuery) {
    items[items.length - 1] = entry;
  } else {
    items.push(entry);
  }
  if (items.length > state.searchHistory.limit) {
    const overflow = items.length - state.searchHistory.limit;
    items = items.slice(overflow);
    state.searchHistory.cursor = Math.max(0, state.searchHistory.cursor - overflow);
  }
  state.searchHistory.items = items;
  state.searchHistory.cursor = items.length - 1;
  updateSearchHistoryControls();
}

function setSearchResults(results, { pushHistory = false, query = "", kind = "group" } = {}) {
  if (kind === "vector") {
    showVectorResultsView(results, query);
    renderVectorResultsSummary(results);
  } else {
    showTimelineView();
    renderSearchResults(results);
  }
  if (pushHistory) {
    pushSearchHistory(query, results, kind);
  }
  updateSearchHistoryControls();
}

function applySearchHistoryIndex(index) {
  const entry = state.searchHistory.items[index];
  if (!entry) {
    return;
  }
  state.searchHistory.cursor = index;
  if (elements.searchInput) {
    elements.searchInput.value = entry.query;
  }
  if (entry.kind === "vector") {
    showVectorResultsView(entry.results || [], entry.query || "");
    renderVectorResultsSummary(entry.results || []);
  } else {
    showTimelineView();
    renderSearchResults(entry.results || []);
  }
  updateSearchHistoryControls();
}

function stepSearchHistory(direction) {
  const nextIndex = state.searchHistory.cursor + direction;
  if (nextIndex < 0 || nextIndex >= state.searchHistory.items.length) {
    return;
  }
  applySearchHistoryIndex(nextIndex);
}

async function handleSearch(event) {
  event.preventDefault();
  openControlPanel();
  closeCombobox();
  const rawQuery = (elements.searchInput.value || "").trim();
  const normalizedQuery = normalizeSearchText(rawQuery);
  const tokens = normalizedQuery ? normalizedQuery.split(" ").filter(Boolean) : [];
  if (!tokens.length) {
    closeControlPanel();
    return;
  }
  if (!isDateLikeQuery(rawQuery)) {
    try {
      const results = await fetchVectorSearch(rawQuery, { limit: 30, candidates: 200 });
      setSearchResults(results, { pushHistory: true, query: rawQuery, kind: "vector" });
    } catch (error) {
      console.error("Vector search failed", error);
      setSearchResults([], { pushHistory: true, query: rawQuery, kind: "vector" });
    }
    return;
  }
  showTimelineView();
  const holidayTerms = [];
  if (rawQuery) {
    holidayTerms.push(rawQuery);
  }
  if (normalizedQuery && normalizedQuery !== rawQuery) {
    holidayTerms.push(normalizedQuery);
  }
  if (tokens.length > 1) {
    const joined = tokens.join(" ");
    if (!holidayTerms.includes(joined)) {
      holidayTerms.push(joined);
    }
  }
  tokens.forEach((token) => {
    if (token && !holidayTerms.includes(token)) {
      holidayTerms.push(token);
    }
  });

  let holidayMatches = [];
  try {
    holidayMatches = await fetchHolidayDates(holidayTerms);
  } catch (error) {
    console.error("Unable to resolve holiday dates", error);
  }

  const holidayIsoMap = new Map();
  holidayMatches.forEach((item) => {
    if (!item || !item.iso) {
      return;
    }
    const isoLower = item.iso.toLowerCase();
    const names = Array.isArray(item.names) && item.names.length ? item.names : (item.name ? [item.name] : []);
    const existing = holidayIsoMap.get(isoLower) || new Set();
    names.forEach((name) => existing.add(name));
    holidayIsoMap.set(isoLower, existing);
  });

  const matches = [];
  state.topGroups.forEach((topGroup) => {
    const subgroups = Array.isArray(topGroup.subgroups) ? topGroup.subgroups : [];
    subgroups.forEach((subgroup) => {
      const haystack = buildSearchHaystack(topGroup, subgroup);
      if (!haystack) {
        return;
      }
      const subgroupDateValue = typeof subgroup.dateValue === "number" && subgroup.dateValue > 0 ? subgroup.dateValue : null;
      const subgroupIsoLower = subgroupDateValue ? formatValueToDateString(subgroupDateValue).toLowerCase() : null;
      const holidayNames = new Set();
      if (subgroupIsoLower && holidayIsoMap.has(subgroupIsoLower)) {
        holidayIsoMap.get(subgroupIsoLower).forEach((name) => holidayNames.add(name));
      }
      const manifest = state.imagesByGroup.get(subgroup.key) || [];
      if (!holidayNames.size && holidayIsoMap.size && Array.isArray(manifest)) {
        manifest.forEach((item) => {
          if (item && typeof item.dateValue === "number" && item.dateValue > 0) {
            const isoLower = formatValueToDateString(item.dateValue).toLowerCase();
            if (holidayIsoMap.has(isoLower)) {
              holidayIsoMap.get(isoLower).forEach((name) => holidayNames.add(name));
            }
          }
        });
      }

      const matchesHoliday = holidayNames.size > 0;
      const matchesQuery = tokens.every((token) => haystack.includes(token));
      if (!matchesQuery && !matchesHoliday) {
        return;
      }
      const topLabel = topGroup.formattedLabel || topGroup.label;
      const subgroupLabel = subgroup.formattedLabel || subgroup.label;
      const location = typeof subgroup.location === "string" ? subgroup.location : "";
      const manifestItems = state.imagesByGroup.get(subgroup.key) || manifest;
      const count = (manifestItems ? manifestItems.length : manifest.length) || subgroup.count || 0;
      const match = {
        key: subgroup.key,
        topLabel,
        label: subgroup.label,
        displayLabel: subgroupLabel,
        location,
        count,
      };
      if (matchesHoliday) {
        match.holidayNames = Array.from(holidayNames).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      }
      matches.push(match);
    });
  });
  setSearchResults(matches, { pushHistory: true, query: rawQuery, kind: "group" });
}

function renderSearchResults(results) {
  if (!elements.searchResults) {
    return;
  }
  elements.searchResults.innerHTML = "";
  if (!results.length) {
    const empty = document.createElement("span");
    empty.className = "search-result empty";
    empty.textContent = "No matches";
    elements.searchResults.appendChild(empty);
    return;
  }
  results.slice(0, 30).forEach((match) => {
    const item = document.createElement("div");
    item.className = "search-result";
    item.dataset.groupKey = match.key;
    const label = match.displayLabel || match.label;
    const parts = [`${match.topLabel} / ${label}`, formatPhotoCount(match.count)];
    if (match.location) {
      parts.push(match.location);
    }
    if (Array.isArray(match.holidayNames) && match.holidayNames.length) {
      parts.push(`Holiday: ${match.holidayNames.join(", ")}`);
    }
    item.textContent = parts.join(" • ");
    elements.searchResults.appendChild(item);
  });
}

function renderVectorResults(results) {
  if (!elements.searchResults) {
    return;
  }
  elements.searchResults.innerHTML = "";
  if (!results.length) {
    const empty = document.createElement("span");
    empty.className = "search-result empty";
    empty.textContent = "No matches";
    elements.searchResults.appendChild(empty);
    return;
  }
  results.slice(0, 30).forEach((match) => {
    const item = document.createElement("div");
    item.className = "search-result";
    item.dataset.path = match.path || "";
    const label = formatVectorResultLabel(match);
    const parts = [];
    if (match.path) {
      parts.push(match.path);
    }
    if (label) {
      parts.push(label);
    }
    if (typeof match.score === "number") {
      parts.push(`Score ${match.score.toFixed(3)}`);
    }
    item.textContent = parts.join(" • ");
    elements.searchResults.appendChild(item);
  });
}

elements.searchResults.addEventListener("click", async (event) => {
  const target = event.target.closest(".search-result");
  if (!target) {
    return;
  }
  if (target.dataset.path) {
    openImageByPath(target.dataset.path);
    closeControlPanel();
    return;
  }
  if (!target.dataset.groupKey) {
    return;
  }
  const key = target.dataset.groupKey;
  ensureSubgroupRendered(key);
  const entry = state.groups.get(key);
  if (!entry) {
    return;
  }
  entry.container.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    await ensureGroupLoaded(key);
  } catch (error) {
    console.error(error);
  }
  const nextKey = getAdjacentGroupKey(key, 1);
  if (nextKey) {
    ensureGroupLoaded(nextKey).catch((error) => console.error(error));
  }
  scheduleViewportLoading();
  closeControlPanel();
});

if (elements.searchHistoryBack) {
  elements.searchHistoryBack.addEventListener("click", () => {
    stepSearchHistory(-1);
  });
}

if (elements.searchHistoryForward) {
  elements.searchHistoryForward.addEventListener("click", () => {
    stepSearchHistory(1);
  });
}

if (elements.searchForm) {
  elements.searchForm.addEventListener("submit", (event) => {
    handleSearch(event).catch((error) => console.error("Search failed", error));
  });
}

if (elements.searchScoreInput) {
  elements.searchScoreInput.addEventListener("input", () => {
    const value = getSemanticScoreCutoff();
    persistSemanticScoreCutoff(value);
    queueSemanticScoreCutoffSync(value);
    updateSemanticScoreLabel();
  });
  elements.searchScoreInput.addEventListener("change", () => {
    const value = getSemanticScoreCutoff();
    persistSemanticScoreCutoff(value);
    queueSemanticScoreCutoffSync(value);
    updateSemanticScoreLabel();
  });
}

if (elements.searchInput) {
  elements.searchInput.addEventListener("focus", handleSearchInputFocus);
  elements.searchInput.addEventListener("input", handleSearchInputInput);
  elements.searchInput.addEventListener("keydown", handleSearchInputKeyDown);
  elements.searchInput.addEventListener("blur", handleSearchInputBlur);
  elements.searchInput.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!state.controlOpen) {
      openControlPanel();
    }
  });
  elements.searchInput.addEventListener("touchstart", (event) => {
    event.stopPropagation();
    if (!state.controlOpen) {
      openControlPanel();
    }
  }, { passive: true });
}

if (elements.searchSuggestions) {
  elements.searchSuggestions.addEventListener("mousedown", handleSuggestionMouseDown);
}

document.addEventListener("click", handleDocumentClick);

if (elements.yearNavigationButtons) {
  elements.yearNavigationButtons.addEventListener("click", (event) => {
    const target = event.target.closest(".year-navigation-button");
    if (!target || !target.dataset.topKey) {
      return;
    }
    const topKey = target.dataset.topKey;
    showTimelineView();
    closeControlPanel();
    requestAnimationFrame(() => {
      navigateToTopGroup(topKey);
    });
  });
}

if (elements.yearNavigationSelect) {
  elements.yearNavigationSelect.addEventListener("change", (event) => {
    const topKey = event.target.value;
    if (!topKey) {
      return;
    }
    navigateToTopGroup(topKey);
    event.target.selectedIndex = 0;
    closeControlPanel();
  });
}

if (elements.downloadClear) {
  elements.downloadClear.addEventListener("click", handleDownloadClearClick);
}

if (elements.downloadButton) {
  elements.downloadButton.addEventListener("click", handleDownloadButtonClick);
}

if (elements.randomViewerToggle) {
  elements.randomViewerToggle.addEventListener("change", handleRandomViewerToggle);
}

if (elements.randomViewerDuration) {
  elements.randomViewerDuration.addEventListener("change", updateRandomViewerDuration);
  elements.randomViewerDuration.addEventListener("input", updateRandomViewerDuration);
}

function updateRandomViewerBlend(event) {
  const value = Number.parseFloat(event.target.value);
  state.randomViewer.blend = Number.isFinite(value) && value >= 0 ? value : 0;
  if (state.randomViewer.running) {
    scheduleRandomViewerTick();
  }
}

if (elements.randomViewerBlend) {
  elements.randomViewerBlend.addEventListener("change", (event) => {
    updateRandomViewerBlend(event);
  });
  elements.randomViewerBlend.addEventListener("input", (event) => {
    updateRandomViewerBlend(event);
  });
}

if (elements.randomViewerStart) {
  elements.randomViewerStart.addEventListener("change", updateRandomViewerRange);
}

if (elements.randomViewerEnd) {
  elements.randomViewerEnd.addEventListener("change", updateRandomViewerRange);
}

if (elements.randomViewerAddDate) {
  elements.randomViewerAddDate.addEventListener("click", (event) => {
    event.preventDefault();
    addRandomViewerSpecificDate().catch((error) => console.error("Failed to add specific date", error));
  });
}

if (elements.randomViewerSpecificInput) {
  elements.randomViewerSpecificInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addRandomViewerSpecificDate().catch((error) => console.error("Failed to add specific date", error));
    }
  });
}

if (elements.flyoutPin) {
  elements.flyoutPin.addEventListener("click", (event) => {
    event.preventDefault();
    toggleFlyoutPin();
  });
  elements.flyoutPin.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleFlyoutPin();
    }
  });
}

if (elements.orderSwitch) {
  elements.orderSwitch.addEventListener("click", (event) => {
    const orderButton = event.target.closest(".order-option");
    if (!orderButton) {
      return;
    }
    const nextOrder = orderButton.dataset.order === "asc" ? "asc" : "desc";
    if (nextOrder === state.order) {
      return;
    }
    applyOrder(nextOrder, { updateUrl: true });
  });
}

if (Array.isArray(elements.controlTabButtons) && elements.controlTabButtons.length) {
  elements.controlTabButtons.forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const tab = button.dataset.tab;
      setActiveControlTab(tab);
    });
  });
}

if (elements.viewerDetailsPanel) {
  elements.viewerDetailsPanel.addEventListener("click", (event) => {
    event.stopPropagation();
  });
}

if (elements.viewerImage) {
  elements.viewerImage.addEventListener("dblclick", handleViewerDoubleClick);
}

if (elements.viewerImageOverlay) {
  elements.viewerImageOverlay.addEventListener("dblclick", handleViewerDoubleClick);
}

if (elements.viewerContainer) {
  elements.viewerContainer.addEventListener("click", handleViewerContainerClick);
}

elements.viewerClose.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeViewer();
});

elements.viewerPrev.addEventListener("click", async (event) => {
  event.preventDefault();
  await showPrevious();
});

elements.viewerNext.addEventListener("click", async (event) => {
  event.preventDefault();
  await showNext();
});

let viewerHammer = null;
let viewerPanOffset = 0;

function resetViewerTransform() {
  if (elements.viewerImage) {
    elements.viewerImage.style.transition = "";
    elements.viewerImage.style.transform = "translateX(0)";
  }
}

function setupViewerGestures() {
  if (!elements.viewerContainer || typeof Hammer === "undefined") {
    return;
  }
  if (viewerHammer) {
    viewerHammer.destroy();
    viewerHammer = null;
  }
  viewerHammer = new Hammer.Manager(elements.viewerContainer);
  const pan = new Hammer.Pan({ direction: Hammer.DIRECTION_HORIZONTAL, threshold: 2 });
  const swipe = new Hammer.Swipe({ direction: Hammer.DIRECTION_HORIZONTAL, velocity: 0.25 });
  const tap = new Hammer.Tap({ taps: 1, interval: 300 });
  viewerHammer.add([pan, swipe, tap]);

  viewerHammer.on("panstart", () => {
    viewerPanOffset = 0;
    if (elements.viewerImage) {
      elements.viewerImage.style.transition = "none";
    }
  });

  viewerHammer.on("panmove", (ev) => {
    viewerPanOffset = ev.deltaX;
    if (elements.viewerImage) {
      elements.viewerImage.style.transform = `translateX(${viewerPanOffset}px)`;
    }
  });

  viewerHammer.on("panend pancancel", async () => {
    if (!elements.viewerImage) {
      return;
    }
    const threshold = 150;
    elements.viewerImage.style.transition = "transform 220ms ease";
    if (viewerPanOffset <= -threshold) {
      elements.viewerImage.style.transform = "translateX(-120%)";
      setTimeout(async () => {
        resetViewerTransform();
        await showNext();
      }, 200);
    } else if (viewerPanOffset >= threshold) {
      elements.viewerImage.style.transform = "translateX(120%)";
      setTimeout(async () => {
        resetViewerTransform();
        await showPrevious();
      }, 200);
    } else {
      resetViewerTransform();
    }
  });

  viewerHammer.on("swipeleft", async () => {
    resetViewerTransform();
    await showNext();
  });

  viewerHammer.on("swiperight", async () => {
    resetViewerTransform();
    await showPrevious();
  });

  viewerHammer.on("tap", (ev) => {
    if (!state.viewer.open) {
      return;
    }
    const target = ev.target;
    if (target && typeof target.closest === "function") {
      if (target.closest(".viewer-nav, .viewer-close, #viewerDetailsPanel")) {
        return;
      }
    }
    setViewerDetailsVisibility(!state.viewer.detailsOpen);
  });

}


function updateFlyoutHandleState(expanded) {
  if (!elements.flyoutHandle) {
    return;
  }
  elements.flyoutHandle.classList.toggle("active", expanded);
  elements.flyoutHandle.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function shouldUseFlyoutBackdrop() {
  const maxTouchPoints = Number.isFinite(navigator.maxTouchPoints) ? navigator.maxTouchPoints : 0;
  return maxTouchPoints > 0;
}

function updateFlyoutBackdropState() {
  const visible = Boolean(
    elements.header
      && !elements.header.classList.contains("collapsed")
      && !state.flyoutPinned,
  );
  if (visible) {
    ensureFlyoutBackdrop();
  } else {
    removeFlyoutBackdrop();
  }
}

function isInsideFlyout(target) {
  if (!target) {
    return false;
  }
  if (elements.header && elements.header.contains(target)) {
    return true;
  }
  if (elements.flyoutHandle && elements.flyoutHandle.contains(target)) {
    return true;
  }
  return false;
}

function setHeaderCollapsed(collapsed) {
  if (!elements.header) return;
  if (state.flyoutPinned && collapsed) {
    collapsed = false;
  }
  if (collapsed) {
    elements.header.classList.add('collapsed');
    elements.header.classList.remove('expanded');
    elements.header.classList.remove('show');
  } else {
    elements.header.classList.remove('collapsed');
    elements.header.classList.add('expanded');
    elements.header.classList.add('show');
  }
  updateFlyoutHandleState(!collapsed);
  updateFlyoutBackdropState();
}

let headerHover = false;
let headerShownRecently = false;

function showHeader() {
  headerHover = true;
  setHeaderCollapsed(false);
  headerShownRecently = true;
}

function hideHeaderIfIdle(event) {
  if (event && elements.header) {
    const nextTarget = event.relatedTarget;
    if (!nextTarget) {
      return;
    }
    if (elements.header.contains(nextTarget)) {
      return;
    }
  }
  headerHover = false;
  if (state.flyoutPinned) {
    return;
  }
  if (!state.controlOpen) {
    setHeaderCollapsed(true);
  }
}

if (elements.header) {
  elements.header.addEventListener("mouseenter", showHeader);
  elements.header.addEventListener("mouseleave", hideHeaderIfIdle);
  elements.header.addEventListener("focusin", showHeader);
  elements.header.addEventListener("focusout", () => {
    setTimeout(() => {
      if (elements.header && !elements.header.contains(document.activeElement)) {
        hideHeaderIfIdle();
      }
    }, 150);
  });
  elements.header.addEventListener("touchstart", () => {
    showHeader();
  }, { passive: true });
}

if (elements.flyoutHandle) {
  const activateHandle = () => {
    headerHover = true;
    if (state.controlOpen) {
      closeControlPanel();
    } else {
      openControlPanel();
    }
    setHeaderCollapsed(false);
  };

  elements.flyoutHandle.addEventListener("mouseenter", () => {
    headerHover = true;
    setHeaderCollapsed(false);
  });

  elements.flyoutHandle.addEventListener("mouseleave", (event) => {
    if (!state.controlOpen) {
      hideHeaderIfIdle(event);
    }
  });

  elements.flyoutHandle.addEventListener("click", (event) => {
    event.preventDefault();
    activateHandle();
  });

  elements.flyoutHandle.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateHandle();
    }
  });
}

document.addEventListener("click", (event) => {
  if (!elements.header) {
    return;
  }
  const inHeader = elements.header.contains(event.target)
    || (elements.flyoutHandle && elements.flyoutHandle.contains(event.target));
  if (state.controlOpen) {
    if (!inHeader && !state.flyoutPinned) {
      suppressViewerOpen();
      closeControlPanel();
    }
  } else if (!inHeader && !headerHover && !state.flyoutPinned) {
    setHeaderCollapsed(true);
  }
});

updateDownloadControls();
updateRandomViewerSettingsAvailability();
renderRandomViewerChips();
updateFlyoutPinUI();
setActiveControlTab(state.activeControlTab);
updateFlyoutBackdropState();

setupViewerGestures();

document.addEventListener("keydown", async (event) => {
  if (event.key === "Escape") {
    if (state.viewer.open) {
      closeViewer();
      return;
    }
    if (state.controlOpen) {
      closeControlPanel();
      return;
    }
    if (state.flyoutPinned) {
      setFlyoutPinned(false);
      return;
    }
    setHeaderCollapsed(!headerHover);
  }
  if (!state.viewer.open) {
    return;
  }
  if (event.key === "ArrowRight") {
    if (state.randomViewer.running) {
      return;
    }
    await showNext();
  } else if (event.key === "ArrowLeft") {
    if (state.randomViewer.running) {
      return;
    }
    await showPrevious();
  }
});

elements.viewerOverlay.addEventListener("click", (event) => {
  if (event.target === elements.viewerOverlay) {
    closeViewer();
  }
});

window.addEventListener("popstate", () => {
  const params = new URLSearchParams(window.location.search);
  const orderParam = params.get("order") === "asc" ? "asc" : "desc";
  if (orderParam !== state.order) {
    applyOrder(orderParam);
    return;
  }
  const imagePath = params.get("image");
  if (imagePath) {
    openImageByPath(imagePath);
  } else if (state.viewer.open) {
    closeViewer();
  }
});

window.addEventListener("beforeunload", () => {
  if (!elements.searchScoreInput) {
    return;
  }
  const value = getSemanticScoreCutoff();
  persistSemanticScoreCutoff(value);
  flushSemanticScoreCutoffToServer(value);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden" || !elements.searchScoreInput) {
    return;
  }
  const value = getSemanticScoreCutoff();
  persistSemanticScoreCutoff(value);
  flushSemanticScoreCutoffToServer(value);
});

function init() {
  updateOrderUI();
  updateSearchHistoryControls();
  applySemanticScoreDefault();
  loadAppConfigDefaults()
    .finally(() => loadSemanticScoreCutoffFromServer());
  if (elements.controlContent) {
    elements.controlContent.setAttribute("aria-hidden", "true");
  }
  setHeaderCollapsed(true);
  if (elements.timeline) {
    elements.timeline.addEventListener("scroll", scheduleViewportLoading, { passive: true });
  }
  fetchHierarchy().then(() => {
    preloadInitialGroups();
    if (state.initialImagePath) {
      openImageByPath(state.initialImagePath);
      state.initialImagePath = null;
    }
  });
}

init();
