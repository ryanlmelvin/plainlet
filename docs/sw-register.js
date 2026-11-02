const UPDATE_TEXT_KEY = `plainlet:update-text:${new URL('./', document.baseURI).pathname}`;

// This snapshot exists only for an explicitly requested update, never ordinary edits.
export function restoreUpdateText(input) {
  try {
    const saved = sessionStorage.getItem(UPDATE_TEXT_KEY);
    if (!saved) return;
    sessionStorage.removeItem(UPDATE_TEXT_KEY);
    const snapshot = JSON.parse(saved);
    if (typeof snapshot.text !== 'string') return;
    input.value = snapshot.text;
    input.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction);
    input.focus();
    requestAnimationFrame(() => { input.scrollTop = snapshot.scrollTop; });
  } catch {
    // Unavailable storage or an invalid snapshot must not stop normal editing.
  }
}

function saveUpdateText(input) {
  if (!input.value) {
    try { sessionStorage.removeItem(UPDATE_TEXT_KEY); } catch { /* No text to preserve. */ }
    return;
  }
  sessionStorage.setItem(UPDATE_TEXT_KEY, JSON.stringify({
    text: input.value,
    start: input.selectionStart,
    end: input.selectionEnd,
    direction: input.selectionDirection,
    scrollTop: input.scrollTop,
  }));
}

export function setupUpdates(input) {
  const offlineStatus = document.querySelector('#offline-status');
  const notice = document.querySelector('#update-notice');
  const button = document.querySelector('#update-button');
  const status = document.querySelector('#update-status');
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    offlineStatus.textContent = 'Online mode';
    return;
  }

  let registration;
  let checking;
  let controller = navigator.serviceWorker.controller;
  let newerVersionActive = false;
  let applying = false;
  let reloading = false;
  let activationTimeout;
  let error = '';
  const watchedRegistrations = new WeakSet();
  const watchedWorkers = new WeakSet();

  function renderUpdate() {
    notice.hidden = !registration?.waiting && !newerVersionActive && !applying;
    button.disabled = applying;
    button.setAttribute('aria-busy', String(applying));
    status.textContent = error || (applying ? 'Updating…' : 'Update available');
  }

  function reloadWithText() {
    if (reloading) return;
    clearTimeout(activationTimeout);
    try {
      // Capture the latest edit, including edits made while activation was pending.
      saveUpdateText(input);
    } catch {
      applying = false;
      error = 'Your text could not be kept for the update. Copy it, then clear the text and try again.';
      renderUpdate();
      return;
    }
    reloading = true;
    location.reload();
  }

  button.addEventListener('click', () => {
    if (applying || reloading) return;
    error = '';
    const waiting = registration?.waiting;
    if (!waiting) {
      if (newerVersionActive) reloadWithText();
      return;
    }
    applying = true;
    renderUpdate();
    activationTimeout = setTimeout(() => {
      applying = false;
      error = 'The update could not finish. Try again.';
      renderUpdate();
    }, 15000);
    try {
      waiting.postMessage({ type: 'SKIP_WAITING' });
    } catch {
      clearTimeout(activationTimeout);
      applying = false;
      error = 'The update could not start. Try again.';
      renderUpdate();
    }
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const nextController = navigator.serviceWorker.controller;
    // A hard-refreshed tab may be uncontrolled even though an update is waiting.
    if ((controller || applying) && nextController && nextController !== controller) newerVersionActive = true;
    controller = nextController;
    if (applying && newerVersionActive) reloadWithText();
    else renderUpdate();
  });

  function watchWorker(worker) {
    if (!worker || watchedWorkers.has(worker)) return;
    watchedWorkers.add(worker);
    const changed = () => {
      renderUpdate();
      // Some browsers expose registration.waiting just after the installed event.
      if (worker.state === 'installed') setTimeout(renderUpdate, 0);
    };
    worker.addEventListener('statechange', changed);
    changed();
  }

  function checkForUpdates() {
    if (checking || document.hidden || !navigator.onLine) return checking;
    checking = (async () => {
      try {
        registration = await navigator.serviceWorker.register('./sw.js', {
          scope: './', updateViaCache: 'none',
        });
        if (!watchedRegistrations.has(registration)) {
          watchedRegistrations.add(registration);
          registration.addEventListener('updatefound', () => watchWorker(registration.installing));
        }
        watchWorker(registration.installing);
        renderUpdate();
        if (!registration.installing && !registration.waiting) {
          // A failed check leaves the current offline version usable.
          try { await registration.update(); } catch { /* Retry on return or reconnect. */ }
          watchWorker(registration.installing);
          renderUpdate();
        }
      } catch {
        offlineStatus.textContent = 'Offline mode unavailable';
      } finally {
        checking = null;
      }
    })();
    return checking;
  }

  navigator.serviceWorker.ready.then(() => { offlineStatus.textContent = 'Ready to work offline'; });
  window.addEventListener('focus', checkForUpdates);
  window.addEventListener('pageshow', checkForUpdates);
  window.addEventListener('online', checkForUpdates);
  document.addEventListener('visibilitychange', checkForUpdates);
  setInterval(checkForUpdates, 60000);
  checkForUpdates();
}
