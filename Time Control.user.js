// ==UserScript==
// @name         Time Control
// @description  Script allowing you to control time.
// @icon         https://parsefiles.back4app.com/JPaQcFfEEQ1ePBxbf6wvzkPMEqKYHhPYv8boI1Rc/ce262758ff44d053136358dcd892979d_low_res_Time_Machine.png
// @namespace    mailto:lucaszheng2011@outlook.com
// @version      1.2.2.2
// @author       lucaszheng
// @license      MIT
//
// @match        *://*/*
// @grant        unsafeWindow
// @inject-into  page
// @run-at       document-start
// ==/UserScript==

(window => {
  "use strict";
  let scale = 1, pristine = true;
  /** @type {null | number} */
  let timeJump = null;

  let timeSync = false;
  let debug = false;

  const {
    Reflect: {
      apply, construct,
      setPrototypeOf
    },
    Object: {
      defineProperty,
      freeze
    },
    Number: {
      isFinite
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

  const time = {
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

    sync(resetScale = true) {
      if (pristine) return;
      if (resetScale) scale = 1;
      timeSync = true;
      update();
      timeSync = false;
      pristine = scale === 1;
    },

    save(saveTime = true, saveScale = true) {
      if (saveTime) {
        if (pristine) {
          GM_deleteValue('baseTime');
          GM_deleteValue('contTime');
        } else {
          GM_setValue('baseTime', time.real);
          GM_setValue('contTime', time.now);
        }
      }
      if (saveScale) {
        if (scale === 1) GM_deleteValue('scale');
        else GM_setValue('scale', time.scale);
      }
    },

    load(loadTime = true, loadScale = true) {
      if (loadTime) {
        let baseTime = GM_getValue('baseTime', null);
        let contTime = GM_getValue('contTime', null);
        if (baseTime != null && contTime != null)
          time.jump((time.now - baseTime) + contTime);
      }
      if (loadScale) {
        let newScale = GM_getValue('scale', null);
        if (newScale != null) time.scale = newScale;
      }
    },

    get debug() { return debug; },
    set debug(value) { debug = !!value; },

    get now() { return apply(date.now, DateConstructor, []); },
    set now(value) { time.jump(value); },

    get pristine() { return pristine; },
    set pristine(value) { if (value) time.sync(); },

    get real() { return apply(date.realTime, DateConstructor, []); },

    get scale() { return scale; },
    set scale(value) {
      value = +value;
      if (value === scale) return;
      pristine = false; update(); scale = value;
    }
  };

  defineProperty(window, 'time', {
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
        contTime = timeJump == null ? handler.apply?.(func, self, []) : timeJump + offset;
        baseTime = apply(func, self, []);
        if (timeSync) contTime = baseTime;
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
        if (!pristine) {
          args.length = 1;
          args[0] = apply(date.now, DateConstructor, []);
        } else return DateConstructor();
        return apply(date.toString, construct(DateConstructor, args), []);
      },
      construct(target, args, newTarget) {
        if (debug) log('construct(%o, %o, %o)', target, args, newTarget);
        if (!pristine && args.length < 1) {
          args[0] = apply(date.now, DateConstructor, []);
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

  time.load();
})(
  /** @type {typeof window} */
  (typeof unsafeWindow === 'object' ? unsafeWindow : window)
);
