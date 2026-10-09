/**
 * State Schedule Card
 * A weekly "paint the grid" editor for Home Assistant. Pick a state, drag across
 * the week, save. Every cell of the week always holds a state, so there is no
 * "unscheduled" gap: unpainted time is simply the default state.
 *
 * Works on top of the Scheduler integration (nielsfaber/scheduler-component):
 * the grid is converted into Scheduler entries that call
 * input_select.select_option / select.select_option on the configured entity.
 */

export const VERSION = '0.2.0';

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_MINUTES = 1440;
const PALETTE = ['#43a047', '#fb8c00', '#e53935', '#1e88e5', '#8e24aa', '#00acc1', '#6d4c41', '#7cb342'];

/* ------------------------------------------------------------------ *
 * Pure model helpers (no DOM, unit tested)
 * ------------------------------------------------------------------ */

export function expandWeekdays(weekdays) {
  const out = new Set();
  for (const w of weekdays || []) {
    if (w === 'daily') DAYS.forEach((d) => out.add(d));
    else if (w === 'workday') DAYS.slice(0, 5).forEach((d) => out.add(d));
    else if (w === 'weekend') DAYS.slice(5).forEach((d) => out.add(d));
    else if (DAYS.includes(w)) out.add(w);
  }
  return DAYS.filter((d) => out.has(d));
}

export function parseTime(str) {
  const [h, m] = String(str).trim().split(':').map(Number);
  return h * 60 + (m || 0);
}

