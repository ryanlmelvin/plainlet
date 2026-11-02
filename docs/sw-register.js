const offlineStatus = document.querySelector('#offline-status');

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js', { scope: './' })
    .then(() => navigator.serviceWorker.ready)
    .then(() => { offlineStatus.textContent = 'Ready to work offline'; })
    .catch(() => { offlineStatus.textContent = 'Offline mode unavailable'; });
} else {
  offlineStatus.textContent = 'Online mode';
}
