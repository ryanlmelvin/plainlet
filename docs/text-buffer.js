/** An in-memory buffer. A future history feature can observe changes here. */
export function createTextBuffer(initialText = '') {
  if (typeof initialText !== 'string') {
    throw new TypeError('The text buffer accepts strings only.');
  }

  let text = initialText;
  let revision = 0;
  const subscribers = new Set();

  return {
    getText: () => text,
    getRevision: () => revision,
    setText(nextText) {
      if (typeof nextText !== 'string') {
        throw new TypeError('The text buffer accepts strings only.');
      }
      if (nextText === text) return false;

      text = nextText;
      revision += 1;
      for (const subscriber of subscribers) subscriber(text, revision);
      return true;
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  };
}
