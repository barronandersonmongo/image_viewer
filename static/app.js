const INITIAL_PREFETCH_GROUPS = 2;
const GROUP_BATCH_SIZE = 3;
const SUBGROUP_BATCH_SIZE = 6;
const THUMBNAILS_PER_GROUP = 20;

const urlParams = new URLSearchParams(window.location.search);
const initialOrder = urlParams.get("order") === "asc" ? "asc" : "desc";
const initialImageParam = urlParams.get("image");

const state = {
  order: initialOrder,
  orderVersion: 0,
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
  viewer: {
    open: false,
    groupKey: null,
    index: -1,
  },
  initialImagePath: initialImageParam,
  activeThumb: null,
  controlOpen: false,
  download: {
    active: false,
    items: new Map(),
    perGroupCounts: new Map(),
    groupSelections: new Set(),
    inProgress: false,
  },
};

const elements = {
  timeline: document.getElementById("timeline"),
  timelineSections: document.getElementById("timelineSections"),
  timelineLoader: document.getElementById("timelineLoader"),
  flyoutHandle: document.getElementById("flyoutHandle"),
  viewerOverlay: document.getElementById("viewerOverlay"),
  viewerContainer: document.getElementById("viewerContainer"),
  viewerImage: document.getElementById("viewerImage"),
  viewerInfoTop: document.getElementById("viewerInfoTop"),
  viewerInfoBottom: document.getElementById("viewerInfoBottom"),
  viewerInfoLeft: document.getElementById("viewerInfoLeft"),
  viewerInfoRight: document.getElementById("viewerInfoRight"),
  viewerPrev: document.getElementById("viewerPrev"),
  viewerNext: document.getElementById("viewerNext"),
  viewerClose: document.getElementById("viewerClose"),
  header: document.getElementById("appHeader"),
  controlContent: document.getElementById("controlContent"),
  searchForm: document.getElementById("searchForm"),
  searchInput: document.getElementById("searchInput"),
  searchCombobox: document.getElementById("searchCombobox"),
  searchSuggestions: document.getElementById("searchSuggestions"),
  searchResults: document.getElementById("searchResults"),
  orderSwitch: document.getElementById("orderSwitch"),
  orderToggle: document.getElementById("orderToggle"),
  yearNavigation: document.getElementById("yearNavigation"),
  yearNavigationButtons: document.getElementById("yearNavigationButtons"),
  yearNavigationSelect: document.getElementById("yearNavigationSelect"),
  downloadControls: document.getElementById("downloadControls"),
  downloadToggle: document.getElementById("downloadToggle"),
  downloadCount: document.getElementById("downloadCount"),
  downloadButton: document.getElementById("downloadButton"),
  downloadClear: document.getElementById("downloadClear"),
};

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

function setGlobalLoaderVisible(visible) {
  elements.timelineLoader.classList.toggle("visible", visible);
}

