const STORAGE_KEY = `plainlet:history:${new URL('./', import.meta.url).pathname}`;

function decodeHistory(value) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    const ids = new Set();
    const texts = new Set();
    return parsed.filter((entry) => {
      if (!entry || typeof entry.id !== 'string' || !entry.id ||
          typeof entry.text !== 'string' || !entry.text.trim() ||
          ids.has(entry.id) || texts.has(entry.text)) return false;
      ids.add(entry.id);
      texts.add(entry.text);
      return true;
    }).map(({ id, text }) => Object.freeze({ id, text }));
  } catch {
    // A damaged or outdated value must not prevent pasting or future saves.
    return [];
  }
}

function applyOperations(entries, operations) {
  for (const operation of operations) {
    if (operation.type === 'add') {
      entries = [operation.entry, ...entries.filter((entry) => entry.text !== operation.entry.text)];
    } else if (operation.type === 'remove') {
      entries = entries.filter((entry) => entry.id !== operation.id);
    } else {
      entries = [];
    }
  }
  return entries;
}

/** Paste history is stored separately from the service worker's app cache. */
export function createPasteHistory() {
  const subscribers = new Set();
  let savedEntries = [];
  let pendingOperations = [];
  let persistent = true;

  function readSaved() {
    savedEntries = decodeHistory(window.localStorage.getItem(STORAGE_KEY));
  }

  try {
    readSaved();
  } catch {
    persistent = false;
  }
  let entries = savedEntries;

  function notify() {
    for (const subscriber of subscribers) subscriber([...entries]);
  }

  function mutate(operation) {
    let readable = true;
    try {
      // Rebase on the latest stored list so another tab's deletions stay deleted.
      readSaved();
    } catch {
      readable = false;
    }
    if (operation.type === 'clear') {
      savedEntries = [];
      pendingOperations = [];
    }
    pendingOperations.push(operation);
    entries = applyOperations(savedEntries, pendingOperations);
    persistent = false;

    if (readable) {
      try {
        if (entries.length) {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
        } else {
          window.localStorage.removeItem(STORAGE_KEY);
        }
        savedEntries = entries;
        pendingOperations = [];
        persistent = true;
      } catch {
        // Keep the current session usable when storage is blocked or full.
      }
    }
    notify();
    return persistent;
  }

  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    try {
      readSaved();
      entries = applyOperations(savedEntries, pendingOperations);
      persistent = pendingOperations.length === 0;
      notify();
    } catch {
      persistent = false;
    }
  });

  return {
    getEntries: () => [...entries],
    isPersistent: () => persistent,
    add(text) {
      if (typeof text !== 'string') throw new TypeError('Paste history accepts strings only.');
      if (!text.trim()) return persistent;
      const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      return mutate({ type: 'add', entry: Object.freeze({ id, text }) });
    },
    remove(id) {
      return mutate({ type: 'remove', id });
    },
    clear() {
      return mutate({ type: 'clear' });
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  };
}
