import { createTextBuffer } from './text-buffer.js';
import { createPasteHistory } from './paste-history.js';
import { restoreUpdateText, setupUpdates } from './sw-register.js';
import { createShareLink, readShareLink, generateSharePassword } from './share-link.js';

const input = document.querySelector('#text-input');
const pasteButton = document.querySelector('#paste-button');
const clearButton = document.querySelector('#clear-button');
const copyButton = document.querySelector('#copy-button');
const status = document.querySelector('#status');
const shareButton = document.querySelector('#share-button');
const shareDialog = document.querySelector('#share-dialog');
const shareLink = document.querySelector('#share-link');
const shareStatus = document.querySelector('#share-status');
const copyShareButton = document.querySelector('#copy-share-button');
const shareProtect = document.querySelector('#share-protect');
const sharePassword = document.querySelector('#share-password');
const passwordControls = document.querySelector('#share-password-controls');
const copyPasswordButton = document.querySelector('#copy-password-button');
const generatePasswordButton = document.querySelector('#generate-password-button');
const shareAccess = document.querySelector('#share-access');
const unlockDialog = document.querySelector('#unlock-dialog');
const unlockPassword = document.querySelector('#unlock-password');
const unlockStatus = document.querySelector('#unlock-status');
const unlockButton = document.querySelector('#unlock-button');
restoreUpdateText(input);
const buffer = createTextBuffer(input.value);
const pasteHistory = createPasteHistory();
const historyButton = document.querySelector('#history-button');
const historyDialog = document.querySelector('#history-dialog');
const historyList = document.querySelector('#history-list');
const historyEmpty = document.querySelector('#history-empty');
const historyStatus = document.querySelector('#history-status');
const clearHistoryButton = document.querySelector('#clear-history-button');
const closeHistoryButton = document.querySelector('#close-history-button');

let activePaste = null;
let copyPending = false;
let interaction = 0;
let historyCopyRequest = null;
let sharePending = false;
let activeShareLoad = null;
let shareCopyRequest = null;
let shareCopyInFlight = false;
let shareSnapshot = '';
let plainShareLink = '';
let lastCopiedShareLink = '';
let protectionRequest = null;
let pendingProtection = null;
let protectionTimer;
let protectionRunning = false;
let unlockRequest = null;
let unlockAttempt = null;

const historyStorageError = 'History could not be saved on this device. Changes will last only while this page is open.';
const copyFeedbackTimers = new WeakMap();

function flashCopyFeedback(button) {
  clearTimeout(copyFeedbackTimers.get(button));
  button.classList.add('copy-feedback');
  copyFeedbackTimers.set(button, setTimeout(() => {
    button.classList.remove('copy-feedback');
    copyFeedbackTimers.delete(button);
  }, 650));
}

function announce(message) {
  status.textContent = message;
}

function updateButtons() {
  pasteButton.disabled = activePaste !== null;
  // Clear also cancels a pending clipboard read, even when the buffer is empty.
  clearButton.disabled = buffer.getText().length === 0 && activePaste === null && activeShareLoad === null;
  copyButton.disabled = buffer.getText().length === 0 || copyPending;
  shareButton.disabled = buffer.getText().length === 0 || sharePending || activePaste !== null || activeShareLoad !== null;
  pasteButton.setAttribute('aria-busy', String(activePaste !== null));
  copyButton.setAttribute('aria-busy', String(copyPending));
  shareButton.setAttribute('aria-busy', String(sharePending));
}

function render(text) {
  if (input.value !== text) input.value = text;
  updateButtons();
}

function cancelPendingPaste() {
  activePaste = null;
  activeShareLoad = null;
  dismissUnlock();
  interaction += 1;
}

buffer.subscribe(render);
render(buffer.getText());

input.addEventListener('input', () => {
  cancelPendingPaste();
  buffer.setText(input.value);
  updateButtons();
  announce('');
});