export function formatTime(minutes) {
  const m = minutes % DAY_MINUTES;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}:00`;
}

export function emptyGrid(step, fill) {
  const rows = DAY_MINUTES / step;
  return DAYS.map(() => new Array(rows).fill(fill));
}

function optionOf(action) {
  if (!action) return undefined;
  const d = action.data || action.service_data || {};
  return d.option;
}

/**
 * Parse the attributes of Scheduler switch entities into a grid[day][row] of
 * option names. Unknown / missing time is filled with `defaultOption`.
 * Returns { grid, skipped } where skipped counts schedules that could not be read.
 */
export function schedulesToGrid(schedules, step, defaultOption) {
  const grid = emptyGrid(step, null);
  const rows = DAY_MINUTES / step;
  let skipped = 0;

  const fill = (dayIdx, from, to, option) => {
    const a = Math.ceil(from / step);
    const b = Math.ceil(to / step);
    for (let r = a; r < b && r < rows; r++) grid[dayIdx][r] = option;
  };

  for (const sched of schedules) {
    const slotsRaw = sched.timeslots || [];
    const actions = sched.actions || [];
    if (!slotsRaw.length || actions.length !== slotsRaw.length) {
      skipped++;
      continue;
    }
    const slots = slotsRaw.map((t, i) => {
      const parts = String(t).split(' - ');
      return {
        start: parseTime(parts[0]),
        stop: parts[1] !== undefined ? parseTime(parts[1]) : null,
        option: optionOf(actions[i]),
      };
    });
    if (slots.some((s) => s.option === undefined)) {
      skipped++;
      continue;
    }
    slots.sort((x, y) => x.start - y.start);
    const startOnly = slots.every((s) => s.stop === null);

    for (const day of expandWeekdays(sched.weekdays)) {
      const di = DAYS.indexOf(day);
      slots.forEach((s, i) => {
        let stop = s.stop;
        if (stop === null) stop = i + 1 < slots.length ? slots[i + 1].start : DAY_MINUTES;
        if (stop === 0 || stop === s.start) stop = DAY_MINUTES;
        if (stop > s.start) {
          fill(di, s.start, stop, s.option);
        } else {
          // overnight slot: runs to midnight and continues into the next day
          fill(di, s.start, DAY_MINUTES, s.option);
          fill((di + 1) % 7, 0, stop, s.option);
        }
      });
      if (startOnly) {
        // the last start-only slot keeps applying until the next day's first slot
        fill((di + 1) % 7, 0, slots[0].start, slots[slots.length - 1].option);
      }
    }
  }

  for (const col of grid) for (let r = 0; r < rows; r++) if (col[r] === null) col[r] = defaultOption;
  return { grid, skipped };
}

/** Merge a day column into contiguous blocks [{start, stop, option}] (minutes). */
export function columnToBlocks(col, step) {
  const blocks = [];
  col.forEach((option, r) => {
    const last = blocks[blocks.length - 1];
    if (last && last.option === option) last.stop = (r + 1) * step;
    else blocks.push({ start: r * step, stop: (r + 1) * step, option });
  });
  // Scheduler cannot take a single slot covering the whole day, so split it.
  if (blocks.length === 1) {
    const { option } = blocks[0];
    return [
      { start: 0, stop: DAY_MINUTES / 2, option },
      { start: DAY_MINUTES / 2, stop: DAY_MINUTES, option },
    ];
  }
  return blocks;
}

/**
 * Convert the grid into the minimal list of Scheduler schedules (identical days
 * are grouped into one schedule). Output is ready for scheduler.add.
 */
export function gridToSchedules(grid, { entity, step, baseName, service }) {
  const groups = new Map();
  grid.forEach((col, di) => {
    const blocks = columnToBlocks(col, step);
    const key = JSON.stringify(blocks);
    if (!groups.has(key)) groups.set(key, { days: [], blocks });
    groups.get(key).days.push(DAYS[di]);
  });
  let n = 0;
  return [...groups.values()].map(({ days, blocks }) => ({
    name: `${baseName} grid ${++n}`,
    weekdays: days.length === 7 ? ['daily'] : days,
    repeat_type: 'repeat',
    timeslots: blocks.map((b) => ({
      start: formatTime(b.start),
      stop: formatTime(b.stop),
      actions: [{ service, entity_id: entity, service_data: { option: b.option } }],
    })),
  }));
}

/** True when an override helper is set to something other than its "follow the schedule" option. */
export function overrideActive(overrideState, noneOption) {
  return !!overrideState && !['unknown', 'unavailable'].includes(overrideState) && overrideState !== noneOption;
}

export function optionAt(grid, step, date) {
  const di = (date.getDay() + 6) % 7;
  const row = Math.floor((date.getHours() * 60 + date.getMinutes()) / step);
  return grid[di][row];
}

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

const Base = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

class StateScheduleCard extends Base {
  constructor() {
    super();
    this._grid = null;
    this._saved = null; // JSON of the last loaded/saved grid
    this._active = null;
    this._painting = false;
    this._last = null;
    this._status = '';
    this._busy = false;
    this._loadedKey = null;
    this.attachShadow({ mode: 'open' });
  }

  static getStubConfig(hass) {
    const e = Object.keys(hass.states).find((k) => k.startsWith('input_select.'));
    return { entity: e || 'input_select.my_mode' };
  }

  setConfig(config) {
    if (!config || !config.entity || !/^(input_select|select)\./.test(config.entity)) {
      throw new Error('state-schedule-card: "entity" must be an input_select or select entity');
    }
    const step = Number(config.step || 30);
    if (![10, 15, 20, 30, 60].includes(step)) throw new Error('state-schedule-card: "step" must be 10, 15, 20, 30 or 60');
    const ov = config.override;
    if (ov && (!ov.entity || !/^(input_select|select)\./.test(ov.entity))) {
      throw new Error('state-schedule-card: "override.entity" must be an input_select or select entity');
    }
    if (ov && ov.sticky && !/^input_boolean\./.test(ov.sticky)) {
      throw new Error('state-schedule-card: "override.sticky" must be an input_boolean entity');
    }
    this._config = { apply_now: true, row_height: 14, collapsed: true, ...config, step };
    if (this._expanded === undefined) this._expanded = !this._config.collapsed;
    this._grid = null;
    this._loadedKey = null;
    this._render();
  }

  getCardSize() {
    return 12;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    const entity = hass.states[this._config.entity];
    if (!entity) {
      this._error = `Entity ${this._config.entity} not found`;
      this._render();
      return;
    }
    this._options = entity.attributes.options || [];
    const key = this._scheduleKey();
    if (!this._grid || (!this._dirty() && key !== this._loadedKey)) this._load(key);
    this._updateChip();
    this._updateOverride();
  }

  /* ---- override -------------------------------------------------- */

  get _ov() {
    const cfg = this._config.override;
    if (!cfg || !this._hass) return null;
    const ent = this._hass.states[cfg.entity];
    if (!ent) return null;
    const options = ent.attributes.options || [];
    const none = cfg.none_option && options.includes(cfg.none_option) ? cfg.none_option : options[0];
    const sticky = cfg.sticky ? this._hass.states[cfg.sticky] : null;
    return { entity: cfg.entity, options, none, state: ent.state, stickyEntity: cfg.sticky, sticky: sticky ? sticky.state === 'on' : false };
  }

  _setOverride(option) {
    const ov = this._ov;
    if (!ov) return;
    const domain = ov.entity.split('.')[0];
    this._hass.callService(domain, 'select_option', { entity_id: ov.entity, option });
  }

  _setSticky(on) {
    const ov = this._ov;
    if (!ov || !ov.stickyEntity) return;
    this._hass.callService('input_boolean', on ? 'turn_on' : 'turn_off', { entity_id: ov.stickyEntity });
  }

  _updateOverride() {
    const ov = this._ov;
    const root = this.shadowRoot;
    if (!ov) return;
    root.querySelectorAll('.ovbtn').forEach((b) => b.classList.toggle('active', b.dataset.opt === ov.state));
    const box = root.querySelector('#sticky');
    if (box) box.checked = ov.sticky;
    const hint = root.querySelector('.ovhint');
    if (hint) {
      hint.textContent = !overrideActive(ov.state, ov.none)
        ? 'Following the schedule.'
        : ov.sticky
          ? 'Overridden until you switch back to the schedule.'
          : 'Overridden until the schedule next changes.';
    }
  }

  /* ---- data ------------------------------------------------------ */

  _schedules() {
    const ent = this._config.entity;
    return Object.entries(this._hass.states)
      .filter(([id, s]) => id.startsWith('switch.') && s.attributes && Array.isArray(s.attributes.timeslots) && (s.attributes.entities || []).includes(ent))
      .map(([id, s]) => ({ id, ...s.attributes }));
  }

  _scheduleKey() {
    return JSON.stringify(this._schedules().map((s) => [s.id, s.weekdays, s.timeslots, s.actions]));
  }

  get _default() {
    const opts = this._options || [];
    return this._config.default_state && opts.includes(this._config.default_state) ? this._config.default_state : opts.includes('On') ? 'On' : opts[0];
  }

  _load(key) {
    const { grid, skipped } = schedulesToGrid(this._schedules(), this._config.step, this._default);
    this._grid = grid;
    this._saved = JSON.stringify(grid);
    this._loadedKey = key;
    if (!this._active || !this._options.includes(this._active)) this._active = this._options.find((o) => o !== this._default) || this._default;
    this._status = skipped ? `${skipped} schedule(s) for this entity could not be read and were ignored.` : '';
    this._render();
  }

  _dirty() {
    return !!this._grid && JSON.stringify(this._grid) !== this._saved;
  }

  _color(option) {
    const cfg = (this._config.states || {})[option];
    if (cfg && cfg.color) return cfg.color;
    if (option === 'On') return PALETTE[0];
    if (option === 'Slowdown') return PALETTE[1];
    if (option === 'Off') return PALETTE[2];
    return PALETTE[((this._options || []).indexOf(option) + 3) % PALETTE.length];
  }

  _label(option) {
    const cfg = (this._config.states || {})[option];
    return (cfg && cfg.label) || option;
  }

  /* ---- actions --------------------------------------------------- */

  async _save() {
    if (this._busy) return;
    const hass = this._hass;
    if (!hass.services.scheduler || !hass.services.scheduler.add) {
      this._setStatus('The Scheduler integration is not installed.', true);
      return;
    }
    this._busy = true;
    this._setStatus('Saving…');
    try {
      const domain = this._config.entity.split('.')[0];
      const base = this._config.name || (hass.states[this._config.entity].attributes.friendly_name || this._config.entity);
      const old = this._schedules().map((s) => s.id);
      const fresh = gridToSchedules(this._grid, { entity: this._config.entity, step: this._config.step, baseName: base, service: `${domain}.select_option` });
      for (const sched of fresh) await hass.callService('scheduler', 'add', sched);
      for (const id of old) await hass.callService('scheduler', 'remove', { entity_id: id });
      if (this._config.apply_now) {
        const now = optionAt(this._grid, this._config.step, new Date());
        if (hass.states[this._config.entity].state !== now) {
          await hass.callService(domain, 'select_option', { entity_id: this._config.entity, option: now });
        }
      }
      this._saved = JSON.stringify(this._grid);
      this._loadedKey = null; // reload from the new Scheduler entities when they appear
      this._setStatus('Saved.');
    } catch (err) {
      this._setStatus(`Save failed: ${err.message || err}`, true);
    } finally {
      this._busy = false;
      this._updateDirty();
    }
  }

  _revert() {
    this._load(this._scheduleKey());
  }

  _fillAll(option) {
    this._grid = emptyGrid(this._config.step, option);
    this._paintDom();
    this._updateDirty();
  }

  /* ---- painting -------------------------------------------------- */

  _paint(d, r) {
    if (this._grid[d][r] === this._active) return;
    this._grid[d][r] = this._active;
    const el = this.shadowRoot.querySelector(`.cell[data-d="${d}"][data-r="${r}"]`);
    if (el) el.style.background = this._color(this._active);
  }

  _paintDom() {
    this.shadowRoot.querySelectorAll('.cell').forEach((el) => {
      el.style.background = this._color(this._grid[+el.dataset.d][+el.dataset.r]);
    });
  }

  _cellAt(x, y) {
    const el = this.shadowRoot.elementFromPoint(x, y);
    return el && el.classList && el.classList.contains('cell') ? { d: +el.dataset.d, r: +el.dataset.r } : null;
  }

  _down(e) {
    const c = this._cellAt(e.clientX, e.clientY);
    if (!c) return;
    e.preventDefault();
    this._painting = true;
    this._last = c;
    e.currentTarget.setPointerCapture(e.pointerId);
    this._paint(c.d, c.r);
  }

  _move(e) {
    if (!this._painting) return;
    const c = this._cellAt(e.clientX, e.clientY);
    if (!c) return;
    if (this._last && this._last.d === c.d) {
      const [a, b] = this._last.r < c.r ? [this._last.r, c.r] : [c.r, this._last.r];
      for (let r = a; r <= b; r++) this._paint(c.d, r);
    } else {
      this._paint(c.d, c.r);
    }
    this._last = c;
  }

  _up() {
    if (!this._painting) return;
    this._painting = false;
    this._last = null;
    this._updateDirty();
  }

  /* ---- rendering ------------------------------------------------- */

  _setStatus(text, isError = false) {
    this._status = text;
    this._statusError = isError;
    const el = this.shadowRoot.querySelector('.status');
    if (el) {
      el.textContent = text;
      el.classList.toggle('error', isError);
    }
  }

  _updateDirty() {
    const dirty = this._dirty();
    const save = this.shadowRoot.querySelector('#save');
    const revert = this.shadowRoot.querySelector('#revert');
    if (save) save.disabled = !dirty || this._busy;
    if (revert) revert.disabled = !dirty || this._busy;
    if (dirty && !this._busy) this._setStatus('Unsaved changes');
    else if (!dirty && this._status === 'Unsaved changes') this._setStatus('');
  }

  _updateChip() {
    const chip = this.shadowRoot.querySelector('.chip');
    if (!chip || !this._hass) return;
    const currentEntity = this._hass.states[this._config.current || this._config.entity];
    const state = currentEntity ? currentEntity.state : 'unknown';
    const ov = this._ov;
    const overridden = ov && overrideActive(ov.state, ov.none);
    chip.textContent = `Now: ${this._label(state)}${overridden ? ' · override' : ''}`;
    chip.style.background = this._color(state);
  }

  _render() {
    const root = this.shadowRoot;
    if (this._error) {
      root.innerHTML = `<ha-card><div style="padding:16px">${this._error}</div></ha-card>`;
      return;
    }
    if (!this._grid) {
      root.innerHTML = '<ha-card><div style="padding:16px">Loading…</div></ha-card>';
      return;
    }
    const { step, row_height: rh } = this._config;
    const rows = DAY_MINUTES / step;
    const perHour = 60 / step;
    const title = this._config.title || (this._hass.states[this._config.entity].attributes.friendly_name || 'Schedule');

    const palette = this._options
      .map((o) => `<button class="swatch${o === this._active ? ' active' : ''}" data-opt="${o}" style="--c:${this._color(o)}">${this._label(o)}</button>`)
      .join('');

    const ov = this._ov;
    const overrideHtml = ov
      ? `<div class="override">
          <div class="ovrow"><span>Override:</span>${ov.options
            .map((o) => `<button class="ovbtn" data-opt="${o}" style="--c:${o === ov.none ? 'var(--primary-color)' : this._color(o)}">${o === ov.none ? 'Follow schedule' : this._label(o)}</button>`)
            .join('')}</div>
          ${ov.stickyEntity ? '<label class="ovsticky"><input type="checkbox" id="sticky"> Keep override until I switch back to the schedule</label>' : ''}
          <div class="ovhint"></div>
        </div>`
      : '';

    let body = '<div class="corner"></div>';
    DAY_LABELS.forEach((l, i) => (body += `<button class="dayhead" data-day="${i}" title="Fill the whole day">${l}</button>`));
    for (let r = 0; r < rows; r++) {
      const label = r % perHour === 0 ? this._hourLabel(r * step) : '';
      body += `<div class="time" style="height:${rh}px">${label}</div>`;
      for (let d = 0; d < 7; d++) {
        const hourStart = r % perHour === 0 ? ' hour' : '';
        body += `<div class="cell${hourStart}" data-d="${d}" data-r="${r}" style="height:${rh}px;background:${this._color(this._grid[d][r])}"></div>`;
      }
    }

    root.innerHTML = `
      <style>
        :host { display:block; }
        ha-card { padding:12px 12px 8px; }
        .top { display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; -webkit-user-select:none; }
        .top:focus-visible { outline:2px solid var(--primary-color); border-radius:6px; }
        .title { font-size:1.2em; font-weight:500; flex:1; }
        .chev { transition:transform .15s; color:var(--secondary-text-color); font-size:1.2em; }
        .chev.open { transform:rotate(180deg); }
        .content { margin-top:8px; }
        .content[hidden] { display:none; }
        .override { border:1px solid var(--divider-color); border-radius:8px; padding:8px; margin-bottom:10px; }
        .ovrow { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
        .ovrow span { font-size:.8em; color:var(--secondary-text-color); margin-right:2px; }
        .ovbtn { background:none; color:var(--primary-text-color); border:2px solid var(--c); border-radius:6px; padding:3px 10px; cursor:pointer; font:inherit; }
        .ovbtn.active { background:var(--c); color:#fff; }
        .ovsticky { display:flex; align-items:center; gap:6px; margin-top:8px; font-size:.9em; cursor:pointer; }
        .ovhint { margin-top:4px; font-size:.8em; color:var(--secondary-text-color); }
        .chip { color:#fff; border-radius:12px; padding:2px 10px; font-size:.85em; white-space:nowrap; }
        .palette { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; align-items:center; }
        .palette span { font-size:.8em; color:var(--secondary-text-color); margin-right:2px; }
        .swatch { background:var(--c); color:#fff; border:2px solid transparent; border-radius:6px; padding:4px 12px; cursor:pointer; font:inherit; opacity:.55; }
        .swatch.active { opacity:1; border-color:var(--primary-text-color); }
        .grid { display:grid; grid-template-columns:42px repeat(7, 1fr); gap:0 2px; touch-action:none; user-select:none; -webkit-user-select:none; }
        .dayhead { background:none; border:none; color:var(--primary-text-color); font:inherit; font-weight:500; cursor:pointer; padding:4px 0; }
        .time { font-size:.7em; color:var(--secondary-text-color); text-align:right; padding-right:4px; line-height:1; transform:translateY(-4px); }
        .cell { cursor:crosshair; box-sizing:border-box; border-top:1px solid transparent; }
        .cell.hour { border-top:1px solid rgba(255,255,255,.35); }
        .bar { display:flex; align-items:center; gap:8px; margin-top:10px; flex-wrap:wrap; }
        .bar button { font:inherit; border:1px solid var(--divider-color); background:var(--card-background-color); color:var(--primary-text-color); border-radius:6px; padding:6px 12px; cursor:pointer; }
        .bar button#save:not(:disabled) { background:var(--primary-color); color:var(--text-primary-color, #fff); border-color:var(--primary-color); }
        .bar button:disabled { opacity:.45; cursor:default; }
        .status { font-size:.85em; color:var(--secondary-text-color); flex:1; min-width:120px; }
        .status.error { color:var(--error-color, #db4437); }
      </style>
      <ha-card>
        <div class="top" role="button" tabindex="0" aria-expanded="${this._expanded}">
          <div class="title">${title}</div>
          <div class="chip"></div>
          <div class="chev${this._expanded ? ' open' : ''}">▾</div>
        </div>
        <div class="content"${this._expanded ? '' : ' hidden'}>
          ${overrideHtml}
          <div class="palette"><span>Paint:</span>${palette}</div>
          <div class="grid">${body}</div>
          <div class="bar">
            <button id="save" disabled>Save</button>
            <button id="revert" disabled>Revert</button>
            <button id="clear" title="Set the whole week to ${this._label(this._default)}">All ${this._label(this._default)}</button>
            <div class="status${this._statusError ? ' error' : ''}">${this._status || ''}</div>
          </div>
        </div>
      </ha-card>`;

    root.querySelectorAll('.swatch').forEach((b) =>
      b.addEventListener('click', () => {
        this._active = b.dataset.opt;
        root.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s === b));
      }),
    );
    root.querySelectorAll('.dayhead').forEach((b) =>
      b.addEventListener('click', () => {
        this._grid[+b.dataset.day].fill(this._active);
        this._paintDom();
        this._updateDirty();
      }),
    );
    const grid = root.querySelector('.grid');
    grid.addEventListener('pointerdown', (e) => this._down(e));
    grid.addEventListener('pointermove', (e) => this._move(e));
    grid.addEventListener('pointerup', () => this._up());
    grid.addEventListener('pointercancel', () => this._up());
    root.querySelector('#save').addEventListener('click', () => this._save());
    root.querySelector('#revert').addEventListener('click', () => this._revert());
    root.querySelector('#clear').addEventListener('click', () => this._fillAll(this._default));

    const top = root.querySelector('.top');
    const toggle = () => {
      this._expanded = !this._expanded;
      root.querySelector('.content').hidden = !this._expanded;
      root.querySelector('.chev').classList.toggle('open', this._expanded);
      top.setAttribute('aria-expanded', String(this._expanded));
    };
    top.addEventListener('click', toggle);
    top.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    root.querySelectorAll('.ovbtn').forEach((b) => b.addEventListener('click', () => this._setOverride(b.dataset.opt)));
    const box = root.querySelector('#sticky');
    if (box) box.addEventListener('change', () => this._setSticky(box.checked));

    this._updateChip();
    this._updateOverride();
    this._updateDirty();
  }

  _hourLabel(minutes) {
    const h = Math.floor(minutes / 60);
    if (h === 0) return '12 AM';
    if (h === 12) return '12 PM';
    return h < 12 ? `${h} AM` : `${h - 12} PM`;
  }
}

if (typeof customElements !== 'undefined') {
  if (!customElements.get('state-schedule-card')) customElements.define('state-schedule-card', StateScheduleCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'state-schedule-card',
    name: 'State Schedule Card',
    description: 'Paint a weekly schedule of states (input_select / select) on a Mon–Sun grid. Requires the Scheduler integration.',
    preview: false,
  });
  // eslint-disable-next-line no-console
  console.info(`%c STATE-SCHEDULE-CARD %c v${VERSION} `, 'color:#fff;background:#43a047;font-weight:700', 'color:#43a047;background:#fff');
}
