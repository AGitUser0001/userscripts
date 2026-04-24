// ==UserScript==
// @name        swapjs.dev/group Record & Replay
// @match       https://swapjs.dev/*
// @grant       unsafeWindow
// @grant       GM_xmlhttpRequest
// @inject-into page
// @version     1.2
// @author      auser0001
// ==/UserScript==

(async function () {
  'use strict';
  /**
   * @typedef {{ t: number, m: [x: number, y: number] }} RecordedMoveEvent
   * @typedef {{ t: number, d: number }} RecordedDownEvent
   * @typedef {{ t: number, u: number }} RecordedUpEvent
   * @typedef {RecordedMoveEvent | RecordedDownEvent | RecordedUpEvent} RecordedEvent
   *
   * @typedef {{ t: number, o: number[] }} OpponentEvent
   *
   * @typedef {{
   *   startOrder: number[],
   *   opponentStartOrder: number[],
   *   events: RecordedEvent[],
   *   opponent: OpponentEvent[],
   *   opponentName: string,
   *   opponentNameClass: string | null
   * }} SwapRecording
   */

  /**
   * Parse UI timer text like "0.99s" into milliseconds.
   *
   * @param {string | null | undefined} text
   * @returns {number}
   */
  function parseUiSecondsToMs(text) {
    if (!text) return 0;
    const m = String(text).trim().match(/(\d+(?:\.\d+)?)\s*s/i);
    return m ? Math.round(parseFloat(m[1]) * 1000) : 0;
  }

  /**
   * @returns {number}
   */
  function readCurrentUiTimerMs() {
    /** @type {HTMLElement | null} */
    const youTime =
      document.querySelector('.match-head .vs-side:not(.right) .vs-time') ||
      document.querySelector('.match-head .vs-time');

    return parseUiSecondsToMs(youTime?.textContent);
  }

  /**
   * @returns {Promise<string>}
   */
  async function readMatchSvelteClass() {
    const re = /\.match-wrap\.(svelte-\w+)\b/;

    for (const sheet of Array.from(document.styleSheets)) {
      /** @type {CSSRuleList | undefined} */
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      if (!rules) continue;

      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSStyleRule)) continue;
        const selector = rule.selectorText;
        if (!selector) continue;
        const m = selector.match(re);
        if (m) return m[1];
      }
    }

    /** @type {HTMLElement | null} */
    const existing = document.querySelector('.match-wrap');
    const klass = existing?.className.match(/\bsvelte-\w+\b/)?.[0];
    if (klass) return klass;

    return new Promise(r => {
      requestAnimationFrame(() => r(readMatchSvelteClass()))
    });
  }

  /**
   * @param {ParentNode} [root=document]
   * @returns {HTMLElement[]}
   */
  function queryPlayerBars(root = document) {
    return Array.from(root.querySelectorAll('.arena .bar'));
  }

  /**
   * @param {ParentNode} [root=document]
   * @returns {HTMLElement[]}
   */
  function queryOpponentBars(root = document) {
    return Array.from(root.querySelectorAll('.opp-bars .opp-bar'));
  }

  /**
   * @param {ParentNode} [root=document]
   * @returns {number[]}
   */
  function readPlayerValues(root = document) {
    return Array.from(root.querySelectorAll('.arena .bar .bar-val'))
      .map(el => Number(String(el.textContent || '').trim()))
      .filter(n => Number.isFinite(n));
  }

  /**
   * @param {number[]} values
   * @returns {{ value: number, height: number }[]}
   */
  function buildHeightValueTable(values) {
    const max = Math.max(...values);
    return values.map(value => ({
      value,
      height: (value / max) * 100
    }));
  }

  /**
   * @param {{ value: number, height: number }[]} table
   * @param {number} height
   * @returns {number}
   */
  function valueFromHeight(table, height) {
    let bestValue = table[0]?.value ?? 0;
    let bestDiff = Infinity;

    for (const entry of table) {
      const diff = Math.abs(entry.height - height);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestValue = entry.value;
      }
    }

    return bestValue;
  }

  /**
   * @param {HTMLElement[]} oppBars
   * @param {{ value: number, height: number }[]} table
   * @returns {number[]}
   */
  function readOpponentValuesFromHeights(oppBars, table) {
    return oppBars.map(bar => {
      const h = parseFloat(bar.style.height || '0');
      return valueFromHeight(table, h);
    });
  }

  /**
   * @param {number[] | null | undefined} a
   * @param {number[] | null | undefined} b
   * @returns {boolean}
   */
  function sameNumberArray(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  class SwapRecorder {
    constructor() {
      /** @type {SwapRecording} */
      this.data = {
        startOrder: [],
        opponentStartOrder: [],
        events: [],
        opponent: [],
        opponentName: 'opponent',
        opponentNameClass: null
      };

      /** @type {HTMLElement | null} */
      this.activeBar = null;

      /** @type {number} */
      this.matchStartTime = 0;

      /** @type {number} */
      this._barCount = 0;

      /** @type {number} */
      this._gap = 8;

      /**
       * Pointer offset inside the grabbed bar, in px from the bar's left edge.
       * This is needed so pointerup can reproduce the game's drop-index logic.
       * @type {number}
       */
      this._dragPointerOffsetX = 0;

      /** @type {number} */
      this._dragStartIndex = -1;

      /** @type {MutationObserver | null} */
      this._observer = null;

      /** @type {number | null} */
      this._watchdogRaf = null;

      /** @type {{ value: number, height: number }[]} */
      this._opponentHeightTable = [];

      this._onMove = this._onMove.bind(this);
      this._onDown = this._onDown.bind(this);
      this._onUp = this._onUp.bind(this);
      this._watchForArenaGone = this._watchForArenaGone.bind(this);
    }

    /**
     * @returns {number}
     */
    _time() {
      return performance.now() - this.matchStartTime;
    }

    /**
     * @returns {HTMLElement[]}
     */
    _bars() {
      /** @type {NodeListOf<HTMLElement>} */
      const q = document.querySelectorAll('.arena .bar');
      return [...q];
    }

    /**
     * @param {HTMLElement} bar
     * @returns {number}
     */
    _barIndex(bar) {
      return this._bars().indexOf(bar);
    }

    /**
     * @param {EventTarget | null} target
     * @returns {HTMLElement | null}
     */
    _barFromTarget(target) {
      if (!(target instanceof HTMLElement)) return null;
      const bar = target.closest('.bar');
      return bar instanceof HTMLElement ? bar : null;
    }

    /**
     * @returns {HTMLElement}
     */
    _getArena() {
      const arena = document.querySelector('.arena');
      if (!(arena instanceof HTMLElement)) {
        throw new Error('No arena');
      }
      return arena;
    }

    /**
     * @returns {{
     *   arena: HTMLElement,
     *   rect: DOMRect,
     *   count: number,
     *   gap: number,
     *   barWidth: number,
     *   step: number
     * }}
     */
    _getLayoutMetrics() {
      const arena = this._getArena();
      const rect = arena.getBoundingClientRect();
      const count = this._barCount || this.data.startOrder.length || this._bars().length;
      const gap = this._gap;
      const barWidth = Math.max(12, (rect.width - gap * (count - 1)) / count);
      const step = barWidth + gap;

      return { arena, rect, count, gap, barWidth, step };
    }

    /**
     * Convert pointer event coordinates to normalized arena-local coordinates.
     *
     * @param {PointerEvent} e
     * @returns {[x: number, y: number]}
     */
    _getPos(e) {
      const arena = this._getArena();
      const rect = arena.getBoundingClientRect();

      if (!rect.width || !rect.height) {
        throw new Error('Arena has invalid rect');
      }

      return [
        (e.clientX - rect.left) / rect.width,
        (e.clientY - rect.top) / rect.height
      ];
    }

    /**
     * Compute the same style of slot index the game computes from pointer position.
     * Uses the real pointer grab offset captured on pointerdown.
     *
     * @param {PointerEvent} e
     * @returns {number}
     */
    _indexFromEvent(e) {
      const { rect, count, barWidth, step } = this._getLayoutMetrics();

      const localPointerX = e.clientX - rect.left;

      const dragLeft = Math.max(
        0,
        Math.min(rect.width - barWidth, localPointerX - this._dragPointerOffsetX)
      );

      const q = (dragLeft + barWidth / 2) / step - 0.5;
      const rounded = Math.round(q);

      return Math.max(0, Math.min(count - 1, rounded));
    }

    /**
     * @returns {Promise<void>}
     */
    async start() {
      await this._waitFor(() =>
        !!document.querySelector('.tab-body .match-wrap') &&
        !!document.querySelector('.arena') &&
        !!document.querySelector('.arena .bar-val')
      );

      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      this.matchStartTime = performance.now() - readCurrentUiTimerMs();

      this.data.startOrder = readPlayerValues(document);

      const oppName = document.querySelector('.vs-side.right .vs-name');
      if (oppName) {
        this.data.opponentName = oppName.textContent.trim();
        this.data.opponentNameClass = [...oppName.classList].find(x => x.startsWith('name-')) || null;
      }

      this._barCount = this.data.startOrder.length;

      const oppBars = queryOpponentBars(document);
      this._opponentHeightTable = buildHeightValueTable(this.data.startOrder);

      const inferredOpponent = readOpponentValuesFromHeights(oppBars, this._opponentHeightTable);
      this.data.opponentStartOrder =
        inferredOpponent.length === this.data.startOrder.length
          ? inferredOpponent
          : this.data.startOrder.slice();

      window.addEventListener('pointermove', this._onMove, true);
      window.addEventListener('pointerdown', this._onDown, true);
      window.addEventListener('pointerup', this._onUp, true);

      this._observeOpponent();
      this._watchdogRaf = requestAnimationFrame(this._watchForArenaGone);

      this.started = true;
    }

    /**
     * @returns {void}
     */
    stop() {
      window.removeEventListener('pointermove', this._onMove, true);
      window.removeEventListener('pointerdown', this._onDown, true);
      window.removeEventListener('pointerup', this._onUp, true);

      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
      }

      if (this._watchdogRaf != null) {
        cancelAnimationFrame(this._watchdogRaf);
        this._watchdogRaf = null;
      }

      this.started = false;
    }

    /**
     * @returns {SwapRecording}
     */
    export() {
      return {
        startOrder: this.data.startOrder.slice(),
        opponentStartOrder: this.data.opponentStartOrder.slice(),
        events: this.data.events.slice(),
        opponent: this.data.opponent.slice(),
        opponentName: this.data.opponentName,
        opponentNameClass: this.data.opponentNameClass
      };
    }

    /**
     * @param {PointerEvent} e
     * @returns {void}
     */
    _onMove(e) {
      if (!document.querySelector('.arena')) return;

      this.data.events.push({
        t: this._time(),
        m: this._getPos(e)
      });
    }

    /**
     * @param {PointerEvent} e
     * @returns {void}
     */
    _onDown(e) {
      const bar = this._barFromTarget(e.target);
      if (!bar) return;

      this.activeBar = bar;
      this._dragStartIndex = this._barIndex(bar);

      const barRect = bar.getBoundingClientRect();
      this._dragPointerOffsetX = e.clientX - barRect.left;

      this.data.events.push({
        t: this._time(),
        d: this._dragStartIndex
      });
    }

    /**
     * @param {PointerEvent} e
     * @returns {Promise<void>}
     */
    async _onUp(e) {
      if (!this.activeBar) return;

      const t = this._time();

      // Compute authoritative drop index immediately, before DOM teardown/reorder.
      const u = this._indexFromEvent(e);

      await this._waitForDragEnd();

      this.data.events.push({ t, u });

      this.activeBar = null;
      this._dragStartIndex = -1;
      this._dragPointerOffsetX = 0;
    }

    /**
     * @returns {Promise<void>}
     */
    async _waitForDragEnd() {
      while (true) {
        await new Promise(r => requestAnimationFrame(r));
        if (!document.querySelector('.arena .bar.dragging')) return;
        if (!document.querySelector('.arena')) return;
      }
    }

    /**
     * @returns {void}
     */
    _observeOpponent() {
      /** @type {HTMLElement | null} */
      const container = document.querySelector('.opp-arena');
      if (!container) return;

      /** @type {number[] | null} */
      let last = null;

      this._observer = new MutationObserver(() => {
        const oppBars = queryOpponentBars(document);
        const state = readOpponentValuesFromHeights(oppBars, this._opponentHeightTable);

        if (!sameNumberArray(state, last)) {
          this.data.opponent.push({
            t: this._time(),
            o: state
          });
          last = state;
        }
      });

      this._observer.observe(container, {
        attributes: true,
        attributeFilter: ['style', 'class'],
        childList: true,
        subtree: true,
        characterData: false
      });
    }

    /**
     * @returns {void}
     */
    _watchForArenaGone() {
      if (!document.querySelector('.arena')) {
        this.stop();
        return;
      }
      this._watchdogRaf = requestAnimationFrame(this._watchForArenaGone);
    }

    /**
     * @param {() => boolean} fn
     * @returns {Promise<void>}
     */
    _waitFor(fn) {
      return new Promise(resolve => {
        const tick = () => {
          if (fn()) return resolve();
          requestAnimationFrame(tick);
        };
        tick();
      });
    }
  }

  /**
   * @typedef {'replay' | 'ghost-player' | 'ghost-opponent'} GhostMode
   */
  class SwapReplay {
    /**
     * @param {SwapRecording} data
     * @param {string} html
     * @param {FakeCursor} cursor
     * @param {GhostMode} [mode]
     */
    constructor(data, html, cursor, mode = 'replay') {
      this.mode = mode;
      this.data = data;
      this.cursor = cursor;

      /** @type {HTMLElement} */
      this.root = this._createDOM(html);

      /** @type {HTMLElement} */
      this.arena = assert(this.root.querySelector('.arena'));

      /** @type {HTMLElement[]} */
      this.bars = queryPlayerBars(this.root);

      /** @type {HTMLElement[]} */
      this.oppBars = queryOpponentBars(this.root);

      /** @type {HTMLElement | null} */
      this.playerTimeEl = this.root.querySelector('.match-head .vs-side:not(.right) .vs-time');

      /** @type {HTMLElement | null} */
      this.opponentTimeEl = this.root.querySelector('.match-head .vs-side.right .vs-time');

      /** @type {HTMLElement | null} */
      this.playerMovesEl = this.root.querySelector('.match-head .vs-side:not(.right) .vs-moves');

      /** @type {HTMLElement | null} */
      this.opponentMovesEl = this.root.querySelector('.match-head .vs-side.right .vs-moves');

      const oppNameEl = this.root.querySelector('.vs-side.right .vs-name');

      if (oppNameEl) {
        oppNameEl.textContent = this.data.opponentName;
        if (this.data.opponentNameClass)
          oppNameEl.classList.add(this.data.opponentNameClass);
      }

      const oppNameEl2 = this.root.querySelector('.opp-label span');
      if (oppNameEl2) {
        oppNameEl2.textContent = this.data.opponentName;
        if (this.data.opponentNameClass)
          oppNameEl2.classList.add(this.data.opponentNameClass);
      }

      /** @type {number} */
      this.gap = 8;

      /** @type {number} */
      this.barWidth = 0;

      /** @type {number} */
      this.step = 0;

      /** @type {HTMLElement | null} */
      this.dragEl = null;

      /** @type {number} */
      this.dragIndex = -1;

      /** @type {number} */
      this.targetIndex = -1;

      /** @type {number} */
      this.dragLeft = 0;

      /** @type {number} */
      this.startTime = 0;

      /** @type {number | null} */
      this._timerRaf = null;

      /** @type {number | null} */
      this._resizeRaf = null;

      /** @type {number} */
      this._lastPlayerMoveCount = 0;

      /** @type {number} */
      this._lastOpponentMoveCount = 0;

      /** @type {OpponentEvent[]} */
      this._opponentEvents = (data.opponent || []).slice().sort((a, b) => a.t - b.t);

      if (mode === 'ghost-player') {
        this._opponentEvents = this._convertPlayerToOpponent();
      }

      /** @type {number} */
      this._nextOpponentEventIndex = 0;

      this._onResize = this._onResize.bind(this);

      this._resetInjectedState();
      this._applyResponsiveRootSizing();
      this._initBarsFromStartOrder();
      this._initOpponentFromStartOrder();
      this._layout();
      window.addEventListener('resize', this._onResize, { passive: true });

      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onPointerUp = this._onPointerUp.bind(this);

      this.arena.addEventListener('pointerdown', this._onPointerDown);
      window.addEventListener('pointermove', this._onPointerMove);
      window.addEventListener('pointerup', this._onPointerUp);
    }

    /**
     * @param {string} html
     * @returns {HTMLElement}
     */
    _createDOM(html) {
      const container = document.createElement('div');
      container.innerHTML = html.trim();

      const root = container.firstElementChild;
      if (!(root instanceof HTMLElement)) {
        throw new Error('Replay HTML did not produce a root element');
      }

      Object.assign(root.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '999999',
        width: '100vw',
        height: '100vh',
        borderRadius: '0',
        boxSizing: 'border-box'
      });

      const close = document.createElement('span');
      close.textContent = '✕';
      close.style.cursor = 'pointer';
      close.style.position = 'absolute';
      close.style.top = '10px';
      close.style.right = '10px';

      close.onclick = () => this.destroy();

      root.appendChild(close);

      document.body.appendChild(root);
      return root;
    }

    /**
     * @returns {void}
     */
    _applyResponsiveRootSizing() {
      this.root.style.width = `${window.innerWidth}px`;
      this.root.style.height = `${window.innerHeight}px`;
    }

    /**
     * @returns {void}
     */
    _onResize() {
      if (this._resizeRaf != null) return;
      this._resizeRaf = requestAnimationFrame(() => {
        this._resizeRaf = null;
        this._applyResponsiveRootSizing();
        this._layout();
      });
    }

    /**
     * @returns {void}
     */

    destroy() {
      this._destroyed = true;

      this._stopUiTimer();

      window.removeEventListener('resize', this._onResize);

      this.arena.removeEventListener('pointerdown', this._onPointerDown);
      window.removeEventListener('pointermove', this._onPointerMove);
      window.removeEventListener('pointerup', this._onPointerUp);

      if (this._resizeRaf != null) {
        cancelAnimationFrame(this._resizeRaf);
        this._resizeRaf = null;
      }

      this.root.remove();
    }

    /**
     * @returns {void}
     */
    _resetInjectedState() {
      for (const bar of this.bars) {
        bar.classList.remove('dragging');
        bar.style.left = '';
        bar.style.width = '';
      }

      this.dragEl = null;
      this.dragIndex = -1;
      this.targetIndex = -1;
      this.dragLeft = 0;
    }

    /**
     * @returns {void}
     */
    _initBarsFromStartOrder() {
      const values = this.data.startOrder.slice();
      const max = Math.max(...values);

      if (values.length !== this.bars.length) {
        throw new Error(`startOrder length ${values.length} !== player bar count ${this.bars.length}`);
      }

      this.bars.forEach((bar, i) => {
        const valEl = bar.querySelector('.bar-val');
        if (!(valEl instanceof HTMLElement)) {
          throw new Error('Missing .bar-val in player bar');
        }

        const value = values[i];
        valEl.textContent = String(value);
        bar.style.height = `${(value / max) * 100}%`;
      });
    }

    /**
     * @returns {void}
     */
    _initOpponentFromStartOrder() {
      const values =
        this.data.opponentStartOrder.length === this.oppBars.length
          ? this.data.opponentStartOrder.slice()
          : this.data.startOrder.slice();

      if (!values.length || !this.oppBars.length) return;

      const max = Math.max(...values);

      this.oppBars.forEach((bar, i) => {
        bar.style.height = `${(values[i] / max) * 100}%`;
      });
    }

    /**
     * @returns {void}
     */
    _computeLayout() {
      const rect = this.arena.getBoundingClientRect();
      const W = rect.width;
      const N = this.bars.length;

      this.barWidth = Math.max(12, (W - this.gap * (N - 1)) / N);
      this.step = this.barWidth + this.gap;
    }

    /**
     * @param {number} i
     * @returns {number}
     */
    _computeLeft(i) {
      if (this.dragIndex === -1) return i * this.step;
      if (i === this.dragIndex) return this.dragLeft;

      let r = i;

      if (this.dragIndex < this.targetIndex) {
        if (i > this.dragIndex && i <= this.targetIndex) r = i - 1;
      } else if (this.dragIndex > this.targetIndex) {
        if (i >= this.targetIndex && i < this.dragIndex) r = i + 1;
      }

      return r * this.step;
    }

    /**
     * @returns {void}
     */
    _layout() {
      this._computeLayout();

      this.bars.forEach((bar, i) => {
        bar.style.width = `${this.barWidth}px`;
        bar.style.left = `${this._computeLeft(i)}px`;
      });
    }

    /**
     * @param {[x: number, y: number]} pos
     * @returns {{ x: number, y: number }}
     */
    _arenaToClient(pos) {
      const [nx, ny] = pos;
      const rect = this.arena.getBoundingClientRect();

      return {
        x: rect.left + nx * rect.width,
        y: rect.top + ny * rect.height
      };
    }

    /**
     * @param {[x: number, y: number]} pos
     * @returns {number}
     */
    _arenaLocalX(pos) {
      const [nx] = pos;
      return nx * this.arena.getBoundingClientRect().width;
    }

    /**
     * @param {number} index
     * @returns {{ x: number, y: number }}
     */
    _getSnapPos(index) {
      const rect = this.arena.getBoundingClientRect();

      const x = rect.left + (index * this.step + this.barWidth / 2);

      const minY = rect.top + rect.height * 0.2;
      const maxY = rect.bottom - rect.height * 0.1;
      const y = Math.max(minY, Math.min(maxY, this.cursor.y));

      return { x, y };
    }

    /**
     * @param {number} from
     * @param {number} to
     * @returns {void}
     */
    _move(from, to) {
      const [el] = this.bars.splice(from, 1);
      this.bars.splice(to, 0, el);
      this.arena.append(...this.bars);
    }

    /**
     * @param {number[]} values
     * @returns {void}
     */
    _updateOpponent(values) {
      if (!values.length || !this.oppBars.length) return;

      const max = Math.max(...values);
      this.oppBars.forEach((bar, i) => {
        if (i < values.length) {
          bar.style.height = `${(values[i] / max) * 100}%`;
        }
      });
    }

    /**
     * @returns {void}
     */
    _startUiTimer() {
      /** @type {number | null} */
      let frozenPlayerMs = null;
      /** @type {number | null} */
      let frozenOppMs = null;

      const tick = () => {
        const elapsed = performance.now() - this.startTime;

        let playerMs;
        if (frozenPlayerMs != null)
          playerMs = frozenPlayerMs;
        else {
          playerMs = elapsed;
          if (this._isSorted())
            frozenPlayerMs = playerMs;
        }

        let opponentMs;
        if (frozenOppMs != null)
          opponentMs = frozenOppMs;
        else {
          opponentMs = elapsed;
          if (this._oppIsSorted())
            frozenOppMs = opponentMs;
        }

        if (this.playerTimeEl) {
          this.playerTimeEl.textContent = `${(playerMs / 1000).toFixed(2)}s`;
        }

        if (this.opponentTimeEl) {
          this.opponentTimeEl.textContent = `${(opponentMs / 1000).toFixed(2)}s`;
        }

        this._timerRaf = requestAnimationFrame(tick);
      };

      this._timerRaf = requestAnimationFrame(tick);
    }

    /**
     * @returns {void}
     */
    _stopUiTimer() {
      if (this._timerRaf != null) {
        cancelAnimationFrame(this._timerRaf);
        this._timerRaf = null;
      }
    }

    /**
     * @returns {void}
     */
    _renderMoveCounts() {
      if (this.playerMovesEl) {
        this.playerMovesEl.textContent = `${this._lastPlayerMoveCount} moves`;
      }
      if (this.opponentMovesEl) {
        this.opponentMovesEl.textContent = `${this._lastOpponentMoveCount} moves`;
      }
    }

    /**
     * @param {number} t
     * @returns {void}
     */
    _flushOpponentUntil(t) {
      while (
        this._nextOpponentEventIndex < this._opponentEvents.length &&
        this._opponentEvents[this._nextOpponentEventIndex].t <= t
      ) {
        const ev = this._opponentEvents[this._nextOpponentEventIndex++];
        this._updateOpponent(ev.o);
        this._lastOpponentMoveCount++;
        this._renderMoveCounts();
      }
    }

    /**
     * @returns {Promise<void>}
     */
    async play() {
      await new Promise(r => requestAnimationFrame(r));
      await new Promise(r => requestAnimationFrame(r));

      this.startTime = performance.now();
      this._startUiTimer();
      this._renderMoveCounts();

      for (const e of this.data.events) {
        await this._wait(e.t);
        this._flushOpponentUntil(e.t);
        await this._handle(e);
        if (this._destroyed) return;
      }

      this._flushOpponentUntil(Infinity);

      if (this.dragEl) {
        const from = this.bars.indexOf(this.dragEl);
        const to = this.targetIndex;

        this._move(from, to);
        this.dragEl.classList.remove('dragging');

        this.dragEl = null;
        this.dragIndex = -1;
        this.targetIndex = -1;

        this._layout();
      }

      this._stopUiTimer();
    }

    /**
     * @param {number} t
     * @returns {Promise<void>}
     */
    async _wait(t) {
      while (true) {
        const now = performance.now() - this.startTime;
        const dt = t - now;
        if (dt <= 0) return;
        await new Promise(r => setTimeout(r, Math.min(dt, 4)));
      }
    }

    /**
     * @param {RecordedEvent} e
     * @returns {Promise<void>}
     */
    async _handle(e) {
      if (this.mode !== 'replay') return;

      if ('m' in e) {
        this.cursor.pointerMove(this._arenaToClient(e.m));
      }

      if ('d' in e) {
        const pos = this._getSnapPos(e.d);
        this.cursor.pointerMove(pos);
        this.cursor.pointerDown();
      }

      if ('u' in e) {
        const pos = this._getSnapPos(e.u);
        this.cursor.pointerMove(pos);
        this.cursor.pointerUp();
      }
    }

    /**
     * @param {number} clientX
     * @returns {number}
     */
    _indexFromClientX(clientX) {
      if (!this._dragOffsetX)
        throw new Error('Missing _dragOffsetX');

      const rect = this.arena.getBoundingClientRect();
      const count = this.bars.length;

      const barWidth = Math.max(12, (rect.width - this.gap * (count - 1)) / count);
      const step = barWidth + this.gap;

      const localPointerX = clientX - rect.left;

      const dragLeft = Math.max(
        0,
        Math.min(rect.width - barWidth, localPointerX - this._dragOffsetX)
      );

      const q = (dragLeft + barWidth / 2) / step - 0.5;
      return Math.max(0, Math.min(count - 1, Math.round(q)));
    }


    /**
     * @param {PointerEvent} e
     */
    _onPointerDown(e) {
      if (this.mode === 'replay' && e.isTrusted) return;

      if (!(e.target instanceof HTMLElement)) return;

      const bar = e.target.closest('.bar');
      if (!(bar instanceof HTMLElement)) return;

      this.dragEl = bar;
      this.dragIndex = this.bars.indexOf(bar);
      this.targetIndex = this.dragIndex;

      const barRect = bar.getBoundingClientRect();
      this._dragOffsetX = e.clientX - barRect.left;

      this.dragLeft = barRect.left - this.arena.getBoundingClientRect().left;
      bar.classList.add('dragging');
    }

    /**
     * @param {PointerEvent} e
     */

    _onPointerMove(e) {
      if (this.mode === 'replay' && e.isTrusted) return;
      if (!this.dragEl) return;
      if (!this._dragOffsetX)
        throw new Error('Missing _dragOffsetX');

      const rect = this.arena.getBoundingClientRect();

      this.dragLeft = Math.max(
        0,
        Math.min(
          rect.width - this.barWidth,
          e.clientX - rect.left - this._dragOffsetX
        )
      );

      this.targetIndex = this._indexFromClientX(e.clientX);
      this._layout();
    }


    /**
     * @param {PointerEvent} e
     */
    _onPointerUp(e) {
      if (this.mode === 'replay' && e.isTrusted) return;
      if (!this.dragEl) return;

      this.targetIndex = this._indexFromClientX(e.clientX);

      const from = this.bars.indexOf(this.dragEl);
      const to = this.targetIndex;

      this._move(from, to);

      this.dragEl.classList.remove('dragging');
      this.dragEl = null;
      this.dragIndex = -1;
      this.targetIndex = -1;
      this._dragOffsetX = 0;

      this._lastPlayerMoveCount++;
      this._renderMoveCounts();
      this._layout();

      if (this._isSorted()) this._onFinish();
    }

    _convertPlayerToOpponent() {
      let bars = this.data.startOrder.map((v, i) => ({ v, id: i }));

      const result = [];

      let lastDown = -1;

      for (const e of this.data.events) {
        if ('d' in e) {
          lastDown = e.d;
        }

        if ('u' in e && lastDown !== -1) {
          const from = lastDown;
          const to = e.u;

          const [el] = bars.splice(from, 1);
          bars.splice(to, 0, el);

          result.push({
            t: e.t,
            o: bars.map(x => x.v)
          });

          lastDown = -1;
        }
      }

      return result;
    }

    _isSorted() {
      const vals = this.bars.map(
        bar => {
          const valEl = bar.querySelector('.bar-val');
          if (!(valEl instanceof HTMLElement)) {
            throw new Error('Missing .bar-val in player bar');
          }
          return Number(valEl.textContent);
        }
      );

      for (let i = 1; i < vals.length; i++) {
        if (vals[i] < vals[i - 1]) return false;
      }
      return true;
    }


    _oppIsSorted() {
      const vals = this.oppBars.map(
        bar => {
          return parseFloat(bar.style.height);
        }
      );

      for (let i = 1; i < vals.length; i++) {
        if (vals[i] < vals[i - 1]) return false;
      }
      return true;
    }

    _onFinish() {
      // freeze interaction
      this.arena.style.pointerEvents = 'none';
    }
  }

  //#region Fake Cursor
  class FakeCursor {
    /** @type {ForcedPseudo | null} */
    _pseudoController = null;

    /** @type {Map<string, boolean>} */
    _cursorLoadCache = new Map();

    /** @type {string | null} */
    _lastCursorImage = null;

    /** @type {Element | null} */
    _lastHoverEl = null;

    /** @type {Element[]} */
    _lastPath = [];

    hideCursor = false;
    hotspot = { x: 0, y: 0 };

    /**
     * @param {Record<string, { url: string, x?: number, y?: number }>} cursorMap
     */
    constructor(cursorMap = {}, enablePseudo = false) {
      if (enablePseudo)
        this._pseudoController = new ForcedPseudo();

      this.x = window.innerWidth / 2;
      this.y = window.innerHeight / 2;
      this.isDown = false;

      this.cursor = document.createElement("div");
      Object.assign(this.cursor.style, {
        position: "fixed",
        left: "0px",
        top: "0px",
        width: "100vw",
        height: "100vh",
        pointerEvents: "none",
        zIndex: "calc(infinity)",
        backgroundRepeat: "no-repeat"
      });

      this.cursorMap = cursorMap;

      document.body.appendChild(this.cursor);
      this._render();
    }

    /**
     * Parse CSS cursor string without naive comma split.
     * Returns { urls: [{url,x,y}], keyword }
     * @param {string} str
     */
    _parseCursor(str) {
      const urls = [];
      let keyword = "default";

      const re = /url\(\s*(['"]?)(.*?)\1\s*\)\s*(\d+)?\s*(\d+)?|([a-z-]+)/gi;
      let m;

      while ((m = re.exec(str))) {
        if (m[2]) {
          urls.push({
            url: m[2],
            x: m[3] ? +m[3] : 0,
            y: m[4] ? +m[4] : 0
          });
        } else if (m[5]) {
          keyword = m[5];
        }
      }

      return { urls, keyword };
    }

    /**
     * Sync check: assume true, flip to false on error
     * @param {string} url
     */
    _canUseCursor(url) {
      if (this._cursorLoadCache.has(url)) {
        return this._cursorLoadCache.get(url);
      }

      this._cursorLoadCache.set(url, true); // optimistic

      const img = new Image();
      img.onerror = () => this._cursorLoadCache.set(url, false);
      img.src = url;

      return true;
    }

    /**
     * Resolve cursor synchronously
     * @param {Element} el
     * @returns {{type: 'image', url: string, x: number, y: number} | {type: 'keyword', keyword: string}}
     */
    _resolveCursor(el) {
      const styleCursor = getComputedStyle(el).cursor;
      const { urls, keyword } = this._parseCursor(styleCursor);

      // 1. URL cursors
      for (const u of urls) {
        if (this._canUseCursor(u.url)) {
          return { type: "image", ...u };
        }
      }

      // 2. Keyword fallback
      let k = keyword;

      if (k === "auto") {
        k = this._isTextCursorAtPoint(this.x, this.y) ? "text" : "default";
      }

      return { type: "keyword", keyword: k };
    }

    /**
     * Apply cursor + hotspot
     * @param {{type: 'image', url: string, x: number, y: number} | {type: 'keyword', keyword: string}} resolved
     */
    _applyCursor(resolved) {
      /** @type { {url: string, x?: number, y?: number} } */
      let cfg;

      if (resolved.type === "image") {
        cfg = resolved;
      } else if (resolved.type === 'keyword') {
        const config = this.cursorMap[resolved.keyword] || this.cursorMap.default;
        if (!config) return;
        cfg = config;
      } else {
        /** @type {never} */
        const _unreachable = resolved;
        return;
      }

      if (this._lastCursorImage !== cfg.url) {
        this.cursor.style.backgroundImage = `url(${cfg.url})`;
      }
      this._lastCursorImage = cfg.url;

      this.hotspot.x = cfg.x ?? 0;
      this.hotspot.y = cfg.y ?? 0;
    }

    /**
     * Update cursor entry point
     * @param {Element} el
     */
    _updateCursorFromElement(el) {
      if (this.hideCursor) {
        this.cursor.style.backgroundImage = "";
        this._lastCursorImage = null;
        return;
      }

      const resolved = this._resolveCursor(el);
      this._applyCursor(resolved);
    }

    /**
     * Render loop
     */
    _render() {
      const el = this._elementAtPoint();
      if (el) this._handleMouseOver(el);
      if (el) this._updateCursorFromElement(el);

      this.cursor.style.backgroundPosition =
        `${this.x - this.hotspot.x}px ${this.y - this.hotspot.y}px`;

      requestAnimationFrame(() => this._render());
    }

    /**
     * @param {Element | null} el 
     * @returns {boolean}
     */
    _isInContentEditable(el) {
      while (el) {
        if (el.nodeType !== Node.ELEMENT_NODE) {
          el = el.parentElement;
          continue;
        }

        const attr = el.getAttribute("contenteditable");

        if (attr === "true" || attr === "") return true;
        if (attr === "false") return false;

        el = el.parentElement;
      }

      return false;
    }

    /**
     * @param {Node | null} el 
     * @returns {boolean}
     */
    _isUserSelectable(el) {
      while (el) {
        if (el instanceof Element) {
          const style = getComputedStyle(el);

          const userSelect =
            style.userSelect ||
            style.webkitUserSelect;

          if (userSelect === "none") return false;

          // stop early if explicitly selectable (optional optimization)
          if (userSelect === "text" || userSelect === "all") return true;
        }

        el = el.parentElement;
      }

      return true;
    }

    /**
     * @param {number} x 
     * @param {number} y 
     * @returns {boolean}
     */
    _isTextCursorAtPoint(x, y) {
      const el = document.elementFromPoint(x, y);
      if (!el) return false;

      // -------------------------
      // 1. Native text inputs
      // -------------------------
      if (
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLInputElement &&
          !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(el.type))
      ) {
        return !el.disabled;
      }

      // -------------------------
      // 2. contenteditable (parent-chain)
      // -------------------------
      if (this._isInContentEditable(el)) {
        return true;
      }

      // -------------------------
      // 3. Caret-based detection
      // -------------------------
      const caret = document.caretPositionFromPoint?.(x, y);
      if (!caret) return false;

      const node = caret.offsetNode;

      if (!node || !(node instanceof Text)) return false;
      if (!this._isUserSelectable(node)) {
        return false;
      }

      const range = document.createRange();
      range.selectNodeContents(node);

      const rects = range.getClientRects();

      const dpr = window.devicePixelRatio || 1;
      const snap = (/** @type {number} */ v) => Math.round(v * dpr) / dpr;

      const px = snap(x);
      const py = snap(y);

      for (const rect of rects) {
        if (rect.width === 0 || rect.height === 0) continue;

        const left = snap(rect.left);
        const right = snap(rect.right);
        const top = snap(rect.top);
        const bottom = snap(rect.bottom);

        if (
          px >= left &&
          px <= right &&
          py >= top &&
          py <= bottom
        ) {
          return true;
        }
      }

      return false;
    }

    /**
     * @returns {Element | null}
     */
    _elementAtPoint() {
      return document.elementFromPoint(this.x, this.y);
    }

    /**
     * @param {`${'pointer' | 'mouse'}${string}` | 'click'} type
     * @param {Element | null} target
     * @param {{
     *  relatedTarget?: Element | null, bubbles?: boolean, detail?: number,
     *  movementX?: number, movementY?: number
     * }} param3
     */
    _dispatch(type, target = this._elementAtPoint(), {
      relatedTarget = null, bubbles = true, detail = 0,
      movementX = 0, movementY = 0
    } = {}) {
      if (!target) return;

      const common = {
        bubbles,
        cancelable: true,
        clientX: this.x,
        clientY: this.y,
        screenX: this.x,
        screenY: this.y,
        movementX, movementY,
        relatedTarget,
      };

      if (type.startsWith("pointer")) {
        target.dispatchEvent(new PointerEvent(type, {
          ...common,
          pointerType: "mouse",
          isPrimary: true,
          buttons: this.isDown ? 1 : 0,
          pressure: this.isDown ? 0.5 : 0,
          detail
        }));
      } else {
        target.dispatchEvent(new MouseEvent(type, {
          ...common,
          button: type === "mousemove" ? -1 : 0,
          buttons: this.isDown ? 1 : 0,
          detail
        }));
      }
    }

    /**
     * @param {Element} el 
     * @returns {boolean}
     */
    _isInside(el) {
      const rect = el.getBoundingClientRect();
      return (
        this.x >= rect.left &&
        this.x <= rect.right &&
        this.y >= rect.top &&
        this.y <= rect.bottom
      );
    }

    /**
     * @param {number} v 
     * @param {number} min 
     * @param {number} max 
     * @returns {number}
     */
    _clamp(v, min, max) {
      return Math.max(min, Math.min(v, max));
    }

    /**
     * @param {Element} el
     * @returns { { x: number, y: number } }
     */
    _getTargetPoint(el, inwardRatio = 0.08, inwardMin = 4, inwardMax = 10) {
      const rect = el.getBoundingClientRect();

      const cx = this.x;
      const cy = this.y;

      let tx = this._clamp(cx, rect.left, rect.right);
      let ty = this._clamp(cy, rect.top, rect.bottom);

      const insetX = Math.min(inwardMax, Math.max(inwardMin, rect.width * inwardRatio));
      const insetY = Math.min(inwardMax, Math.max(inwardMin, rect.height * inwardRatio));

      if (tx === rect.left) tx += insetX;
      else if (tx === rect.right) tx -= insetX;

      if (ty === rect.top) ty += insetY;
      else if (ty === rect.bottom) ty -= insetY;

      if (rect.left + insetX > rect.right - insetX)
        tx = (rect.left + rect.right) / 2;
      else
        tx = this._clamp(tx, rect.left + insetX, rect.right - insetX);

      if (rect.top + insetY > rect.bottom - insetY)
        ty = (rect.top + rect.bottom) / 2;
      else
        ty = this._clamp(ty, rect.top + insetY, rect.bottom - insetY);

      return { x: tx, y: ty };
    }

    // Faster start, stronger stop than the previous version.
    /**
     * @param {number} t 
     * @returns {number}
     */
    _easeOutHard(t) {
      return 1 - Math.pow(1 - t, 4);
    }

    /**
     * @param {Element | { x: number, y: number }} target
     * @param {number} duration
     * @returns {Promise<void>}
     */
    async moveTo(target, duration) {
      if (
        target instanceof Element &&
        this._isInside(target)
      ) {
        return;
      }

      /**
       * Resolve a target into a point.
       * @param {Element | { x: number, y: number }} target
       */
      const resolveTargetPoint = (target) => {
        if (target instanceof Element) {
          const pt = this._getTargetPoint(target);
          return { x: pt.x, y: pt.y };
        }
        return { x: target.x, y: target.y };
      };


      let initialPoint = resolveTargetPoint(target);

      const startX = this.x;
      const startY = this.y;
      const initialDx = initialPoint.x - startX;
      const initialDy = initialPoint.y - startY;
      const initialDist = Math.hypot(initialDx, initialDy);

      const startTime = performance.now();

      // Middle-only deviation, zero at start/end.
      const deviationMag =
        Math.min(6, Math.max(0, initialDist * 0.03)) * (Math.random() - 0.5);

      return new Promise(resolve => {
        /** @type {FrameRequestCallback} */
        const step = (now) => {
          let t = (now - startTime) / duration;
          if (isNaN(t)) t = 1;
          if (t < 0) t = 0;
          if (t > 1) t = 1;

          // Re-resolve only when following.
          const currentTarget = resolveTargetPoint(target);

          const dx = currentTarget.x - startX;
          const dy = currentTarget.y - startY;
          const dist = Math.hypot(dx, dy);

          if (dist < 1 / devicePixelRatio || t >= 1) {
            this.pointerMove(currentTarget);
            resolve();
            return;
          }

          const e = this._easeOutHard(t);

          let x = startX + dx * e;
          let y = startY + dy * e;

          // Perpendicular deviation, only through the middle.
          const nx = -dy / dist;
          const ny = dx / dist;

          const midEnvelope = Math.sin(Math.PI * t);
          const endFade = Math.max(0, 1 - Math.pow(t, 1.8));
          const deviation = deviationMag * midEnvelope * endFade;

          x += nx * deviation;
          y += ny * deviation;

          this.pointerMove({ x, y });

          if (t < 1) {
            requestAnimationFrame(step);
          } else {
            resolve();
          }
        };

        requestAnimationFrame(step);
      });
    }

    /**
     * @param {{x: number, y: number}} position 
     */
    pointerMove(position) {
      const movementX = position.x - this.x;
      const movementY = position.y - this.y;
      this.x = position.x;
      this.y = position.y;
      const el = this._elementAtPoint();
      this._handleMouseOver(el);
      this._dispatch("pointermove", el, { movementX, movementY });
      this._dispatch("mousemove", el, { movementX, movementY });
    }

    /** @type {Element[]} */
    _downPath = [];

    pointerDown() {
      this.isDown = true;
      const el = this._elementAtPoint();
      this._downPath = this._getPath(el);

      if (el)
        this._pseudoController?.togglePseudo(el, 'active', true);

      this._dispatch("pointerdown", el);
      this._dispatch("mousedown", el, { detail: 1 });
    }

    pointerUp() {
      const el = this._elementAtPoint();

      // remove active BEFORE events
      const downEl = this._downPath[0];
      if (downEl) {
        this._pseudoController?.togglePseudo(downEl, 'active', false);
      }

      this._dispatch("pointerup", el);
      this._dispatch("mouseup", el, { detail: 1 });

      const upPath = this._getPath(el);

      let clickTarget = null;

      for (const pathEl of this._downPath) {
        if (upPath.includes(pathEl)) {
          clickTarget = pathEl;
          break;
        }
      }

      if (clickTarget && !this._isDisabled(clickTarget)) {
        this._dispatch("click", clickTarget, { detail: 1 });
      }

      this.isDown = false;
      this._downPath = [];
    }

    async click(duration = (Math.random() / 1.5 + 0.75) * 500) {
      this.pointerDown();
      await new Promise(r => setTimeout(r, duration));
      this.pointerUp();
    }

    /**
     * @param {Element} el
     */
    _isDisabled(el) {
      return (el instanceof HTMLButtonElement ||
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement)
        ? el.disabled
        : false;
    }

    /**
     * @param {Element | null} el
     */
    _getPath(el) {
      const path = [];
      while (el) {
        path.push(el);
        el = el.parentElement;
      }
      return path;
    }

    /**
     * Handles mouse/pointer over/out/enter/leave events
     * @param {Element | null} newEl 
     */
    _handleMouseOver(newEl) {
      const oldPath = this._lastPath;
      const newPath = this._getPath(newEl);
      const oldEl = oldPath[0] || null;

      // find common ancestor
      let i = oldPath.length - 1;
      let j = newPath.length - 1;

      while (i >= 0 && j >= 0 && oldPath[i] === newPath[j]) {
        i--;
        j--;
      }

      const exited = oldPath.slice(0, i + 1);
      const entered = newPath.slice(0, j + 1);

      // --- OUT (target only, bubbling) ---
      if (oldEl && oldEl !== newEl) {
        this._dispatch("pointerout", oldEl, { relatedTarget: newEl, bubbles: true });
        this._dispatch("mouseout", oldEl, { relatedTarget: newEl, bubbles: true });
      }

      if (this._pseudoController) {
        for (const el of exited) {
          this._pseudoController.togglePseudo(el, 'hover', false);
        }

        for (const el of entered) {
          this._pseudoController.togglePseudo(el, 'hover', true);
        }
      }

      // --- LEAVE (inner → outer, level-aware relatedTarget) ---
      for (let k = 0; k < exited.length; k++) {
        const el = exited[k];
        const relatedTarget = newPath[k] || null;

        this._dispatch("pointerleave", el, { relatedTarget, bubbles: false });
        this._dispatch("mouseleave", el, { relatedTarget, bubbles: false });
      }

      // --- OVER (target only, bubbling) ---
      if (newEl && oldEl !== newEl) {
        this._dispatch("pointerover", newEl, { relatedTarget: oldEl, bubbles: true });
        this._dispatch("mouseover", newEl, { relatedTarget: oldEl, bubbles: true });
      }

      // --- ENTER (outer → inner, level-aware relatedTarget) ---
      for (let k = entered.length - 1; k >= 0; k--) {
        const el = entered[k];
        const relatedTarget = oldPath[k] || null;

        this._dispatch("pointerenter", el, { relatedTarget, bubbles: false });
        this._dispatch("mouseenter", el, { relatedTarget, bubbles: false });
      }

      this._lastPath = newPath;
    }
  }

  class ForcedPseudo {
    constructor({
      pseudos = ["hover", "active"],
      pollMs = 500,
    } = {}) {
      this.prefix = Math.random().toString(36).slice(2) + "_";
      this.pseudos = new Set(pseudos);

      /** @type {Record<string, string>} */
      this.classes = {};
      for (const p of pseudos) {
        this.classes[p] = this.prefix + p;
      }

      this.sourceToMirror = new WeakMap();
      this.sourceState = new WeakMap();
      this.ownedSheets = new WeakSet();
      this.knownSources = new Set();
      this.blockedSheets = new WeakSet();
      this.fetched = new WeakSet();

      this.pollMs = pollMs;
      this.timer = undefined;

      /** @type {any} */
      // @ts-ignore
      const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      /** @type {ForcedPseudo | undefined} */
      const singleton = w._ForcedPseudo_instance;
      if (singleton) return singleton;
      w._ForcedPseudo_instance = this;

      this.init();
      return this;
    }

    init() {
      this.reconcile();
      this.timer = setInterval(() => this.reconcile(), this.pollMs);
      return this;
    }

    destroy() {
      clearInterval(this.timer);

      document.adoptedStyleSheets =
        document.adoptedStyleSheets.filter(
          s => !this.ownedSheets.has(s)
        );

      this.knownSources.clear();
    }

    /**
     * @param {Element} el
     * @param {string} pseudo
     * @param {boolean} [force]
     */
    togglePseudo(el, pseudo, force) {
      const cls = this.classes[pseudo];
      if (!cls || !el) return;

      if (force === undefined) {
        el.classList.toggle(cls);
      } else {
        el.classList.toggle(cls, !!force);
      }
    }

    reconcile() {
      const sources = [
        ...document.styleSheets,
        ...document.adoptedStyleSheets
      ].filter(s =>
        !this.ownedSheets.has(s) &&
        !this.blockedSheets.has(s)
      );

      const current = new Set(sources);

      for (const sheet of sources) {
        this.knownSources.add(sheet);
        this.sync(sheet);
      }

      for (const sheet of [...this.knownSources]) {
        if (!current.has(sheet)) {
          this.remove(sheet);
        }
      }

      this.reorder(sources);
    }

    /**
     * @param {string} url 
     * @returns {Promise<string>}
     */
    fetchCSS(url) {
      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest === "function") {
          GM_xmlhttpRequest({
            method: "GET",
            url,
            onload: res => res.responseText ? resolve(res.responseText) : reject(),
            onerror: reject
          });
        } else {
          fetch(url)
            .then(r => r.text())
            .then(resolve)
            .catch(reject);
        }
      });
    }

    /**
     * @param {string} cssText
     * @param {string} baseHref
     */
    resolveUrls(cssText, baseHref) {
      if (!baseHref || !cssText) return cssText;

      const SCANNING = 0;
      const STRING = 1;
      const URL_STRING = 2;
      const RAW_URL = 3;

      let state = SCANNING;
      let quoteChar = null;
      let urlBuffer = "";
      let parenLevel = 0;
      let imageSetLevel = -1;

      let result = "";
      let i = 0;
      const len = cssText.length;

      /**
       * @param {string} path 
       */
      const resolve = (path) => {
        path = path.trim();
        // Ignore empty paths, internal IDs, data URIs, and already absolute URLs
        if (!path || path.startsWith('#') || /^(?:data:|https?:|\/\/)/i.test(path)) {
          return path;
        }
        try {
          return new URL(path, baseHref).href;
        } catch {
          return path;
        }
      };

      while (i < len) {
        const char = cssText[i];

        if (state === SCANNING) {
          // Handle escapes to avoid false positives
          if (char === '\\') {
            result += char + (cssText[i + 1] || '');
            i += 2;
            continue;
          }

          // Entering a string
          if (char === '"' || char === "'") {
            quoteChar = char;
            // If we are inside an image-set(), strings are implicitly URLs
            state = (imageSetLevel !== -1) ? URL_STRING : STRING;

            if (state === STRING) {
              result += char; // URL_STRING defers adding the quote until resolution
            }
            i++;
            continue;
          }

          if (char === '(') {
            parenLevel++;
            result += char;
            i++;
            continue;
          }

          if (char === ')') {
            parenLevel--;
            if (imageSetLevel !== -1 && parenLevel < imageSetLevel) {
              imageSetLevel = -1; // Exited the image-set()
            }
            result += char;
            i++;
            continue;
          }

          // Detect url()
          if ((char === 'u' || char === 'U') && cssText.slice(i, i + 4).toLowerCase() === 'url(') {
            result += cssText.slice(i, i + 4);
            i += 4;
            parenLevel++;

            // Fast-forward through whitespace inside url(
            while (i < len && /\s/.test(cssText[i])) {
              result += cssText[i];
              i++;
            }

            if (i < len) {
              if (cssText[i] === '"' || cssText[i] === "'") {
                quoteChar = cssText[i];
                state = URL_STRING;
                i++;
              } else {
                state = RAW_URL;
                urlBuffer = cssText[i]; // Start capturing the unquoted path
                i++;
              }
            }
            continue;
          }

          const imgset_RE = /^(?:-webkit-)?image-set\(/iy;
          // Detect image-set() or -webkit-image-set()
          if ((char === 'i' || char === 'I' || char === '-')) {
            imgset_RE.lastIndex = i;
            const match = cssText.match(imgset_RE)?.[0];
            if (match) {
              result += match;
              i += match.length;
              parenLevel++;
              imageSetLevel = parenLevel;
              continue;
            }
          }

          result += char;
          i++;
        }
        else if (state === STRING) {
          if (char === '\\') {
            result += char + (cssText[i + 1] || '');
            i += 2;
          } else if (char === quoteChar) {
            result += char;
            state = SCANNING;
            i++;
          } else {
            result += char;
            i++;
          }
        }
        else if (state === URL_STRING) {
          if (char === '\\') {
            urlBuffer += char + (cssText[i + 1] || '');
            i += 2;
          } else if (char === quoteChar) {
            result += quoteChar + resolve(urlBuffer) + quoteChar;
            urlBuffer = "";
            state = SCANNING;
            i++;
          } else {
            urlBuffer += char;
            i++;
          }
        }
        else if (state === RAW_URL) {
          if (char === '\\') {
            urlBuffer += char + (cssText[i + 1] || '');
            i += 2;
          } else if (char === ')') {
            // A raw URL ends at the closing parenthesis
            result += resolve(urlBuffer) + ')';
            urlBuffer = "";
            parenLevel--;

            if (imageSetLevel !== -1 && parenLevel < imageSetLevel) {
              imageSetLevel = -1;
            }

            state = SCANNING;
            i++;
          } else {
            urlBuffer += char;
            i++;
          }
        }
      }

      return result;
    }

    /**
   * @param {CSSStyleSheet} sheet
   */
    async processExternalSheet(sheet) {
      if (!sheet.href || this.fetched.has(sheet)) return;
      this.fetched.add(sheet);

      try {
        const rawCss = await this.fetchCSS(sheet.href);

        // 1. Resolve URLs once on the raw string
        const sanitizedCss = this.resolveUrls(rawCss, sheet.href);

        // 2. Parse the sanitized CSS
        const temp = new CSSStyleSheet();
        temp.replaceSync(sanitizedCss);

        // 3. Transform and create the mirror
        const transformed = this.collect(temp.cssRules, temp);
        this.create(sheet, transformed);
        this.sourceState.set(sheet, transformed);

        // Trigger an immediate reconcile to snap the new styles in
        this.reconcile();
      } catch (e) {
        this.blockedSheets.add(sheet);
        this.remove(sheet);
      }
    }

    /**
     * @param {CSSStyleSheet} sheet
     */
    sync(sheet) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        if (sheet.href) {
          this.processExternalSheet(sheet);
        } else {
          this.blockedSheets.add(sheet);
          this.remove(sheet);
        }
        return;
      }

      if (!rules) return;

      const css = this.collect(rules, sheet);

      const sig =
        css +
        "|" +
        sheet.disabled +
        "|" +
        (sheet.media?.mediaText || "");

      if (!this.sourceToMirror.has(sheet)) {
        this.create(sheet, css);
        this.sourceState.set(sheet, sig);
        return;
      }

      if (this.sourceState.get(sheet) !== sig) {
        this.create(sheet, css);
        this.sourceState.set(sheet, sig);
      }

      const mirror = this.sourceToMirror.get(sheet);
      if (mirror) {
        mirror.disabled = sheet.disabled;
      }
    }

    /**
     * @param {CSSStyleSheet} sheet
     * @param {string} css
     */
    create(sheet, css) {
      let mirror = this.sourceToMirror.get(sheet);

      if (!mirror) {
        mirror = new CSSStyleSheet({ media: sheet.media });
        this.sourceToMirror.set(sheet, mirror);
        this.ownedSheets.add(mirror);
      }

      mirror.replaceSync(css);
    }

    /**
     * @param {CSSStyleSheet} sheet
     */
    remove(sheet) {
      const mirror = this.sourceToMirror.get(sheet);
      if (mirror) {
        document.adoptedStyleSheets =
          document.adoptedStyleSheets.filter(s => s !== mirror);

        this.sourceToMirror.delete(sheet);
        this.sourceState.delete(sheet);
      }

      this.knownSources.delete(sheet);
    }

    /**
     * @param {CSSStyleSheet[]} sources
     */
    reorder(sources) {
      const mirrors = [];

      for (const s of sources) {
        const m = this.sourceToMirror.get(s);
        if (m) mirrors.push(m);
      }

      const external =
        document.adoptedStyleSheets.filter(
          s => !this.ownedSheets.has(s)
        );

      const newAdoptedStyleSheets = [...external, ...mirrors];
      for (let i = 0; i < newAdoptedStyleSheets.length; i++) {
        if (document.adoptedStyleSheets[i] !== newAdoptedStyleSheets[i])
          document.adoptedStyleSheets[i] = newAdoptedStyleSheets[i];
      }
      if (document.adoptedStyleSheets.length > newAdoptedStyleSheets.length)
        document.adoptedStyleSheets.length = newAdoptedStyleSheets.length;
    }

    /**
     * @param {CSSRuleList} rules
     * @param {CSSStyleSheet} sheet
     */
    collect(rules, sheet) {
      let out = "";

      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          const sel = this.transform(rule.selectorText);
          out += `${sel} { ${rule.style.cssText} }\n`;
        } else if ("cssRules" in rule) {
          const r = /** @type {CSSGroupingRule} */ (rule);
          const inner = this.collect(r.cssRules, sheet);
          if (!inner.trim()) continue;

          const i = r.cssText.indexOf("{");
          if (i === -1) continue;

          const prefix = r.cssText.slice(0, i);
          out += `${prefix}{\n${inner}}\n`;
        }
      }

      return out;
    }

    /**
     * @param {string} selector
     */
    transform(selector) {
      return selector.replace(
        /(?<!:):([a-z0-9-]+)\b(?![^\[]*\])(?!\()/gi,
        (_, name) => {
          if (!this.pseudos.has(name)) return ":" + name;
          return `:is(${":" + name}, ${"." + this.prefix + name})`;
        }
      );
    }
  }
  //#endregion

  const svClass = await readMatchSvelteClass();
  const snapshotHTML = `<div class="match-wrap ${svClass}">
  <div class="match-head ${svClass}">
    <div class="vs-side ${svClass}"><span class="vs-name ${svClass}">you</span> <span
      class="vs-time ${svClass}">0.99s</span> <span class="vs-moves ${svClass}">0 moves</span></div>
    <div class="match-clock ${svClass}"><span class="clock-cap ${svClass}">90s</span><!----></div>
    <div class="vs-side right ${svClass}"><span class="vs-name ${svClass}">sorting </span> <span
      class="vs-time ${svClass}">0.99s</span> <span class="vs-moves ${svClass}">6 moves</span></div>
  </div>
  <div class="arena ${svClass}">
    <div role="button" tabindex="0" class="bar ${svClass}" style="left: 0px; width: 57.0833px; height: 29.3684%;">
      <span class="bar-val ${svClass}">31</span></div>
    <div role="button" tabindex="0" class="bar ${svClass}"
      style="left: 65.0833px; width: 57.0833px; height: 50.2105%;"><span class="bar-val ${svClass}">53</span>
    </div>
    <div role="button" tabindex="0" class="bar ${svClass}"
      style="left: 130.167px; width: 57.0833px; height: 68.2105%;"><span class="bar-val ${svClass}">72</span>
    </div>
    <div role="button" tabindex="0" class="bar ${svClass}"
      style="left: 195.25px; width: 57.0833px; height: 58.7368%;"><span class="bar-val ${svClass}">62</span></div>
    <div role="button" tabindex="0" class="bar ${svClass}"
      style="left: 260.333px; width: 57.0833px; height: 25.5789%;"><span class="bar-val ${svClass}">27</span>
    </div>
    <div role="button" tabindex="0" class="bar ${svClass} dragging"
      style="left: 325.414px; width: 57.0833px; height: 28.4211%;"><span class="bar-val ${svClass}">30</span>
    </div>
    <div role="button" tabindex="0" class="bar ${svClass}" style="left: 390.5px; width: 57.0833px; height: 90%;">
      <span class="bar-val ${svClass}">95</span></div>
    <div role="button" tabindex="0" class="bar ${svClass}"
      style="left: 455.583px; width: 57.0833px; height: 82.4211%;"><span class="bar-val ${svClass}">87</span>
    </div>
    <div role="button" tabindex="0" class="bar ${svClass}"
      style="left: 520.667px; width: 57.0833px; height: 47.3684%;"><span class="bar-val ${svClass}">50</span>
    </div>
    <div role="button" tabindex="0" class="bar ${svClass}"
      style="left: 585.75px; width: 57.0833px; height: 89.0526%;"><span class="bar-val ${svClass}">94</span></div>
    <div role="button" tabindex="0" class="bar ${svClass}"
      style="left: 650.833px; width: 57.0833px; height: 69.1579%;"><span class="bar-val ${svClass}">73</span>
    </div>
    <div role="button" tabindex="0" class="bar ${svClass}"
      style="left: 715.917px; width: 57.0833px; height: 43.5789%;"><span class="bar-val ${svClass}">46</span>
    </div>
  </div>
  <div class="opp-arena ${svClass}">
    <div class="opp-label ${svClass}"><span class="${svClass}">sorting</span>'s board</div>
    <div class="opp-bars ${svClass}">
      <div class="opp-bar ${svClass}" style="height: 28.4211%;"></div>
      <div class="opp-bar ${svClass}" style="height: 31.5789%;"></div>
      <div class="opp-bar ${svClass}" style="height: 32.6316%;"></div>
      <div class="opp-bar ${svClass}" style="height: 48.4211%;"></div>
      <div class="opp-bar ${svClass}" style="height: 52.6316%;"></div>
      <div class="opp-bar ${svClass}" style="height: 55.7895%;"></div>
      <div class="opp-bar ${svClass}" style="height: 65.2632%;"></div>
      <div class="opp-bar ${svClass}" style="height: 75.7895%;"></div>
      <div class="opp-bar ${svClass}" style="height: 76.8421%;"></div>
      <div class="opp-bar ${svClass}" style="height: 100%;"></div>
      <div class="opp-bar ${svClass}" style="height: 91.5789%;"></div>
      <div class="opp-bar ${svClass}" style="height: 98.9474%;"></div>
    </div>
  </div>
</div>`;

  /**
   * @template T
   * @param {T | null | undefined} v
   * @returns {T}
   */
  function assert(v) {
    if (v == null)
      throw new Error('Assert failed!');
    return v;
  }

  function uuid4() {
    const hex = [];
    const randomValues = new Uint8Array(16);
    crypto.getRandomValues(randomValues);

    for (let i = 0; i < 16; i++) {
      // Set version 4 (at index 6) and variant (at index 8) per RFC4122
      if (i === 6) {
        hex.push(((randomValues[i] & 0x0f) | 0x40).toString(16).padStart(2, '0'));
      } else if (i === 8) {
        hex.push(((randomValues[i] & 0x3f) | 0x80).toString(16).padStart(2, '0'));
      } else {
        hex.push(randomValues[i].toString(16).padStart(2, '0'));
      }
    }

    return [
      hex.slice(0, 4).join(''),
      hex.slice(4, 6).join(''),
      hex.slice(6, 8).join(''),
      hex.slice(8, 10).join(''),
      hex.slice(10, 16).join('')
    ].join('-');
  }

  const replaySS = new CSSStyleSheet();
  replaySS.replaceSync(`
  .rc-root {
    background: var(--card);
    border-radius: 16px;
    padding: 20px 24px;
    box-shadow: 0 1px 4px #1613160a;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 310px;
  }

  /* Header - matches .rank-ladder-title and .lb-head */
  .rc-header {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
    padding-bottom: 12px;
    margin: 0;
  }

  /* Actions wrapper */
  .rc-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .rc-actions .row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  /* Standard Secondary Action Buttons - mapped from .choose-btn & .secondary-btn */
  .rc-actions button {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, transform 0.15s;
    flex: 1 1 auto;
    text-align: center;
  }

  .rc-actions button:not([data-act="replay"]):hover:not(:disabled) {
    color: var(--dark);
    border-color: var(--accent);
    transform: translateY(-1px);
  }

  /* Replay Button - Highlighted as a primary action (mapped from .primary-btn) */
  .rc-actions button[data-act="replay"] {
    background: var(--dark);
    color: var(--bg);
    border: 1px solid var(--dark);
  }

  .rc-actions button[data-act="replay"]:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px #16131622;
  }

  /* Delete Button - Danger styling mapped from .err / .stakes-neg */
  .rc-actions button[data-act="delete"]:hover:not(:disabled) {
    color: #b8432e;
    border-color: rgba(184, 67, 46, 0.3);
    background: #b8432e14;
  }

  [data-theme=dark] .rc-actions button[data-act="delete"]:hover:not(:disabled) {
    color: #e08668;
    border-color: rgba(224, 134, 104, 0.3);
    background: #e086681a;
  }

  /* List container - styling borrowed from .lb-table */
  .rc-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 8px;
    max-height: 240px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--muted) transparent;
  }

  /* Scrollbar styles matching the existing dark/light mode logic */
  .rc-list::-webkit-scrollbar {
    width: 8px;
  }

  .rc-list::-webkit-scrollbar-track {
    background: transparent;
  }

  .rc-list::-webkit-scrollbar-thumb {
    background: var(--muted);
    border-radius: 4px;
  }

  [data-theme=dark] .rc-list::-webkit-scrollbar-thumb {
    background: #ffffff2e;
  }

  [data-theme=dark] .rc-list {
    scrollbar-color: rgba(255,255,255,.18) transparent;
  }

  /* --- Collapsible Logic --- */

  /* Make the header clickable */
  .rc-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    user-select: none;
  }

  /* Subtle toggle button styling */
  .rc-toggle-btn {
    background: none;
    border: none;
    color: var(--muted);
    font-size: 10px;
    cursor: pointer;
    padding: 4px;
    transition: transform 0.2s ease;
  }

  /* Hide content when collapsed */
  .rc-root.is-collapsed .rc-content {
    display: none;
  }

  /* Remove border from header when closed so it looks clean */
  .rc-root.is-collapsed .rc-header {
    border-bottom: none;
    padding-bottom: 0;
  }

  /* Flip the arrow when collapsed */
  .rc-root.is-collapsed .rc-toggle-btn {
    transform: rotate(-90deg);
  }

  /* --- Mobile: Small Square Mode --- */
  @media (max-width: 600px) {
    .rc-root {
      transition: all 0.2s ease; /* Smooth morphing */
    }

    /* When collapsed on mobile, shrink to a perfect square */
    .rc-root.is-collapsed {
      min-width: 0;
      width: 48px;
      height: 48px;
      padding: 0;
      overflow: hidden;
      justify-content: center;
      border-radius: 12px; /* Slightly rounder for a floating icon look */
    }

    /* Hide the text title when in square mode */
    .rc-root.is-collapsed .rc-title {
      display: none;
    }

    /* Center the arrow in the square */
    .rc-root.is-collapsed .rc-header {
      justify-content: center;
      width: 100%;
      height: 100%;
    }

    /* Reset the arrow flip on mobile so it looks like an "expand" icon */
    .rc-root.is-collapsed .rc-toggle-btn {
      transform: rotate(0deg); 
      font-size: 14px; /* Make it a bit bigger for tap targets */
    }
  }
  `);
  document.adoptedStyleSheets.push(replaySS);

  /**
   * @typedef {0|1|2} ReplayResult // 0 unknown, 1 win, 2 loss
   *
   * @typedef {{
   *   id: string,
   *   ts: number,
   *   result: ReplayResult,
   *   data: SwapRecording
   * }} ReplayEntry
   */

  class ReplayController {
    _cursor = new FakeCursor({
      default: { url: "https://tobiasahlin.com/static/cursors/default.png" },
      text: { url: "https://tobiasahlin.com/static/cursors/type.png" },
      pointer: { url: "https://tobiasahlin.com/static/cursors/pointer.png" },
      grab: { url: "https://tobiasahlin.com/static/cursors/drag.png" },
      grabbing: { url: "https://tobiasahlin.com/static/cursors/drag.png" },
      'zoom-in': { url: "https://tobiasahlin.com/static/cursors/zoom-in.png" },
      'zoom-out': { url: "https://tobiasahlin.com/static/cursors/zoom-out.png" },
    }, true);

    constructor() {
      /** @type {IDBDatabase | null} */
      this.db = null;

      /** @type {ReplayEntry[]} */
      this.replays = [];

      /** @type {SwapRecorder | null} */
      this.recorder = null;

      /** @type {HTMLElement} */
      this.root = this._createUI();

      /** @type {HTMLElement} */
      this.listEl = assert(this.root.querySelector('.rc-list'));

      /** @type {string | null} */
      this.selectedId = null;

      this._cursor.pointerMove({ x: -500, y: -500 });

      this._init();
    }

    /* ================= DB ================= */

    async _openDB() {
      return new Promise((res, rej) => {
        const req = indexedDB.open('swap-replays', 1);

        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore('replays', { keyPath: 'id', autoIncrement: true });
        };

        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    }

    async _loadAll() {
      const tx = assert(this.db).transaction('replays');
      const store = tx.objectStore('replays');

      return new Promise(res => {
        const req = store.getAll();
        req.onsuccess = () => {
          const arr = req.result.sort((a, b) => b.ts - a.ts);
          res(arr);
        };
      });
    }

    /**
     * @param {ReplayEntry} entry
     */
    async _add(entry) {
      const tx = assert(this.db).transaction('replays', 'readwrite');
      tx.objectStore('replays').add(entry);
    }

    /**
     * @param {IDBValidKey} id
     */
    async _delete(id) {
      const tx = assert(this.db).transaction('replays', 'readwrite');
      tx.objectStore('replays').delete(id);
    }

    /* ================= INIT ================= */

    async _init() {
      this.db = await this._openDB();
      this.replays = await this._loadAll();
      this._renderList();
      this._watchMatches();
    }

    /* ================= AUTO RECORD ================= */

    async _watchMatches() {
      while (true) {
        this.recorder = new SwapRecorder();
        await this.recorder.start();

        await this._waitFor(() => !this.recorder?.started);

        this.recorder.stop();

        const result = await this._detectResult();

        const entry = {
          id: uuid4(),
          ts: Date.now(),
          result,
          data: this.recorder.export()
        };

        await this._add(entry);
        this.replays = await this._loadAll();
        this._renderList();
      }
    }

    /**
     * @returns {Promise<ReplayResult>}
     */
    async _detectResult() {
      while (true) {
        await new Promise(r => requestAnimationFrame(r));

        const rt = document.querySelector('.result-wrap .result-title');
        if (!rt) continue;

        const t = rt.textContent.toLowerCase();

        if (t.includes('won')) return 1;
        if (t.includes('lost')) return 2;
        return 0;
      }
    }

    /* ================= UI ================= */

    _createUI() {
      const el = document.createElement('div');

      el.className = 'rc-root';
      el.innerHTML = `
        <div class="rc-header">
          <span class="rc-title">Replays</span>
          <button class="rc-toggle-btn">▼</button>
        </div>

        <div class="rc-content">
          <div class="rc-actions">
            <div class="row">
              <button data-act="import">import</button>
              <button data-act="export">export</button>
              <button data-act="delete">delete</button>
            </div>
            <div class="row">
              <button data-act="replay">replay</button>
            </div>
            <div class="row">
              <button data-act="ghost-player">ghost: player</button>
              <button data-act="ghost-opponent">ghost: opponent</button>
            </div>
          </div>
          <div class="rc-list"></div>
        </div>
      `;

      const header = assert(el.querySelector('.rc-header'));
      header.addEventListener('click', () => {
        el.classList.toggle('is-collapsed');
      });

      Object.assign(el.style, {
        position: 'fixed',
        top: '3em',
        right: '1em',
        zIndex: 999999,
        borderRadius: '6px',
        overflow: 'hidden'
      });

      document.body.appendChild(el);

      this._wireUI(el);
      // this._makeDraggable(el);

      return el;
    }

    /**
     * @param {HTMLElement} root
     */
    _wireUI(root) {
      root.addEventListener('click', e => {
        if (!(e.target instanceof HTMLElement)) return;
        const btn = e.target.closest('button');
        if (!btn) return;

        const act = btn.dataset.act;

        if (act === 'replay') this._play('replay');
        if (act === 'ghost-player') this._play('ghost-player');
        if (act === 'ghost-opponent') this._play('ghost-opponent');
        if (act === 'delete') this._deleteSelected();
        if (act === 'export') this._exportSelected();
        if (act === 'import') this._import();
      });
    }

    /**
     * @param {HTMLElement} root
     */
    _makeDraggable(root) {
      let dx = 0, dy = 0, drag = false;

      const header = assert(root.querySelector('.rc-header'));
      if (!(header instanceof HTMLElement))
        throw new Error('Header is not HTMLElement.');

      header.onpointerdown = e => {
        drag = true;
        dx = e.clientX - root.offsetLeft;
        dy = e.clientY - root.offsetTop;
      };

      window.onpointermove = e => {
        if (!drag) return;
        root.style.left = (e.clientX - dx) + 'px';
        root.style.top = (e.clientY - dy) + 'px';
        root.style.right = 'auto';
      };

      window.onpointerup = () => drag = false;
    }

    _renderList() {
      this.listEl.innerHTML = '';

      for (const r of this.replays) {
        const el = document.createElement('div');

        const label =
          `${new Date(r.ts).toLocaleTimeString()} - ${r.data.opponentName} - ${['?', 'W', 'L'][r.result]}`;

        el.textContent = label;
        el.style.padding = '4px';
        el.style.cursor = 'pointer';

        if (this.selectedId === r.id || this.selectedId === null) {
          this.selectedId = r.id;
          el.style.background = '#333';
        }

        el.onclick = () => {
          this.selectedId = r.id;
          this._renderList();
        };

        this.listEl.appendChild(el);
      }
    }

    /* ================= ACTIONS ================= */

    _getSelected() {
      return this.replays.find(r => r.id === this.selectedId);
    }

    /**
     * @param {GhostMode} mode
     */
    _play(mode) {
      const r = this._getSelected();
      if (!r) return;

      new SwapReplay(r.data, snapshotHTML, this._cursor, mode).play();
    }

    async _deleteSelected() {
      const r = this._getSelected();
      if (!r) return;

      await this._delete(r.id);
      this.replays = await this._loadAll();
      this.selectedId = null;
      this._renderList();
    }

    _exportSelected() {
      const r = this._getSelected();
      if (!r) return;

      const blob = new Blob([JSON.stringify(r)], { type: 'application/json' });
      const a = document.createElement('a');

      a.href = URL.createObjectURL(blob);
      a.download = `replay-${r.ts}.json`;
      a.click();
    }

    _import() {
      const input = document.createElement('input');
      input.type = 'file';

      input.onchange = async () => {
        const files = assert(input.files);
        if (!files.length) return;
        for (const file of files) {
          const text = await file.text();
          const data = JSON.parse(text);

          if (!('id' in data)) continue;

          await this._add(data);
        }
        this.replays = await this._loadAll();
        this._renderList();
      };

      input.click();
    }

    /* ================= UTILS ================= */

    /**
     * @param {() => boolean} fn 
     * @returns {Promise<void>}
     */
    _waitFor(fn) {
      return new Promise(res => {
        const loop = () => {
          if (fn()) return res();
          requestAnimationFrame(loop);
        };
        loop();
      });
    }
  }


  /** @type {any} */
  // @ts-ignore
  const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  w.replayController = new ReplayController();
})();
