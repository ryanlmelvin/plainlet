import { createTextBuffer } from './text-buffer.js';

const input = document.querySelector('#text-input');
const pasteButton = document.querySelector('#paste-button');
const clearButton = document.querySelector('#clear-button');
const copyButton = document.querySelector('#copy-button');
const status = document.querySelector('#status');
const characterCount = document.querySelector('#character-count');
const buffer = createTextBuffer(input.value);
const numberFormat = new Intl.NumberFormat();

let activePaste = null;
let copyPending = false;
let interaction = 0;

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
  const count = Array.from(text).length;
  characterCount.textContent = `${numberFormat.format(count)} ${count === 1 ? 'character' : 'characters'}`;
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
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    announce('Pasted as plain text.');
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

/** Keep the fallback clipboard payload plain text, just like writeText(). */
function copyWithSelection(text) {
  const previousFocus = document.activeElement;
  const selectionStart = input.selectionStart;
  const selectionEnd = input.selectionEnd;
  const selectionDirection = input.selectionDirection;
  let wrotePlainText = false;

  function onCopy(event) {
    if (!event.clipboardData) return;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    wrotePlainText = true;
  }

  input.focus();
  input.select();
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
