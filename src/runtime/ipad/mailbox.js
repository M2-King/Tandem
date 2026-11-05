// Shared memory between the page and a Python worker, so Python can wait for
// a line of input (input()) or a debugger command without busy-looping.
//
// Each slot has a state word, a length word and a 64 KB text buffer.
// state 0: empty (Python waits), 1: a line is ready, 2: end of input.

export const SLOT_STDIN = 0;
export const SLOT_COMMAND = 1;
const SLOTS = 2;
const SIZE = 64 * 1024;

export function createMailbox() {
  return {
    control: new SharedArrayBuffer(4 * 2 * SLOTS),
    data: new SharedArrayBuffer(SIZE * SLOTS),
    interrupt: new SharedArrayBuffer(4),
  };
}

// Page side: deliver a line (or null for end of input).
export function writeSlot(mailbox, slot, text) {
  const control = new Int32Array(mailbox.control);
  if (text === null) {
    Atomics.store(control, slot * 2 + 1, 0);
    Atomics.store(control, slot * 2, 2);
  } else {
    const bytes = new TextEncoder().encode(text).slice(0, SIZE);
    new Uint8Array(mailbox.data, slot * SIZE, SIZE).set(bytes);
    Atomics.store(control, slot * 2 + 1, bytes.length);
    Atomics.store(control, slot * 2, 1);
  }
  Atomics.notify(control, slot * 2);
}

// Worker side: wait for a line; null means end of input.
export function readSlot(mailbox, slot) {
  const control = new Int32Array(mailbox.control);
  Atomics.wait(control, slot * 2, 0);
  const state = Atomics.load(control, slot * 2);
  const length = Atomics.load(control, slot * 2 + 1);
  Atomics.store(control, slot * 2, 0);
  if (state === 2) return null;
  // TextDecoder can't read shared memory directly: copy first.
  const bytes = new Uint8Array(length);
  bytes.set(new Uint8Array(mailbox.data, slot * SIZE, length));
  return new TextDecoder().decode(bytes);
}
