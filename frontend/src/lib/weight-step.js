// The weight + and − buttons, and the equipment facts an exercise can carry for them.
//
// What a tap adds used to come from one of three places, and only one of them could be changed:
//   • the dumbbells you own (lib/dumbbells.js, issue #376), bell to bell;
//   • the routine slot's progression step (cfg.inc), editable only with a progression rule on;
//   • the default by body part (lib/exercises.js defaultIncrement): 5 kg for anything that
//     trains the legs, back or hips, so a dumbbell row went 10 → 15 with no way to say 12.5.
// And the tap itself snapped to that grid whenever the weight was within 0.1 of it, so with a
// 0.5 kg step 11.4 went up to 12 and came back down to 11.5.
//
// S.exEquip[exId] is the exercise's own equipment, per gym-floor reality rather than per plan:
//   { step: { kg?: 2.5, lb?: 5 }, pulley: '1:1' | '2:1' | '4:1' | null, _ts }
// `step` is what + and − add, kept per unit and never converted (like the plate and dumbbell
// inventories: a 2.5 kg stack plate is not a 5.5 lb one). Set, it wins over everything above;
// absent, the buttons step exactly as they did. `pulley` is a note on how the cable is rigged:
// you still log the number the machine shows, and nothing is recalculated from it. The entry is
// stamped like S.loadKind (lib/sync-merge.js STAMPED_MAPS), so the last change wins a sync and a
// cleared step stays cleared.
//
// Only the buttons read the step. Progression, deloads and warm-ups keep their own increment
// (lib/progression.js weightIncrement), and nothing here touches a logged set.

import { weightIncrement } from './progression.js'
import { ownedWeightsFor, stepOwned } from './dumbbells.js'
import { EXIDX } from './exercises.js'
import { t } from './i18n-core.js'
import { fmtPlate } from './format.js'

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)
const unitOf = S => (S?.unit === 'lb' ? 'lb' : 'kg')

/** The pulley ratios the editor offers. A label only: logged weights stay what the machine shows. */
export const PULLEYS = ['1:1', '2:1', '4:1']
/** Steps one tap away in the editor, per unit. Anything else can be typed. */
export const STEP_PRESETS = { kg: [0.5, 1, 1.25, 2.5, 5], lb: [1, 2.5, 5, 10] }
// No step finer than this is kept: 0.005 kg is nobody's plate, and the app's steppers keep
// weights to the hundredth (components/ui.jsx Stepper).
const MIN_STEP = 0.01

const cleanStep = v => {
  const n = Math.round(Number(v) * 100) / 100
  return Number.isFinite(n) && n >= MIN_STEP ? n : null
}
export const pulleyOf = v => (PULLEYS.includes(v) ? v : null)

/** The exercise's own + / − step in the profile's unit, or null when it has none. */
export function ownStepFor(S, exId) {
  const e = S?.exEquip?.[exId]
  return isMap(e) && isMap(e.step) ? cleanStep(e.step[unitOf(S)]) : null
}
/** How the exercise's cable is rigged, when it was said (a note, never a conversion). */
export const pulleyFor = (S, exId) => pulleyOf(S?.exEquip?.[exId]?.pulley)

/** Whether a pulley ratio is worth asking about: the cable and selectorised machines. */
export const PULLEY_EQ = new Set(['cable', 'leverage machine', 'assisted'])
export const takesPulley = exOrId => PULLEY_EQ.has((typeof exOrId === 'string' ? EXIDX[exOrId] : exOrId)?.eq)

/**
 * S.exEquip with this exercise's entry changed by `patch` ({ step?, pulley? }), stamped. A step
 * of null clears the profile unit's step only, so the other unit's survives a unit switch. With
 * nothing left the entry stays as a stamped empty one: a clear has to win a sync like a set does.
 */
export function withExEquip(S, exId, patch, now = Date.now()) {
  const map = isMap(S?.exEquip) ? S.exEquip : {}
  const prev = isMap(map[exId]) ? map[exId] : {}
  const step = { ...(isMap(prev.step) ? prev.step : {}) }
  if ('step' in patch) {
    const n = cleanStep(patch.step)
    if (n) step[unitOf(S)] = n; else delete step[unitOf(S)]
  }
  const pulley = 'pulley' in patch ? pulleyOf(patch.pulley) : pulleyOf(prev.pulley)
  return { ...map, [exId]: { step, pulley, _ts: now } }
}

