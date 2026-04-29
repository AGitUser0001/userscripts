// ==UserScript==
// @name        swapjs.dev/group Record & Replay
// @match       https://swapjs.dev/*
// @grant       unsafeWindow
// @inject-into page
// @version     2026.04.28.9.39
// @author      auser0001
// ==/UserScript==

(async function () {
  'use strict';
  /**
   * @typedef {{ t: number, m: [x: number, y: number], c: 1 | 0 }} RecordedMoveEvent
   * @typedef {{ t: number, d: number, c: 1 | 0 }} RecordedDownEvent
   * @typedef {{ t: number, u: number, c: 1 | 0 }} RecordedUpEvent
   * @typedef {RecordedMoveEvent | RecordedDownEvent | RecordedUpEvent} RecordedEvent
   *
   * @typedef {{ t: number, o: number[], n: number }} OpponentEvent
   *
   * @typedef {{
   *   startOrder: number[],
   *   opponentStartOrder: number[],
   *   events: RecordedEvent[],
   *   opponent: OpponentEvent[],
   *   playerName: string,
   *   playerNameClass: string | null,
   *   opponentName: string,
   *   opponentNameClass: string | null,
   *   playerElo: number | null,
   *   opponentElo: number | null,
   *   matchLength: number
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
    /**
     * 
     * @param {{ 
     *  extraStartCond?: (() => boolean) | null,
     *  extraStopCond?: (() => string | false) | null
     * }} param0 
     */
    constructor({ extraStartCond, extraStopCond } = {}) {
      /** @type {() => boolean} */
      this._extraStartCond = extraStartCond || (() => true);
      /** @type {() => string | false} */
      this._extraStopCond = extraStopCond || (() => false);

      /** @type {SwapRecording} */
      this.data = {
        startOrder: [],
        opponentStartOrder: [],
        events: [],
        opponent: [],
        playerName: 'you',
        playerNameClass: null,
        opponentName: 'opponent',
        opponentNameClass: null,
        playerElo: null,
        opponentElo: null,
        matchLength: 0
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
      while (true) {
        await this._waitFor(() =>
          this._extraStartCond() &&
          !!document.querySelector('.tab-body .match-wrap') &&
          !!document.querySelector('.vs-side .vs-elo')
        );

        this.data.playerElo = +assert(document.querySelector('.vs-side:not(.right) .vs-elo')).textContent;
        this.data.opponentElo = +assert(document.querySelector('.vs-side.right .vs-elo')).textContent;

        await this._waitFor(() =>
          (!!document.querySelector('.arena') &&
            !!document.querySelector('.arena .bar-val'))
          || !document.querySelector('.tab-body .match-wrap')
          || !this._extraStartCond()
        );
        if (document.querySelector('.arena') && this._extraStartCond()) break;
      }

      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      this.matchStartTime = performance.now() - readCurrentUiTimerMs();

      this.data.startOrder = readPlayerValues(document);

      const oppName = document.querySelector('.vs-side.right .vs-name');
      if (oppName) {
        this.data.opponentName = oppName.textContent.trim();
        this.data.opponentNameClass = [...oppName.classList].find(x => x.startsWith('name-')) || null;
      }

      const playerName = document.querySelector('.player-card .player-name span');
      if (playerName) {
        this.data.playerName = playerName.textContent.trim();
        this.data.playerNameClass = [...playerName.classList].find(x => x.startsWith('name-')) || null;
      }

      this._barCount = this.data.startOrder.length;

      const oppBars = queryOpponentBars(document);
      this._opponentHeightTable = buildHeightValueTable(this.data.startOrder);

      const inferredOpponent = readOpponentValuesFromHeights(oppBars, this._opponentHeightTable);
      if (inferredOpponent.length !== this.data.startOrder.length)
        throw new Error('Invalid opponent data!');
      this.data.opponentStartOrder = inferredOpponent;

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
      if (!this.started) return;
      window.removeEventListener('pointermove', this._onMove, true);
      window.removeEventListener('pointerdown', this._onDown, true);
      window.removeEventListener('pointerup', this._onUp, true);

      this.data.matchLength = this._time();

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
        playerName: this.data.playerName,
        playerNameClass: this.data.playerNameClass,
        opponentName: this.data.opponentName,
        opponentNameClass: this.data.opponentNameClass,
        playerElo: this.data.playerElo,
        opponentElo: this.data.opponentElo,
        matchLength: this.data.matchLength
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
        m: this._getPos(e),
        c: e.pointerType === 'mouse' ? 1 : 0
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
        d: this._dragStartIndex,
        c: e.pointerType === 'mouse' ? 1 : 0
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

      this.data.events.push({
        t, u,
        c: e.pointerType === 'mouse' ? 1 : 0
      });

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
      let lastMoveCount = 0;

      this._observer = new MutationObserver(() => {
        const oppBars = queryOpponentBars(document);
        const state = readOpponentValuesFromHeights(oppBars, this._opponentHeightTable);
        const moveCount = parseInt(assert(document.querySelector('.vs-side.right .vs-moves')).textContent);

        if (moveCount !== lastMoveCount || !sameNumberArray(state, last)) {
          this.data.opponent.push({
            t: this._time(),
            o: state,
            n: moveCount
          });
          last = state;
          lastMoveCount = moveCount;
        }
      });

      this._observer.observe(
        assert(document.querySelector('.vs-side.right .vs-moves')),
        { characterData: true, childList: true, subtree: true }
      );

      this._observer.observe(container, {
        attributes: true,
        attributeFilter: ['style', 'class'],
        childList: true,
        subtree: true,
        characterData: false
      });
    }

    /**
     * The method which the recorder exited.
     * `exitMode` is `'arena'` for arena exits, `'extraStopCond'` for `extraStopCond` returning true,
     * and the string `extraStopCond` returned otherwise
     */
    exitMode = 'arena';

    /**
     * @returns {void}
     */
    _watchForArenaGone() {
      if (!document.querySelector('.arena')) {
        this.exitMode = 'arena';
        this.stop();
        return;
      }
      const condResult = this._extraStopCond();
      if (condResult) {
        this.exitMode = condResult;
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
   * @typedef {'replay' | 'ghost-player' | 'ghost-opponent' | 'ghost-solo'} ReplayMode
   */
  class SwapReplay {
    /**
     * @param {SwapRecording} data
     * @param {string} html
     * @param {FakeCursor} cursor
     * @param {ReplayMode} [mode]
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
      this.matchClockEl = this.root.querySelector('.match-head .match-clock .clock-cap');

      /** @type {HTMLElement | null} */
      this.opponentTimeEl = this.root.querySelector('.match-head .vs-side.right .vs-time');

      /** @type {HTMLElement | null} */
      this.playerMovesEl = this.root.querySelector('.match-head .vs-side:not(.right) .vs-moves');

      /** @type {HTMLElement | null} */
      this.opponentMovesEl = this.root.querySelector('.match-head .vs-side.right .vs-moves');

      let { opponentName, playerName, opponentNameClass, playerNameClass, playerElo, opponentElo } = this.data;

      if (mode === 'ghost-player') {
        opponentName = playerName;
        opponentNameClass = playerNameClass;
        opponentElo = playerElo;
      }

      if (mode.startsWith('ghost-')) {
        playerName = 'you';
        playerNameClass = null;
        playerElo = null;
        for (const el of document.querySelectorAll('.player-stats .stat')) {
          if (el.textContent.includes('elo'))
            playerElo = parseInt(el.textContent);
        }
      }

      if (mode === 'ghost-solo') {
        /** @type {NodeListOf<HTMLElement>} */
        const vsSideRight = this.root.querySelectorAll('.match-head .vs-side.right');
        for (const el of vsSideRight) {
          el.style.visibility = 'hidden';
        }
        /** @type {HTMLElement | null} */
        const oppArena = this.root.querySelector('.opp-arena');
        if (oppArena) oppArena.style.display = 'none';
      }

      for (const el of this.root.querySelectorAll('.vs-side:not(.right) .vs-name')) {
        el.textContent = playerName;
        if (playerNameClass)
          el.classList.add(playerNameClass);
      }

      for (const el of this.root.querySelectorAll('.vs-side.right .vs-name, .opp-label span')) {
        el.textContent = opponentName;
        if (opponentNameClass)
          el.classList.add(opponentNameClass);
      }

      const playerEloEl = this.root.querySelector('.vs-side:not(.right) .vs-elo');
      if (playerEloEl) playerEloEl.textContent = String(playerElo == null ? '?' : playerElo);

      const opponentEloEl = this.root.querySelector('.vs-side.right .vs-elo');
      if (opponentEloEl) opponentEloEl.textContent = String(opponentElo == null ? '?' : opponentElo);

      /** @type {HTMLElement} */
      this.countdownEl = assert(this.root.querySelector('.stage-1'));

      /** @type {HTMLElement} */
      this.countdownTextEl = assert(this.countdownEl.querySelector('.countdown-big'));

      /** @type {HTMLElement} */
      this.matchEl = assert(this.root.querySelector('.stage-2'));

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

      this._update = this._update.bind(this);

      /** @type {number | null} */
      this._updateRaf = requestAnimationFrame(this._update);

      /** @type {number} */
      this._lastPlayerMoveCount = 0;

      /** @type {number} */
      this._lastOpponentMoveCount = 0;

      /** @type {RecordedEvent[]} */
      this._events = data.events.slice().sort((a, b) => a.t - b.t);

      /** @type {OpponentEvent[]} */
      this._opponentEvents = data.opponent.slice().sort((a, b) => a.t - b.t);

      this._startOrder = this.data.startOrder.slice();
      this._opponentStartOrder = this.data.opponentStartOrder.slice();

      if (mode === 'ghost-player') {
        this._opponentEvents = this._convertPlayerToOpponent();
        this._opponentStartOrder = this._startOrder.slice();
      }

      if (mode.startsWith('ghost-')) {
        this._events = [];
      }

      this._onResize = this._onResize.bind(this);

      this._resetInjectedState();
      this._initBarsFromStartOrder();
      this._initOpponentFromStartOrder();
      this._layout();
      window.addEventListener('resize', this._onResize, { passive: true });

      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onPointerUp = this._onPointerUp.bind(this);

      this.matchEl.remove();

      this.arena.addEventListener('pointerdown', this._onPointerDown);
      window.addEventListener('pointermove', this._onPointerMove);
      window.addEventListener('pointerup', this._onPointerUp);

      this._destroyed = false;
    }

    _originalTabBody = assert(
      document.querySelector('.page .tab-body')
    );

    _tabList = assert(
      document.querySelector('.page .tabs')
    );

    /** @type {HTMLElement} */
    _originalActiveTab = assert(
      document.querySelector('.page .tabs .tab.active')
    );

    _tab =
      /** @type {typeof this._originalActiveTab} */
      (this._originalActiveTab.cloneNode(true));

    /**
     * @param {PointerEvent} e 
     */
    _tabClickListener = e => {
      this.destroy();
      e.stopImmediatePropagation();
    }

    _navigateListener = () => this.destroy();

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

      this._tab.textContent = {
        'replay': 'replay',
        'ghost-player': 'ghost: player',
        'ghost-opponent': 'ghost: opponent',
        'ghost-solo': 'solo'
      }[this.mode];

      this._originalActiveTab.classList.remove('active');
      this._originalActiveTab.addEventListener('click', this._tabClickListener, { capture: true });
      this._tabList.appendChild(this._tab);

      this._originalTabBody.replaceWith(root);
      navigation.addEventListener('navigate', this._navigateListener);
      return root;
    }

    /**
     * @returns {void}
     */
    _onResize() {
      if (this._resizeRaf != null) return;
      this._resizeRaf = requestAnimationFrame(() => {
        if (!this.matchEl.isConnected) return;
        this._resizeRaf = null;
        this._layout();
      });
    }

    /**
     * @returns {void}
     */

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      navigation.removeEventListener('navigate', this._navigateListener);

      this._stopUiTimer();

      window.removeEventListener('resize', this._onResize);

      this.arena.removeEventListener('pointerdown', this._onPointerDown);
      window.removeEventListener('pointermove', this._onPointerMove);
      window.removeEventListener('pointerup', this._onPointerUp);

      if (this._resizeRaf != null) {
        cancelAnimationFrame(this._resizeRaf);
        this._resizeRaf = null;
      }

      if (this._updateRaf != null) {
        cancelAnimationFrame(this._updateRaf);
        this._updateRaf = null;
      }

      this.root.replaceWith(this._originalTabBody);
      this._originalActiveTab.classList.add('active');
      this._originalActiveTab.removeEventListener('click', this._tabClickListener, { capture: true });
      this._tab.remove();
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

    _initBarsFromStartOrder() {
      const values = this._startOrder;
      const max = Math.max(...values);

      if (values.length > this.bars.length) {
        const barRoot = /**@type {HTMLElement}*/(this.bars[0].parentElement);
        for (let i = this.bars.length; i < values.length; i++) {
          this.bars[i] = /**@type {typeof this.bars[0]}*/(this.bars[0].cloneNode(true));
          barRoot.appendChild(this.bars[i]);
        }
      }

      if (values.length < this.bars.length) {
        for (let i = values.length; i < this.bars.length; i++) {
          this.bars[i].remove();
        }
        this.bars.length = values.length;
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

    _initOpponentFromStartOrder() {
      const values = this._opponentStartOrder;

      if (values.length > this.oppBars.length) {
        const barRoot = /**@type {HTMLElement}*/(this.oppBars[0].parentElement);
        for (let i = this.oppBars.length; i < values.length; i++) {
          this.oppBars[i] = /**@type {typeof this.oppBars[0]}*/(this.oppBars[0].cloneNode(true));
          barRoot.appendChild(this.oppBars[i]);
        }
      }

      if (values.length < this.oppBars.length) {
        for (let i = values.length; i < this.oppBars.length; i++) {
          this.oppBars[i].remove();
        }
      }

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
    _getDropPos(index) {
      const rect = this.arena.getBoundingClientRect();

      const x = rect.left + (index * this.step + this.barWidth / 2);

      const minY = rect.top + rect.height * 0.2;
      const maxY = rect.bottom - rect.height * 0.1;
      const y = Math.max(minY, Math.min(maxY, this.cursor.y));

      return { x, y };
    }

    /**
     * @param {number} index
     * @param {HTMLElement} barEl
     * @returns {{ x: number, y: number }}
     */
    _getSnapPos(index, barEl) {
      const rect = this.arena.getBoundingClientRect();

      // X remains mathematically locked to the center of the bar's column
      const x = rect.left + (index * this.step + this.barWidth / 2);

      const barHeight = barEl.offsetHeight;

      // Since bars grow from the bottom up, the logical top is the arena's bottom minus the bar's height.
      // We add a 6px padding so the cursor doesn't visually clip over the absolute edge.
      const paddingY = 6;
      const minY = rect.bottom - barHeight + paddingY;
      const maxY = rect.bottom - paddingY;

      // Clamp the current cursor Y to strictly fall within this bar's physical bounds
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

    /** @type {number | null} */
    _frozenPlayerMs = null;
    /** @type {number | null} */
    _frozenClockMs = null;
    /** @type {number | null} */
    _frozenOppMs = null;

    _matchClockMax = 90;

    /**
     * @returns {void}
     */
    _startUiTimer() {
      const elapsed = performance.now() - this.startTime;

      let playerMs;
      if (this._frozenPlayerMs != null)
        playerMs = this._frozenPlayerMs;
      else {
        playerMs = elapsed;
        if (this.mode === 'replay') {
          if (elapsed > this.data.matchLength)
            this._frozenPlayerMs = elapsed;
        } else if (this.mode.startsWith('ghost-')) {
          if (this._isSorted()) {
            this._frozenPlayerMs = playerMs;
            this._onFinish();
          }
        }
      }

      let opponentMs;
      if (this._frozenOppMs != null)
        opponentMs = this._frozenOppMs;
      else {
        opponentMs = elapsed;
        if (elapsed > this.data.matchLength)
          this._frozenOppMs = opponentMs;
        if (this.mode === 'ghost-solo')
          this._frozenOppMs = opponentMs;
      }

      if (this.playerTimeEl) {
        this.playerTimeEl.textContent = `${(playerMs / 1000).toFixed(2)}s`;
      }

      let matchClockMs;
      if (this._frozenClockMs != null)
        matchClockMs = this._frozenClockMs;
      else {
        matchClockMs = elapsed;
        if (this._frozenOppMs != null && this._frozenPlayerMs != null)
          this._frozenClockMs = elapsed;
      }

      if (this.matchClockEl) {
        const currentMatchClock = Math.max(0, Math.ceil(this._matchClockMax - (matchClockMs / 1000)));
        this.matchClockEl.textContent = `${currentMatchClock}s`;
      }

      if (this.opponentTimeEl) {
        this.opponentTimeEl.textContent = `${(opponentMs / 1000).toFixed(2)}s`;
      }

      this._timerRaf = requestAnimationFrame(() => this._startUiTimer());
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
        if (this._lastPlayerMoveCount === 1)
          this.playerMovesEl.textContent = `${this._lastPlayerMoveCount} move`;
        else
          this.playerMovesEl.textContent = `${this._lastPlayerMoveCount} moves`;
      }
      if (this.opponentMovesEl) {
        if (this._lastOpponentMoveCount === 1)
          this.opponentMovesEl.textContent = `${this._lastOpponentMoveCount} move`;
        else
          this.opponentMovesEl.textContent = `${this._lastOpponentMoveCount} moves`;
      }
    }

    /**
     * @param {OpponentEvent} ev
     * @returns {void}
     */
    _handleOpponent(ev) {
      this._updateOpponent(ev.o);
      if (ev.n != undefined)
        this._lastOpponentMoveCount = ev.n;
      else
        this._lastOpponentMoveCount++;
      this._renderMoveCounts();
    }

    /**
     * @returns {Promise<void>}
     */
    async play() {
      this.matchEl.replaceWith(this.countdownEl);
      setTimeout(() => {
        if (this._destroyed) return;
        this.countdownEl.scrollIntoView({
          behavior: "smooth",
          block: "start"
        });
      }, 60);
      let countdown = 3;
      while (countdown > 0 && !this._destroyed) {
        this.countdownTextEl.textContent = `${countdown}`;
        await new Promise(r => setTimeout(r, 1000));
        countdown--;
      }
      if (this._destroyed) return;
      this.countdownEl.replaceWith(this.matchEl);
      this._layout();
      setTimeout(() => {
        if (this._destroyed) return;
        this.matchEl.scrollIntoView({
          behavior: "smooth",
          block: "start"
        });
      }, 60);

      this.startTime = performance.now();
      this._startUiTimer();
      this._renderMoveCounts();

      let pevent = 0; // player events
      let oevent = 0; // opponent events

      while (!this._destroyed) {
        await new Promise(r => requestAnimationFrame(r));

        const elapsed = performance.now() - this.startTime;

        // process player events up to current time
        while (pevent < this._events.length && this._events[pevent].t <= elapsed) {
          this._handle(this._events[pevent]);
          pevent++;
        }

        // process opponent events up to current time
        while (oevent < this._opponentEvents.length && this._opponentEvents[oevent].t <= elapsed) {
          this._handleOpponent(this._opponentEvents[oevent]);
          oevent++;
        }

        const done =
          pevent >= this._events.length &&
          oevent >= this._opponentEvents.length;

        if (done) break;
      }
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

    /** @type {[x: number, y: number] | null} */
    _cursorPos = null;

    /**
     * @param {RecordedEvent} e
     * @returns {void}
     */
    _handle(e) {
      this.cursor.hideCursor = e.c === 0;
      if ('m' in e) {
        this._cursorPos = e.m;
      }

      if ('d' in e) {
        const pos = this._getSnapPos(e.d, this.bars[e.d]);
        this.cursor.pointerMove(pos);
        this.cursor.pointerDown();
      }

      if ('u' in e) {
        const pos = this._getDropPos(e.u);
        this.cursor.pointerMove(pos);
        this.cursor.pointerUp();
      }
    }

    _update() {
      if (this.matchEl.isConnected)
        this.cursor.pointerMove(
          this._cursorPos == null ?
            { x: -500, y: -500 } :
            this._arenaToClient(this._cursorPos)
        );
      this._updateRaf = requestAnimationFrame(this._update);
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
      if (!this.matchEl.isConnected) return;
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
      if (!this.matchEl.isConnected) return;
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
      if (!this.matchEl.isConnected) return;
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
    }

    _convertPlayerToOpponent() {
      let bars = this._startOrder.map((v, i) => ({ v, id: i }));

      const result = [];

      let lastDown = -1;
      let moveCount = 0;

      for (const e of this._events) {
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
            o: bars.map(x => x.v),
            n: ++moveCount
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
    constructor(cursorMap = {}) {
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
        k = 'default';
        if (this._isTextCursorAtPoint(this.x, this.y)) {
          const writingMode = getComputedStyle(el).writingMode;
          const verticalModes = [
            'vertical-rl', 'vertical-lr',
            'sideways-rl', 'sideways-lr',
            'tb', 'tb-rl', 'tb-lr'
          ];
          k = verticalModes.includes(writingMode) ? 'vertical-text' : 'text';
        }
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

      this._dispatch("pointerdown", el);
      this._dispatch("mousedown", el, { detail: 1 });
    }

    pointerUp() {
      const el = this._elementAtPoint();

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
  //#endregion

  const svClass = await readMatchSvelteClass();

  const snapshotHTML = `
  <section class="tab-body ${svClass}">
    <div class="match-wrap ${svClass} stage-1">
      <div class="match-head ${svClass}">
        <div class="vs-side ${svClass}"><span class="vs-name ${svClass}">you</span> <span
                class="vs-elo ${svClass}">?</span></div>
        <div class="vs-dot ${svClass}">vs</div>
        <div class="vs-side right ${svClass}"><span class="vs-name ${svClass}">opponent</span>
          <span class="vs-elo ${svClass}">?</span></div>
      </div>
      <div class="countdown-big ${svClass}">3</div>
    </div>
    <div class="match-wrap ${svClass} stage-2">
      <div class="match-head ${svClass}">
        <div class="vs-side ${svClass}"><span class="vs-name ${svClass}">you</span> <span
                class="vs-time ${svClass}">0.00s</span> <span class="vs-moves ${svClass}">0 moves</span></div>
        <div class="match-clock ${svClass}"><span class="clock-cap ${svClass}">90s</span></div>
        <div class="vs-side right ${svClass}"><span class="vs-name ${svClass}">opponent </span> <span
                class="vs-time ${svClass}">0.00s</span> <span class="vs-moves ${svClass}">0 moves</span></div>
      </div>
      <div class="arena ${svClass}">
        <div role="button" tabindex="0" class="bar ${svClass}">
          <span class="bar-val ${svClass}"></span>
        </div>
        <div role="button" tabindex="0" class="bar ${svClass}">
          <span class="bar-val ${svClass}"></span>
        </div>
        <div role="button" tabindex="0" class="bar ${svClass}">
          <span class="bar-val ${svClass}"></span>
        </div>
        <div role="button" tabindex="0" class="bar ${svClass}">
          <span class="bar-val ${svClass}"></span>
        </div>
        <div role="button" tabindex="0" class="bar ${svClass}">
          <span class="bar-val ${svClass}"></span>
        </div>
        <div role="button" tabindex="0" class="bar ${svClass}">
          <span class="bar-val ${svClass}"></span>
        </div>
        <div role="button" tabindex="0" class="bar ${svClass}">
          <span class="bar-val ${svClass}"></span>
        </div>
        <div role="button" tabindex="0" class="bar ${svClass}">
          <span class="bar-val ${svClass}"></span>
        </div>
        <div role="button" tabindex="0" class="bar ${svClass}">
          <span class="bar-val ${svClass}"></span>
        </div>
        <div role="button" tabindex="0" class="bar ${svClass}">
          <span class="bar-val ${svClass}"></span>
        </div>
        <div role="button" tabindex="0" class="bar ${svClass}">
          <span class="bar-val ${svClass}"></span>
        </div>
        <div role="button" tabindex="0" class="bar ${svClass}">
          <span class="bar-val ${svClass}"></span>
        </div>
      </div>
      <div class="opp-arena ${svClass}">
        <div class="opp-label ${svClass}"><span class="${svClass}">opponent</span>'s board</div>
        <div class="opp-bars ${svClass}">
          <div class="opp-bar ${svClass}"></div>
          <div class="opp-bar ${svClass}"></div>
          <div class="opp-bar ${svClass}"></div>
          <div class="opp-bar ${svClass}"></div>
          <div class="opp-bar ${svClass}"></div>
          <div class="opp-bar ${svClass}"></div>
          <div class="opp-bar ${svClass}"></div>
          <div class="opp-bar ${svClass}"></div>
          <div class="opp-bar ${svClass}"></div>
          <div class="opp-bar ${svClass}"></div>
          <div class="opp-bar ${svClass}"></div>
          <div class="opp-bar ${svClass}"></div>
        </div>
      </div>
    </div>
  </section>`;

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
      display: none;
    }
    .group-active .rc-root {
      display: flex;
    }

    /* --- Root --- */
    .rc-root {
      position: fixed;
      top: 3em;
      right: 1em;
      z-index: 999999;
      background: var(--card);
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 1px 4px #1613160a;
      flex-direction: column;
      gap: 16px;
      overflow: hidden;

      width: 300px;
      max-width: calc(100vw - 2em);
      transition: width 0.5s, height 0.5s, border-radius 0.5s;
    }

    .rc-root * {
      box-sizing: border-box;
    }

    /* --- Header --- */
    .rc-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: var(--muted);
      cursor: pointer;
      user-select: none;
    }

    .rc-toggle-btn {
      background: none;
      border: none;
      color: var(--muted);
      font-size: 10px;
      cursor: pointer;
      padding: 4px;
      transition: transform 0.2s;
    }

    /* --- Actions --- */
    .rc-actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .rc-actions .row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .rc-actions button {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 8px 10px;
      font-size: 13px;
      font-weight: 600;
      color: var(--muted);
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s, transform 0.15s;
      flex: 1 1 auto;
      text-align: center;
    }

    .rc-actions button:not([data-act="replay"], [data-act="solo"]):hover:not(:disabled) {
      color: var(--dark);
      border-color: var(--accent);
    }

    .rc-actions button:hover:not(:disabled) {
      transform: translateY(-1px);
    }

    .rc-actions button[data-act="replay"] {
      background: var(--dark);
      color: var(--bg);
      border: 1px solid var(--dark);
    }

    .rc-actions button[data-act="solo"] {
      background: var(--accent);
      color: var(--bg);
      border: 1px solid var(--accent);
      flex-grow: 0.5;
    }

    .rc-actions button:disabled {
      background: var(--empty);
      color: var(--muted);
      border: 1px solid var(--border);
      cursor: not-allowed;
    }

    .rc-actions button.is-active {
      border-color: var(--accent);
    }

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

    .rc-root:has(.rc-item.is-selected .rc-result.is-loss) .rc-actions button[data-act="ghost-player"],
    .rc-root:has(.rc-item.is-selected .rc-result.is-win) .rc-actions button[data-act="ghost-opponent"] {
      background: #b8432e15;
    }

    .rc-root:has(.rc-item.is-selected .rc-result.is-win) .rc-actions button[data-act="ghost-player"],
    .rc-root:has(.rc-item.is-selected .rc-result.is-loss) .rc-actions button[data-act="ghost-opponent"] {
      background: #2e8b5715;
    }

    /* --- List --- */
    .rc-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 250px;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--muted) transparent;
    }

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

    /* --- List Items --- */
    .rc-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 10px 12px;
      border-radius: 12px;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.1s ease, opacity 0.15s;
    }

    .rc-item:hover {
      background: var(--empty);
    }

    /* Selected */
    .rc-item.is-selected {
      background: var(--bg);
    }

    /* --- Main row --- */
    .rc-item-main {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
    }

    .rc-opponent, .rc-player {
      flex: 1;
      white-space: normal;
      word-break: break-word;
      line-height: 1.2;
    }

    .rc-right {
      font-size: 11px;
      flex-shrink: 0;
    }

    .rc-elo {
      margin-left: 6px;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }

    /* --- Result badge --- */
    .rc-result {
      font-size: 11px;
      font-weight: 700;
      flex-shrink: 0;
    }

    .rc-result.is-win {
      color: #2e8b57;
    }

    .rc-result.is-loss {
      color: #b8432e;
    }

    .rc-result.is-unknown {
      color: var(--muted);
    }

    .rc-item-sub {
      font-size: 11px;
      color: var(--muted);
      display: flex;
      justify-content: space-between;
    }

    .rc-time, .rc-duration {
      font-variant-numeric: tabular-nums;
    }

    .rc-type {
      font-weight: 600;
      text-transform: lowercase;
    }

    .rc-select-btn {
      background: var(--bg);
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 4px 8px;
      font-size: 12px;
      cursor: pointer;
    }

    .rc-select-btn:hover {
      border-color: var(--accent);
      color: var(--dark);
    }

    /* --- Empty --- */
    .rc-empty {
      text-align: center;
      font-size: 12px;
      color: var(--muted);
      padding: 12px;
    }

    .rc-collapsible {
      display: grid;
      grid-template-rows: 1fr;
      /* Transitions both the grid height AND the display property */
      transition: grid-template-rows 0.4s ease, display 0.4s allow-discrete;
    }

    @starting-style {
      .rc-collapsible {
        grid-template-rows: 0fr;
      }
    }

    .rc-collapsible-content {
      min-height: 0;
      overflow: hidden;
    }

    .rc-root.is-collapsed .rc-collapsible {
      grid-template-rows: 0fr;
      display: none;
    }

    .rc-content {
      border-top: 1px solid var(--border);
      padding-top: 12px;
    }

    .rc-root.is-collapsed .rc-toggle-btn {
      transform: rotate(-90deg);
    }

    .rc-search {
      width: 100%;
      margin: 10px 0;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--bg);
      font-size: 13px;
      font-weight: 600;
      color: var(--dark);
    }

    .rc-search:focus {
      outline: 1px solid var(--accent);
      outline-offset: -1px;
      border-color: transparent;
    }

    /* --- Mobile --- */
    @media (max-width: 600px) {
      .rc-root.is-collapsed {
        width: 60px;
      }

      .rc-root.is-collapsed .rc-title {
        display: none;
      }

      .rc-root.is-collapsed .rc-header {
        justify-content: center;
      }

      .rc-root.is-collapsed .rc-toggle-btn {
        transform: scale(2);
      }
    }

    .rc-tool-root {
      position: relative;
      display: flex;
      width: 100%;
    }

    /* hidden by default */
    .rc-tool-list {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;

      max-height: 220px;
      overflow-y: auto;

      display: none;

      gap: 4px;
      padding-top: 5px;
      flex-direction: column;
      z-index: 10;
    }

    .rc-tool-toggle::after {
      content: '▾';
      margin-left: 8px;
      font-size: 12px;
    }

    /* open state */
    .rc-tool-root.is-open .rc-tool-list {
      display: flex;
    }
  `);
  document.adoptedStyleSheets.push(replaySS);

  /**
   * @typedef {0|1|2} ReplayResult 0 unknown, 1 win, 2 loss
   *
   * @typedef {{
   *   id: string,
   *   ts: number,
   *   result: ReplayResult,
   *   data: SwapRecording,
   *   lineage: ReplayLineageEntry[],
   *   isSolo: boolean
   * }} ReplayEntry
   *
   * @typedef {{
   *   id: string,
   *   ts: number,
   *   type: 'live' | 'generated' | 'ghost-player' | 'ghost-opponent' | 'ghost-solo',
   *   result: ReplayResult,
   *   isSolo: boolean,
   *   playerName: string,
   *   playerNameClass: string | null,
   *   opponentName: string,
   *   opponentNameClass: string | null,
   *   playerElo: number | null,
   *   opponentElo: number | null,
   *   matchLength: number
   * }} ReplayLineageEntry
   */

  class ReplayController {
    //#region Cursor Data
    /*!
     * The following icon data is provided by Phosphor Icons under the MIT License,
     * and has been modified by a script for use as UI cursor icons.
     * (https://github.com/phosphor-icons/core)
     *
     * The license text is included below:
     * Copyright (c) 2023 Phosphor Icons
     * Permission is hereby granted, free of charge, to any person obtaining a copy
     * of this software and associated documentation files (the "Software"), to deal
     * in the Software without restriction, including without limitation the rights
     * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
     * copies of the Software, and to permit persons to whom the Software is
     * furnished to do so, subject to the following conditions:
     *
     * The above copyright notice and this permission notice shall be included in all
     * copies or substantial portions of the Software.
     *
     * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
     * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
     * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
     * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
     * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
     * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
     * SOFTWARE.
     */
    _cursor = new FakeCursor({ "default": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%22-8.511%2032.217%20237.615%20237.615%22%3E%3Cpath%20fill%3D%22none%22%20d%3D%22M0%200h256v256H0z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M123.128%20173.402a8%208%200%200%201%206.356-11.604l49.646-2.606a8%208%200%200%200%203.913-14.343L46.96%2045.673a8%208%200%200%200-12.6%206.42l.209%20168.408a8%208%200%200%200%2013.904%205.264l31.289-38.632a8%208%200%200%201%2013.124%201.677l32.943%2064.655a8%208%200%200%200%2010.756%203.495l15.981-8.12a8%208%200%200%200%203.495-10.756Z%22%2F%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2216%22%20d%3D%22M123.128%20173.402a8%208%200%200%201%206.356-11.604l49.646-2.606a8%208%200%200%200%203.913-14.343L46.96%2045.673a8%208%200%200%200-12.6%206.42l.209%20168.408a8%208%200%200%200%2013.904%205.264l31.289-38.632a8%208%200%200%201%2013.124%201.677l32.943%2064.655a8%208%200%200%200%2010.756%203.495l15.981-8.12a8%208%200%200%200%203.495-10.756Z%22%2F%3E%3C%2Fsvg%3E", "x": 2, "y": 0 }, "none": { "url": "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'/%3E", "x": 0, "y": 0 }, "context-menu": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%22-8.511%2032.217%20237.615%20237.615%22%3E%3Cpath%20fill%3D%22none%22%20d%3D%22M0%200h256v256H0z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M123.128%20173.402a8%208%200%200%201%206.356-11.604l49.646-2.606a8%208%200%200%200%203.913-14.343L46.96%2045.673a8%208%200%200%200-12.6%206.42l.209%20168.408a8%208%200%200%200%2013.904%205.264l31.289-38.632a8%208%200%200%201%2013.124%201.677l32.943%2064.655a8%208%200%200%200%2010.756%203.495l15.981-8.12a8%208%200%200%200%203.495-10.756Z%22%2F%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2216%22%20d%3D%22M123.128%20173.402a8%208%200%200%201%206.356-11.604l49.646-2.606a8%208%200%200%200%203.913-14.343L46.96%2045.673a8%208%200%200%200-12.6%206.42l.209%20168.408a8%208%200%200%200%2013.904%205.264l31.289-38.632a8%208%200%200%201%2013.124%201.677l32.943%2064.655a8%208%200%200%200%2010.756%203.495l15.981-8.12a8%208%200%200%200%203.495-10.756Z%22%2F%3E%3Cg%20transform%3D%22matrix(.6%200%200%20.6%2082.4%2020)%22%3E%3Cpath%20fill%3D%22none%22%20d%3D%22M0%200h256v256H0z%22%2F%3E%3Crect%20width%3D%22192%22%20height%3D%22160%22%20x%3D%2232%22%20y%3D%2248%22%20fill%3D%22%23fff%22%20rx%3D%228%22%2F%3E%3Crect%20width%3D%22192%22%20height%3D%22160%22%20x%3D%2232%22%20y%3D%2248%22%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2224%22%20rx%3D%228%22%2F%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2224%22%20d%3D%22M80%2096h96m-96%2032h96m-96%2032h96%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E", "x": 2, "y": 0 }, "help": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2220%2020%20216%20216%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M224%20128a96%2096%200%201%201-96-96%2096%2096%200%200%201%2096%2096%22%2F%3E%3Cpath%20d%3D%22M140%20180a12%2012%200%201%201-12-12%2012%2012%200%200%201%2012%2012M128%2072c-22.06%200-40%2016.15-40%2036v4a8%208%200%200%200%2016%200v-4c0-11%2010.77-20%2024-20s24%209%2024%2020-10.77%2020-24%2020a8%208%200%200%200-8%208v8a8%208%200%200%200%2016%200v-.72c18.24-3.35%2032-17.9%2032-35.28%200-19.85-17.94-36-40-36m104%2056A104%20104%200%201%201%20128%2024a104.11%20104.11%200%200%201%20104%20104m-16%200a88%2088%200%201%200-88%2088%2088.1%2088.1%200%200%200%2088-88%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "pointer": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2212.031%2012%20232%20232%22%3E%3Cpath%20fill%3D%22none%22%20d%3D%22M0%200h256v256H0z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M196%2096a20%2020%200%200%200-20%2020v-16a20%2020%200%200%200-40%200V44a20%2020%200%200%200-40%200v108l-18.68-30a20%2020%200%200%200-34.64%2020c37.51%2066%2049.14%2090%2093.32%2090a80%2080%200%200%200%2080-80v-36a20%2020%200%200%200-20-20%22%2F%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2216%22%20d%3D%22M42.68%20142a20%2020%200%200%201%2034.64-20L96%20152V44a20%2020%200%200%201%2040%200v56a20%2020%200%200%201%2040%200v16a20%2020%200%200%201%2040%200v36a80%2080%200%200%201-80%2080c-44.18%200-55.81-24-93.32-90%22%2F%3E%3C%2Fsvg%3E", "x": 7, "y": 0 }, "progress": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%22-8.511%2032.217%20237.615%20237.615%22%3E%3Cpath%20fill%3D%22none%22%20d%3D%22M0%200h256v256H0z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M123.128%20173.402a8%208%200%200%201%206.356-11.604l49.646-2.606a8%208%200%200%200%203.913-14.343L46.96%2045.673a8%208%200%200%200-12.6%206.42l.209%20168.408a8%208%200%200%200%2013.904%205.264l31.289-38.632a8%208%200%200%201%2013.124%201.677l32.943%2064.655a8%208%200%200%200%2010.756%203.495l15.981-8.12a8%208%200%200%200%203.495-10.756Z%22%2F%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2216%22%20d%3D%22M123.128%20173.402a8%208%200%200%201%206.356-11.604l49.646-2.606a8%208%200%200%200%203.913-14.343L46.96%2045.673a8%208%200%200%200-12.6%206.42l.209%20168.408a8%208%200%200%200%2013.904%205.264l31.289-38.632a8%208%200%200%201%2013.124%201.677l32.943%2064.655a8%208%200%200%200%2010.756%203.495l15.981-8.12a8%208%200%200%200%203.495-10.756Z%22%2F%3E%3Cg%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M82.4%2020H236v153.6H82.4z%22%2F%3E%3Cpath%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2221.6%22%20d%3D%22M159.2%2039.2v19.2m57.6%2038.4h-19.2m2.328%2040.728L186.35%20123.95M159.2%20154.4v-19.2m-40.728%202.328%2013.578-13.578M101.6%2096.8h19.2m-2.328-40.728L132.05%2069.65%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E", "x": 2, "y": 0 }, "wait": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2220%2022.055%20216%20216%22%3E%3Cpath%20fill%3D%22none%22%20d%3D%22M0%200h256v256H0z%22%2F%3E%3Cpath%20d%3D%22M78.6%2045.67A96%2096%200%200%200%2032%20128v1.61c39.27-29.85%2067.64-15.73%2096-1.61-2-31.62-3.91-63.25-49.4-82.33M81.4%20212a96%2096%200%200%200%2094.6-.81c.47-.27.94-.53%201.4-.81C131.91%20191.25%20130%20159.62%20128%20128c-26.41%2017.5-52.82%2035-46.6%2084M224%20126.39a96%2096%200%200%200-48-81.53l-1.4-.81C180.82%2093%20154.41%20110.5%20128%20128c28.36%2014.12%2056.73%2028.24%2096-1.61%22%20opacity%3D%22.2%22%2F%3E%3Ccircle%20cx%3D%22128%22%20cy%3D%22128%22%20r%3D%2296%22%20fill%3D%22%23fff%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2216%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2216%22%20d%3D%22M32%20129.61c78.55-59.69%20113.45%2056.47%20192-3.22%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2216%22%20d%3D%22M177.4%20210.33c-91-38.17-7.82-126.49-98.8-164.66%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2216%22%20d%3D%22M174.6%2044.05C187%20141.93%2069%20114.07%2081.4%20212%22%2F%3E%3Cpath%20fill%3D%22none%22%20d%3D%22M0%200h256v256H0z%22%2F%3E%3Cpath%20fill%3D%22gray%22%20d%3D%22M78.6%2045.67A96%2096%200%200%200%2032%20128v1.61c39.27-29.85%2067.64-15.73%2096-1.61-2-31.62-3.91-63.25-49.4-82.33M81.4%20212a96%2096%200%200%200%2094.6-.81c.47-.27.94-.53%201.4-.81C131.91%20191.25%20130%20159.62%20128%20128c-26.41%2017.5-52.82%2035-46.6%2084M224%20126.39a96%2096%200%200%200-48-81.53l-1.4-.81C180.82%2093%20154.41%20110.5%20128%20128c28.36%2014.12%2056.73%2028.24%2096-1.61%22%2F%3E%3Ccircle%20cx%3D%22128%22%20cy%3D%22128%22%20r%3D%2296%22%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2216%22%2F%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2216%22%20d%3D%22M32%20129.61c78.55-59.69%20113.45%2056.47%20192-3.22%22%2F%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2216%22%20d%3D%22M177.4%20210.33c-91-38.17-7.82-126.49-98.8-164.66%22%2F%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2216%22%20d%3D%22M174.6%2044.05C187%20141.93%2069%20114.07%2081.4%20212%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "cell": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2236%2036%20184%20184%22%3E%3Cpath%20d%3D%22M200%2040H56a16%2016%200%200%200-16%2016v144a16%2016%200%200%200%2016%2016h144a16%2016%200%200%200%2016-16V56a16%2016%200%200%200-16-16m0%2080h-64V56h64Zm-80-64v64H56V56Zm-64%2080h64v64H56Zm144%2064h-64v-64h64z%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "crosshair": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2232%2032%20192%20192%22%3E%3Cpath%20d%3D%22M220%20128a4%204%200%200%201-4%204h-84v84a4%204%200%200%201-8%200v-84H40a4%204%200%200%201%200-8h84V40a4%204%200%200%201%208%200v84h84a4%204%200%200%201%204%204%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "text": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2238%2038%20180%20180%22%3E%3Cpath%20fill%3D%22none%22%20d%3D%22M0%200h256v256H0z%22%2F%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2212%22%20d%3D%22M128%2080a32%2032%200%200%201%2032-32h16m0%20160h-16a32%2032%200%200%201-32-32m-48%2032h16a32%2032%200%200%200%2032-32V80a32%2032%200%200%200-32-32H80m24%2080h48%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "vertical-text": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2238%2038%20180%20180%22%3E%3Cg%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M256%200v256H0V0z%22%2F%3E%3Cpath%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2212%22%20d%3D%22M176%20128a32%2032%200%200%201%2032%2032v16m-160%200v-16a32%2032%200%200%201%2032-32M48%2080v16a32%2032%200%200%200%2032%2032h96a32%2032%200%200%200%2032-32V80m-80%2024v48%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "alias": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%22-8.511%2032.217%20237.615%20237.615%22%3E%3Cpath%20fill%3D%22none%22%20d%3D%22M0%200h256v256H0z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M123.128%20173.402a8%208%200%200%201%206.356-11.604l49.646-2.606a8%208%200%200%200%203.913-14.343L46.96%2045.673a8%208%200%200%200-12.6%206.42l.209%20168.408a8%208%200%200%200%2013.904%205.264l31.289-38.632a8%208%200%200%201%2013.124%201.677l32.943%2064.655a8%208%200%200%200%2010.756%203.495l15.981-8.12a8%208%200%200%200%203.495-10.756Z%22%2F%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2216%22%20d%3D%22M123.128%20173.402a8%208%200%200%201%206.356-11.604l49.646-2.606a8%208%200%200%200%203.913-14.343L46.96%2045.673a8%208%200%200%200-12.6%206.42l.209%20168.408a8%208%200%200%200%2013.904%205.264l31.289-38.632a8%208%200%200%201%2013.124%201.677l32.943%2064.655a8%208%200%200%200%2010.756%203.495l15.981-8.12a8%208%200%200%200%203.495-10.756Z%22%2F%3E%3Cg%20transform%3D%22matrix(.6%200%200%20.6%2047.2%2020)%22%3E%3Cpath%20fill%3D%22none%22%20d%3D%22M0%200h256v256H0z%22%2F%3E%3Crect%20width%3D%22144%22%20height%3D%22144%22%20x%3D%2240%22%20y%3D%2272%22%20opacity%3D%22.2%22%20rx%3D%228%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2224%22%20d%3D%22m136%20120%2080-80m0%2064-.01-63.99L152%2040m32%2096v72a8%208%200%200%201-8%208H48a8%208%200%200%201-8-8V80a8%208%200%200%201%208-8h72%22%2F%3E%3Cpath%20fill%3D%22none%22%20d%3D%22M0%200h256v256H0z%22%2F%3E%3Crect%20width%3D%22144%22%20height%3D%22144%22%20x%3D%2240%22%20y%3D%2272%22%20fill%3D%22gray%22%20rx%3D%228%22%2F%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2224%22%20d%3D%22m136%20120%2080-80m0%2064-.01-63.99L152%2040m32%2096v72a8%208%200%200%201-8%208H48a8%208%200%200%201-8-8V80a8%208%200%200%201%208-8h72%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E", "x": 2, "y": 0 }, "copy": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%22-8.511%2032.217%20237.615%20237.615%22%3E%3Cpath%20fill%3D%22none%22%20d%3D%22M0%200h256v256H0z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M123.128%20173.402a8%208%200%200%201%206.356-11.604l49.646-2.606a8%208%200%200%200%203.913-14.343L46.96%2045.673a8%208%200%200%200-12.6%206.42l.209%20168.408a8%208%200%200%200%2013.904%205.264l31.289-38.632a8%208%200%200%201%2013.124%201.677l32.943%2064.655a8%208%200%200%200%2010.756%203.495l15.981-8.12a8%208%200%200%200%203.495-10.756Z%22%2F%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2216%22%20d%3D%22M123.128%20173.402a8%208%200%200%201%206.356-11.604l49.646-2.606a8%208%200%200%200%203.913-14.343L46.96%2045.673a8%208%200%200%200-12.6%206.42l.209%20168.408a8%208%200%200%200%2013.904%205.264l31.289-38.632a8%208%200%200%201%2013.124%201.677l32.943%2064.655a8%208%200%200%200%2010.756%203.495l15.981-8.12a8%208%200%200%200%203.495-10.756Z%22%2F%3E%3Cpath%20fill%3D%22none%22%20d%3D%22M82.4%2020H236v153.6H82.4z%22%2F%3E%3Cpath%20d%3D%22M135.2%2044v28.8h48v48H212V44z%22%20opacity%3D%22.2%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2214.4%22%20d%3D%22M183.2%20120.8H212V44h-76.8v28.8%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2214.4%22%20d%3D%22M106.4%2072.8h76.8v76.8h-76.8z%22%2F%3E%3Cpath%20fill%3D%22none%22%20d%3D%22M82.4%2020H236v153.6H82.4z%22%2F%3E%3Cpath%20fill%3D%22gray%22%20d%3D%22M135.2%2044v28.8h48v48H212V44z%22%2F%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2214.4%22%20d%3D%22M183.2%20120.8H212V44h-76.8v28.8%22%2F%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%2214.4%22%20d%3D%22M106.4%2072.8h76.8v76.8h-76.8z%22%2F%3E%3C%2Fsvg%3E", "x": 2, "y": 0 }, "move": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2211.994%2011.994%20232.013%20232.013%22%3E%3Cpath%20d%3D%22M90.34%2061.66a8%208%200%200%201%200-11.32l32-32a8%208%200%200%201%2011.32%200l32%2032a8%208%200%200%201-11.32%2011.32L136%2043.31V96a8%208%200%200%201-16%200V43.31l-18.34%2018.35a8%208%200%200%201-11.32%200m64%20132.68L136%20212.69V160a8%208%200%200%200-16%200v52.69l-18.34-18.35a8%208%200%200%200-11.32%2011.32l32%2032a8%208%200%200%200%2011.32%200l32-32a8%208%200%200%200-11.32-11.32m83.32-72-32-32a8%208%200%200%200-11.32%2011.32L212.69%20120H160a8%208%200%200%200%200%2016h52.69l-18.35%2018.34a8%208%200%200%200%2011.32%2011.32l32-32a8%208%200%200%200%200-11.32M43.31%20136H96a8%208%200%200%200%200-16H43.31l18.35-18.34a8%208%200%200%200-11.32-11.32l-32%2032a8%208%200%200%200%200%2011.32l32%2032a8%208%200%200%200%2011.32-11.32Z%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "no-drop": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2220%2020%20216%20216%22%3E%3Cpath%20d%3D%22M165.66%20154.34a8%208%200%200%201-11.32%2011.32l-64-64a8%208%200%200%201%2011.32-11.32ZM232%20128A104%20104%200%201%201%20128%2024a104.11%20104.11%200%200%201%20104%20104m-16%200a88%2088%200%201%200-88%2088%2088.1%2088.1%200%200%200%2088-88%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "not-allowed": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2220%2020%20216%20216%22%3E%3Cpath%20d%3D%22M128%2024a104%20104%200%201%200%20104%20104A104.11%20104.11%200%200%200%20128%2024m88%20104a87.56%2087.56%200%200%201-20.41%2056.28L71.72%2060.4A88%2088%200%200%201%20216%20128m-176%200a87.56%2087.56%200%200%201%2020.41-56.28L184.28%20195.6A88%2088%200%200%201%2040%20128%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "grab": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%223.968%2011.987%20232.013%20232.013%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M208%2076v76a80%2080%200%200%201-80%2080c-44.18%200-60.75-21.28-93.32-90a20%2020%200%200%201%2034.64-20L88%20152V60a20%2020%200%200%201%2040%200V44a20%2020%200%200%201%2040%200v32a20%2020%200%200%201%2040%200%22%2F%3E%3Cpath%20d%3D%22M188%2048a27.75%2027.75%200%200%200-12%202.71V44a28%2028%200%200%200-54.65-8.6A28%2028%200%200%200%2080%2060v64l-3.82-6.13a28%2028%200%200%200-48.6%2027.82c16%2033.77%2028.93%2057.72%2043.72%2072.69C86.24%20233.54%20103.2%20240%20128%20240a88.1%2088.1%200%200%200%2088-88V76a28%2028%200%200%200-28-28m12%20104a72.08%2072.08%200%200%201-72%2072c-20.38%200-33.51-4.88-45.33-16.85C69.44%20193.74%2057.26%20171%2041.9%20138.58a6%206%200%200%200-.3-.58%2012%2012%200%200%201%2020.79-12%202%202%200%200%200%20.14.23l18.67%2030A8%208%200%200%200%2096%20152V60a12%2012%200%200%201%2024%200v60a8%208%200%200%200%2016%200V44a12%2012%200%200%201%2024%200v76a8%208%200%200%200%2016%200V76a12%2012%200%200%201%2024%200Z%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "grabbing": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2235.998%2059.995%20184.005%20184.005%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M208%20108v44a80%2080%200%200%201-160%200v-12a20%2020%200%200%201%2020-20h20V92a20%2020%200%200%201%2040%200%2020%2020%200%200%201%2040%200v16a20%2020%200%200%201%2040%200%22%2F%3E%3Cpath%20d%3D%22M188%2080a27.8%2027.8%200%200%200-13.36%203.4%2028%2028%200%200%200-46.64-11A28%2028%200%200%200%2080%2092v20H68a28%2028%200%200%200-28%2028v12a88%2088%200%200%200%20176%200v-44a28%2028%200%200%200-28-28m12%2072a72%2072%200%200%201-144%200v-12a12%2012%200%200%201%2012-12h12v24a8%208%200%200%200%2016%200V92a12%2012%200%200%201%2024%200v28a8%208%200%200%200%2016%200V92a12%2012%200%200%201%2024%200v28a8%208%200%200%200%2016%200v-12a12%2012%200%200%201%2024%200Z%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "all-scroll": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2211.994%2011.994%20232.013%20232.013%22%3E%3Cpath%20d%3D%22M90.34%2061.66a8%208%200%200%201%200-11.32l32-32a8%208%200%200%201%2011.32%200l32%2032a8%208%200%200%201-11.32%2011.32L136%2043.31V96a8%208%200%200%201-16%200V43.31l-18.34%2018.35a8%208%200%200%201-11.32%200m64%20132.68L136%20212.69V160a8%208%200%200%200-16%200v52.69l-18.34-18.35a8%208%200%200%200-11.32%2011.32l32%2032a8%208%200%200%200%2011.32%200l32-32a8%208%200%200%200-11.32-11.32m83.32-72-32-32a8%208%200%200%200-11.32%2011.32L212.69%20120H160a8%208%200%200%200%200%2016h52.69l-18.35%2018.34a8%208%200%200%200%2011.32%2011.32l32-32a8%208%200%200%200%200-11.32M43.31%20136H96a8%208%200%200%200%200-16H43.31l18.35-18.34a8%208%200%200%200-11.32-11.32l-32%2032a8%208%200%200%200%200%2011.32l32%2032a8%208%200%200%200%2011.32-11.32Z%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "col-resize": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2211.994%2011.994%20232.013%20232.013%22%3E%3Cpath%20d%3D%22m237.66%20133.66-32%2032a8%208%200%200%201-11.32-11.32L212.69%20136H43.31l18.35%2018.34a8%208%200%200%201-11.32%2011.32l-32-32a8%208%200%200%201%200-11.32l32-32a8%208%200%200%201%2011.32%2011.32L43.31%20120h169.38l-18.35-18.34a8%208%200%200%201%2011.32-11.32l32%2032a8%208%200%200%201%200%2011.32%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "row-resize": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2211.995%2011.994%20232.013%20232.013%22%3E%3Cpath%20d%3D%22M165.66%20194.34a8%208%200%200%201%200%2011.32l-32%2032a8%208%200%200%201-11.32%200l-32-32a8%208%200%200%201%2011.32-11.32L120%20212.69V43.31l-18.34%2018.35a8%208%200%200%201-11.32-11.32l32-32a8%208%200%200%201%2011.32%200l32%2032a8%208%200%200%201-11.32%2011.32L136%2043.31v169.38l18.34-18.35a8%208%200%200%201%2011.32%200%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "n-resize": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2227.998%2027.994%20200.006%20200.006%22%3E%3Cpath%20d%3D%22M205.66%20117.66a8%208%200%200%201-11.32%200L136%2059.31V216a8%208%200%200%201-16%200V59.31l-58.34%2058.35a8%208%200%200%201-11.32-11.32l72-72a8%208%200%200%201%2011.32%200l72%2072a8%208%200%200%201%200%2011.32%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "e-resize": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2228%2027.997%20200.006%20200.006%22%3E%3Cpath%20d%3D%22m221.66%20133.66-72%2072a8%208%200%200%201-11.32-11.32L196.69%20136H40a8%208%200%200%201%200-16h156.69l-58.35-58.34a8%208%200%200%201%2011.32-11.32l72%2072a8%208%200%200%201%200%2011.32%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "s-resize": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2227.997%2028%20200.006%20200.006%22%3E%3Cpath%20d%3D%22m205.66%20149.66-72%2072a8%208%200%200%201-11.32%200l-72-72a8%208%200%200%201%2011.32-11.32L120%20196.69V40a8%208%200%200%201%2016%200v156.69l58.34-58.35a8%208%200%200%201%2011.32%2011.32%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "w-resize": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2227.994%2027.997%20200.006%20200.006%22%3E%3Cpath%20d%3D%22M224%20128a8%208%200%200%201-8%208H59.31l58.35%2058.34a8%208%200%200%201-11.32%2011.32l-72-72a8%208%200%200%201%200-11.32l72-72a8%208%200%200%201%2011.32%2011.32L59.31%20120H216a8%208%200%200%201%208%208%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "ne-resize": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2251.996%2052%20152.004%20152.004%22%3E%3Cpath%20d%3D%22M200%2064v104a8%208%200%200%201-16%200V83.31L69.66%20197.66a8%208%200%200%201-11.32-11.32L172.69%2072H88a8%208%200%200%201%200-16h104a8%208%200%200%201%208%208%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "nw-resize": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2252%2052%20152.006%20152.006%22%3E%3Cpath%20d%3D%22M197.66%20197.66a8%208%200%200%201-11.32%200L72%2083.31V168a8%208%200%200%201-16%200V64a8%208%200%200%201%208-8h104a8%208%200%200%201%200%2016H83.31l114.35%20114.34a8%208%200%200%201%200%2011.32%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "se-resize": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2251.996%2051.996%20152.004%20152.004%22%3E%3Cpath%20d%3D%22M200%2088v104a8%208%200%200%201-8%208H88a8%208%200%200%201%200-16h84.69L58.34%2069.66a8%208%200%200%201%2011.32-11.32L184%20172.69V88a8%208%200%200%201%2016%200%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "sw-resize": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2252%2051.996%20152.004%20152.004%22%3E%3Cpath%20d%3D%22M197.66%2069.66%2083.31%20184H168a8%208%200%200%201%200%2016H64a8%208%200%200%201-8-8V88a8%208%200%200%201%2016%200v84.69L186.34%2058.34a8%208%200%200%201%2011.32%2011.32%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "ew-resize": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2211.994%2011.994%20232.013%20232.013%22%3E%3Cpath%20d%3D%22m237.66%20133.66-32%2032a8%208%200%200%201-11.32-11.32L212.69%20136H43.31l18.35%2018.34a8%208%200%200%201-11.32%2011.32l-32-32a8%208%200%200%201%200-11.32l32-32a8%208%200%200%201%2011.32%2011.32L43.31%20120h169.38l-18.35-18.34a8%208%200%200%201%2011.32-11.32l32%2032a8%208%200%200%201%200%2011.32%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "ns-resize": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2211.995%2011.994%20232.013%20232.013%22%3E%3Cpath%20d%3D%22M165.66%20194.34a8%208%200%200%201%200%2011.32l-32%2032a8%208%200%200%201-11.32%200l-32-32a8%208%200%200%201%2011.32-11.32L120%20212.69V43.31l-18.34%2018.35a8%208%200%200%201-11.32-11.32l32-32a8%208%200%200%201%2011.32%200l32%2032a8%208%200%200%201-11.32%2011.32L136%2043.31v169.38l18.34-18.35a8%208%200%200%201%2011.32%200%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "nesw-resize": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2211.995%2011.994%20232.013%20232.013%22%3E%3Cpath%20d%3D%22M107.72%20201.538a8%208%200%200%201-8.004%208.005H54.461a8%208%200%200%201-8.004-8.005v-45.254a8.004%208.004%200%200%201%2016.009%200l-.007%2025.943%20119.77-119.77-25.944.008a8.004%208.004%200%200%201%200-16.01h45.254a8%208%200%200%201%208.005%208.005v45.255a8.004%208.004%200%200%201-16.01%200l.008-25.944-119.77%20119.77%2025.944-.007a8%208%200%200%201%208.004%208.004%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "nwse-resize": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2211.995%2011.994%20232.013%20232.013%22%3E%3Cpath%20d%3D%22M201.54%20148.28a8%208%200%200%201%208.004%208.005v45.255a8%208%200%200%201-8.005%208.004h-45.254a8.004%208.004%200%200%201%200-16.009l25.943.007-119.77-119.77.008%2025.944a8.004%208.004%200%200%201-16.01%200V54.462a8%208%200%200%201%208.005-8.005h45.255a8.004%208.004%200%200%201%200%2016.009l-25.944-.007%20119.77%20119.77-.007-25.944a8%208%200%200%201%208.004-8.005%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "zoom-in": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2219.611%2019.581%20216.424%20216.424%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M192%20112a80%2080%200%201%201-80-80%2080%2080%200%200%201%2080%2080%22%2F%3E%3Cpath%20d%3D%22m229.66%20218.34-50.06-50.06a88.21%2088.21%200%201%200-11.32%2011.31l50.06%2050.07a8%208%200%200%200%2011.32-11.32M40%20112a72%2072%200%201%201%2072%2072%2072.08%2072.08%200%200%201-72-72m112%200a8%208%200%200%201-8%208h-24v24a8%208%200%200%201-16%200v-24H80a8%208%200%200%201%200-16h24V80a8%208%200%200%201%2016%200v24h24a8%208%200%200%201%208%208%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 }, "zoom-out": { "url": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%2219.611%2019.581%20216.424%20216.424%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M192%20112a80%2080%200%201%201-80-80%2080%2080%200%200%201%2080%2080%22%2F%3E%3Cpath%20d%3D%22m229.66%20218.34-50.06-50.06a88.21%2088.21%200%201%200-11.32%2011.31l50.06%2050.07a8%208%200%200%200%2011.32-11.32M40%20112a72%2072%200%201%201%2072%2072%2072.08%2072.08%200%200%201-72-72m112%200a8%208%200%200%201-8%208H80a8%208%200%200%201%200-16h64a8%208%200%200%201%208%208%22%2F%3E%3C%2Fsvg%3E", "x": 8, "y": 8 } });
    //#endregion

    constructor() {
      /** @type {IDBDatabase | null} */
      this.db = null;

      /** @type {ReplayEntry[]} */
      this.replays = [];

      /** @type {SwapRecorder | null} */
      this.recorder = null;

      /** @type {HTMLElement} */
      this.root = this._createUI();

      /** @type {NodeListOf<HTMLButtonElement>} */
      this.selectionControls = this.root.querySelectorAll(
        '[data-act="replay"], [data-act="ghost-player"], [data-act="ghost-opponent"], [data-act="solo"], [data-act="export"], [data-act="delete"], [data-act="view-lineage"]'
      );

      /** @type {NodeListOf<HTMLButtonElement>} */
      this.vsControls = this.root.querySelectorAll(
        '[data-act="replay"], [data-act="ghost-player"], [data-act="ghost-opponent"]'
      );

      /** @type {HTMLElement} */
      this.listEl = assert(this.root.querySelector('.rc-list'));

      /** @type {string | null} */
      this.selectedId = null;

      /** @type {string} */
      this.searchQuery = '';

      /** @type {boolean} */
      this.recordGhostReplays = false;

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

      return new Promise((res, rej) => {
        /** @type {IDBRequest<ReplayEntry[]>} */
        const req = store.getAll();
        req.onsuccess = () => {
          const arr = req.result.sort((a, b) => b.ts - a.ts);
          for (const entry of arr) {
            if (!entry.data.matchLength) {
              let matchLength = 0;
              for (const e of entry.data.events) {
                if (e.t > matchLength) matchLength = e.t;
              }
              for (const e of entry.data.opponent) {
                if (e.t > matchLength) matchLength = e.t;
              }
              entry.data.matchLength = matchLength;
            }
            if (!entry.lineage) entry.lineage = [this._createLineageEntry(entry, 'live')];
          }
          res(arr);
        };
        req.onerror = () => rej(req.error);   // specific failure
        tx.onabort = () => rej(tx.error);     // transaction failed
      });
    }

    /**
     * @param {ReplayEntry} entry
     * @returns {Promise<void>}
     */
    async _add(entry) {
      const tx = assert(this.db).transaction('replays', 'readwrite');
      const req = tx.objectStore('replays').add(entry);

      return new Promise((res, rej) => {
        req.onerror = () => rej(req.error);   // specific failure
        tx.onabort = () => rej(tx.error);     // transaction failed
        tx.oncomplete = () => res();          // success
      });
    }

    /**
     * @param {IDBValidKey} id
     * @returns {Promise<void>}
     */
    async _delete(id) {
      const tx = assert(this.db).transaction('replays', 'readwrite');
      const req = tx.objectStore('replays').delete(id);

      return new Promise((res, rej) => {
        req.onerror = () => rej(req.error);   // specific failure
        tx.onabort = () => rej(tx.error);     // transaction failed
        tx.oncomplete = () => res();          // success
      });
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
        this.recorder = new SwapRecorder({
          extraStartCond() {
            return !!document.querySelector('.tab.active')?.textContent.includes('1v1 ranked');
          },
          extraStopCond() {
            if (!document.querySelector('.tab.active')?.textContent.includes('1v1 ranked'))
              return 'tabExit';
            return false;
          }
        });
        await this.recorder.start();

        await this._waitFor(() => !this.recorder?.started);

        /** @type {ReplayResult} */
        const result = this.recorder.exitMode === 'tabExit' ? 0 : await this._detectResult();

        /** @type {ReplayEntry} */
        const entry = {
          id: uuid4(),
          ts: Date.now(),
          result,
          data: this.recorder.export(),
          isSolo: false,
          lineage: []
        };
        entry.lineage.push(this._createLineageEntry(entry, 'live'));

        await this._add(entry);
        this.replays = await this._loadAll();
        this._renderList(entry.id);
      }
    }

    /**
     * @returns {Promise<ReplayResult>}
     */
    async _detectResult() {
      while (true) {
        await new Promise(r => requestAnimationFrame(r));

        const rt = document.querySelector('.result-wrap .result-title, .result-wrap .big-text');
        if (!rt) continue;

        const pb = document.querySelector('.result-wrap .primary-btn');
        if (!pb) continue;

        const t = rt.textContent.toLowerCase();

        if (t.includes('won')) return 1;
        if (t.includes('lost')) return 2;
        return 0;
      }
    }

    /* ================= UI ================= */

    _createUI() {
      const el = document.createElement('div');

      el.className = 'rc-root is-collapsed';
      el.innerHTML = `
        <div class="rc-header">
          <span class="rc-title">Replays</span>
          <button class="rc-toggle-btn">▼</button>
        </div>

        <div class="rc-collapsible">
          <div class="rc-collapsible-content">
            <div class="rc-content">
              <div class="rc-actions">
                <div class="row">
                  <button data-act="import">import</button>
                  <button data-act="export">export</button>
                  <button data-act="delete">delete</button>
                </div>
                <div class="row">
                  <div class="rc-tool-root">
                    <button class="rc-tool-toggle" data-act="show-tool-list">tools</button>

                    <div class="rc-tool-list">
                      <button data-act="toggle-ghost-recording">ghost recording: <span>off</span></button>
                      <button data-act="view-lineage">view lineage</button>
                      <button data-act="solo-sort">solo sort</button>
                      <button data-act="generate-sort">generate sort</button>
                    </div>
                  </div>
                </div>
                <div class="row">
                  <button data-act="replay">replay</button>
                  <button data-act="solo">solo</button>
                </div>
                <div class="row">
                  <button data-act="ghost-player">ghost: player</button>
                  <button data-act="ghost-opponent">ghost: opponent</button>
                </div>
              </div>
              <input type="text" placeholder="search" class="rc-search" />
              <div class="rc-list"></div>
            </div>
          </div>
        </div>
      `;

      const header = assert(el.querySelector('.rc-header'));
      header.addEventListener('click', () => {
        el.classList.toggle('is-collapsed');
      });

      /** @type {HTMLInputElement} */
      const searchField = assert(el.querySelector('.rc-search'));
      searchField.addEventListener('input', () => {
        const trimStart = searchField.value.trimStart();
        if (searchField.value !== trimStart) {
          let { selectionStart, selectionEnd, selectionDirection } = searchField;
          const offset = trimStart.length - searchField.value.length;
          searchField.value = trimStart;

          if (selectionStart != null) selectionStart += offset;
          if (selectionEnd != null) selectionEnd += offset;
          searchField.setSelectionRange(selectionStart, selectionEnd, selectionDirection || undefined);
        }
        this.searchQuery = searchField.value.trim();
        this._renderList(null);
      });
      searchField.addEventListener('change', () => {
        if (searchField.value !== this.searchQuery)
          searchField.value = this.searchQuery;
      });

      document.addEventListener('pointerdown', e => {
        if (!e.isTrusted) return;

        const root = this.root.querySelector('.rc-tool-root');
        if (!root) return;

        if (!(e.target instanceof Element) || !root.contains(e.target)) {
          this._closeToolList();
        }
      });

      document.body.appendChild(el);

      this._wireUI(el);
      this._startTimeUpdates();

      return el;
    }

    /**
     * @param {ReplayEntry} entry
     * @param {ReplayLineageEntry['type']} type
     * @returns {ReplayLineageEntry}
     */
    _createLineageEntry(entry, type) {
      const d = entry.data;

      return {
        id: entry.id,
        ts: entry.ts,
        type,
        result: entry.result,
        matchLength: d.matchLength,
        playerName: d.playerName,
        opponentName: d.opponentName,
        playerNameClass: d.playerNameClass,
        opponentNameClass: d.opponentNameClass,
        playerElo: d.playerElo,
        opponentElo: d.opponentElo,
        isSolo: entry.isSolo
      };
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
        else if (act === 'ghost-player') this._play('ghost-player');
        else if (act === 'ghost-opponent') this._play('ghost-opponent');
        else if (act === 'solo') this._play('ghost-solo');
        else if (act === 'delete') this._deleteSelected();
        else if (act === 'export') this._exportSelected();
        else if (act === 'import') this._import();
        else if (act === 'show-tool-list') this._toggleToolList();
        else {
          this._closeToolList();
          if (act === 'generate-sort') this._UIgenerateSort();
          else if (act === 'solo-sort') this._UIsoloSort();
          else if (act === 'toggle-ghost-recording') this._toggleGhostRecording();
          else if (act === 'view-lineage') this._UIviewLineage();
        }
      });

      root.addEventListener('keydown', e => {
        if (e.target instanceof HTMLButtonElement) return;

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this._moveSelection(1);
        }

        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this._moveSelection(-1);
        }

        if (e.key === 'Enter') {
          e.preventDefault();

          if (e.shiftKey) {
            this._play('ghost-player');
          } else if (e.altKey) {
            this._play('ghost-opponent');
          } else {
            this._play('replay');
          }
        }
      });
    }

    _toggleToolList() {
      const toolRoot = assert(this.root.querySelector('.rc-tool-root'));
      toolRoot.classList.toggle('is-open');
    }

    _closeToolList() {
      const toolRoot = assert(this.root.querySelector('.rc-tool-root'));
      toolRoot.classList.remove('is-open');
    }

    _toggleGhostRecording() {
      this.recordGhostReplays = !this.recordGhostReplays;

      const btn = this.root.querySelector('[data-act="toggle-ghost-recording"]');
      if (btn) {
        btn.children[0].textContent = this.recordGhostReplays ? 'on' : 'off';
        btn.classList.toggle('is-active', this.recordGhostReplays);
      }
    }

    _UIgenerateSort() {
      new SortGenerationWidget(async (recording) => {
        /** @type {ReplayEntry} */
        const entry = {
          id: uuid4(),
          ts: Date.now(),
          result: 0,
          data: recording,
          isSolo: false,
          lineage: []
        };
        entry.lineage.push(this._createLineageEntry(entry, 'generated'));

        await this._add(entry);
        this.replays = await this._loadAll();
        this._renderList(entry.id);
      }).open();
    }

    _UIsoloSort() {
      new SoloSortWidget(async (recording, save) => {
        /** @type {ReplayEntry} */
        const entry = {
          id: uuid4(),
          ts: Date.now(),
          result: 0,
          data: recording,
          isSolo: true,
          lineage: []
        };
        entry.lineage.push(this._createLineageEntry(entry, 'generated'));

        if (save) {
          await this._add(entry);
          this.replays = await this._loadAll();
          this._renderList(entry.id);
        } else {
          this.root.classList.add('is-collapsed');
          this._startReplay(entry, 'ghost-solo');
        }
      }).open();
    }

    _UIviewLineage() {
      const r = this._getSelected();
      if (!r) return;
      new LineageWidget(r, id => {
        this._renderList(id);
      }).open();
    }

    /** @type {ReplayEntry[]} */
    resultList = [];

    /** 
     * @param {string} text
     */
    _emptyList(text) {
      this.selectedId = null;
      this.selectionControls.forEach(b => b.disabled = true);
      const empty = document.createElement('div');
      empty.className = 'rc-empty';
      empty.textContent = text;
      this.listEl.appendChild(empty);
    }

    _renderList(selectId = this.selectedId, refreshResults = true) {
      this.listEl.innerHTML = '';

      if (!this.replays.length) {
        this._emptyList('No replays yet');
        return;
      }

      if (refreshResults)
        this.resultList = this.searchQuery ? searchReplays(this.searchQuery, this.replays) : this.replays;

      if (!this.resultList.length) {
        this._emptyList('No results');
        return;
      }
      this.selectionControls.forEach(b => b.disabled = false);

      if (selectId == null) {
        this.selectedId = this.resultList[0].id;
      }

      let selectedChanged = false;
      if (selectId && selectId !== this.selectedId) {
        for (const entry of this.resultList) {
          if (entry.id === selectId) {
            this.selectedId = selectId;
            selectedChanged = true;
          }
        }
      }

      /** @type {HTMLElement | null} */
      let selectedEl = null;
      for (const r of this.resultList) {
        const el = document.createElement('div');
        el.className = 'rc-item';

        if (this.selectedId === r.id) {
          el.classList.add('is-selected');
          if (r.isSolo) {
            this.vsControls.forEach(b => b.disabled = true);
          }
          selectedEl = el;
        }

        const time = new Date(r.ts);

        const resultLabel = ['?', 'W', 'L'][r.result];
        const resultClass = ['is-unknown', 'is-win', 'is-loss'][r.result];

        const opponentClass = r.data.opponentNameClass || '';

        const elo = r.data.opponentElo;

        const eloHtml = elo != null
          ? `<span class="rc-elo">${elo}</span>`
          : '';

        el.innerHTML = `
          <div class="rc-item-main">
            <span class="rc-opponent ${opponentClass} ${svClass}">
              ${r.data.opponentName}
              ${eloHtml}
            </span>
            <span class="rc-result ${resultClass}">
              ${resultLabel}
            </span>
          </div>
          <div class="rc-item-sub">
            <span class="rc-time"
                  data-ts="${time.getTime()}"
                  title="${time.toLocaleString()}">
              ${formatTime(time)}
            </span>
            <span class="rc-duration">
              ${formatDuration(r.data.matchLength)}
            </span>
          </div>
        `;

        el.onclick = () => {
          this._renderList(r.id);
        };

        this.listEl.appendChild(el);
      }

      if (selectedChanged) {
        selectedEl?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest'
        });
      }
    }

    _getSelectedIndex() {
      return this.resultList.findIndex(r => r.id === this.selectedId);
    }

    /** @param {number} i */
    _setSelectedByIndex(i) {
      if (!this.resultList.length) return;

      i = Math.max(0, Math.min(this.resultList.length - 1, i));
      this._renderList(this.resultList[i].id, false);
    }

    /** @param {number} delta */
    _moveSelection(delta) {
      let i = this._getSelectedIndex();

      if (i === -1) i = 0;
      else i += delta;

      this._setSelectedByIndex(i);
    }

    _startTimeUpdates() {
      if (this._timeInterval) return;

      this._timeInterval = setInterval(() => {
        /** @type {NodeListOf<HTMLElement>} */
        const nodes = this.listEl.querySelectorAll('.rc-time');

        for (const el of nodes) {
          const ts = Number(el.dataset.ts);
          el.textContent = formatTime(new Date(ts));
        }
      }, 10000);
    }

    /* ================= ACTIONS ================= */

    _getSelected() {
      return this.replays.find(r => r.id === this.selectedId);
    }

    /** @type {SwapReplay | null} */
    _replay = null;

    /**
     * @param {ReplayMode} mode
     */
    _play(mode) {
      const r = this._getSelected();
      if (!r) return;

      this.root.classList.add('is-collapsed');
      this._startReplay(r, mode);
    }

    /**
     * @param {ReplayEntry} entry
     * @param {ReplayMode} mode
     */
    _startReplay(entry, mode) {
      if (this._replay) {
        this._replay.destroy();
        this._replay = null;
      }

      const replay = new SwapReplay(entry.data, snapshotHTML, this._cursor, mode);
      this._replay = replay;

      if (this.recordGhostReplays && mode !== 'replay') {
        const recorder = new SwapRecorder({
          extraStopCond: () => {
            if (replay._frozenPlayerMs != null) return 'player';
            if (replay._frozenOppMs != null && replay._oppIsSorted()) return 'opponent';
            if (replay._destroyed === true) return 'destroyed';
            return false;
          }
        });
        recorder.start().then(async () => {
          await this._waitFor(() => !recorder.started);

          /** @type {ReplayResult} */
          const result = recorder.exitMode === 'player' ?
            1 : recorder.exitMode === 'opponent' ? 2 : 0;

          /** @type {ReplayEntry} */
          const newEntry = {
            id: uuid4(),
            ts: Date.now(),
            result,
            data: recorder.export(),
            isSolo: mode === 'ghost-solo',
            lineage: entry.lineage.slice()
          };

          if (mode === 'ghost-solo') {
            newEntry.data.opponent = [];
            if (newEntry.data.opponentName.endsWith(' (ghost)'))
              newEntry.data.opponentName = newEntry.data.opponentName.slice(0, -' (ghost)'.length);
            if (!newEntry.data.opponentName.endsWith(' (solo)'))
              newEntry.data.opponentName += ' (solo)';
          } else if (!newEntry.data.opponentName.endsWith(' (ghost)'))
            newEntry.data.opponentName += ' (ghost)';

          newEntry.lineage.push(this._createLineageEntry(newEntry, mode));
          await this._add(newEntry);
          this.replays = await this._loadAll();
          this._renderList(newEntry.id);
        });
      }

      replay.play().then(async () => {
        await this._waitFor(() => replay._destroyed);
        this._cursor.pointerMove({ x: -500, y: -500 });
      });
    }

    async _deleteSelected() {
      const r = this._getSelected();
      if (!r) return;

      await this._delete(r.id);
      this.replays = await this._loadAll();
      this._renderList(null);
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
        let id = null, ts = 0;
        for (const file of files) {
          const text = await file.text();
          /** @type {ReplayEntry} */
          const data = JSON.parse(text);

          if (!('id' in data)) continue;

          await this._add(data);
          if (data.ts > ts) {
            ts = data.ts;
            id = data.id;
          }
        }
        this.replays = await this._loadAll();
        if (id)
          this._renderList(id);
        else
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

  const tf = new Intl.DurationFormat(undefined, {
    style: 'narrow'
  });
  /**
   * @param {Date} date 
   * @returns {string}
   */
  function formatTime(date) {
    const now = Date.now();
    const diffMs = now - date.getTime();

    const totalSec = Math.floor(diffMs / 1000);

    const df = tf;

    // < 20 seconds → now
    if (totalSec < 20) {
      return 'now';
    }

    // < 1 minute → seconds
    if (totalSec < 60) {
      return df.format({ seconds: totalSec }) + ' ago';
    }

    // < 1 hour → m + s
    if (totalSec < 3600) {
      return df.format({
        minutes: Math.floor(totalSec / 60),
        seconds: totalSec % 60
      }) + ' ago';
    }

    // < 24 hours → h + m
    if (totalSec < 86400) {
      return df.format({
        hours: Math.floor(totalSec / 3600),
        minutes: Math.floor((totalSec % 3600) / 60)
      }) + ' ago';
    }

    const d = new Date(date);

    // < 7 days → weekday + time
    if (totalSec < 604800) {
      return d.toLocaleString(undefined, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit'
      });
    }

    // older → full date
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  /**
   * @param {number} ms
   * @returns {string}
   */
  function formatDuration(ms, enableFractional = true) {
    const s = Math.floor(ms / 1000);
    const fractional = enableFractional ? Math.floor(ms % 1000) : 0;

    // < 1 minute → seconds
    if (s < 60) {
      return dfn.format({
        seconds: s,
        milliseconds: fractional
      });
    }

    // < 1 hour → m + s
    if (s < 3600) {
      return dfd.format({
        minutes: Math.floor(s / 60),
        seconds: s % 60,
        milliseconds: fractional
      });
    }

    return dfd.format({
      hours: Math.floor(s / 3600),
      minutes: Math.floor((s % 3600) / 60),
      seconds: s % 60,
      milliseconds: fractional
    });
  }

  const dfd = new Intl.DurationFormat(undefined, {
    style: 'digital',
    milliseconds: 'numeric',
    hoursDisplay: 'auto'
  });

  const dfn = new Intl.DurationFormat(undefined, {
    style: 'narrow',
    milliseconds: 'numeric',
    secondsDisplay: 'always'
  });

  /**
   * @param {string} query
   * @param {ReplayEntry[]} list
   */
  function searchReplays(query, list) {
    query = query.toLowerCase();

    /** @param {string} s */
    const tokenize = (s) =>
      s.split(/[\s\-_/.,]+/).filter(Boolean);

    const parts = tokenize(query);

    return list
      .map(r => {
        const tsDate = new Date(r.ts);
        /** @type {Map<string, [weight: number, text: string]>} */
        const fields = new Map([
          ['name', [1.4, r.data.opponentName]],
          ['elo', [1.0, r.data.opponentElo != null ? `${r.data.opponentElo} elo ${r.data.opponentElo}` : '']],
          ['rank', [0.8, r.data.opponentNameClass != null ? `${(
            r.data.opponentNameClass.replace(/^name-/, '')
          )}` : '']],
          ['result', [0.6, ['unknown', 'win won', 'loss lost lose'][r.result]]],
          ['short', [1.4, ['?', 'w', 'l'][r.result]]],
          ['duration', [0.5, formatDuration(r.data.matchLength) + ' ' + formatDuration(r.data.matchLength, false)]],
          ['time', [0.5, formatTime(tsDate)]]
        ]);

        let totalScore = 0;
        let matchedParts = 0;

        for (let [_key, [_weight, text]] of fields) {
          text = text.toLowerCase();
          const dist = fuzzySubstring(query, text);
          let score = Math.max(0, 1 - dist);
          if (text.includes(query))
            score += 0.5;
          if (text === query)
            score += 1;
          if (score > totalScore) totalScore = score;
        }

        for (const part of parts) {
          let score = 0;

          for (let [_key, [weight, text]] of fields) {
            text = text.toLowerCase();
            const tokens = tokenize(text);

            let bestLocal = 0;

            // Tokens
            for (const token of tokens) {
              const dist = fuzzySubstring(part, token);
              bestLocal = Math.max(bestLocal, 1 - dist);
            }

            let bonus = 0;


            if (text.includes(part)) bonus += 0.2;
            {
              let prefixBest = 0;

              for (const token of tokens) {
                for (let i = part.length; i <= part.length + 2; i++) {
                  if (i >= token.length) break;
                  const slice = token.slice(0, i);
                  const dist = fuzzySubstring(part, slice);
                  const score = 1 - dist;
                  if (score > prefixBest) prefixBest = score;
                }
              }

              bonus += prefixBest * 0.3;
            };
            if (tokens.includes(part)) bonus += 0.3;

            const weighted = Math.max(0, bestLocal + bonus) * weight;

            if (weighted > score) score = weighted;
          }

          if (score > 0.3) {
            totalScore += score;
            matchedParts++;
          }
        }

        // normalize score
        const score = totalScore * ((matchedParts + 1) / (parts.length + 1));

        return {
          r,
          score,
          date: r.ts
        };
      })
      .filter(x => x.score > 0.4)
      .sort((a, b) => {
        // strong match wins
        if (Math.abs(a.score - b.score) > 0.2) {
          return b.score - a.score;
        }
        // otherwise chronological
        return b.date - a.date;
      })
      .map(x => x.r);
  }

  /**
   * Performs a fuzzy substring match that ignores accents and case.
   * Returns the minimum edit distance (lower is better).
   * @param {string} needle
   * @param {string} haystack
   * @returns {number}
   */
  function fuzzySubstring(needle, haystack) {
    // 1. Clean strings: Strip diacritics, lowercase, and trim
    /** @param {string} s */
    const clean = (s) => s.normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

    const s1 = clean(needle);
    const s2 = clean(haystack);

    const n = s1.length;
    const h = s2.length;

    if (n === 0) return 0;
    if (h === 0) return n;

    // 2. Initialize DP Matrix
    // We initialize the first row with 0s to allow the match to start 
    // anywhere in the haystack for "free" (substring matching).
    let rows = Array.from({ length: n + 1 }, (_, i) => [i]);
    for (let j = 0; j <= h; j++) rows[0][j] = 0;

    // 3. Fill Matrix using Levenshtein logic
    for (let i = 1; i <= n; i++) {
      const char1 = s1[i - 1];

      // Determine significance of char1 if it's a digit
      // We look ahead to see how many digits follow it
      let significance1 = 0.5;
      if (/\d/.test(char1)) {
        let lookAhead = i;
        while (lookAhead < n && /\d/.test(s1[lookAhead])) {
          significance1 *= 2; // Each digit to the right increases importance
          lookAhead++;
        }
        if (!/\d/.test(s1[i - 2])) {
          significance1 *= 3;
        }
      }

      for (let j = 1; j <= h; j++) {
        const char2 = s2[j - 1];
        let cost;

        if (char1 === char2) {
          cost = 0;
        } else {
          const num1 = parseInt(char1, 10);
          const num2 = parseInt(char2, 10);

          if (!isNaN(num1) && !isNaN(num2)) {
            cost = 0.5 * significance1;
            if (num2 - num1 < num1)
              cost += Math.abs(num2 - num1) * significance1 / Math.max(num1, num2);
          } else {
            cost = 3; // Standard high penalty for text
          }
        }

        rows[i][j] = Math.min(
          rows[i - 1][j] + 2,
          rows[i][j - 1] + 2,
          rows[i - 1][j - 1] + cost
        );
      }
    }

    // 4. Result is the minimum value in the last row
    // This represents the best match found anywhere in the haystack.
    return Math.min(...rows[n]) / n;
  }

  //#region Base Widget
  const widgetStyles = `
    /* === Overlay / Scrim === */
    .w-scrim {
      position: fixed;
      inset: 0;
      background: #1613168c;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999999;
      padding: 24px;
      backdrop-filter: blur(4px);
    }

    /* === Modal Container === */
    .w-modal {
      background: var(--card);
      border-radius: 20px;
      padding: 32px;
      max-width: 460px;
      width: 100%;
      box-shadow: 0 24px 80px #0000004d;
      font-family: inherit;
    }

    /* === Headings === */
    .w-title {
      font-size: 22px;
      font-weight: 700;
      margin: 0 0 6px;
      letter-spacing: -.5px;
      color: var(--dark);
    }

    .w-sub {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
      margin: 0 0 20px;
    }

    /* === Layout === */
    .w-grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 20px;
    }

    /* === Selectable Cards === */
    .w-option {
      background: var(--empty);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px;
      text-align: left;
      display: flex;
      flex-direction: column;
      gap: 4px;
      cursor: pointer;
      transition: border-color .15s, transform .15s;
    }

    .w-option:hover,
    .w-option.is-selected {
      border-color: var(--accent);
      transform: translateY(-2px);
    }

    .w-option.is-selected {
      background: var(--bg);
      box-shadow: 0 4px 12px #16131614;
    }

    .w-option-title {
      color: var(--dark);
      font-size: 14px;
      font-weight: 600;
    }

    .w-option-sub {
      color: var(--muted);
      font-size: 12px;
    }

    /* === Labels === */
    .w-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--muted);
      margin-bottom: 8px;
    }

    /* === Inputs === */
    .w-input {
      width: 100%;
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--bg);
      font-size: 15px;
      color: var(--dark);
      box-sizing: border-box;
      margin-bottom: 20px;
    }

    .w-input:focus {
      outline: 2px solid var(--accent);
      border-color: transparent;
    }

    /* === Actions === */
    .w-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 10px;
    }

    /* === Buttons === */
    .w-btn-primary {
      background: var(--dark);
      color: var(--bg);
      padding: 11px 22px;
      border-radius: 100px;
      border: none;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: transform .12s, opacity .15s;
    }

    .w-btn-primary:hover:not(:disabled) {
      transform: translateY(-1px);
    }

    .w-btn-primary:disabled {
      opacity: .4;
      cursor: not-allowed;
    }

    .w-btn-secondary {
      background: none;
      color: var(--muted);
      padding: 11px 18px;
      border: none;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }

    .w-btn-secondary:hover {
      color: var(--dark);
    }
  `;


  const widgetStyleSheet = new CSSStyleSheet();
  widgetStyleSheet.replaceSync(widgetStyles);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, widgetStyleSheet];

  /**
   * @typedef {{
   *   label: string,
   *   primary?: boolean,
   *   disabled?: () => boolean,
   *   onClick: (widget: Widget) => void
   * }} WidgetAction
   */
  class Widget {
    /**
     * @param {{
     *   title?: string,
     *   sub?: string,
     *   content: (root: HTMLElement, widget: Widget) => void,
     *   actions?: WidgetAction[]
     * }} opts
     */
    constructor(opts) {
      this.opts = opts;
      this.root = document.createElement('div');
      this.root.className = 'w-scrim';

      this.modal = document.createElement('div');
      this.modal.className = 'w-modal';

      this.root.appendChild(this.modal);

      // Header
      if (this.opts.title) {
        const h = document.createElement('h2');
        h.className = 'w-title';
        h.textContent = this.opts.title;
        this.modal.appendChild(h);
      }

      if (this.opts.sub) {
        const p = document.createElement('p');
        p.className = 'w-sub';
        p.textContent = this.opts.sub;
        this.modal.appendChild(p);
      }

      // Content
      this.contentEl = document.createElement('div');
      this.modal.appendChild(this.contentEl);

      // Close on background click
      this.root.addEventListener('pointerdown', e => {
        if (e.target === this.root) {
          this.close();
        }
      });

      /** @param {KeyboardEvent} e */
      this._onKey = (e) => {
        if (e.key === 'Escape') this.close();

        if (e.key === 'Enter') {
          /** @type {HTMLElement | null} */
          const primaryBtn = this.root.querySelector('.w-btn-primary');
          if (primaryBtn) primaryBtn.click();
        }
      };
    }

    _initialized = false;
    _lazy() {
      if (this._initialized) return;
      this.opts.content(this.contentEl, this);

      // Actions
      if (this.opts.actions?.length) {
        const actions = document.createElement('div');
        actions.className = 'w-actions';

        for (const act of this.opts.actions) {
          const btn = document.createElement('button');

          btn.className = act.primary
            ? 'w-btn-primary'
            : 'w-btn-secondary';

          btn.textContent = act.label;
          const update = () => {
            if (act.disabled) {
              btn.disabled = !!act.disabled();
            }
          };

          const aArr = this._actions.get(act.label) || [];
          aArr.push(update);
          this._actions.set(act.label, aArr);

          btn.onclick = () => {
            act.onClick(this);
            update();
          };

          update();
          actions.appendChild(btn);
        }

        this.modal.appendChild(actions);
      }
      this._initialized = true;
    }
    /** @type {Map<string, (() => void)[]>} */
    _actions = new Map();

    /**
     * @param {string} label 
     */
    updateAction(label) {
      const aArr = this._actions.get(label) || [];
      for (const update of aArr) update();
    };

    open() {
      this._lazy();
      document.body.appendChild(this.root);
      window.addEventListener('keydown', this._onKey);
    }

    close() {
      this.root.remove();
      window.removeEventListener('keydown', this._onKey);
    }
  }
  //#endregion

  //#region Sort Generator Widget
  const forbiddenSort = ['sort', 'ick', 'qu'].reverse().join('');

  /**
   * Modular sorting logic blocks.
   * Each returns an array of { from, to } splice moves.
   */
  /** @type {Record<string, (arr: number[]) => { from: number, to: number }[]>} */
  const Algorithms = {
    insertion: (arr) => {
      const moves = [];
      const state = [...arr];
      for (let i = 1; i < state.length; i++) {
        let j = i;
        while (j > 0 && state[j - 1] > state[i]) {
          j--;
        }
        if (j !== i) {
          moves.push({ from: i, to: j });
          const [val] = state.splice(i, 1);
          state.splice(j, 0, val);
        }
      }
      return moves;
    },

    [forbiddenSort]: (arr) => {
      /** @type {{ from: number, to: number }[]} */
      const moves = [];
      const state = [...arr];

      // Drag-and-Drop (Splice) adapted Qu###Sort
      /**
       * @param {number} low 
       * @param {number} high 
       */
      const sort = (low, high) => {
        if (low < high) {
          const pi = partition(low, high);
          sort(low, pi - 1);
          sort(pi + 1, high);
        }
      };

      /**
       * @param {number} low 
       * @param {number} high 
       */
      const partition = (low, high) => {
        const pivot = state[high];
        let i = low; // The destination index for elements smaller than pivot

        for (let j = low; j < high; j++) {
          if (state[j] < pivot) {
            // Only move if it's not already in the correct position
            if (i !== j) {
              moves.push({ from: j, to: i });
              const [val] = state.splice(j, 1);
              state.splice(i, 0, val);
            }
            i++;
          }
        }

        // Finally, move the pivot to its correct sorted index (i)
        if (i !== high) {
          moves.push({ from: high, to: i });
          const [val] = state.splice(high, 1);
          state.splice(i, 0, val);
        }

        return i;
      };

      sort(0, state.length - 1);
      return moves;
    },

    lis: (arr) => {
      // 1. Setup state with object references to handle potential duplicates safely
      // and match the bot's expected {v: number} structure.
      const state = arr.map(v => ({ v }));
      const n = state.length;
      if (n === 0) return [];

      // 2. Identify Anchors via LIS (Rightmost/Latest LIS for stability)
      const dp = new Array(n).fill(1);
      const parent = new Array(n).fill(-1);

      for (let i = 0; i < n; i++) {
        for (let j = 0; j < i; j++) {
          if (state[j].v <= state[i].v && dp[i] < dp[j] + 1) {
            dp[i] = dp[j] + 1;
            parent[i] = j;
          }
        }
      }

      let maxIdx = 0;
      for (let i = 1; i < n; i++) {
        if (dp[i] >= dp[maxIdx]) maxIdx = i;
      }

      const anchorsSet = new Set();
      let currIdx = maxIdx;
      while (currIdx !== -1) {
        anchorsSet.add(state[currIdx]);
        currIdx = parent[currIdx];
      }

      // 3. Determine target sorting order for the non-anchors
      const sortedTarget = [...state].sort((a, b) => a.v - b.v);
      const nonAnchors = sortedTarget.filter(el => !anchorsSet.has(el));

      /** @type {{from: number, to: number}[]} */
      const moves = [];

      // Helper: Find where an object SHOULD go based on current array state
      /**
       * @param {{v: number}} targetObj
       */
      const getToIdx = (targetObj) => {
        let toIdx = 0;
        const targetFinalRank = sortedTarget.indexOf(targetObj);
        for (let j = 0; j < targetFinalRank; j++) {
          const neighbor = sortedTarget[j];
          const neighborIdx = state.indexOf(neighbor);
          if (neighborIdx >= toIdx) toIdx = neighborIdx + 1;
        }
        return toIdx;
      };

      // Helper: Execute move, record indices for the Replay UI, and mutate state
      /**
       * @param {{v: number}} fromObj
       * @param {number} rawToIdx
       */
      const applyMove = (fromObj, rawToIdx) => {
        const fromIdx = state.indexOf(fromObj);
        const actualToIdx = fromIdx < rawToIdx ? rawToIdx - 1 : rawToIdx;

        if (actualToIdx === fromIdx) return;

        // Record the index-based move
        moves.push({ from: fromIdx, to: actualToIdx });

        // Mutate the running state to simulate the drag-and-drop
        state.splice(fromIdx, 1);
        state.splice(actualToIdx, 0, fromObj);
      };

      // 4. Process all steps sequentially
      for (const targetObj of nonAnchors) {
        let toIdx = getToIdx(targetObj);
        let fromIdx = state.indexOf(targetObj);

        if (fromIdx === toIdx) continue;

        // Standard move
        applyMove(targetObj, toIdx);
      }

      return moves;
    }
  };

  class SortGenerationWidget extends Widget {
    /**
     * @param {(recording: SwapRecording) => void} callback
     */
    constructor(callback) {
      let selectedAlgo = forbiddenSort;
      let delay = 450;
      let seed = '';
      /** @type {Set<string>} */
      let errs = new Set();

      super({
        title: 'Generate Sort',
        sub: 'Generate a match recording using sorting algorithms.',

        content: (root, widget) => {
          // === Algorithm Selection ===
          const grid = document.createElement('div');
          grid.className = 'w-grid-2';

          /**
           * @param {string} algo
           * @param {string} title
           * @param {string} desc
           */
          const makeBtn = (algo, title, desc, span2 = false) => {
            const btn = document.createElement('div');
            btn.className = 'w-option';
            if (algo === selectedAlgo) btn.classList.add('is-selected');
            if (span2) btn.style.gridColumn = 'span 2';

            btn.innerHTML = `
            <div class="w-option-title">${title}</div>
            <div class="w-option-sub">${desc}</div>
          `;

            btn.onclick = () => {
              selectedAlgo = algo;
              [...grid.children].forEach(b => b.classList.remove('is-selected'));
              btn.classList.add('is-selected');
            };

            return btn;
          };

          grid.appendChild(makeBtn(forbiddenSort, 'Q' + forbiddenSort.slice(1), 'Erratic partitions'));
          grid.appendChild(makeBtn('insertion', 'Insertion Sort', 'Linear scanning'));
          grid.appendChild(makeBtn('lis', 'LIS Sort', 'Mathematically perfect efficiency', true));

          root.appendChild(grid);

          // === Delay Input ===
          const delayLabel = document.createElement('label');
          delayLabel.className = 'w-label';
          delayLabel.textContent = 'Delay (ms between moves)';

          const delayInput = document.createElement('input');
          delayInput.className = 'w-input';
          delayInput.type = 'number';
          delayInput.value = '450';
          delayInput.min = '50';
          delayInput.step = '50';

          const delayErr = document.createElement('div');
          delayErr.className = 'w-sub';
          delayErr.style.color = '#b8432e';
          delayErr.style.display = 'none';
          delayErr.textContent = 'Delay must be a positive integer or zero.';

          delayInput.oninput = () => {
            delay = parseInt(delayInput.value, 10);
            if (isNaN(delay) || delay < 0) {
              errs.add('delayInput');
              widget.updateAction('Generate Replay');
              delayInput.style.borderColor = '#b8432e';
              delayErr.style.display = 'block';
            } else {
              errs.delete('delayInput');
              widget.updateAction('Generate Replay');
              delayInput.style.borderColor = '';
              delayErr.style.display = 'none';
            }
          };

          root.appendChild(delayLabel);
          root.appendChild(delayInput);
          root.appendChild(delayErr);

          // === Seed Input ===
          const seedLabel = document.createElement('label');
          seedLabel.className = 'w-label';
          seedLabel.textContent = 'Custom Seed';

          const seedInput = document.createElement('input');
          seedInput.className = 'w-input';
          seedInput.placeholder = '50, 12, 85, 33...';

          const seedErr = document.createElement('div');
          seedErr.className = 'w-sub';
          seedErr.style.color = '#b8432e';
          seedErr.style.display = 'none';
          seedErr.textContent = 'Seed must contain only integers greater than or equal to zero.';

          seedInput.oninput = () => {
            seed = seedInput.value.trim();

            if (!seed) {
              errs.delete('seedInput');
              widget.updateAction('Generate Replay');
              seedInput.style.borderColor = '';
              seedErr.style.display = 'none';
              return;
            }

            const hasNaN = seed
              .split(',')
              .filter(n => n.trim())
              .map(n => parseInt(n.trim(), 10))
              .some(n => isNaN(n) || n < 0);

            if (hasNaN) {
              errs.add('seedInput');
              widget.updateAction('Generate Replay');
              seedInput.style.borderColor = '#b8432e';
              seedErr.style.display = 'block';
            } else {
              errs.delete('seedInput');
              widget.updateAction('Generate Replay');
              seedInput.style.borderColor = 'var(--accent)';
              seedErr.style.display = 'none';
            }
          };

          root.appendChild(seedLabel);
          root.appendChild(seedInput);
          root.appendChild(seedErr);
        },

        actions: [
          {
            label: 'Cancel',
            onClick: w => w.close()
          },
          {
            label: 'Generate Replay',
            primary: true,
            disabled: () => !!errs.size,
            onClick: (w) => {
              /** @type {number[]} */
              let startOrder = seed
                .split(',')
                .filter(n => n.trim())
                .map(n => parseInt(n.trim(), 10));

              if (!startOrder.length) {
                startOrder = this._generateRandomSeed(12);
              }

              const moveSequence = Algorithms[selectedAlgo](startOrder);

              /** @type {RecordedEvent[]} */
              const events = [];
              let currentTime = moveSequence.length > 0 ? delay : 0;
              let currentState = [...startOrder];

              /** @type {OpponentEvent[]} */
              const opponent = [];
              let oppState = [...startOrder];

              const maxVal = Math.max(...startOrder);
              /** @type {[x: number, y: number]} */
              let currentCursor = [0.5, 0.5];

              const fidelity = 120 / 1000;
              let moveCount = 0;

              for (const move of moveSequence) {
                const targetVal = currentState[move.from];

                const pickup = this._getBarHotspot(move.from, targetVal, maxVal, currentState.length);
                const hoverDuration = delay * 0.3;

                events.push(...this._synthesizeMousePath(currentCursor, pickup, currentTime, hoverDuration, hoverDuration * fidelity, true));
                currentTime += hoverDuration;
                currentCursor = pickup;

                events.push({ t: currentTime, d: move.from, c: 1 });

                const drop = this._getBarHotspot(move.to, targetVal, maxVal, currentState.length);
                const dragDuration = delay * 0.5;

                events.push(...this._synthesizeMousePath(currentCursor, drop, currentTime, dragDuration, dragDuration * fidelity, true));
                currentTime += dragDuration;
                currentCursor = drop;

                events.push({ t: currentTime, u: move.to, c: 1 });

                const [val] = currentState.splice(move.from, 1);
                currentState.splice(move.to, 0, val);

                const [el] = oppState.splice(move.from, 1);
                oppState.splice(move.to, 0, el);

                opponent.push({
                  t: currentTime,
                  o: oppState.slice(),
                  n: ++moveCount
                });

                currentTime += delay * 0.2;
              }

              let nameClass = 'name-bronze';
              if (currentTime < 6000) nameClass = 'name-champion';
              else if (currentTime < 8000) nameClass = 'name-grandmaster';
              else if (currentTime < 10000) nameClass = 'name-master';
              else if (currentTime < 12000) nameClass = 'name-diamond';
              else if (currentTime < 14000) nameClass = 'name-platinum';
              else if (currentTime < 16000) nameClass = 'name-gold';
              else if (currentTime < 18000) nameClass = 'name-silver';

              const recording = {
                startOrder: [...startOrder],
                opponentStartOrder: [...startOrder],
                events,
                opponent,
                playerName: `${selectedAlgo} ${delay}ms`,
                playerNameClass: nameClass,
                opponentName: `${selectedAlgo} ${delay}ms`,
                opponentNameClass: nameClass,
                playerElo: null,
                opponentElo: null,
                matchLength: currentTime
              };

              callback(recording);
              w.close();
            }
          }
        ]
      });
    }

    /**
     * @param {number} length 
     * @returns {number[]}
     */
    _generateRandomSeed(length) {
      const baseMin = 5;
      const baseMax = 100;

      // Scale factor
      const scale = Math.ceil(length / (baseMax - baseMin));

      const min = baseMin * scale;
      const max = baseMax * scale;

      const set = new Set();
      const arr = [];

      while (arr.length < length) {
        const v = Math.floor(Math.random() * (max - min)) + min;

        if (!set.has(v)) {
          set.add(v);
          arr.push(v);
        }
      }

      return arr;
    }

    /**
     * @param {number} index
     * @param {number} val
     * @param {number} maxVal
     * @param {number} totalBars
     * @returns {[x: number, y: number]}
     */
    _getBarHotspot(index, val, maxVal, totalBars) {
      const W = 300;
      const gap = 8;
      const barWidth = Math.max(12, (W - gap * (totalBars - 1)) / totalBars);
      const step = barWidth + gap;

      const minX = (index * step) / W;
      const maxX = (index * step + barWidth) / W;

      const padX = (barWidth * 0.2) / W;
      const safeMinX = minX + padX;
      const safeMaxX = maxX - padX;

      const heightPercent = val / maxVal;
      const paddingY = heightPercent * 0.2;

      const minY = 1 - heightPercent + paddingY;
      const maxY = 1 - paddingY;

      return [
        safeMinX + Math.random() * (safeMaxX - safeMinX),
        minY + Math.random() * (maxY - minY)
      ];
    }

    /**
     * 
     * @param {[x: number, y: number]} start
     * @param {[x: number, y: number]} end
     * @param {number} startTime
     * @param {number} duration
     * @param {number} steps
     * @param {boolean} isCursor
     * @returns {RecordedMoveEvent[]}
     */
    _synthesizeMousePath(start, end, startTime, duration, steps, isCursor) {
      /** @type {RecordedMoveEvent[]} */
      const path = [];
      const timeStep = duration / steps;

      for (let i = 1; i <= steps; i++) {
        const p = i / steps;
        path.push({
          t: Math.floor(startTime + timeStep * i),
          m: [
            start[0] + (end[0] - start[0]) * p,
            start[1] + (end[1] - start[1]) * p
          ],
          c: isCursor ? 1 : 0
        });
      }

      return path;
    }
  }
  //#endregion

  //#region Solo Sort Widget
  class SoloSortWidget extends Widget {
    /**
     * @param {(recording: SwapRecording, save: boolean) => void} callback
     */
    constructor(callback) {
      let mode = 'random';
      let count = 12;
      let seed = '';
      /** @type {Set<string>} */
      let errs = new Set();

      // Helper to build recording (so we don't duplicate logic)
      /** @returns {SwapRecording} */
      const buildRecording = () => {
        /** @type {number[]} */
        let startOrder;

        if (mode === 'seed') {
          startOrder = seed
            .split(',')
            .filter(x => x.trim())
            .map(x => parseInt(x.trim(), 10));
        } else {
          startOrder = this._generateRandomSeed(count);
        }

        return {
          startOrder: [...startOrder],
          opponentStartOrder: [...startOrder],
          events: [],
          opponent: [],
          playerName: `solo (${startOrder.length})`,
          playerNameClass: null,
          opponentName: `solo (${startOrder.length})`,
          opponentNameClass: null,
          playerElo: null,
          opponentElo: null,
          matchLength: 0
        };
      };

      super({
        title: 'Solo Sort',
        sub: 'Play on a board without an opponent.',

        content: (root, widget) => {
          // === Mode selection ===
          const grid = document.createElement('div');
          grid.className = 'w-grid-2';

          /**
           * @param {string} id
           * @param {string} title
           * @param {string} desc
           * @param {() => void} cb
           */
          const make = (id, title, desc, cb) => {
            const el = document.createElement('div');
            el.className = 'w-option';
            if (mode === id) el.classList.add('is-selected');

            el.innerHTML = `
              <div class="w-option-title">${title}</div>
              <div class="w-option-sub">${desc}</div>
            `;

            el.onclick = () => {
              mode = id;
              [...grid.children].forEach(x => x.classList.remove('is-selected'));
              el.classList.add('is-selected');
              cb();
            };

            return el;
          };

          grid.appendChild(make('random', 'Random', 'Generate N random values',
            () => {
              countGroup.style.display = 'contents';
              seedGroup.style.display = 'none';
              widget.updateAction('Save');
              widget.updateAction('Start');
            }
          ));
          grid.appendChild(make('seed', 'Seed', 'Use exact values',
            () => {
              countGroup.style.display = 'none';
              seedGroup.style.display = 'contents';
              widget.updateAction('Save');
              widget.updateAction('Start');
            }
          ));

          root.appendChild(grid);

          // === Count input ===
          const countLabel = document.createElement('label');
          countLabel.className = 'w-label';
          countLabel.textContent = 'Number of Bars';

          const countInput = document.createElement('input');
          countInput.className = 'w-input';
          countInput.type = 'number';
          countInput.value = '12';
          countInput.min = '1';
          countInput.max = '200';

          const countErr = document.createElement('div');
          countErr.className = 'w-sub';
          countErr.style.color = '#b8432e';
          countErr.style.display = 'none';
          countErr.textContent = 'Must be a positive integer.';

          countInput.oninput = () => {
            count = parseInt(countInput.value, 10);

            if (isNaN(count) || count <= 0) {
              errs.add('random');
              countInput.style.borderColor = '#b8432e';
              countErr.style.display = 'block';
            } else {
              errs.delete('random');
              countInput.style.borderColor = '';
              countErr.style.display = 'none';
            }

            widget.updateAction('Save');
            widget.updateAction('Start');
          };

          const countGroup = document.createElement('div');
          countGroup.style.display = 'contents';
          countGroup.appendChild(countLabel);
          countGroup.appendChild(countInput);
          countGroup.appendChild(countErr);
          root.appendChild(countGroup);

          // === Seed input ===
          const seedLabel = document.createElement('label');
          seedLabel.className = 'w-label';
          seedLabel.textContent = 'Custom Seed';

          const seedInput = document.createElement('input');
          seedInput.className = 'w-input';
          seedInput.placeholder = '50, 12, 85, 33...';

          const seedErr = document.createElement('div');
          seedErr.className = 'w-sub';
          seedErr.style.color = '#b8432e';
          seedErr.style.display = 'none';
          seedErr.textContent = 'Seed must contain only integers greater than or equal to zero.';

          seedInput.oninput = () => {
            seed = seedInput.value.trim();

            if (!seed) {
              errs.delete('seed');
              seedInput.style.borderColor = '';
              seedErr.style.display = 'none';
              widget.updateAction('Save');
              widget.updateAction('Start');
              return;
            }

            const parsed = seed
              .split(',')
              .filter(x => x.trim())
              .map(x => parseInt(x.trim(), 10));

            if (parsed.some(n => isNaN(n) || n < 0)) {
              errs.add('seed');
              seedInput.style.borderColor = '#b8432e';
              seedErr.style.display = 'block';
            } else {
              errs.delete('seed');
              seedInput.style.borderColor = 'var(--accent)';
              seedErr.style.display = 'none';
            }

            widget.updateAction('Save');
            widget.updateAction('Start');
          };

          const seedGroup = document.createElement('div');
          seedGroup.style.display = 'none';
          seedGroup.appendChild(seedLabel);
          seedGroup.appendChild(seedInput);
          seedGroup.appendChild(seedErr);
          root.appendChild(seedGroup);
        },

        actions: [
          {
            label: 'Cancel',
            onClick: w => w.close()
          },
          {
            label: 'Save',
            disabled: () => errs.has(mode),
            onClick: (w) => {
              const recording = buildRecording();
              callback(recording, true); // ← save = true
              w.close();
            }
          },
          {
            label: 'Start',
            primary: true,
            disabled: () => errs.has(mode),
            onClick: (w) => {
              const recording = buildRecording();
              callback(recording, false); // ← save = false
              w.close();
            }
          }
        ]
      });
    }

    /**
     * @param {number} length 
     * @returns {number[]}
     */
    _generateRandomSeed(length) {
      const baseMin = 5;
      const baseMax = 100;

      // Scale factor
      const scale = Math.ceil(length / (baseMax - baseMin));

      const min = baseMin * scale;
      const max = baseMax * scale;

      const set = new Set();
      const arr = [];

      while (arr.length < length) {
        const v = Math.floor(Math.random() * (max - min)) + min;

        if (!set.has(v)) {
          set.add(v);
          arr.push(v);
        }
      }

      return arr;
    }
  }
  //#endregion

  //#region Lineage Widget
  class LineageWidget extends Widget {
    /**
     * @param {ReplayEntry} entry
     * @param {(id: string) => void} onSelect
     */
    constructor(entry, onSelect) {
      super({
        title: 'Lineage',
        sub: 'Replay history and transformations.',

        content: (root, widget) => {
          const list = document.createElement('div');
          list.className = 'rc-list';

          if (!entry.lineage.length) {
            const empty = document.createElement('div');
            empty.className = 'rc-empty';
            empty.textContent = 'No lineage data';
            list.appendChild(empty);
          } else {
            entry.lineage.forEach((l, i, lineage) => {
              const isCurrent = i === lineage.length - 1;
              const item = this._createItem(l, isCurrent, widget, onSelect);
              list.prepend(item);
            });
          }

          root.appendChild(list);
        },

        actions: [
          {
            label: 'Close',
            primary: true,
            onClick: w => w.close()
          }
        ]
      });
    }

    /**
     * @param {ReplayLineageEntry} l
     * @param {boolean} isCurrent
     * @param {Widget} widget
     * @param {(id: string) => void} onSelect
     */
    _createItem(l, isCurrent, widget, onSelect) {
      const el = document.createElement('div');
      el.className = 'rc-item';

      if (isCurrent) el.classList.add('is-selected');

      const time = new Date(l.ts);

      const resultLabel = ['?', 'W', 'L'][l.result];
      const resultClass = ['is-unknown', 'is-win', 'is-loss'][l.result];

      const opponentClass = l.opponentNameClass || '';
      const playerClass = l.playerNameClass || '';

      const elo = l.opponentElo;

      const eloHtml = elo != null
        ? `<span class="rc-elo">${elo}</span>`
        : '';

      const pelo = l.playerElo;

      const peloHtml = pelo != null
        ? `<span class="rc-elo">${pelo}</span>`
        : '';

      el.innerHTML = `
        <div class="rc-item-main">
          <span class="rc-player ${playerClass} ${svClass}">
            ${l.playerName}
            ${peloHtml}
          </span>
          <span class="rc-right">
            vs.
          </span>
        </div>
        <div class="rc-item-main">
          <span class="rc-opponent ${opponentClass} ${svClass}">
            ${l.opponentName}
            ${eloHtml}
          </span>
          <span class="rc-result ${resultClass}">
            ${resultLabel}
          </span>
        </div>
        <div class="rc-item-sub">
          <span class="rc-time"
                data-ts="${time.getTime()}"
                title="${time.toLocaleString()}">
            ${formatTime(time)}
          </span>
          <span class="rc-duration">
            ${formatDuration(l.matchLength)}
          </span>
        </div>
        <div class="rc-item-sub">
          <span class="rc-type">${l.type}</span>
          ${l.id && !isCurrent ? `<button class="rc-select-btn">select</button>` : ''}
        </div>
      `;

      // attach click handler for select button
      /** @type {HTMLButtonElement | null} */
      const btn = el.querySelector('.rc-select-btn');
      if (btn) {
        btn.onclick = (e) => {
          e.stopPropagation();
          onSelect(l.id);
          widget.close();
        };
      }

      return el;
    }
  }
  //#endregion

  /** @type {any} */
  // @ts-ignore
  const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  w.replayController = new ReplayController();
})();
