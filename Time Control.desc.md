This script creates a global window.time object that allows you to control time in a webpage.

The window.time object contains:

- `jump(newTime: number): void`:
  Jumps time to *newTime*, a number.

- `sync(resetScale: boolean = true): void`:
  Syncs time with real time, optionally resetting the scale.

- `get time.debug(): boolean`:
- `set time.debug(value: boolean): void`:
  A boolean that controls logging of calls.

- `get time.now(): number`:
  The current time on the page. Should be equal to window.Date.now().
- `set time.now(value: number): void`:
  Time jumps to `value`.

- `get pristine(): boolean`:
  Whether time has been modified.
- `set pristine(value): void`:
  If `value` is true, syncs time.

- `get time.real(): number`:
  The actual time grabbed from DateConstructor.now().

- `get time.scale(): number`:
  The current scale that time moves at.
- `set time.scale(value: number): void`:
  When set, changes the scale and sets pristine to false.
