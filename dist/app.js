(function () {
  "use strict";

  const TITLE_SOURCES = [
    {
      label: "Local proxy",
      url: "/wikipedia-latest-titles.txt",
    },
    {
      label: "S3",
      url: "https://charta-public.s3.us-east-2.amazonaws.com/interview/wikipedia-latest-titles.txt",
    },
    {
      label: "Notion",
      url: "https://file.notion.so/f/f/c7bb86eb-fa3b-4667-85b8-304db4bd37fc/64c076a6-b90c-4fad-887b-c60cacb5c2db/wikipedia-latest-titles.txt?table=block&id=3d5a0739-fda7-80aa-a720-c9de99b0209e&spaceId=c7bb86eb-fa3b-4667-85b8-304db4bd37fc&expirationTimestamp=1789084800000&signature=x2lh1MYiKYX8JPCte8canfDI4FlJHScD9Rpwtx1Sr0k&downloadName=wikipedia-latest-titles.txt",
    },
  ];

  const MAX_RESULTS = 10;
  const MAX_HISTORY = 6;
  const HISTORY_KEY = "wikipedia-autocomplete-history";

  const input = document.getElementById("searchInput");
  const suggestions = document.getElementById("suggestions");
  const status = document.getElementById("status");
  const countPill = document.getElementById("countPill");
  const combobox = document.querySelector(".combobox");

  const worker = new Worker("./search-worker.js");

  let currentResults = [];
  let currentHistory = [];
  let selectedIndex = -1;
  let latestRequestId = 0;
  let hasCompleteIndex = false;
  let loadedCount = 0;
  let activeList = "none";

  // Keep query/title matching consistent between display text and worker search.
  function normalize(value) {
    return value
      .replace(/_/g, " ")
      .trim()
      .toLocaleLowerCase()
      .replace(/\s+/g, " ");
  }

  function displayTitle(value) {
    return value.replace(/_/g, " ");
  }

  // Convert a title into the required Wikipedia page URL format.
  function createWikipediaUrl(title) {
    const path = displayTitle(title).trim().replace(/\s+/g, "_");
    return `http://wikipedia.org/wiki/${encodeURIComponent(path)}`;
  }

  function setStatus(message) {
    status.textContent = message;
  }

  function setExpanded(isExpanded) {
    combobox.setAttribute("aria-expanded", String(isExpanded));
  }

  function formatCount(count) {
    return new Intl.NumberFormat().format(count);
  }

  // Reset all visible dropdown state, including active keyboard selection.
  function clearSuggestions() {
    currentResults = [];
    currentHistory = [];
    selectedIndex = -1;
    activeList = "none";
    suggestions.innerHTML = "";
    input.removeAttribute("aria-activedescendant");
    setExpanded(false);
  }

  // Escape title text before injecting highlighted markup into suggestion rows.
  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, function (character) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      }[character];
    });
  }

  // Bold the matched prefix while preserving the original display title.
  function highlightPrefix(title, query) {
    const visibleTitle = displayTitle(title);
    const normalizedQuery = normalize(query);

    if (!normalizedQuery) {
      return escapeHtml(visibleTitle);
    }

    const comparableVisibleTitle = normalize(visibleTitle);

    if (!comparableVisibleTitle.startsWith(normalizedQuery)) {
      return escapeHtml(visibleTitle);
    }

    const prefixLength = query.replace(/_/g, " ").trim().length;
    const prefix = visibleTitle.slice(0, prefixLength);
    const rest = visibleTitle.slice(prefixLength);

    return `<mark>${escapeHtml(prefix)}</mark>${escapeHtml(rest)}`;
  }

  // Read recent queries from localStorage; failures should not break search.
  function loadHistory() {
    try {
      const savedHistory = JSON.parse(localStorage.getItem(HISTORY_KEY));
      return Array.isArray(savedHistory) ? savedHistory.filter(Boolean) : [];
    } catch (error) {
      return [];
    }
  }

  // Store the query that led to an opened result, newest first and deduplicated.
  function saveHistory(query) {
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      return;
    }

    const normalizedQuery = normalize(trimmedQuery);
    const nextHistory = [
      trimmedQuery,
      ...loadHistory().filter(function (historyItem) {
        return normalize(historyItem) !== normalizedQuery;
      }),
    ].slice(0, MAX_HISTORY);

    localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory));
  }

  // Show recent searches when the input is empty.
  function renderHistory() {
    const nextHistory = loadHistory();
    const nextSelectedIndex =
      activeList === "history" && selectedIndex >= 0
        ? Math.min(selectedIndex, nextHistory.length - 1)
        : 0;

    currentResults = [];
    currentHistory = nextHistory;
    selectedIndex = currentHistory.length > 0 ? nextSelectedIndex : -1;
    activeList = currentHistory.length > 0 ? "history" : "none";
    suggestions.innerHTML = "";
    input.removeAttribute("aria-activedescendant");

    if (currentHistory.length === 0) {
      setExpanded(false);
      return;
    }

    currentHistory.forEach(function (query, index) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      const id = `history-${index}`;

      item.id = id;
      item.className = "suggestion history-item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === selectedIndex));

      button.type = "button";
      button.className = "suggestion-action";
      button.textContent = query;
      button.addEventListener("click", function () {
        chooseHistory(index);
      });

      if (index === selectedIndex) {
        item.classList.add("is-selected");
        input.setAttribute("aria-activedescendant", id);
      }

      item.appendChild(button);
      suggestions.appendChild(item);
    });

    setExpanded(true);
  }

  // Render worker results as clickable Wikipedia links.
  function renderSuggestions(results, isPartial) {
    suggestions.innerHTML = "";
    input.removeAttribute("aria-activedescendant");

    if (!input.value.trim()) {
      renderHistory();
      return;
    }

    activeList = "results";
    currentHistory = [];

    if (results.length === 0) {
      const item = document.createElement("li");
      item.className = "empty-state";
      item.textContent = isPartial
        ? "No matches in loaded titles yet"
        : "No matching titles";
      suggestions.appendChild(item);
      setExpanded(true);
      return;
    }

    results.forEach(function (title, index) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      const id = `suggestion-${index}`;

      item.id = id;
      item.className = "suggestion";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === selectedIndex));

      link.className = "suggestion-action";
      link.href = createWikipediaUrl(title);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.innerHTML = highlightPrefix(title, input.value);
      link.addEventListener("click", function () {
        saveHistory(input.value);
      });

      if (index === selectedIndex) {
        item.classList.add("is-selected");
        input.setAttribute("aria-activedescendant", id);
      }

      item.appendChild(link);
      suggestions.appendChild(item);
    });

    setExpanded(true);
  }

  // Send the latest query to the worker; request IDs let us ignore stale replies.
  function requestSuggestions() {
    latestRequestId += 1;

    if (!input.value.trim()) {
      renderHistory();
      return;
    }

    worker.postMessage({
      type: "query",
      query: input.value,
      requestId: latestRequestId,
      maxResults: MAX_RESULTS,
    });
  }

  // Open the highlighted result and remember the query in search history.
  function chooseSuggestion(index) {
    const title = currentResults[index];

    if (!title) {
      return;
    }

    saveHistory(input.value);
    window.open(createWikipediaUrl(title), "_blank", "noopener,noreferrer");
    clearSuggestions();
    setStatus(`Opened "${displayTitle(title)}"`);
  }

  // Restore a previous query and run it through the same worker search path.
  function chooseHistory(index) {
    const query = currentHistory[index];

    if (!query) {
      return;
    }

    input.value = query;
    input.focus();
    requestSuggestions();
  }

  // Support combobox-style keyboard navigation for results and history.
  function handleKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      clearSuggestions();
      return;
    }

    const activeItems =
      activeList === "history" ? currentHistory : currentResults;

    if (!activeItems.length) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectedIndex = (selectedIndex + 1) % activeItems.length;
      rerenderActiveList();
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedIndex =
        (selectedIndex - 1 + activeItems.length) % activeItems.length;
      rerenderActiveList();
    }

    if (event.key === "Enter" && selectedIndex >= 0) {
      event.preventDefault();

      if (activeList === "history") {
        chooseHistory(selectedIndex);
      } else {
        chooseSuggestion(selectedIndex);
      }
    }
  }

  // Refresh whichever dropdown list is currently active after selection changes.
  function rerenderActiveList() {
    if (activeList === "history") {
      renderHistory();
      return;
    }

    renderSuggestions(currentResults, !hasCompleteIndex);
  }

  // Apply progress, readiness, result, and error messages from the search worker.
  function handleWorkerMessage(event) {
    const message = event.data;

    if (message.type === "progress") {
      loadedCount = message.loadedCount;
      countPill.textContent = `${formatCount(loadedCount)} loaded`;

      if (message.loadedBytes && message.totalBytes) {
        const loadedMb = Math.round(message.loadedBytes / 1024 / 1024);
        const totalMb = Math.round(message.totalBytes / 1024 / 1024);
        setStatus(`Loading titles... ${loadedMb} MB of ${totalMb} MB`);
      } else {
        setStatus("Loading titles... results are partial");
      }

      return;
    }

    if (message.type === "sorting") {
      countPill.textContent = `${formatCount(message.count)} loaded`;
      setStatus("Sorting final index... searches may pause briefly");
      return;
    }

    if (message.type === "ready") {
      hasCompleteIndex = true;
      loadedCount = message.count;
      countPill.textContent = `${formatCount(loadedCount)} titles`;
      setStatus("Ready");
      requestSuggestions();
      return;
    }

    if (message.type === "results") {
      if (message.requestId !== latestRequestId) {
        return;
      }

      currentResults = message.results;
      selectedIndex = currentResults.length > 0 ? 0 : -1;
      activeList = currentResults.length > 0 ? "results" : "none";
      renderSuggestions(currentResults, message.isPartial);

      if (message.isPartial && input.value.trim()) {
        setStatus("Searching loaded titles while the full index builds");
      }

      return;
    }

    if (message.type === "error") {
      countPill.textContent = "Error";
      setStatus(message.message);
    }
  }

  input.disabled = false;
  input.focus();
  countPill.textContent = "Loading";
  setStatus("Loading titles... you can start typing now");

  input.addEventListener("input", requestSuggestions);
  input.addEventListener("keydown", handleKeydown);
  input.addEventListener("focus", function () {
    if (!input.value.trim()) {
      renderHistory();
    }
  });

  document.addEventListener("click", function (event) {
    if (!combobox.contains(event.target)) {
      clearSuggestions();
    }
  });

  worker.addEventListener("message", handleWorkerMessage);
  worker.postMessage({
    type: "load",
    sources: TITLE_SOURCES,
  });
})();
