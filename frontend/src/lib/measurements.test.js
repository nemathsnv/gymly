import { describe, expect, it } from 'vitest'
import {
  MEASUREMENT_KEYS, DEFAULT_MEASUREMENT_KEYS, emptyMeasurement, enabledMeasurementFields,
  normalizeMeasurementEntry, normalizeMeasurementsState, measurementSeries,
  toMeasurementDisplay, fromMeasurementDisplay, measurementEntryHasValues,
  homeMeasurementField, pinHomeMeasurement, setMeasurementValue,
} from './measurements.js'

describe('body measurements', () => {
  it('creates a complete entry with nulls instead of ambiguous zeroes', () => {
    const e = emptyMeasurement('2026-08-11', [{ id: 'knee', name: 'Around knees' }])
    expect(Object.keys(e).filter(k => MEASUREMENT_KEYS.includes(k))).toEqual(MEASUREMENT_KEYS)
    expect(MEASUREMENT_KEYS.every(k => e[k] === null)).toBe(true)
    expect(e.other).toEqual([{ id: 'knee', name: 'Around knees', value: null }])
    expect(measurementEntryHasValues(e)).toBe(false)
  })

  it('normalizes partial entries and preserves unknown custom history', () => {
    const e = normalizeMeasurementEntry({
      d: '2026-08-11', waist: 82.54, chest: 0,
      bodyFat: 140,
      other: [{ id: 'old', name: 'Old field', value: 12.34 }],
    }, [{ id: 'knee', name: 'Knee' }])
    expect(e.waist).toBe(82.5)
    expect(e.chest).toBeNull()
    expect(e.bodyFat).toBeNull()
    expect(e.other).toEqual([
      { id: 'old', name: 'Old field', value: 12.3 },
      { id: 'knee', name: 'Knee', value: null },
    ])
  })

  it('uses centimetres as canonical storage and round-trips inches', () => {
    expect(fromMeasurementDisplay(32.5, 'lb')).toBe(82.6)
    expect(toMeasurementDisplay(82.6, 'lb')).toBe(32.5)
    expect(fromMeasurementDisplay(82.6, 'kg')).toBe(82.6)
  })

  it('migrates missing state defaults and sorts entries', () => {
    const s = normalizeMeasurementsState({ measurements: [
      { d: '2026-08-12', waist: 83 }, { d: '2026-08-11', waist: 82 },
    ] })
    expect(s.measurementEnabled).toEqual(DEFAULT_MEASUREMENT_KEYS)
    expect(s.measurements.map(e => e.d)).toEqual(['2026-08-11', '2026-08-12'])
    expect(MEASUREMENT_KEYS.every(k => k in s.measurements[0])).toBe(true)
  })

  it('builds a display-unit series and ignores missing values', () => {
    const s = normalizeMeasurementsState({ unit: 'lb', measurements: [
      { d: '2026-08-11', t: 100, waist: 82.55 },
      { d: '2026-08-12', t: 200, waist: null },
      { d: '2026-08-13', t: 300, waist: 85.09 },
    ] })
    expect(measurementSeries(s, 'waist').map(p => p.y)).toEqual([32.5, 33.5])
  })

  it('folds two entries for one date into a single check-in', () => {
    const s = normalizeMeasurementsState({
      customMeasurements: [{ id: 'knee', name: 'Knee' }],
      measurements: [
        { d: '2026-08-11', t: 100, waist: 82, chest: 101, other: [{ id: 'knee', value: 38 }] },
        { d: '2026-08-11', t: 200, waist: 83, other: [{ id: 'knee', value: null }] },
        { d: '2026-08-12', t: 300, waist: 84 },
      ],
    })
    expect(s.measurements.map(e => e.d)).toEqual(['2026-08-11', '2026-08-12'])
    const [merged] = s.measurements
    expect(merged.t).toBe(200)
    expect(merged.waist).toBe(83)     // later reading wins
    expect(merged.chest).toBe(101)    // only the earlier row had it — kept
    expect(merged.other).toEqual([{ id: 'knee', name: 'Knee', value: 38 }])
  })

  it('orders fields by the field list, not by when each was switched on', () => {
    // measurementEnabled is a set the toggles append to: switching Neck off and on again puts
    // it last there, and the form must not reorder itself because of that.
    const state = {
      measurementEnabled: [...DEFAULT_MEASUREMENT_KEYS.filter(k => k !== 'neck'), 'neck'],
      customMeasurements: [{ id: 'knee', name: 'Around knees', enabled: true }],
    }
    expect(enabledMeasurementFields(state).map(f => f.key))
      .toEqual([...DEFAULT_MEASUREMENT_KEYS, 'other:knee'])
  })
})