// Record the pasted text, without capturing each edit or replacing native paste behavior.
input.addEventListener('paste', (event) => {
  const text = event.clipboardData?.getData('text/plain');
  if (!text?.trim()) return;
  // Run after the browser's default insertion and input event, so its status
  // reset cannot erase a storage failure message.
  setTimeout(() => {
    if (!event.defaultPrevented && !pasteHistory.add(text)) announce(historyStorageError);
  }, 0);
});

pasteButton.addEventListener('click', async () => {
  cancelPendingPaste();
  const request = Symbol('paste');
  activePaste = request;
  updateButtons();
  announce('Reading clipboard…');

  try {
    if (!navigator.clipboard?.readText) throw new Error('Clipboard reading is unavailable.');
    const text = await navigator.clipboard.readText();
    // Permission prompts may stay open while the user edits or clears the field.
    if (activePaste !== request) return;

    if (text.length === 0) {
      announce('No text found on the clipboard. Your text is unchanged.');
      return;
    }

    buffer.setText(text);
    const saved = pasteHistory.add(text);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    announce(saved ? 'Pasted as plain text.' : `Pasted as plain text. ${historyStorageError}`);
  } catch {
    if (activePaste !== request) return;
    input.focus();
    announce('Clipboard access is unavailable. Paste in the text box with Ctrl+V or ⌘V, or touch and hold, then choose Paste.');
  } finally {
    if (activePaste === request) {
      activePaste = null;
      updateButtons();
    }
  }
});

clearButton.addEventListener('click', () => {
  cancelPendingPaste();
  buffer.setText('');
  updateButtons();
  input.focus();
  announce('Text cleared.');
});

function selectText(target) {
  target.focus();
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    target.select();
  } else {
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

/** Keep the fallback clipboard payload plain text, just like writeText(). */
function copyWithSelection(text, target = input) {
  const previousFocus = document.activeElement;
  const selectionStart = input.selectionStart;
  const selectionEnd = input.selectionEnd;
  const selectionDirection = input.selectionDirection;
  const selection = window.getSelection();
  const previousRanges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange());
  let wrotePlainText = false;

  function onCopy(event) {
    if (!event.clipboardData) return;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    wrotePlainText = true;
  }

  selectText(target);
  document.addEventListener('copy', onCopy, { capture: true });

  let copied = false;
  try {
    copied = document.execCommand('copy') && wrotePlainText;
  } catch {
    copied = false;
  } finally {
    document.removeEventListener('copy', onCopy, { capture: true });
  }

  if (copied) {
    selection.removeAllRanges();
    for (const range of previousRanges) selection.addRange(range);
    input.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
    previousFocus?.focus();
  }
  return copied;
}

copyButton.addEventListener('click', async () => {
  const text = buffer.getText();
  if (text.length === 0 || copyPending) return;
  flashCopyFeedback(copyButton);

  const startedAt = interaction;
  copyPending = true;
  updateButtons();
  announce('Copying…');

  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    } else {
      copied = copyWithSelection(text);
    }
  } catch {
    // Do not move the selection or copy stale text after a user edit.
    if (startedAt === interaction) copied = copyWithSelection(text);
  } finally {
    copyPending = false;
    updateButtons();
  }

  if (startedAt !== interaction) return;
  if (copied) {
    announce('Plain text copied.');
  } else {
    input.focus();
    input.select();
    announce('Copy access is unavailable. Text selected: press Ctrl+C or ⌘C, or touch and hold, then choose Copy.');
  }
});