// ---- One tap ---------------------------------------------------------------------------------

// Digits after the point, as the number prints (0.1 + 0.2 counts as many; capped below).
const decimalsOf = n => {
  const s = String(n)
  const e = s.indexOf('e-')
  if (e >= 0) return Number(s.slice(e + 2))
  const p = s.indexOf('.')
  return p < 0 ? 0 : s.length - p - 1
}
const MAX_DECIMALS = 3

/**
 * `value` moved by one `step` in `dir` (+1 or −1), exactly. The arithmetic runs on integers at
 * the finer of the two numbers' decimals, so a hundred taps of 1.25 land on 125, not on
 * 124.99999999999997, and a tap back is always the tap undone: 11.5 + 2.5 is 14 and 14 − 2.5 is
 * 11.5 again. Nothing is snapped to the step's grid. A weight typed off it stays off it, the step
 * apart from where it was: the number on the screen is the number you chose.
 *
 * Never below 0: from 1 a tap down of 2.5 is 0, and the tap up from there is 2.5.
 */
export function stepBy(value, step, dir) {
  const v = Math.max(0, Number(value) || 0)
  const s = Number(step)
  if (!(s > 0) || !dir) return v
  const p = 10 ** Math.min(MAX_DECIMALS, Math.max(decimalsOf(v), decimalsOf(s)))
  const I = Math.round(s * p)
  if (I <= 0) return v
  return Math.max(0, Math.round(v * p) + Math.sign(dir) * I) / p
}

/**
 * The weight progression meant by `value`, on the plan's own increment. The engine rounds a
 * prescription to a tenth (lib/progression.js snapWeight), which puts a 1.25 grid on 61.3, 63.8:
 * such a value is read as the grid value it stands for, so the plan's step takes 61.3 to 62.5,
 * as the buttons always did, and not to 62.55. Anything else is returned as it is. Only the
 * plan's step needs this; a step of the exercise's own is a grid progression never wrote on.
 */
export function onPlanGrid(value, step) {
  const v = Number(value) || 0
  const s = Number(step)
  if (!(s > 0) || decimalsOf(s) <= 1 || decimalsOf(v) > 1) return v
  const sp = 10 ** Math.min(MAX_DECIMALS, decimalsOf(s))
  const g = Math.round(v / s) * Math.round(s * sp) / sp
  return Math.round(g * 10) / 10 === v ? g : v
}

/**
 * What the weight buttons of this exercise do, resolved once per render:
 *   { step, source, move(value, dir) }
 * `source` says where the step came from — 'exercise' (its own, S.exEquip), 'dumbbells' (bell to
 * bell over the ones you own; `step` is then the plan's, for display), or 'plan' (the slot's
 * progression step, or the default for the exercise). `cfg` is the session's or routine's
 * config with the exercise `id` on it.
 */
export function weightStepper(S, cfg) {
  const own = ownStepFor(S, cfg?.id)
  if (own) return { step: own, source: 'exercise', move: (v, dir) => stepBy(v, own, dir) }
  const plan = weightIncrement(cfg, S?.unit)
  const owned = ownedWeightsFor(S, cfg)
  if (owned) return { step: plan, source: 'dumbbells', move: (v, dir) => stepOwned(owned, v, dir) }
  return { step: plan, source: 'plan', move: (v, dir) => stepBy(onPlanGrid(v, plan), plan, dir) }
}

/** A step as the editor and the menu show it: 1.25 kg keeps its quarter. */
export const fmtStep = (n, unit) => fmtPlate(n) + ' ' + (unit === 'lb' ? 'lb' : 'kg')

/** One line for a menu: what + and − do on this exercise, and its pulley when said. */
export function weightStepSummary(S, cfg) {
  const s = weightStepper(S, cfg)
  const pulley = pulleyFor(S, cfg?.id)
  const step = s.source === 'exercise' ? fmtStep(s.step, S?.unit)
    : s.source === 'dumbbells' ? t('Your dumbbells') : t('Default ({0})', fmtStep(s.step, S?.unit))
  return pulley ? step + ' · ' + t('Pulley {0}', pulley) : step
}
