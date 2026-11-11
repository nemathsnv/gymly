/* mcp-remote/log-budget.js: at most 20 workouts logged through assistants in any hour, per
   profile. Only saves count, the hour slides, and one profile's saves are not another's. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogBudget, LOG_WORKOUT_LIMIT, LOG_WORKOUT_WINDOW_MS } from '../mcp-remote/log-budget.js';
const fakeClock = (t = 0) => ({ now: () => t, advance: ms => { t += ms; } });

test('20 saves an hour, upstream\'s number', () => {
  assert.equal(LOG_WORKOUT_LIMIT, 20);
  assert.equal(LOG_WORKOUT_WINDOW_MS, 3600000);
});

test('the 21st save in an hour waits until the oldest is an hour old; asking does not count', () => {
  const clock = fakeClock(1_000_000);
  const b = createLogBudget({ now: clock.now });
  for (let i = 0; i < 20; i++) {
    for (let k = 0; k < 3; k++) assert.equal(b.wait('u1'), 0, 'asking is free');
    b.spend('u1');
    clock.advance(60000);
  }
  // 20 saves, a minute apart; the first was 20 minutes ago.
  assert.equal(b.wait('u1'), 40 * 60);
  assert.equal(b.wait('u2'), 0, 'another profile has its own hour');
  clock.advance(40 * 60000 - 1000);
  assert.equal(b.wait('u1'), 1);
  clock.advance(1000);
  assert.equal(b.wait('u1'), 0, 'the hour slides: the first save has left it');
  b.spend('u1');
  assert.equal(b.wait('u1'), 60, 'and the next one leaves a minute later');
});

test('sweep forgets profiles whose saves are all over an hour old', () => {
  const clock = fakeClock(0);
  const b = createLogBudget({ now: clock.now });
  b.spend('a'); b.spend('b');
  clock.advance(LOG_WORKOUT_WINDOW_MS);
  b.spend('b');
  b.sweep();
  assert.equal(b.size, 1);
});