shareButton.addEventListener('click', async () => {
  const text = buffer.getText();
  if (!text.length || sharePending) return;
  const startedAt = interaction;
  sharePending = true;
  updateButtons();
  announce('Creating share link…');
  try {
    const link = await createShareLink(text, location.href);
    if (startedAt !== interaction) return;
    shareSnapshot = text;
    plainShareLink = link;
    lastCopiedShareLink = '';
    shareLink.value = link;
    shareProtect.checked = false;
    sharePassword.value = '';
    passwordControls.hidden = true;
    shareAccess.textContent = 'Anyone with this link can read this snapshot of your text.';
    shareStatus.textContent = '';
    updateShareControls();
    interaction += 1;
    shareDialog.showModal();
    announce('');
  } catch (error) {
    if (startedAt !== interaction) return;
    announce(error.code === 'too-large' ? 'This paste is too big to share.'
      : error.code === 'unsupported' ? 'Sharing is unavailable in this browser. You can still copy your text.'
        : 'The share link could not be created. Try again.');
  } finally {
    sharePending = false;
    updateButtons();
  }
});

function updateShareControls() {
  copyShareButton.disabled = !shareLink.value || shareCopyInFlight;
  copyPasswordButton.disabled = !shareLink.value || !sharePassword.value || shareCopyInFlight;
  // An issued clipboard write cannot be cancelled. Keep mode/password stable
  // until it settles, including across a close/reopen of this dialog.
  shareProtect.disabled = shareCopyInFlight;
  sharePassword.readOnly = shareCopyInFlight;
  generatePasswordButton.disabled = shareCopyInFlight;
}

function invalidateProtection() {
  clearTimeout(protectionTimer);
  protectionRequest = null;
  pendingProtection = null;
  shareCopyRequest = null;
}

function queueProtectedLink(delay = 250) {
  invalidateProtection();
  // Never leave the previous password's link available while the field changes.
  shareLink.value = '';
  updateShareControls();
  if (!sharePassword.value) {
    shareStatus.textContent = '';
    return;
  }
  const request = { text: shareSnapshot, password: sharePassword.value };
  protectionRequest = request;
  shareStatus.textContent = 'Protecting link…';
  protectionTimer = setTimeout(() => {
    pendingProtection = request;
    buildProtectedLink();
  }, delay);
}

async function buildProtectedLink() {
  // Only one password derivation runs at a time; rapid typing queues the latest.
  if (protectionRunning || !pendingProtection) return;
  const request = pendingProtection;
  pendingProtection = null;
  if (request !== protectionRequest || !shareDialog.open || !shareProtect.checked) return;
  protectionRunning = true;
  const isCurrent = () => request === protectionRequest && shareDialog.open && shareProtect.checked && sharePassword.value === request.password;
  try {
    const link = await createShareLink(request.text, location.href, { password: request.password });
    if (!isCurrent()) return;
    shareLink.value = link;
    shareStatus.textContent = lastCopiedShareLink ? 'Link changed. Copy the new link.' : '';
  } catch (error) {
    if (!isCurrent()) return;
    shareStatus.textContent = error.code === 'too-large' ? 'This paste is too big to share.'
      : error.code === 'password-too-long' ? 'This password is too long. Use a shorter password.'
        : error.code === 'unsupported' ? 'Password protection is unavailable in this browser.'
          : 'The protected link could not be created. Edit the password to try again.';
  } finally {
    protectionRunning = false;
    updateShareControls();
    if (pendingProtection) buildProtectedLink();
  }
}

shareProtect.addEventListener('change', () => {
  invalidateProtection();
  sharePassword.value = '';
  shareLink.value = shareProtect.checked ? '' : plainShareLink;
  passwordControls.hidden = !shareProtect.checked;
  shareStatus.textContent = !shareProtect.checked && lastCopiedShareLink && lastCopiedShareLink !== plainShareLink
    ? 'Link changed. Copy the new link.' : '';
  shareAccess.textContent = shareProtect.checked
    ? 'The password is required to read this snapshot of your text.'
    : 'Anyone with this link can read this snapshot of your text.';
  updateShareControls();
  if (shareProtect.checked) sharePassword.focus();
});
sharePassword.addEventListener('input', () => queueProtectedLink());
generatePasswordButton.addEventListener('click', () => {
  try {
    sharePassword.value = generateSharePassword();
    queueProtectedLink(0);
  } catch {
    invalidateProtection();
    shareLink.value = '';
    sharePassword.value = '';
    updateShareControls();
    shareStatus.textContent = 'Password generation is unavailable in this browser.';
  }
});

