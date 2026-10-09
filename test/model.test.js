import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAYS,
  expandWeekdays,
  parseTime,
  formatTime,
  emptyGrid,
  schedulesToGrid,
  columnToBlocks,
  gridToSchedules,
  optionAt,
  overrideActive,
} from '../dist/state-schedule-card.js';

const STEP = 30;
const paint = (grid, day, fromH, toH, option) => {
  const d = DAYS.indexOf(day);
  for (let r = (fromH * 60) / STEP; r < (toH * 60) / STEP; r++) grid[d][r] = option;
};

// Simulates how Scheduler exposes a schedule's attributes after scheduler.add
const toAttributes = (s) => ({
  weekdays: s.weekdays,
  timeslots: s.timeslots.map((t) => `${t.start} - ${t.stop}`),
  actions: s.timeslots.map((t) => ({ service: t.actions[0].service, data: { option: t.actions[0].service_data.option } })),
});

test('time helpers', () => {
  assert.equal(parseTime('23:30:00'), 1410);
  assert.equal(formatTime(1410), '23:30:00');
  assert.equal(formatTime(1440), '00:00:00');
});

test('expandWeekdays handles daily/workday/weekend', () => {
  assert.deepEqual(expandWeekdays(['daily']), DAYS);
  assert.deepEqual(expandWeekdays(['workday']), ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.deepEqual(expandWeekdays(['weekend']), ['sat', 'sun']);
  assert.deepEqual(expandWeekdays(['sun', 'mon']), ['mon', 'sun']);
});

test('a column of one state is split in two (Scheduler needs >1 slot)', () => {
  const col = new Array(48).fill('On');
  const blocks = columnToBlocks(col, STEP);
  assert.equal(blocks.length, 2);
  assert.deepEqual([blocks[0].start, blocks[0].stop, blocks[1].start, blocks[1].stop], [0, 720, 720, 1440]);
});

test('identical days are grouped into one schedule', () => {
  const grid = emptyGrid(STEP, 'On');
  const schedules = gridToSchedules(grid, { entity: 'input_select.x', step: STEP, baseName: 'X', service: 'input_select.select_option' });
  assert.equal(schedules.length, 1);
  assert.deepEqual(schedules[0].weekdays, ['daily']);
});

test('round trip: grid -> schedules -> grid is lossless', () => {
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

  const schedules = gridToSchedules(grid, { entity: 'input_select.x', step: STEP, baseName: 'X', service: 'input_select.select_option' });
  assert.ok(schedules.length >= 3);
  const back = schedulesToGrid(schedules.map(toAttributes), STEP, 'On');
  assert.equal(back.skipped, 0);
  assert.deepEqual(back.grid, grid);
});

test('start-only schedules (like the Scheduler card makes) are understood', () => {
  const { grid } = schedulesToGrid(
    [
      {
        weekdays: ['daily'],
        timeslots: ['00:00:00', '06:00:00', '23:30:00'],
        actions: [{ data: { option: 'Off' } }, { data: { option: 'On' } }, { data: { option: 'Slowdown' } }],
      },
    ],
    STEP,
    'On',
  );
  assert.equal(grid[0][0], 'Off');
  assert.equal(grid[0][11], 'Off');
  assert.equal(grid[0][12], 'On');
  assert.equal(grid[0][46], 'On'); // 23:00
  assert.equal(grid[0][47], 'Slowdown'); // 23:30
  assert.equal(grid[1][0], 'Off'); // next day's first slot starts at 00:00
});

test('overnight slot continues into the next day', () => {
  const { grid } = schedulesToGrid(
    [{ weekdays: ['fri'], timeslots: ['22:00:00 - 02:00:00'], actions: [{ data: { option: 'Off' } }] }],
    STEP,
    'On',
  );
  assert.equal(grid[DAYS.indexOf('fri')][44], 'Off');
  assert.equal(grid[DAYS.indexOf('sat')][3], 'Off');
  assert.equal(grid[DAYS.indexOf('sat')][4], 'On');
});

test('unreadable schedules are skipped, not fatal', () => {
  const { grid, skipped } = schedulesToGrid([{ weekdays: ['mon'], timeslots: ['00:00:00 - 12:00:00'], actions: [] }], STEP, 'On');
  assert.equal(skipped, 1);
  assert.equal(grid[0][0], 'On');
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
