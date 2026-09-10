(function () {
  "use strict";

  let loadedRecords = [];
  let sortedIndex = [];
  let buckets = new Map();
  let isReady = false;
  let lastProgressAt = 0;

  // Match app.js normalization so queries and titles compare the same way.
  function normalize(value) {
    return value
      .replace(/_/g, " ")
      .trim()
      .toLocaleLowerCase()
      .replace(/\s+/g, " ");
  }

  // Use the first normalized character to group titles for partial search.
  function bucketKey(normalizedTitle) {
    return normalizedTitle.charAt(0) || "#";
  }

  // Convert one raw line into a searchable record and add it to partial indexes.
  function addTitle(rawTitle) {
    const originalTitle = rawTitle.trim();
    const normalizedTitle = normalize(originalTitle);

    if (!normalizedTitle) {
      return;
    }

    const record = [normalizedTitle, originalTitle];
    const key = bucketKey(normalizedTitle);

    loadedRecords.push(record);

    if (!buckets.has(key)) {
      buckets.set(key, []);
    }

    buckets.get(key).push(record);
  }

  // Find the first sorted title whose normalized value is >= the query.
  function lowerBound(query) {
    let low = 0;
    let high = sortedIndex.length;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);

      if (sortedIndex[mid][0] < query) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    return low;
  }

  // Search the completed sorted index using binary search plus a short forward scan.
  function searchSorted(query, maxResults) {
    const matches = [];
    let index = lowerBound(query);

    while (index < sortedIndex.length && matches.length < maxResults) {
      const [normalizedTitle, originalTitle] = sortedIndex[index];

      if (!normalizedTitle.startsWith(query)) {
        break;
      }

      matches.push(originalTitle);
      index += 1;
    }

    return matches;
  }

  // Search titles loaded so far while the full file is still streaming.
  function searchLoaded(query, maxResults) {
    const matches = [];
    const candidates = buckets.get(bucketKey(query)) || [];

    for (const [normalizedTitle, originalTitle] of candidates) {
      if (normalizedTitle.startsWith(query)) {
        matches.push(originalTitle);
      }

      if (matches.length >= maxResults) {
        break;
      }
    }

    return matches;
  }

  // Route each query to partial search before ready, or binary search after ready.
  function findMatches(rawQuery, maxResults) {
    const query = normalize(rawQuery);

    if (!query) {
      return [];
    }

    if (isReady) {
      return searchSorted(query, maxResults);
    }

    return searchLoaded(query, maxResults);
  }

  // Throttle progress messages so the UI is informative without being noisy.
  function sendProgress(loadedBytes, totalBytes) {
    const now = Date.now();

    if (now - lastProgressAt < 250) {
      return;
    }

    lastProgressAt = now;

    self.postMessage({
      type: "progress",
      loadedCount: loadedRecords.length,
      loadedBytes,
      totalBytes,
    });
  }

  // Try each configured source in order and return the first successful response.
  async function fetchFromSources(sources) {
    const errors = [];

    for (const source of sources) {
      try {
        const response = await fetch(source.url);

        if (!response.ok) {
          throw new Error(`${source.label} failed with status ${response.status}`);
        }

        return response;
      } catch (error) {
        errors.push(error.message);
      }
    }

    throw new Error(errors.join("; "));
  }

  // Load, parse, sort, and publish the final searchable title index.
  async function loadTitles(sources) {
    try {
      const response = await fetchFromSources(sources);
      const totalBytes = Number(response.headers.get("content-length")) || 0;
      const reader = response.body && response.body.getReader();

      if (!reader) {
        const text = await response.text();
        parseText(text);
      } else {
        await parseStream(reader, totalBytes);
      }

      self.postMessage({
        type: "sorting",
        count: loadedRecords.length,
      });

      buckets = new Map();
      sortedIndex = loadedRecords;
      sortedIndex.sort(function (left, right) {
        if (left[0] < right[0]) {
          return -1;
        }

        if (left[0] > right[0]) {
          return 1;
        }

        return 0;
      });

      loadedRecords = [];
      isReady = true;

      self.postMessage({
        type: "ready",
        count: sortedIndex.length,
      });
    } catch (error) {
      self.postMessage({
        type: "error",
        message:
          "Could not load the title file. Check the network connection or CORS settings.",
        detail: error.message,
      });
    }
  }

  // Fallback parser for browsers that do not expose a readable response stream.
  function parseText(text) {
    for (const title of text.split(/\r?\n/)) {
      addTitle(title);
    }
  }

  // Parse streamed chunks into complete title lines without waiting for full download.
  async function parseStream(reader, totalBytes) {
    const decoder = new TextDecoder();
    let bufferedText = "";
    let loadedBytes = 0;

    while (true) {
      const result = await reader.read();

      if (result.done) {
        break;
      }

      loadedBytes += result.value.byteLength;
      bufferedText += decoder.decode(result.value, { stream: true });

      const lines = bufferedText.split(/\r?\n/);
      bufferedText = lines.pop() || "";

      for (const title of lines) {
        addTitle(title);
      }

      sendProgress(loadedBytes, totalBytes);
    }

    bufferedText += decoder.decode();

    if (bufferedText) {
      addTitle(bufferedText);
    }

    self.postMessage({
      type: "progress",
      loadedCount: loadedRecords.length,
      loadedBytes,
      totalBytes,
    });
  }

  self.addEventListener("message", function (event) {
    const message = event.data;

    if (message.type === "load") {
      loadTitles(message.sources);
      return;
    }

    if (message.type === "query") {
      self.postMessage({
        type: "results",
        requestId: message.requestId,
        results: findMatches(message.query, message.maxResults),
        isPartial: !isReady,
      });
    }
  });
})();
