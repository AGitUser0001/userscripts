// ==UserScript==
// @name         Time Control
// @description  Script allowing you to control time.
// @icon         https://parsefiles.back4app.com/JPaQcFfEEQ1ePBxbf6wvzkPMEqKYHhPYv8boI1Rc/ce262758ff44d053136358dcd892979d_low_res_Time_Machine.png
// @namespace    mailto:lucaszheng2011@outlook.com
// @version      1.2.1
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
  let timeJump = null;
  let timeSync = false;
  let debug = false;

  const { isFinite,
          Reflect: {
            apply, construct,
            setPrototypeOf
          },
          Object: {
            defineProperty,
            freeze
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

  const time = freeze({
    get debug() { return debug; },
    set debug(value) { debug = !!value; },

    get scale() { return scale; },
    set scale(value) { pristine = false; update(); scale = +value; },

    get pristine() { return pristine; },
    set pristine(value) { if (value) time.sync(); },

    get now() { return apply(date.now, DateConstructor, []); },
    set now(value) { time.jump(value); },

    get real() { return apply(date.realTime, DateConstructor, []); },

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
    }
  });
  defineProperty(window, 'time', {
    value: time,
    writeable: true,
    enumerable: false,
    configurable: true
  });
  const updaters = [];

  function wrap_now(func, self, offset = 0) {
    let baseTime = 0;
    let contTime = baseTime;

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
        contTime = timeJump == null ? handler.apply(func, self, []): timeJump + offset;
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

  function wrap_timer(func, self) {
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
})(typeof unsafeWindow === 'object' ? unsafeWindow : globalThis);