function formatPhotoCount(count) {
  const value = Number.isFinite(count) ? Math.max(0, count) : 0;
  const formatted = value.toLocaleString();
  return `${formatted} photo${value === 1 ? "" : "s"}`;
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
    label: group.label,
    count: group.count || 0,
    dateValue: typeof group.dateValue === "number" ? group.dateValue : 0,
  }));
  options.sort((a, b) => {
    if (a.dateValue !== b.dateValue) {
      return b.dateValue - a.dateValue;
    }
    return b.label.localeCompare(a.label, undefined, { numeric: true, sensitivity: "base" });
  });
  state.topGroupOptions = options;
  state.combobox.filtered = options.slice();
  renderYearNavigation(options);
  renderComboboxOptions();
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
  const normalized = query.trim().toLowerCase();
  if (!state.topGroupOptions.length) {
    state.combobox.filtered = [];
    renderComboboxOptions();
    return;
  }
  const filtered = normalized
    ? state.topGroupOptions.filter((option) => option.label.toLowerCase().includes(normalized))
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
  element.setAttribute("aria-pressed", selected ? "true" : "false");
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
      groupState.selectButton.textContent = fullySelected ? "Deselect date" : "Select date";
    }
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
  if (elements.downloadControls) {
    elements.downloadControls.classList.toggle("has-selection", selectedCount > 0);
    elements.downloadControls.classList.toggle("is-busy", state.download.inProgress);
    elements.downloadControls.classList.toggle("is-active", state.download.active);
  }
  if (elements.downloadCount) {
    if (selectedCount > 0) {
      elements.downloadCount.textContent = `${selectedCount.toLocaleString()} selected`;
      elements.downloadCount.hidden = false;
    } else {
      elements.downloadCount.hidden = true;
      elements.downloadCount.textContent = "";
    }
  }
  if (elements.downloadButton) {
    elements.downloadButton.disabled = selectedCount === 0 || state.download.inProgress;
    elements.downloadButton.textContent = state.download.inProgress ? "Preparing…" : "Download";
  }
  if (elements.downloadClear) {
    elements.downloadClear.disabled = selectedCount === 0 || state.download.inProgress;
  }
  if (elements.downloadToggle) {
    elements.downloadToggle.classList.toggle("active", state.download.active);
    elements.downloadToggle.setAttribute("aria-pressed", state.download.active ? "true" : "false");
    elements.downloadToggle.textContent = state.download.active ? "Exit selection" : "Select images";
    elements.downloadToggle.disabled = state.download.inProgress;
  }
}

function setDownloadMode(active) {
  const normalized = Boolean(active);
  if (state.download.active === normalized) {
    return;
  }
  state.download.active = normalized;
  if (elements.timeline) {
    elements.timeline.classList.toggle("download-mode", normalized);
  }
  updateDownloadControls();
}

function resetDownloadState({ keepMode = false } = {}) {
  const preserveMode = Boolean(keepMode && state.download.active);
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
        groupState.selectButton.textContent = "Select date";
      }
    }
    if (groupState.selectedCountElement) {
      groupState.selectedCountElement.hidden = true;
      groupState.selectedCountElement.textContent = "";
    }
  });
  if (elements.timeline) {
    elements.timeline.classList.toggle("download-mode", preserveMode);
  }
  state.download.active = preserveMode;
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

function toggleGroupDownloadSelection(groupKey, desiredState) {
  if (state.download.inProgress) {
    return;
  }
  const groupState = state.groups.get(groupKey);
  if (!groupState) {
    return;
  }
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
  const path = button.dataset.path;
  const wantsSelection = state.download.active || event.metaKey || event.ctrlKey;
  if (wantsSelection && path) {
    event.preventDefault();
    event.stopPropagation();
    if (state.download.inProgress) {
      return;
    }
    if (!state.download.active) {
      setDownloadMode(true);
    }
    toggleImageSelection(path, groupKey);
    return;
  }
  if (button.disabled) {
    event.preventDefault();
    return;
  }
  openViewerAt(groupKey, index);
}

function clearDownloadSelection({ keepMode = false } = {}) {
  resetDownloadState({ keepMode });
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
    clearDownloadSelection({ keepMode: state.download.active });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    alert(`Unable to download images: ${message}`);
  } finally {
    state.download.inProgress = false;
    updateDownloadControls();
  }
}

function handleDownloadToggleClick(event) {
  event.preventDefault();
  setDownloadMode(!state.download.active);
}

function handleDownloadClearClick(event) {
  event.preventDefault();
  clearDownloadSelection({ keepMode: true });
}

async function handleDownloadButtonClick(event) {
  event.preventDefault();
  await initiateDownload();
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
  if (!elements.header || !elements.controlContent || state.controlOpen) {
    return;
  }
  state.controlOpen = true;
  setHeaderCollapsed(false);
  elements.controlContent.setAttribute("aria-hidden", "false");
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
}

