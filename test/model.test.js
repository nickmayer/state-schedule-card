import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAYS,
  parseTime,
  formatTime,
  emptyGrid,
  helpersToGrid,
  gridToHelperDays,
  helperName,
  buildApplyAutomation,
  optionAt,
  rowOffset,
  overrideActive,
  formatDevices,
  formatMeasurement,
  StateScheduleCard,
} from '../dist/state-schedule-card.js';

const STEP = 30;
const paint = (grid, day, fromH, toH, option) => {
  const d = DAYS.indexOf(day);
  for (let r = (fromH * 60) / STEP; r < (toH * 60) / STEP; r++) grid[d][r] = option;
};

test('time helpers', () => {
  assert.equal(parseTime('23:30:00'), 1410);
  assert.equal(formatTime(1410), '23:30:00');
  assert.equal(formatTime(1440), '24:00:00');
});

// What the schedule helper API returns, built from the blocks of the grid
const asHelpers = (grid, options) => options.map((option) => ({ option, config: { name: option, ...gridToHelperDays(grid, option, STEP) } }));

test('a block that runs to midnight ends at 24:00:00', () => {
  const grid = emptyGrid(STEP, 'On');
  paint(grid, 'mon', 23.5, 24, 'Slowdown');
  assert.deepEqual(gridToHelperDays(grid, 'Slowdown', STEP).monday, [{ from: '23:30:00', to: '24:00:00' }]);
  assert.deepEqual(gridToHelperDays(grid, 'Slowdown', STEP).tuesday, []);
});

test('separate blocks of a state on a day are kept apart', () => {
  const grid = emptyGrid(STEP, 'On');
  paint(grid, 'wed', 0, 6, 'Off');
  paint(grid, 'wed', 12, 13, 'Off');
  assert.deepEqual(gridToHelperDays(grid, 'Off', STEP).wednesday, [
    { from: '00:00:00', to: '06:00:00' },
    { from: '12:00:00', to: '13:00:00' },
  ]);
});

test('round trip: grid -> schedule helpers -> grid is lossless', () => {
  const grid = emptyGrid(STEP, 'On');
  for (const d of DAYS) {
    paint(grid, d, 0, 6, 'Off');
    paint(grid, d, 23.5, 24, 'Slowdown');
  }
  // Friday night an hour later (spills into Saturday)
  paint(grid, 'fri', 23.5, 24, 'On');
  paint(grid, 'sat', 0, 0.5, 'On');
  paint(grid, 'sat', 0.5, 1, 'Slowdown');
  paint(grid, 'sat', 1, 6, 'Off');

  const back = helpersToGrid(asHelpers(grid, ['Slowdown', 'Off']), STEP, 'On');
  assert.deepEqual(back, grid);
});

test('time that no helper covers is the default state', () => {
  const grid = helpersToGrid([], STEP, 'On');
  assert.deepEqual(grid, emptyGrid(STEP, 'On'));
});

test('helper names depend on the entity and the state', () => {
  assert.equal(helperName('Internet Cole', 'Off'), 'Internet Cole schedule Off');
});

test('the automation applies the active helper and falls back to the default', () => {
  const automation = buildApplyAutomation({
    entity: 'input_select.internet_cole',
    title: 'Internet Cole',
    helpers: [
      { entity_id: 'schedule.internet_cole_schedule_slowdown', option: 'Slowdown' },
      { entity_id: 'schedule.internet_cole_schedule_off', option: 'Off' },
    ],
    defaultOption: 'On',
  });
  assert.equal(automation.mode, 'restart');
  assert.deepEqual(automation.triggers[0].entity_id, ['schedule.internet_cole_schedule_slowdown', 'schedule.internet_cole_schedule_off']);
  assert.ok(automation.triggers.some((t) => t.trigger === 'homeassistant'));
  const [wait, change] = automation.actions;
  assert.ok(wait.delay);
  assert.equal(change.action, 'input_select.select_option');
  assert.equal(change.target.entity_id, 'input_select.internet_cole');
  assert.ok(change.data.option.includes('namespace(option="On")'));
  assert.ok(change.data.option.includes('["schedule.internet_cole_schedule_off","Off"]'));
});

test('optionAt maps a Date to the right cell (Monday-first)', () => {
  const grid = emptyGrid(STEP, 'On');
  paint(grid, 'sun', 0, 1, 'Off');
  const sunday = new Date(2026, 9, 11, 0, 15); // Sun 2026-10-11 00:15
  assert.equal(optionAt(grid, STEP, sunday), 'Off');
  const monday = new Date(2026, 9, 12, 0, 15);
  assert.equal(optionAt(grid, STEP, monday), 'On');
});

test('overrideActive: only a non-"follow schedule" value counts', () => {
  assert.equal(overrideActive('Schedule', 'Schedule'), false);
  assert.equal(overrideActive('Off', 'Schedule'), true);
  assert.equal(overrideActive('unavailable', 'Schedule'), false);
  assert.equal(overrideActive(undefined, 'Schedule'), false);
});

test('visual editor form: schema, labels and nested override fields', () => {
  const form = StateScheduleCard.getConfigForm();
  const top = form.schema.map((f) => f.name);
  assert.deepEqual(top, ['entity', 'title', 'current', 'collapsed', 'devices', 'traffic', 'override', 'appearance']);

  const entity = form.schema.find((f) => f.name === 'entity');
  assert.equal(entity.required, true);
  assert.equal(form.computeLabel(entity), 'Scheduled entity');

  // the nested override.entity shares a name with the top-level one but needs its own label
  const override = form.schema.find((f) => f.name === 'override');
  assert.equal(override.type, 'expandable');
  const nested = override.schema.find((f) => f.name === 'entity');
  assert.equal(form.computeLabel(nested), 'Override entity');
  assert.notEqual(form.computeLabel(nested), form.computeLabel(entity));

  // flattened group keeps its keys at the top level of the config
  const appearance = form.schema.find((f) => f.name === 'appearance');
  assert.equal(appearance.flatten, true);
  assert.deepEqual(appearance.schema.map((f) => f.name), ['step', 'default_state', 'apply_now', 'row_height', 'name']);

  // every field has a label (no raw key names shown to the user)
  const all = [...form.schema, ...override.schema, ...appearance.schema];
  for (const f of all) assert.notEqual(form.computeLabel(f), f.name, `missing label for ${f.name}`);
});

test('formatDevices / formatMeasurement', () => {
  assert.equal(formatDevices('0'), '0 devices');
  assert.equal(formatDevices('1'), '1 device');
  assert.equal(formatDevices('7'), '7 devices');
  assert.equal(formatDevices('unavailable'), '–');
  assert.equal(formatDevices(undefined), '–');
  assert.equal(formatMeasurement('1.234', 'Mbps'), '1.2 Mbps');
  assert.equal(formatMeasurement('250.7', 'kB/s'), '251 kB/s');
  assert.equal(formatMeasurement('unknown', 'Mbps'), '–');
  assert.equal(formatMeasurement('3'), '3');
});

test('rowOffset places the current time in the grid', () => {
  assert.equal(rowOffset(new Date(2026, 9, 9, 0, 0, 0), 30), 0);
  assert.equal(rowOffset(new Date(2026, 9, 9, 6, 0, 0), 30), 12);
  assert.equal(rowOffset(new Date(2026, 9, 9, 23, 45, 0), 30), 47.5);
  assert.equal(rowOffset(new Date(2026, 9, 9, 12, 15, 30), 15), 49 + 30 / 60 / 15);
});
