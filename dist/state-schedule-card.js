/**
 * State Schedule Card
 * A weekly "paint the grid" editor for Home Assistant. Pick a state, drag across
 * the week, save. Every cell of the week always holds a state, so there is no
 * "unscheduled" gap: unpainted time is simply the default state.
 *
 * Needs nothing but Home Assistant itself: the time of every state except the default
 * is kept in a built-in `schedule` helper, and an automation that the card creates
 * copies the helpers to the input_select / select entity.
 */

export const VERSION = '0.7.0';

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_MINUTES = 1440;
const PALETTE = ['#43a047', '#fb8c00', '#e53935', '#1e88e5', '#8e24aa', '#00acc1', '#6d4c41', '#7cb342'];

/* ------------------------------------------------------------------ *
 * Pure model helpers (no DOM, unit tested)
 * ------------------------------------------------------------------ */

const HELPER_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export function parseTime(str) {
  const [h, m] = String(str).trim().split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Minutes since midnight as HH:MM:SS; the end of the day is 24:00:00, as schedule helpers expect. */
export function formatTime(minutes) {
  if (minutes >= DAY_MINUTES) return '24:00:00';
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}:00`;
}

export function emptyGrid(step, fill) {
  const rows = DAY_MINUTES / step;
  return DAYS.map(() => new Array(rows).fill(fill));
}

/**
 * Name of the schedule helper that holds the time of one state. The card finds its
 * helpers by this name, so the states of different entities do not mix.
 */
export function helperName(base, option) {
  return `${base} schedule ${option}`;
}

/**
 * Build the grid[day][row] of state names from schedule helpers.
 * helpers: [{ option, config }] where config is an item of schedule/list.
 * Time that no helper covers is the default state.
 */
export function helpersToGrid(helpers, step, defaultOption) {
  const grid = emptyGrid(step, defaultOption);
  const rows = DAY_MINUTES / step;
  for (const { option, config } of helpers) {
    HELPER_DAYS.forEach((day, di) => {
      for (const block of config[day] || []) {
        const from = Math.ceil(parseTime(block.from) / step);
        const to = Math.ceil(parseTime(block.to) / step);
        for (let r = from; r < to && r < rows; r++) grid[di][r] = option;
      }
    });
  }
  return grid;
}

/** The time of one state as the days of a schedule helper: { monday: [{from, to}], ... } */
export function gridToHelperDays(grid, option, step) {
  const days = {};
  HELPER_DAYS.forEach((day, di) => {
    const blocks = [];
    let start = null;
    grid[di].forEach((o, r) => {
      if (o === option) {
        if (start === null) start = r;
      } else if (start !== null) {
        blocks.push({ from: formatTime(start * step), to: formatTime(r * step) });
        start = null;
      }
    });
    if (start !== null) blocks.push({ from: formatTime(start * step), to: formatTime(DAY_MINUTES) });
    days[day] = blocks;
  });
  return days;
}

/**
 * Automation that copies the schedule helpers to the entity: the state whose helper is
 * on, or the default state when none is. It waits a moment so that two helpers that switch
 * at the same time (one block ends where the next begins) give one change, not two.
 */
export function buildApplyAutomation({ entity, title, helpers, defaultOption }) {
  const pairs = JSON.stringify(helpers.map((h) => [h.entity_id, h.option]));
  const template = `{% set ns = namespace(option=${JSON.stringify(defaultOption)}) %}{% for e, o in ${pairs} %}{% if is_state(e, 'on') %}{% set ns.option = o %}{% endif %}{% endfor %}{{ ns.option }}`;
  return {
    alias: `State schedule: ${title}`,
    description: `Created by the State Schedule Card. Sets ${entity} from its schedule helpers.`,
    mode: 'restart',
    triggers: [
      { trigger: 'state', entity_id: helpers.map((h) => h.entity_id) },
      { trigger: 'homeassistant', event: 'start' },
    ],
    conditions: [],
    actions: [
      { delay: { seconds: 2 } },
      { action: `${entity.split('.')[0]}.select_option`, target: { entity_id: entity }, data: { option: template } },
    ],
  };
}

/** "3 devices" / "1 device" / "–" for a count sensor state. */
export function formatDevices(state) {
  const n = Number(state);
  if (state === undefined || state === null || state === '' || Number.isNaN(n)) return '–';
  return `${n} ${n === 1 ? 'device' : 'devices'}`;
}

/** "1.5 Mbps" style text for a numeric sensor state + its unit. */
export function formatMeasurement(state, unit) {
  const n = Number(state);
  if (state === undefined || state === null || state === '' || Number.isNaN(n)) return '–';
  const v = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return unit ? `${v} ${unit}` : String(v);
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

/** Position of a time in the grid as a (fractional) number of rows from the top. */
export function rowOffset(date, step) {
  return (date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60) / step;
}

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

const Base = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

export class StateScheduleCard extends Base {
  constructor() {
    super();
    this._grid = null;
    this._saved = null; // JSON of the last loaded/saved grid
    this._active = null;
    this._painting = false;
    this._last = null;
    this._status = '';
    this._busy = false;
    this._loading = false;
    this.attachShadow({ mode: 'open' });
  }

  static getStubConfig(hass) {
    const e = Object.keys(hass.states).find((k) => k.startsWith('input_select.'));
    return { entity: e || 'input_select.my_mode' };
  }

  /** Schema for Home Assistant's built-in visual editor (ha-form). */
  static getConfigForm() {
    const info = new Map(); // field -> { label, help }
    const field = (name, selector, label, help, extra = {}) => {
      const f = { name, selector, ...extra };
      info.set(f, { label, help });
      return f;
    };
    const group = (name, title, schema, extra = {}) => {
      const g = { name, type: 'expandable', title, schema, ...extra };
      info.set(g, { label: title });
      return g;
    };
    const anySelect = { entity: { domain: ['input_select', 'select'] } };

    return {
      schema: [
        field('entity', anySelect, 'Scheduled entity', 'The input_select / select the schedule writes to. Its options are the states you can paint.', { required: true }),
        field('title', { text: {} }, 'Title'),
        field('current', anySelect, 'Entity shown as "Now"', 'Optional. The entity holding the state actually in effect. Defaults to the scheduled entity.'),
        field('collapsed', { boolean: {} }, 'Start collapsed', undefined, { default: true }),
        field('devices', { entity: { domain: 'sensor' } }, 'Device count sensor', 'Optional. A sensor whose state is a number of devices; shown on the top line.'),
        field('traffic', { entity: { domain: 'sensor' } }, 'Traffic sensor', 'Optional. A numeric sensor (for example a data rate); shown on the top line with its unit.'),
        group('override', 'Override', [
          field('entity', anySelect, 'Override entity', 'An input_select / select whose options are the "follow the schedule" option plus every state.'),
          field('sticky', { entity: { domain: 'input_boolean' } }, '"Keep override" checkbox entity', 'Optional input_boolean. When on, an override survives schedule changes.'),
          field('none_option', { text: {} }, '"Follow the schedule" option', 'The override option that means "no override". Defaults to the first option.'),
        ]),
        group(
          'appearance',
          'Appearance & behaviour',
          [
            field(
              'step',
              {
                select: {
                  mode: 'dropdown',
                  options: [
                    { value: '10', label: '10 minutes' },
                    { value: '15', label: '15 minutes' },
                    { value: '20', label: '20 minutes' },
                    { value: '30', label: '30 minutes (default)' },
                    { value: '60', label: '1 hour' },
                  ],
                },
              },
              'Grid resolution',
              undefined,
              { default: '30' },
            ),
            field('default_state', { text: {} }, 'Default state', 'State used for unpainted time. Defaults to "On" if the entity has it, else its first option.'),
            field('apply_now', { boolean: {} }, 'Apply the new schedule immediately after saving', undefined, { default: true }),
            field('row_height', { number: { min: 6, max: 40, mode: 'box' } }, 'Row height (px)', undefined, { default: 14 }),
            field('name', { text: {} }, 'Name for the schedule helpers', 'Base name for the schedule helpers the card creates. Defaults to the entity name.'),
          ],
          { flatten: true },
        ),
      ],
      computeLabel: (schema) => (info.get(schema) || {}).label || schema.name,
      computeHelper: (schema) => (info.get(schema) || {}).help,
    };
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
    this._loading = false;
    this._render();
  }

  connectedCallback() {
    this._placeNow();
    this._nowTimer = setInterval(() => this._placeNow(), 30000);
  }

  disconnectedCallback() {
    clearInterval(this._nowTimer);
    if (this._resizeObserver) this._resizeObserver.disconnect();
  }

  /** Move the blue "now" arrow and line to the current time. */
  _placeNow() {
    const root = this.shadowRoot;
    const arrow = root && root.querySelector('.nowarrow');
    const line = arrow && root.querySelector('.nowline');
    const head = line && root.querySelector('.dayhead');
    if (!head) return;
    const now = new Date();
    const cell = root.querySelector(`.cell[data-d="${(now.getDay() + 6) % 7}"][data-r="0"]`);
    if (!cell) return;
    const top = `${head.offsetHeight + rowOffset(now, this._config.step) * this._config.row_height}px`;
    arrow.style.top = top;
    arrow.style.left = `${cell.offsetLeft}px`;
    line.style.top = top;
    line.style.left = `${cell.offsetLeft}px`;
    line.style.width = `${cell.offsetWidth}px`;
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
    if (!this._grid && !this._loading) this._load();
    this._updateChip();
    this._updateMeta();
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

  get _default() {
    const opts = this._options || [];
    return this._config.default_state && opts.includes(this._config.default_state) ? this._config.default_state : opts.includes('On') ? 'On' : opts[0];
  }

  get _base() {
    return this._config.name || this._hass.states[this._config.entity].attributes.friendly_name || this._config.entity;
  }

  /** Schedule helpers of this entity: { items: [{ option, config }], error } */
  async _fetchHelpers() {
    const hass = this._hass;
    if (!hass.user || !hass.user.is_admin) {
      return { items: [], error: 'Only administrators can read and change the schedule helpers this card uses.' };
    }
    let list;
    try {
      list = await hass.callWS({ type: 'schedule/list' });
    } catch (err) {
      return { items: [], error: 'The Schedule helper is not available. Enable the built-in Schedule integration in Home Assistant.' };
    }
    const items = [];
    for (const option of this._options) {
      if (option === this._default) continue;
      const config = list.find((h) => h.name === helperName(this._base, option));
      if (config) items.push({ option, config });
    }
    return { items, error: '' };
  }

  async _load() {
    this._loading = true;
    try {
      const { items, error } = await this._fetchHelpers();
      this._grid = helpersToGrid(items, this._config.step, this._default);
      this._helperError = error;
      this._status = error;
      this._statusError = !!error;
    } finally {
      this._loading = false;
    }
    this._saved = JSON.stringify(this._grid);
    if (!this._active || !this._options.includes(this._active)) this._active = this._options.find((o) => o !== this._default) || this._default;
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
    const { error } = await this._fetchHelpers();
    if (error) {
      this._setStatus(error, true);
      return;
    }
    this._busy = true;
    this._setStatus('Saving…');
    try {
      const entity = this._config.entity;
      const step = this._config.step;
      const list = await hass.callWS({ type: 'schedule/list' });
      const helpers = [];
      for (const option of this._options) {
        if (option === this._default) continue;
        const name = helperName(this._base, option);
        const payload = { name, icon: 'mdi:calendar-clock', ...gridToHelperDays(this._grid, option, step) };
        const existing = list.find((h) => h.name === name);
        const saved = existing
          ? await hass.callWS({ type: 'schedule/update', schedule_id: existing.id, ...payload })
          : await hass.callWS({ type: 'schedule/create', ...payload });
        helpers.push({ entity_id: `schedule.${saved.id}`, option });
      }
      const automation = buildApplyAutomation({ entity, title: this._base, helpers, defaultOption: this._default });
      await hass.callApi('POST', `config/automation/config/state_schedule_${entity.replace('.', '_')}`, automation);
      if (this._config.apply_now) {
        const now = optionAt(this._grid, step, new Date());
        if (hass.states[entity].state !== now) {
          await hass.callService(entity.split('.')[0], 'select_option', { entity_id: entity, option: now });
        }
      }
      this._saved = JSON.stringify(this._grid);
      this._setStatus('Saved.');
    } catch (err) {
      this._setStatus(`Save failed: ${err.message || JSON.stringify(err)}`, true);
    } finally {
      this._busy = false;
      this._updateDirty();
    }
  }

  _revert() {
    this._load();
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

  _updateMeta() {
    const el = this.shadowRoot.querySelector('.meta');
    if (!el || !this._hass) return;
    const parts = [];
    const dev = this._config.devices && this._hass.states[this._config.devices];
    if (this._config.devices) parts.push(formatDevices(dev ? dev.state : undefined));
    const tr = this._config.traffic && this._hass.states[this._config.traffic];
    if (this._config.traffic) parts.push(formatMeasurement(tr ? tr.state : undefined, tr && tr.attributes.unit_of_measurement));
    el.textContent = parts.join(' · ');
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

    const dayHeads = DAY_LABELS.map((l, i) => `<button class="dayhead" data-day="${i}" title="Fill the whole day">${l}</button>`).join('');
    let body = `<div class="corner"></div>${dayHeads}<div class="corner"></div>`;
    for (let r = 0; r < rows; r++) {
      const label = r % perHour === 0 ? this._hourLabel(r * step) : '';
      body += `<div class="time" style="height:${rh}px">${label}</div>`;
      for (let d = 0; d < 7; d++) {
        const hourStart = r % perHour === 0 ? ' hour' : '';
        body += `<div class="cell${hourStart}" data-d="${d}" data-r="${r}" style="height:${rh}px;background:${this._color(this._grid[d][r])}"></div>`;
      }
      body += `<div class="time right" style="height:${rh}px">${label}</div>`;
    }
    body += `<div class="corner"></div>${dayHeads}<div class="corner"></div>`;

    root.innerHTML = `
      <style>
        :host { display:block; }
        ha-card { padding:12px 12px 8px; }
        .top { display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; -webkit-user-select:none; }
        .top:focus-visible { outline:2px solid var(--primary-color); border-radius:6px; }
        .title { font-size:1.2em; font-weight:500; flex:1; }
        .meta { font-size:.85em; color:var(--secondary-text-color); white-space:nowrap; }
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
        .grid { position:relative; display:grid; grid-template-columns:42px repeat(7, 1fr) 42px; gap:0 2px; touch-action:none; user-select:none; -webkit-user-select:none; }
        .nowline { position:absolute; height:0; border-top:2px solid #2196f3; pointer-events:none; z-index:2; }
        .nowarrow { position:absolute; width:0; height:0; margin-top:-5px; border-left:10px solid #2196f3; border-top:6px solid transparent; border-bottom:6px solid transparent; pointer-events:none; z-index:2; }
        .dayhead { background:none; border:none; color:var(--primary-text-color); font:inherit; font-weight:500; cursor:pointer; padding:4px 0; }
        .time { font-size:.7em; color:var(--secondary-text-color); text-align:right; padding-right:4px; line-height:1; transform:translateY(-4px); }
        .time.right { text-align:left; padding-right:0; padding-left:4px; }
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
          <div class="meta"></div>
          <div class="chip"></div>
          <div class="chev${this._expanded ? ' open' : ''}">▾</div>
        </div>
        <div class="content"${this._expanded ? '' : ' hidden'}>
          ${overrideHtml}
          <div class="palette"><span>Paint:</span>${palette}</div>
          <div class="grid">${body}<div class="nowarrow"></div><div class="nowline"></div></div>
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
    if (typeof ResizeObserver !== 'undefined') {
      if (this._resizeObserver) this._resizeObserver.disconnect();
      this._resizeObserver = new ResizeObserver(() => this._placeNow());
      this._resizeObserver.observe(grid);
    }
    root.querySelector('#save').addEventListener('click', () => this._save());
    root.querySelector('#revert').addEventListener('click', () => this._revert());
    root.querySelector('#clear').addEventListener('click', () => this._fillAll(this._default));

    const top = root.querySelector('.top');
    const toggle = () => {
      this._expanded = !this._expanded;
      root.querySelector('.content').hidden = !this._expanded;
      root.querySelector('.chev').classList.toggle('open', this._expanded);
      top.setAttribute('aria-expanded', String(this._expanded));
      this._placeNow();
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
    this._updateMeta();
    this._updateOverride();
    this._updateDirty();
    this._placeNow();
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
    description: 'Paint a weekly schedule of states (input_select / select) on a Mon–Sun grid.',
    preview: false,
  });
  // eslint-disable-next-line no-console
  console.info(`%c STATE-SCHEDULE-CARD %c v${VERSION} `, 'color:#fff;background:#43a047;font-weight:700', 'color:#43a047;background:#fff');
}