function closeControlPanel() {
  if (!state.controlOpen || !elements.header || !elements.controlContent) {
    return;
  }
  state.controlOpen = false;
  setHeaderCollapsed(!headerHover);
  elements.controlContent.setAttribute("aria-hidden", "true");
  if (elements.searchInput) {
    elements.searchInput.value = "";
  }
  if (elements.searchResults) {
    elements.searchResults.innerHTML = "";
  }
}

function updateOrderUI() {
  if (!elements.orderToggle || !elements.orderSwitch) {
    return;
  }
  elements.orderToggle.checked = state.order === "asc";
  elements.orderToggle.setAttribute("aria-checked", state.order === "asc" ? "true" : "false");
  elements.orderSwitch.classList.toggle("asc", state.order === "asc");
}

function resetStateForOrder() {
  resetDownloadState();
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
  state.viewer = { open: false, groupKey: null, index: -1 };
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
    const data = await fetchJson(`/api/hierarchy?order=${state.order}`);
    resetStateForOrder();
    const imagesByGroup = data.imagesByGroup || {};
    state.imagesByGroup = new Map(
      Object.entries(imagesByGroup).map(([key, list]) => [key, Array.isArray(list) ? list : []]),
    );
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
  heading.textContent = topGroup.label;
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

  const manifest = state.imagesByGroup.get(subgroup.key) || [];
  const totalCount = manifest.length || subgroup.count || 0;

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
    metaRow.appendChild(locationElement);
  }

  const selectedCountElement = document.createElement("span");
  selectedCountElement.className = "subgroup-selected-count";
  selectedCountElement.hidden = true;
  metaRow.appendChild(selectedCountElement);

  headingText.appendChild(metaRow);
  header.appendChild(headingText);

  const actions = document.createElement("div");
  actions.className = "subgroup-actions";
  const selectButton = document.createElement("button");
  selectButton.type = "button";
  selectButton.className = "group-select-toggle";
  selectButton.dataset.groupKey = subgroup.key;
  selectButton.setAttribute("aria-pressed", "false");
  if (totalCount === 0) {
    selectButton.textContent = "No photos";
    selectButton.disabled = true;
  } else {
    selectButton.textContent = "Select date";
  }
  actions.appendChild(selectButton);
  header.appendChild(actions);

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
  };

  state.groups.set(subgroup.key, groupState);
  state.groupSequence.push(subgroup.key);

  if (groupState.selectButton) {
    groupState.selectButton.addEventListener("click", () => {
      if (!state.download.active) {
        setDownloadMode(true);
      }
      toggleGroupDownloadSelection(groupState.key);
    });
  }

  if (totalCount > 0) {
    renderNextThumbnails(groupState, Math.min(THUMBNAILS_PER_GROUP, totalCount));
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
  if (!groupState || !groupState.manifest) {
    return;
  }
  const startIndex = groupState.renderedCount || 0;
  const total = groupState.manifest.length;
  if (startIndex >= total) {
    return;
  }
  const endIndex = Math.min(total, startIndex + batchSize);
  const fragment = document.createDocumentFragment();

  for (let index = startIndex; index < endIndex; index += 1) {
    const meta = groupState.manifest[index] || {};
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thumbnail-button placeholder";
    button.classList.add("downloadable");
    button.disabled = true;
    button.tabIndex = -1;
    button.setAttribute("aria-hidden", "true");
    button.setAttribute("aria-pressed", "false");
    button.dataset.groupKey = groupState.key;
    button.dataset.index = String(index);
    if (meta.path) {
      button.dataset.path = meta.path;
    }

    button.addEventListener("click", (event) => {
      handleThumbnailClick(event, groupState.key, index);
    });

    const indicator = document.createElement("span");
    indicator.className = "thumbnail-select-indicator";
    indicator.setAttribute("aria-hidden", "true");
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
  if (!groupState || !groupState.manifest) {
    return;
  }
  if (groupState.renderedCount >= groupState.manifest.length) {
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

function ensureGroupLoaded(groupKey) {
  const groupState = state.groups.get(groupKey);
  if (!groupState) {
    return Promise.resolve();
  }
  if (groupState.renderedCount === 0) {
    renderNextThumbnails(groupState, THUMBNAILS_PER_GROUP);
  }
  return Promise.resolve();
}

let scrollIdleHandle = null;

function loadVisibleGroups() {
  if (!elements.timeline) {
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
    ensureGroupLoaded(key);
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
    ensureGroupLoaded(state.groupSequence[firstIndex - 1]);
  }
  if (lastIndex !== undefined && lastIndex + 1 < state.groupSequence.length) {
    ensureGroupLoaded(state.groupSequence[lastIndex + 1]);
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
  const manifest = groupState.manifest || state.imagesByGroup.get(groupKey) || [];
  const targetIndex = manifest.findIndex((item) => item && item.path === path);
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
  const groupState = state.groups.get(groupKey);
  if (!groupState || index < 0 || index >= groupState.images.length) {
    return;
  }
  const targetItem = groupState.images[index];
  if (!targetItem || !targetItem.element) {
    return;
  }
  state.viewer.open = true;
  state.viewer.groupKey = groupKey;
  state.viewer.index = index;
  elements.viewerOverlay.hidden = false;
  document.body.classList.add("viewer-open");
  if (elements.header) {
    elements.header.classList.add("viewer-hidden");
  }
  showViewerLoading();
  updateUrlWithImage(targetItem.path);
  renderViewer();
}

function closeViewer() {
  state.viewer.open = false;
  state.viewer.groupKey = null;
  state.viewer.index = -1;
  elements.viewerOverlay.hidden = true;
  document.body.classList.remove("viewer-open");
  if (elements.header) {
    elements.header.classList.remove("viewer-hidden");
    if (!state.controlOpen && !headerHover) {
      setHeaderCollapsed(true);
    }
  }
  updateUrlWithImage(null);
  if (state.activeThumb) {
    state.activeThumb.classList.remove("active");
    state.activeThumb = null;
  }
  showViewerLoading();
}

function renderViewer() {
  if (!state.viewer.open) {
    return;
  }
  const groupState = state.groups.get(state.viewer.groupKey);
  if (!groupState) {
    return;
  }
  const item = groupState.images[state.viewer.index];
  if (!item) {
    return;
  }
  showViewerLoading();
  elements.viewerImage.src = `/api/image?path=${encodeURIComponent(item.path)}`;
  elements.viewerImage.alt = item.name;
  const finalize = () => {
    updateViewerMetadata(groupState, item);
    highlightActiveThumbnail(item);
    elements.viewerImage.removeEventListener("load", finalize);
    elements.viewerImage.removeEventListener("error", handleError);
  };
  const handleError = () => {
    setInfoBar(elements.viewerInfoTop, "Failed to load image", "block");
    setInfoBar(elements.viewerInfoBottom, item.name || "", item.name ? "block" : "none");
    setInfoBar(elements.viewerInfoLeft, "", "block");
    setInfoBar(elements.viewerInfoRight, "", "block");
    highlightActiveThumbnail(item);
    if (elements.viewerContainer) {
      elements.viewerContainer.classList.remove("portrait");
    }
    elements.viewerImage.removeEventListener("load", finalize);
    elements.viewerImage.removeEventListener("error", handleError);
  };
  elements.viewerImage.addEventListener("load", finalize);
  elements.viewerImage.addEventListener("error", handleError);
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

function showViewerLoading() {
  if (elements.viewerContainer) {
    elements.viewerContainer.classList.remove("portrait");
  }
  resetViewerTransform();
  setInfoBar(elements.viewerInfoTop, "Loading image…", "block");
  setInfoBar(elements.viewerInfoBottom, "", "block");
  setInfoBar(elements.viewerInfoLeft, "", "block");
  setInfoBar(elements.viewerInfoRight, "", "block");
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
  const currentGroup = state.groups.get(state.viewer.groupKey);
  if (!currentGroup) {
    return;
  }
  const nextIndex = state.viewer.index + 1;
  const currentManifest = currentGroup.manifest || state.imagesByGroup.get(currentGroup.key) || [];
  if (nextIndex < currentGroup.images.length) {
    const entry = currentGroup.images[nextIndex];
    if (entry && entry.element) {
      openViewerAt(currentGroup.key, nextIndex);
      return;
    }
    const manifestItem = currentManifest[nextIndex];
    if (manifestItem && manifestItem.path) {
      const resolvedIndex = await ensureImageLoaded(manifestItem.path, currentGroup.key);
      if (resolvedIndex !== -1) {
        openViewerAt(currentGroup.key, resolvedIndex);
        return;
      }
    }
  }
  const nextGroupKey = getAdjacentGroupKey(currentGroup.key, 1);
  if (!nextGroupKey) {
    return;
  }
  await ensureGroupLoaded(nextGroupKey);
  const nextGroup = state.groups.get(nextGroupKey);
  if (!nextGroup) {
    return;
  }
  const nextManifest = nextGroup.manifest || state.imagesByGroup.get(nextGroupKey) || [];
  const target = nextManifest[0];
  if (target && target.path) {
    const resolvedIndex = await ensureImageLoaded(target.path, nextGroupKey);
    if (resolvedIndex !== -1) {
      openViewerAt(nextGroupKey, resolvedIndex);
    }
  }
}

async function showPrevious() {
  if (!state.viewer.open) {
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
      openViewerAt(currentGroup.key, prevIndex);
      return;
    }
    const manifest = currentGroup.manifest || state.imagesByGroup.get(currentGroup.key) || [];
    const manifestItem = manifest[prevIndex];
    if (manifestItem && manifestItem.path) {
      const resolvedIndex = await ensureImageLoaded(manifestItem.path, currentGroup.key);
      if (resolvedIndex !== -1) {
        openViewerAt(currentGroup.key, resolvedIndex);
        return;
      }
    }
  }
  const prevGroupKey = getAdjacentGroupKey(currentGroup.key, -1);
  if (!prevGroupKey) {
    return;
  }
  await ensureGroupLoaded(prevGroupKey);
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
        openViewerAt(prevGroupKey, resolvedIndex);
      }
    }
  }
}

async function openImageByPath(path) {
  const groupKey = deriveGroupKey(path);
  if (!state.groups.has(groupKey)) {
    await fetchHierarchy();
  }
  const groupState = state.groups.get(groupKey);
  if (!groupState) {
    alert("Unable to locate the requested folder.");
    return;
  }
  await ensureGroupLoaded(groupKey);
  const index = await ensureImageLoaded(path, groupKey);
  if (index === -1) {
    alert("Unable to locate the requested image.");
    return;
  }
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
    ensureGroupLoaded(key);
  });
  scheduleViewportLoading();
}