async function copyShareField(field, button, label) {
  const text = field.value;
  if (!text || !shareLink.value || shareCopyInFlight) return;
  flashCopyFeedback(button);
  const request = Symbol('share-copy');
  shareCopyRequest = request;
  shareCopyInFlight = true;
  const isCurrent = () => shareCopyRequest === request && shareDialog.open && field.value === text;
  updateShareControls();
  button.setAttribute('aria-busy', 'true');
  shareStatus.textContent = 'Copying…';
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    } else {
      copied = copyWithSelection(text, field);
    }
  } catch {
    if (isCurrent()) copied = copyWithSelection(text, field);
  } finally {
    shareCopyInFlight = false;
    button.setAttribute('aria-busy', 'false');
    updateShareControls();
  }
  if (!isCurrent()) return;
  shareCopyRequest = null;
  if (copied) {
    if (field === shareLink) lastCopiedShareLink = text;
    const reminder = field === sharePassword && lastCopiedShareLink && lastCopiedShareLink !== shareLink.value
      ? ' Copy the updated link too.' : '';
    shareStatus.textContent = `${label} copied.${reminder}`;
  } else {
    selectText(field);
    shareStatus.textContent = `Copy access is unavailable. ${label} selected: press Ctrl+C or ⌘C, or touch and hold, then choose Copy.`;
  }
}

copyShareButton.addEventListener('click', () => copyShareField(shareLink, copyShareButton, 'Share link'));
copyPasswordButton.addEventListener('click', () => copyShareField(sharePassword, copyPasswordButton, 'Password'));

shareDialog.addEventListener('close', () => {
  invalidateProtection();
  shareSnapshot = '';
  plainShareLink = '';
  lastCopiedShareLink = '';
  shareLink.value = '';
  sharePassword.value = '';
  shareProtect.checked = false;
  passwordControls.hidden = true;
  shareStatus.textContent = '';
  updateShareControls();
  shareButton.focus();
});

function dismissUnlock() {
  if (unlockRequest?.request === activeShareLoad) activeShareLoad = null;
  unlockRequest = null;
  unlockAttempt = null;
  unlockPassword.value = '';
  unlockStatus.textContent = '';
  unlockButton.disabled = false;
  unlockButton.setAttribute('aria-busy', 'false');
  if (unlockDialog.open) unlockDialog.close();
}

function showSharedText(text) {
  buffer.setText(text);
  if (!document.querySelector('dialog[open]')) {
    input.focus();
    input.setSelectionRange(0, 0);
  }
  announce('Shared text opened.');
}

function cancelUnlock() {
  dismissUnlock();
  updateButtons();
  announce('Share link not opened. Your text is unchanged.');
}

document.querySelector('#cancel-unlock-button').addEventListener('click', cancelUnlock);
unlockDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  cancelUnlock();
});
unlockDialog.addEventListener('close', () => {
  if (!unlockDialog.open && unlockRequest) cancelUnlock();
});
unlockPassword.addEventListener('input', () => {
  unlockAttempt = null;
  unlockStatus.textContent = '';
  unlockButton.disabled = false;
  unlockButton.setAttribute('aria-busy', 'false');
});
document.querySelector('#unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const pending = unlockRequest;
  const password = unlockPassword.value;
  if (!pending || !password || unlockAttempt) return;
  const attempt = Symbol('unlock');
  unlockAttempt = attempt;
  const isCurrent = () => unlockAttempt === attempt && unlockRequest === pending && activeShareLoad === pending.request;
  unlockButton.disabled = true;
  unlockButton.setAttribute('aria-busy', 'true');
  unlockStatus.textContent = 'Opening…';
  try {
    const text = await readShareLink(pending.hash, { password });
    if (!isCurrent()) return;
    dismissUnlock();
    showSharedText(text);
    updateButtons();
  } catch (error) {
    if (!isCurrent()) return;
    unlockStatus.textContent = error.code === 'password-too-long' ? 'This password is too long. Use a shorter password.'
      : error.code === 'unsupported' ? 'This browser cannot open this protected link. Try a newer browser.'
        : 'Wrong password or damaged link.';
    unlockPassword.focus();
    unlockPassword.select();
  } finally {
    if (unlockAttempt === attempt) {
      unlockAttempt = null;
      unlockButton.disabled = false;
      unlockButton.setAttribute('aria-busy', 'false');
    }
  }
});

