import { describe, expect, it } from 'vitest'
import { parseBodyweight, parseImport, mergeImport, importHasWeighIn } from './import-csv.js'

const record = (day, value, unit) => `<Record type="HKQuantityTypeIdentifierBodyMass" unit="${unit}" value="${value}" startDate="2026-09-${day} 08:00:00 +0000"/>`

describe('Apple Health body-weight units', () => {
  it.each([
    ['kg', [80, 81.6]],
    ['lb', [176.4, 180]],
  ])('converts each record into %s independently', (unit, expected) => {
    const parsed = parseBodyweight(record('01', 80, 'kg') + record('02', 180, 'lb'), { unit })
    expect(parsed.bodyweight.map(b => b.w)).toEqual(expected)
    expect(parsed.converted).toBe(true)
    expect(parsed.fileUnit).toBe('kg / lb')
  })

  it('does not let record order change another day’s weight', () => {
    const kg = record('01', 80, 'kg'), lb = record('02', 180, 'lb')
    expect(parseBodyweight(kg + lb).bodyweight).toEqual(parseBodyweight(lb + kg).bodyweight)
  })

  it('preserves conversion for single-unit XML and CSV exports', () => {
    expect(parseBodyweight(record('01', 180, 'lb')).bodyweight[0].w).toBe(81.6)
    expect(parseBodyweight('Date,Weight (lbs)\n2026-09-01,180').bodyweight[0].w).toBe(81.6)
    expect(parseBodyweight(record('01', 80, 'kg')).converted).toBe(false)
  })
})

// #859 (ported from upstream): an Apple Health export with several body-mass records a day kept
// one per day.
describe('several weigh-ins a day from a file', () => {
  const at = (day, time, value) => `<Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" value="${value}" startDate="2026-09-${day} ${time}:00 +0200"/>`
  const FILE = at('01', '07:05', 80.2) + at('01', '21:40', 81.4) + at('02', '06:58', 80) + at('01', '21:40', 81.4)

  it('keeps every record with its time, once', () => {
    const parsed = parseImport(FILE)
    expect(parsed.bodyweight.map(b => [b.d, b.at, b.w])).toEqual([['2026-09-01', '07:05', 80.2], ['2026-09-01', '21:40', 81.4], ['2026-09-02', '06:58', 80]])
  })

  it('files them by day, the morning one the day\'s value, and a second import adds nothing', () => {
    const S = { unit: 'kg', workouts: [], bodyweight: [] }
    expect(mergeImport(S, parseImport(FILE))).toEqual({ added: 3, skipped: 0 })
    expect(S.bodyweight.map(b => [b.d, b.w, b.ins.length])).toEqual([['2026-09-01', 80.2, 2], ['2026-09-02', 80, 1]])
    expect(mergeImport(S, parseImport(FILE))).toEqual({ added: 0, skipped: 3 })
  })

  it('skips a record at the time of a weigh-in the day already has', () => {
    const S = { unit: 'kg', workouts: [], bodyweight: [{ d: '2026-09-01', w: 79, t: new Date(2026, 8, 1, 7, 5).getTime() }] }
    expect(importHasWeighIn(S, { d: '2026-09-01', at: '07:05', w: 80.2 })).toBe(true)
    expect(importHasWeighIn(S, { d: '2026-09-01', at: '21:40', w: 81.4 })).toBe(false)
    expect(mergeImport(S, parseImport(FILE))).toEqual({ added: 2, skipped: 1 })
    expect(S.bodyweight[0].ins.map(r => [r.at, r.w])).toEqual([['07:05', 79], ['21:40', 81.4]])
  })

  it('a CSV without times keeps one weigh-in per day, as before', () => {
    const parsed = parseImport('Date,Weight (kg)\n2026-09-01,80\n2026-09-01,80.4\n2026-09-02,80.5')
    expect(parsed.bodyweight.map(b => [b.d, b.at || null, b.w])).toEqual([['2026-09-01', null, 80.4], ['2026-09-02', null, 80.5]])
  })

  it('a CSV with times keeps each of them', () => {
    const parsed = parseImport('Date,Weight (kg)\n2026-09-01 07:00,80\n2026-09-01 20:30,80.9')
    expect(parsed.bodyweight.map(b => [b.d, b.at, b.w])).toEqual([['2026-09-01', '07:00', 80], ['2026-09-01', '20:30', 80.9]])
  })

  it('a day the profile has gets the file\'s untimed weigh-in only when it has none', () => {
    const S = { unit: 'kg', workouts: [], bodyweight: [{ d: '2026-09-01', w: 79, t: 5 }] }
    expect(mergeImport(S, parseImport('Date,Weight (kg)\n2026-09-01,80\n2026-09-02,80.5'))).toEqual({ added: 1, skipped: 1 })
    expect(S.bodyweight[0]).toEqual({ d: '2026-09-01', w: 79, t: 5 })
    expect(S.bodyweight[1]).toMatchObject({ d: '2026-09-02', w: 80.5 })
  })

  // openGym's body CSV: a row per weigh-in with its time, the day's measurements on its first row.
  it('reads an openGym body CSV with several weigh-ins a day and the measurements beside them', () => {
    const csv = 'date,weight_kg,waist_cm,Muscle ratio (%)\n2026-09-01 07:10,80.2,84.5,40.5\n2026-09-01 21:30,81.4,,\n2026-09-02,80,,\n'
    const parsed = parseImport(csv, { unit: 'kg' })
    expect(parsed.bodyweight.map(b => [b.d, b.at || null, b.w])).toEqual([['2026-09-01', '07:10', 80.2], ['2026-09-01', '21:30', 81.4], ['2026-09-02', null, 80]])
    expect(parsed.measurements).toHaveLength(1)
    const S = { unit: 'kg', workouts: [], bodyweight: [], measurements: [], customMeasurements: [] }
    expect(mergeImport(S, parsed)).toEqual({ added: 3, skipped: 0, measurements: 1 })
    expect(S.bodyweight.map(b => [b.d, b.w, b.ins.length])).toEqual([['2026-09-01', 80.2, 2], ['2026-09-02', 80, 1]])
    expect(S.measurements[0]).toMatchObject({ d: '2026-09-01', waist: 84.5 })
    expect(mergeImport(S, parseImport(csv, { unit: 'kg' }))).toEqual({ added: 0, skipped: 3, measurements: 0 })
  })
})