function handleSearch(event) {
  event.preventDefault();
  openControlPanel();
  closeCombobox();
  const query = elements.searchInput.value.trim().toLowerCase();
  if (!query) {
      closeControlPanel();
    return;
  }
  const matches = [];
  state.topGroups.forEach((topGroup) => {
    const topLabel = topGroup.label;
    const subgroups = Array.isArray(topGroup.subgroups) ? topGroup.subgroups : [];
    subgroups.forEach((subgroup) => {
      const subgroupLabel = subgroup.formattedLabel || subgroup.label;
      const location = typeof subgroup.location === "string" ? subgroup.location : "";
      const haystack = `${topLabel} ${subgroupLabel} ${location}`.toLowerCase();
      if (!haystack.includes(query)) {
        return;
      }
      const manifest = state.imagesByGroup.get(subgroup.key) || [];
      const count = manifest.length || subgroup.count || 0;
      matches.push({
        key: subgroup.key,
        topLabel,
        label: subgroup.label,
        displayLabel: subgroupLabel,
        location,
        count,
      });
    });
  });
  renderSearchResults(matches);
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
    item.textContent = parts.join(" • ");
    elements.searchResults.appendChild(item);
  });
}

elements.searchResults.addEventListener("click", async (event) => {
  const target = event.target.closest(".search-result");
  if (!target || !target.dataset.groupKey) {
    return;
  }
  const key = target.dataset.groupKey;
  ensureSubgroupRendered(key);
  const entry = state.groups.get(key);
  if (!entry) {
    return;
  }
  entry.container.scrollIntoView({ behavior: "smooth", block: "start" });
  await ensureGroupLoaded(key);
  const nextKey = getAdjacentGroupKey(key, 1);
  if (nextKey) {
    ensureGroupLoaded(nextKey);
  }
  scheduleViewportLoading();
  closeControlPanel();
});