async function openSharedText() {
  const hash = location.hash;
  if (!hash.startsWith('#share=')) return;
  cancelPendingPaste();
  const request = Symbol('share-load');
  activeShareLoad = request;
  // Consume the link so Clear/reload cannot restore it and later navigation
  // does not retain the key. The original link may still exist outside this tab.
  history.replaceState(history.state, '', location.pathname + location.search);
  updateButtons();
  announce('Opening shared text…');
  try {
    const text = await readShareLink(hash);
    if (activeShareLoad !== request) return;
    showSharedText(text);
  } catch (error) {
    if (activeShareLoad !== request) return;
    if (error.code === 'password-required') {
      unlockRequest = { request, hash };
      announce('');
      openDialog(unlockDialog);
    } else {
      announce(error.code === 'unsupported' ? 'This browser cannot open this share link. Try a newer browser.'
        : 'This share link is invalid or incomplete. Your text is unchanged.');
    }
  } finally {
    if (activeShareLoad === request && unlockRequest?.request !== request) {
      activeShareLoad = null;
      updateButtons();
    }
  }
}

function historyIconButton(action, path) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button button-clear icon-button';
  button.dataset.action = action;
  button.setAttribute('aria-label', `${action} paste`);
  button.title = `${action} paste`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  button.append(svg);
  return button;
}

function loadHistoryEntry(text) {
  // Loading a saved paste is a new edit: delayed reads/copies must not replace it.
  cancelPendingPaste();
  historyCopyRequest = null;
  historyDialog.close();
  buffer.setText(text);
  updateButtons();
  input.focus();
  input.setSelectionRange(0, 0);
  input.scrollTop = 0;
  announce('Paste loaded from history.');
}

function renderHistory() {
  if (!historyDialog.open) return;
  const entries = pasteHistory.getEntries();
  const focused = document.activeElement;
  const focusedEntry = focused?.closest('.history-entry');
  const focusedIndex = Array.from(historyList.children).indexOf(focusedEntry);
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const row = document.createElement('li');
    row.className = 'history-entry';
    row.dataset.id = entry.id;
    const text = document.createElement('pre');
    text.className = 'history-text';
    text.tabIndex = 0;
    text.setAttribute('role', 'button');
    text.setAttribute('aria-label', `Load paste: ${entry.text.slice(0, 120)}`);
    text.title = 'Load into editor';
    text.textContent = entry.text;
    text.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      loadHistoryEntry(entry.text);
    });
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    const copy = historyIconButton('Copy', 'M8 8h12v12H8zM15 8V4H4v11h4');
    const remove = historyIconButton('Delete', 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7');
    copy.addEventListener('click', () => copyHistoryEntry(entry.text, text, copy));
    remove.addEventListener('click', () => {
      historyCopyRequest = null;
      const saved = pasteHistory.remove(entry.id);
      historyStatus.textContent = saved ? 'Paste deleted.' : historyStorageError;
    });
    actions.append(copy, remove);
    row.append(text, actions);
    row.addEventListener('click', (event) => {
      // Include row padding and gaps, but keep both icon actions independent.
      if (event.target.closest('button')) return;
      loadHistoryEntry(entry.text);
    });
    fragment.append(row);
  }
  historyList.replaceChildren(fragment);
  historyList.hidden = entries.length === 0;
  historyEmpty.hidden = entries.length !== 0;
  clearHistoryButton.disabled = entries.length === 0;
  if (focusedEntry) {
    const rows = Array.from(historyList.children);
    const nextRow = rows.find((row) => row.dataset.id === focusedEntry.dataset.id) || rows[Math.min(focusedIndex, rows.length - 1)];
    const nextFocus = focused.dataset.action
      ? nextRow?.querySelector(`[data-action="${focused.dataset.action}"]`)
      : nextRow?.querySelector('.history-text');
    (nextFocus || closeHistoryButton).focus();
  } else if (focused === clearHistoryButton && clearHistoryButton.disabled) {
    closeHistoryButton.focus();
  }
}

