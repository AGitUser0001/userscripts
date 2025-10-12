This script creates a global window.time object that allows you to control time in a webpage.

We wrap `Date.now`, `Performance.prototype.now`, `AnimationTimeline.prototype.currentTime`, and `Event.prototype.timeStamp` with a `Proxy` that adjusts what is returned when the state has been modified.
We wrap `setTimeout` and `setInterval` with a `Proxy` that adjusts the timeout/interval parameter while the state is modified.
`requestAnimationFrame` is wrapped with another `Proxy` that adjusts the `DOMHighResTimeStamp` by wrapping the input function if the state has been modified.

The window.time object contains:

- `jump(newTime: number): void`:
  Jumps time to *newTime*, a number.

- `shift(shiftTime: number): void`:
  Shifts time by *shiftTime*, a number.

- `reset(resetTime: boolean = true, resetScale: boolean = true, resetDebug: boolean = true): void`:
  Optionally syncs the scale and/or time with real time in the page.

- `storage`
  - `get profile(): string | null`:
    The current profile id, or `null` if unset.
  - `set profile(value: string | null): void`:
    Set the current profile to `value`, or unset profile if `value` is an empty string or `null`.

  - `save(saveTime: boolean = true, saveScale: boolean = true, saveDebug: boolean = true): void`:
  - `load(loadTime: boolean = true, loadScale: boolean = true, loadDebug: boolean = true): void`:
    Saves or loads the current time and/or scale in script storage.

  - `reset(resetTime: boolean = true, resetScale: boolean = true, resetDebug: boolean = true): void`:
    Resets the time and/or scale in script storage.

  - `get now(): number`:
    The current time in the script storage.
  - `set now(value: number): void`:
    Time is set to `value` in the storage.

  - `get pristine(): boolean`:
    Whether time has been modified in the storage.
  - `set pristine(value): void`:
    If `value` is true, syncs time to real time in storage.

  - `get real(): number`:
    The actual time grabbed from DateConstructor.now().

  - `get scale(): number`:
    The current scale that time moves at in the storage.
  - `set scale(value: number): void`:
    When set, changes the scale of time in storage.

- `get debug(): boolean`:
- `set debug(value: boolean): void`:
  A boolean that controls logging of calls.

- `get now(): number`:
  The current time on the page. Should be equal to window.Date.now().
- `set now(value: number): void`:
  Time jumps to `value`.

- `get pristine(): boolean`:
  Whether time has been modified.
- `set pristine(value): void`:
  If `value` is true, syncs 

- `get real(): number`:
  The actual time grabbed from DateConstructor.now().

- `get scale(): number`:
  The current scale that time moves at.
- `set scale(value: number): void`:
  When set, changes the scale of time.