elements.searchForm.addEventListener("submit", handleSearch);

if (elements.searchInput) {
  elements.searchInput.addEventListener("focus", handleSearchInputFocus);
  elements.searchInput.addEventListener("input", handleSearchInputInput);
  elements.searchInput.addEventListener("keydown", handleSearchInputKeyDown);
  elements.searchInput.addEventListener("blur", handleSearchInputBlur);
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
    navigateToTopGroup(target.dataset.topKey);
    closeControlPanel();
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

if (elements.downloadToggle) {
  elements.downloadToggle.addEventListener("click", handleDownloadToggleClick);
}

if (elements.downloadClear) {
  elements.downloadClear.addEventListener("click", handleDownloadClearClick);
}

if (elements.downloadButton) {
  elements.downloadButton.addEventListener("click", handleDownloadButtonClick);
}

if (elements.orderToggle) {
  elements.orderToggle.addEventListener("change", () => {
    const nextOrder = elements.orderToggle.checked ? "asc" : "desc";
    applyOrder(nextOrder, { updateUrl: true });
  });
}

if (elements.orderSwitch) {
  elements.orderSwitch.addEventListener("click", (event) => {
    const textNode = event.target.closest(".order-text");
    if (!textNode) {
      return;
    }
    const nextOrder = textNode.classList.contains("order-text-right") ? "asc" : "desc";
    if (nextOrder === state.order) {
      return;
    }
    elements.orderToggle.checked = nextOrder === "asc";
    applyOrder(nextOrder, { updateUrl: true });
  });
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

}


function updateFlyoutHandleState(expanded) {
  if (!elements.flyoutHandle) {
    return;
  }
  elements.flyoutHandle.classList.toggle("active", expanded);
  elements.flyoutHandle.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function setHeaderCollapsed(collapsed) {
  if (!elements.header) return;
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
}

let headerHover = false;
let headerShownRecently = false;

function showHeader() {
  headerHover = true;
  setHeaderCollapsed(false);
  headerShownRecently = true;
}

function hideHeaderIfIdle() {
  headerHover = false;
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
    setTimeout(() => {
      if (!state.controlOpen) {
        hideHeaderIfIdle();
      }
    }, 1200);
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

  elements.flyoutHandle.addEventListener("mouseleave", () => {
    headerHover = false;
    if (!state.controlOpen) {
      hideHeaderIfIdle();
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

  elements.flyoutHandle.addEventListener("touchstart", () => {
    headerHover = true;
    setHeaderCollapsed(false);
  }, { passive: true });
}

document.addEventListener("click", (event) => {
  if (!elements.header) {
    return;
  }
  const inHeader = elements.header.contains(event.target);
  if (state.controlOpen) {
    if (!inHeader) {
      closeControlPanel();
    }
  } else if (!inHeader && !headerHover) {
    setHeaderCollapsed(true);
  }
});

updateDownloadControls();

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
    if (state.download.active && !state.download.inProgress) {
      setDownloadMode(false);
      return;
    }
    setHeaderCollapsed(!headerHover);
  }
  if (!state.viewer.open) {
    return;
  }
  if (event.key === "ArrowRight") {
    await showNext();
  } else if (event.key === "ArrowLeft") {
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

function init() {
  updateOrderUI();
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
