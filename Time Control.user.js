// ==UserScript==
// @name         Time Control
// @description  Script allowing you to control time.
// @icon         https://parsefiles.back4app.com/JPaQcFfEEQ1ePBxbf6wvzkPMEqKYHhPYv8boI1Rc/ce262758ff44d053136358dcd892979d_low_res_Time_Machine.png
// @namespace    mailto:lucaszheng2011@outlook.com
// @version      1.2.6
// @author       lucaszheng
// @license      MIT
//
// @match        *://*/*
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue

// @inject-into  page
// @run-at       document-start
// ==/UserScript==
/*globals unsafeWindow,GM_setValue,GM_getValue,GM_deleteValue*/

(function (window) {
  'use strict';
  let scale = 1, pristine = true;
  /** @type {null | number} */
  let timeJump = null;

  let timeReset = false;
  let debug = false;

  const {
    Reflect: {
      apply, construct,
      setPrototypeOf,
      getPrototypeOf
    },
    Object: {
      defineProperty,
      freeze
    },
    Number: {
      isFinite
    },
    Symbol: {
      toPrimitive,
      toStringTag
    },
    console: {
      trace: log
    }
  } = window;

  function update() {
    for (let idx = 0; idx < updaters.length; idx++) {
      updaters[idx]();
    }
  }

  /**
   * @param {'string' | 'number' | 'default'} type
   */
  function timeToPrimitive(type) {
    switch (type) {
      case 'string': return this.toString();
      default: return this.now;
    }
  }

  function timeToString() {
    return apply(date.toString, construct(DateConstructor, [this.now]), []);
  }

  const time = {
    [toStringTag]: 'time',
    [toPrimitive]: timeToPrimitive,
    toString: timeToString,
    /**
     * @param {number} newTime
     */
    jump(newTime) {
      if (newTime == null) return;
      pristine = false;
      timeJump = +newTime;
      update();
      timeJump = null;
    },

    reset(resetTime = true, resetScale = true, resetDebug = true) {
      if (resetDebug) debug = false;
      if (pristine) return;

      if (resetScale) scale = 1;

      if (!resetTime) return;
      timeReset = true;
      update();
      timeReset = false;
      pristine = scale === 1;
    },

    storage: {
      [toStringTag]: 'storage',
      [toPrimitive]: timeToPrimitive,
      toString: timeToString,

      /**
       * @param {number} newTime
       */
      jump(newTime) {
        GM_setValue('baseTime', time.real);
        GM_setValue('contTime', +newTime);
      },

      save(saveTime = true, saveScale = true, saveDebug = true) {
        if (saveDebug) {
          if (debug === false) time.storage.reset(false, false, true);
          else time.storage.debug = debug;
        }
        if (saveTime) {
          if (pristine) time.storage.reset(true, false, false);
          else time.storage.now = time.now;
        }
        if (saveScale) {
          if (scale === 1) time.storage.reset(false, true, false);
          else time.storage.scale = scale;
        }
      },

      load(loadTime = true, loadScale = true, loadDebug = true) {
        if (loadDebug) time.debug = time.storage.debug;
        if (time.storage.pristine) return time.reset(true, true, false);

        if (loadTime) {
          let baseTime = GM_getValue('baseTime', null);
          let contTime = GM_getValue('contTime', null);
          if (baseTime != null && contTime != null)
            time.jump((time.real - baseTime) + contTime);
        }
        if (loadScale) time.scale = time.storage.scale;
      },

      reset(resetTime = true, resetScale = true, resetDebug = true) {
        if (resetTime) {
          GM_deleteValue('baseTime');
          GM_deleteValue('contTime');
        }
        if (resetScale) GM_deleteValue('scale');
        if (resetDebug) GM_deleteValue('debug');
      },

      get debug() { return GM_getValue('debug', false); },
      set debug(value) { GM_setValue('debug', !!value); },

      get now() {
        let baseTime = GM_getValue('baseTime', null);
        let contTime = GM_getValue('contTime', null);
        if (baseTime != null && contTime != null)
          return (time.real - baseTime) + contTime;
        return time.real;
      },
      set now(value) { time.storage.jump(value); },

      get pristine() {
        let baseTime = GM_getValue('baseTime', null);
        let contTime = GM_getValue('contTime', null);
        let scale = GM_getValue('scale', null);
        return (baseTime == null || contTime == null) && scale == null;
      },
      set pristine(value) {
        if (!value) return;
        time.storage.reset(true, true, false);
      },

      get real() { return apply(date.realTime, DateConstructor, []); },

      get scale() {
        let scale = GM_getValue('scale', null);
        if (scale != null) return scale;
        return 1;
      },
      set scale(value) {
        if (value === time.storage.scale) return;
        GM_setValue('scale', +value);
      }
    },

    get debug() { return debug; },
    set debug(value) { debug = !!value; },

    get now() { return apply(date.now, DateConstructor, []); },
    set now(value) { time.jump(value); },

    get pristine() { return pristine; },
    set pristine(value) { if (value) time.reset(); },

    get real() { return apply(date.realTime, DateConstructor, []); },

    get scale() { return scale; },
    set scale(value) {
      value = +value;
      if (value === scale) return;
      pristine = false; update(); scale = value;
    }
  };

  freeze(time.storage);
  defineProperty(getPrototypeOf(window), 'time', {
    value: freeze(time),
    writable: true,
    enumerable: false,
    configurable: true
  });

  /** @type {(() => void)[]} */
  const updaters = [];

  /**
   * @param {() => number} func
   * @param {any} self
   */
  function wrap_now(func, self, offset = 0) {
    let baseTime = 0;
    let contTime = baseTime;

    /** @type {ProxyHandler<typeof func>} */
    const handler = {
      apply(target, self, args) {
        if (debug) log('apply(%o, %o, %o)', target, self, args);
        let time = apply(target, self, args);
        if (pristine || !isFinite(time)) return time;
        return ((time - baseTime) * scale) + contTime;
      }
    };
    setPrototypeOf(handler, null);

    updaters[updaters.length] =
      function update() {
        if (!handler.apply) return;
        contTime = timeJump == null ? handler.apply(func, self, []) : timeJump + offset;
        baseTime = apply(func, self, []);
        if (timeReset) contTime = baseTime;
      };

    return new Proxy(func, handler);
  }

  window.Performance.prototype.now = wrap_now(
    window.Performance.prototype.now,
    window.performance,
    window.performance.now() - window.Date.now()
  );

  const DateConstructor = window.Date;
  /** @type {{ realTime: typeof Date.now, now: typeof Date.now, toString: typeof Date.prototype.toString, handler: ProxyHandler<DateConstructor> }} */
  const date = {
    realTime: window.Date.now,
    now: wrap_now(window.Date.now, window.Date),
    toString: DateConstructor.prototype.toString,
    handler: {
      apply(target, self, args) {
        if (debug) log('apply(%o, %o, %o)', target, self, args);
        if (pristine) return DateConstructor();
        return time.toString();
      },
      construct(target, args, newTarget) {
        if (debug) log('construct(%o, %o, %o)', target, args, newTarget);
        if (!pristine && args.length < 1) {
          args[0] = time.now;
        }
        return construct(DateConstructor, args, newTarget);
      }
    }
  };
  setPrototypeOf(date, null);
  setPrototypeOf(date.handler, null);
  DateConstructor.now = date.now;

  window.Date = new Proxy(DateConstructor, date.handler);
  window.Date.prototype.constructor = window.Date;

  function noop() { }

  /**
   * @param {(handler: TimerHandler, timeout?: number | undefined, ...args: any[]) => number} func
   */
  function wrap_timer(func) {
    /** @type {ProxyHandler<typeof func>} */
    const handler = {
      apply(target, self, args) {
        if (debug) log('apply(%o, %o, %o)', target, self, args);
        if (!pristine && args.length > 1) {
          args[1] = +args[1];
          if (args[1] && scale === 0)
            args[0] = noop;
          else if (args[1] && isFinite(args[1]))
            args[1] /= scale;
        }
        return apply(target, self, args);
      }
    };
    setPrototypeOf(handler, null);
    return new Proxy(func, handler);
  }

  window.setTimeout = wrap_timer(window.setTimeout);
  window.setInterval = wrap_timer(window.setInterval);

  time.storage.load();
})(/** @type {typeof window} */(unsafeWindow));
