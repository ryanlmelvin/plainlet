import { createTextBuffer } from './text-buffer.js';
import { createPasteHistory } from './paste-history.js';

const input = document.querySelector('#text-input');
const pasteButton = document.querySelector('#paste-button');
const clearButton = document.querySelector('#clear-button');
const copyButton = document.querySelector('#copy-button');
const status = document.querySelector('#status');
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

const historyStorageError = 'History could not be saved on this device. Changes will last only while this page is open.';

function announce(message) {
  status.textContent = message;
}

function updateButtons() {
  pasteButton.disabled = activePaste !== null;
  // Clear also cancels a pending clipboard read, even when the buffer is empty.
  clearButton.disabled = buffer.getText().length === 0 && activePaste === null;
  copyButton.disabled = buffer.getText().length === 0 || copyPending;
  pasteButton.setAttribute('aria-busy', String(activePaste !== null));
  copyButton.setAttribute('aria-busy', String(copyPending));
}

function render(text) {
  if (input.value !== text) input.value = text;
  updateButtons();
}

function cancelPendingPaste() {
  activePaste = null;
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
  const request = Symbol('paste');
  activePaste = request;
  interaction += 1;
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
  if (target === input) {
    input.select();
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
    text.textContent = entry.text;
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
historyButton.addEventListener('click', () => {
  // A pending editor copy must not select text behind the modal if it fails.
  interaction += 1;
  historyStatus.textContent = pasteHistory.isPersistent() ? '' : historyStorageError;
  historyDialog.showModal();
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
  installDialog.showModal();
});
installDialog.addEventListener('close', () => {
  aboutMenu.open = true;
  document.querySelector('#install-button').focus();
});

const privacyDialog = document.querySelector('#privacy-dialog');
document.querySelector('#privacy-button').addEventListener('click', () => {
  privacyDialog.showModal();
});
privacyDialog.addEventListener('close', () => {
  aboutMenu.open = true;
  document.querySelector('#privacy-button').focus();
});