describe('the measurement pinned to Home', () => {
  it('reads a built-in or custom pin, and none for a removed custom one', () => {
    expect(homeMeasurementField({})).toBeNull()
    expect(homeMeasurementField({ homeMeasurement: 'abdomen' }).label).toBe('Abdomen')
    const custom = [{ id: 'belly', name: 'Belly' }]
    expect(homeMeasurementField({ homeMeasurement: 'other:belly', customMeasurements: custom }))
      .toEqual({ key: 'other:belly', label: 'Belly', group: 'Other', custom: true })
    expect(homeMeasurementField({ homeMeasurement: 'other:gone', customMeasurements: custom })).toBeNull()
    expect(homeMeasurementField({ homeMeasurement: 'nonsense' })).toBeNull()
  })

  it('switches the pinned field on in the full form, keeping the others as they were', () => {
    const s = pinHomeMeasurement({ measurementEnabled: null }, 'abdomen')
    expect(s.homeMeasurement).toBe('abdomen')
    expect(s.measurementEnabled).toEqual([...DEFAULT_MEASUREMENT_KEYS, 'abdomen'])
    const c = pinHomeMeasurement({ customMeasurements: [{ id: 'belly', name: 'Belly', enabled: false }] }, 'other:belly')
    expect(c.customMeasurements[0].enabled).toBe(true)
    expect(pinHomeMeasurement(s, null).homeMeasurement).toBeNull()
    expect(s.measurementEnabled).toContain('abdomen') // unpinning leaves the form alone
  })
})

describe('logging one measurement for a day', () => {
  it('adds a check-in when the day has none', () => {
    const s = setMeasurementValue({ measurements: [] }, '2026-11-11', 'abdomen', 92.34, 500)
    expect(s.measurements).toHaveLength(1)
    expect(s.measurements[0]).toMatchObject({ d: '2026-11-11', t: 500, abdomen: 92.3, waist: null })
  })

  it('writes into the day\'s existing check-in without touching its other measurements', () => {
    const s = { measurements: [
      { d: '2026-11-10', t: 100, abdomen: 93 },
      { d: '2026-11-11', t: 200, waist: 84, chest: 101 },
    ] }
    setMeasurementValue(s, '2026-11-11', 'abdomen', 92, 900)
    expect(s.measurements).toHaveLength(2)
    expect(s.measurements[1]).toMatchObject({ d: '2026-11-11', t: 900, waist: 84, chest: 101, abdomen: 92 })
    expect(s.measurements[0].abdomen).toBe(93)
    // a second reading the same morning replaces the first
    setMeasurementValue(s, '2026-11-11', 'abdomen', 91.5, 950)
    expect(s.measurements[1].abdomen).toBe(91.5)
  })

  it('logs a custom measurement and keeps the list in date order', () => {
    const s = { customMeasurements: [{ id: 'belly', name: 'Belly' }], measurements: [{ d: '2026-11-12', t: 1, waist: 80 }] }
    setMeasurementValue(s, '2026-11-11', 'other:belly', 95, 5)
    expect(s.measurements.map(e => e.d)).toEqual(['2026-11-11', '2026-11-12'])
    expect(s.measurements[0].other).toEqual([{ id: 'belly', name: 'Belly', value: 95 }])
  })

  it('clears the field, and drops a check-in left empty', () => {
    const s = { measurements: [{ d: '2026-11-11', t: 1, waist: 84, abdomen: 92 }] }
    setMeasurementValue(s, '2026-11-11', 'abdomen', null, 2)
    expect(s.measurements[0]).toMatchObject({ waist: 84, abdomen: null })
    setMeasurementValue(s, '2026-11-11', 'waist', 0, 3)
    expect(s.measurements).toEqual([])
  })

  it('refuses body fat past 100% and ignores an unknown key', () => {
    const s = { measurements: [] }
    setMeasurementValue(s, '2026-11-11', 'bodyFat', 140, 1)
    expect(s.measurements).toEqual([])
    setMeasurementValue(s, '2026-11-11', 'nope', 10, 1)
    expect(s.measurements).toEqual([])
  })
})
