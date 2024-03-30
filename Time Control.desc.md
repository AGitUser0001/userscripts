This script creates a global window.time object that allows you to control time in a webpage.

The window.time object contains:
 - `get, set time.scale: number`:
   The current scale that time moves at.
   When set, changes the scale and sets pristine to false.
 - `get, set time.now: number`:
   The current time on the page. Should be equal to window.Date.now().
   When set, time jumps to the set time.

 - `get time.real: number`:
   The actual time grabbed from DateConstructor.now().

 - `get, set time.debug: boolean`:
   A boolean that controls logging of calls.

 - `get, set time.pristine: boolean`:
   Whether time has been modified. When set, if set to true, syncs time.

 - `time.jump(newTime: number): undefined`:
   Jumps time to *newTime*, a number.

 - `time.sync(resetScale: boolean = true): undefined`:
   Syncs time with real time, optionally resetting the scale.
