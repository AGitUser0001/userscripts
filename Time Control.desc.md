This script creates a global window.time object that allows you to control time in a webpage.

The window.time object contains:

- `jump(newTime: number): void`:
  Jumps time to *newTime*, a number.

- `sync(syncTime: boolean = true, syncScale: boolean = true, syncDebug: boolean = true): void`:
  Optionally syncs the scale and/or time with real time in the page.

- `storage`
  - `save(saveTime: boolean = true, saveScale: boolean = true, saveDebug: boolean = true): void`:
  - `load(loadTime: boolean = true, loadScale: boolean = true, loadDebug: boolean = true): void`:
    Saves or loads the current time and/or scale in script storage.

  - `reset(resetTime: boolean = true, resetScale: boolean = true, resetDebug: boolean = true): void`:
    Resets the time and/or scale in script storage.

  - `get time.now(): number`:
    The current time in the script storage.
  - `set time.now(value: number): void`:
    Time is set to `value` in the storage.

  - `get pristine(): boolean`:
    Whether time has been modified in the storage.
  - `set pristine(value): void`:
    If `value` is true, syncs time to real time in storage.

  - `get time.scale(): number`:
    The current scale that time moves at in the storage.
  - `set time.scale(value: number): void`:
    When set, changes the scale of time in storage.

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
  When set, changes the scale of time.