async function copyHistoryEntry(text, preview, button) {
  flashCopyFeedback(button);
  const request = Symbol('history-copy');
  historyCopyRequest = request;
  const isCurrent = () => historyCopyRequest === request && historyDialog.open && preview.isConnected;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  historyStatus.textContent = 'Copying…';
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    } else {
      copied = copyWithSelection(text, preview);
    }
  } catch {
    if (isCurrent()) copied = copyWithSelection(text, preview);
  } finally {
    button.disabled = false;
    button.setAttribute('aria-busy', 'false');
  }
  if (!isCurrent()) return;
  if (copied) {
    historyStatus.textContent = 'Plain text copied.';
  } else {
    selectText(preview);
    historyStatus.textContent = 'Copy access is unavailable. Text selected: press Ctrl+C or ⌘C, or touch and hold, then choose Copy.';
  }
}

pasteHistory.subscribe(renderHistory);
function openDialog(dialog) {
  // Reading help/history must not lose an incoming share or let a pending
  // outgoing share/copy interrupt the dialog that the user just chose.
  interaction += 1;
  if (sharePending) announce('');
  dialog.showModal();
}

historyButton.addEventListener('click', () => {
  // A pending editor copy must not select text behind the modal if it fails.
  historyStatus.textContent = pasteHistory.isPersistent() ? '' : historyStorageError;
  openDialog(historyDialog);
  renderHistory();
});
closeHistoryButton.addEventListener('click', () => historyDialog.close());
historyDialog.addEventListener('close', () => { historyCopyRequest = null; });
clearHistoryButton.addEventListener('click', () => {
  historyCopyRequest = null;
  const saved = pasteHistory.clear();
  historyStatus.textContent = saved ? 'History cleared.' : historyStorageError;
});

const aboutMenu = document.querySelector('.about-menu');
document.addEventListener('click', (event) => {
  if (!aboutMenu.contains(event.target)) aboutMenu.open = false;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && aboutMenu.open) {
    aboutMenu.open = false;
    aboutMenu.querySelector('summary').focus();
  }
});

const installDialog = document.querySelector('#install-dialog');
document.querySelector('#install-button').addEventListener('click', () => {
  openDialog(installDialog);
});
installDialog.addEventListener('close', () => {
  aboutMenu.open = true;
  document.querySelector('#install-button').focus();
});

const privacyDialog = document.querySelector('#privacy-dialog');
document.querySelector('#privacy-button').addEventListener('click', () => {
  openDialog(privacyDialog);
});
privacyDialog.addEventListener('close', () => {
  aboutMenu.open = true;
  document.querySelector('#privacy-button').focus();
});

const shareHelpDialog = document.querySelector('#share-help-dialog');
document.querySelector('#share-help-button').addEventListener('click', () => {
  openDialog(shareHelpDialog);
});
shareHelpDialog.addEventListener('close', () => {
  aboutMenu.open = true;
  document.querySelector('#share-help-button').focus();
});

setupUpdates(input);
window.addEventListener('hashchange', openSharedText);
openSharedText();
