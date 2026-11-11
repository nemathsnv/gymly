import { describe, expect, it } from 'vitest'
import { parseBodyweight, parseImport, mergeImport } from './import-csv.js'
import {
  CUSTOM_MEASUREMENT_UNITS, fromMeasurementDisplay, measurementSeries, measurementUnitLabel,
  normalizeMeasurementsState, parseCustomCsvColumn, builtinCsvColumn, MEASUREMENT_FIELDS,
} from './measurements.js'

// #718 follow-ups (upstream 7c6fd6682): a unitless custom field (a score, a count), and a body
// CSV whose custom columns name their unit read back in with its measurements. Gymly has no body
// CSV export of its own yet, so the file here is the one openGym's export writes (its
// lib/export-csv.js bodyCSV): someone moving across brings their measurements with them.
const custom = [
  { id: 'ratio', name: 'Muscle ratio', unit: '%', enabled: true },
  { id: 'lean', name: 'Lean mass', unit: 'lb', enabled: true },
  { id: 'knee', name: 'Knee', enabled: true },
  { id: 'visc', name: 'Visceral fat', unit: 'none', enabled: true },
]
const state = () => normalizeMeasurementsState({
  unit: 'kg', bodyweight: [{ d: '2026-10-01', w: 80, t: 1 }], customMeasurements: structuredClone(custom),
  measurements: [{ d: '2026-10-01', waist: 84.5, other: [
    { id: 'ratio', value: 40.5, unit: '%' }, { id: 'lean', value: 60, unit: 'lb' },
    { id: 'knee', value: 38.1 }, { id: 'visc', value: 0, unit: 'none' },
  ] }],
})
// What openGym's bodyCSV writes for state() above.
const text = 'date,weight_kg,waist_cm,Muscle ratio (%),Lean mass (lb),Knee (cm),Visceral fat\n2026-10-01,80,84.5,40.5,132.3,38.1,0\n'

describe('a custom measurement without a unit', () => {
  it('is one of the units, shows no label and keeps a zero', () => {
    expect(CUSTOM_MEASUREMENT_UNITS).toContain('none')
    expect(measurementUnitLabel('none')).toBe('')
    expect(fromMeasurementDisplay(0, 'kg', { unit: 'none' })).toBe(0)
    expect(fromMeasurementDisplay(12, 'lb', { unit: 'none' })).toBe(12)
    const S = state()
    expect(S.measurements[0].other.find(o => o.id === 'visc')).toMatchObject({ value: 0, unit: 'none' })
    expect(measurementSeries({ ...S, unit: 'lb' }, 'other:visc').map(p => p.y)).toEqual([0])
  })
})

describe('a body CSV with custom units (#718)', () => {
  it('reads the column names the export writes', () => {
    expect(MEASUREMENT_FIELDS.map(builtinCsvColumn).slice(0, 4)).toEqual(['neck_cm', 'shoulders_cm', 'chest_cm', 'waist_cm'])
    expect(builtinCsvColumn(MEASUREMENT_FIELDS.find(f => f.key === 'bodyFat'))).toBe('body_fat_percent')
    expect(parseCustomCsvColumn('Lean mass (lb)')).toEqual({ name: 'Lean mass', unit: 'lb' })
    expect(parseCustomCsvColumn('Muscle ratio(%)')).toEqual({ name: 'Muscle ratio', unit: '%' })
    expect(parseCustomCsvColumn('Visceral fat')).toEqual({ name: 'Visceral fat', unit: 'none' })
  })

  it('brings measurements into a fresh profile with the same fields and units', () => {
    const parsed = parseImport(text, { unit: 'kg' })
    expect(parsed.kind).toBe('bodyweight')
    expect(parsed.measurements).toHaveLength(1)
    const S = normalizeMeasurementsState({ unit: 'kg', bodyweight: [] })
    const res = mergeImport(S, parsed)
    expect(res).toMatchObject({ added: 1, measurements: 1 })
    expect(S.customMeasurements.map(c => [c.name, c.unit])).toEqual([
      ['Muscle ratio', '%'], ['Lean mass', 'lb'], ['Knee', 'cm'], ['Visceral fat', 'none'],
    ])
    const m = S.measurements[0]
    expect(m.waist).toBe(84.5)
    const byName = Object.fromEntries(m.other.map(o => [S.customMeasurements.find(c => c.id === o.id).name, o]))
    expect(byName['Muscle ratio']).toMatchObject({ value: 40.5, unit: '%' })
    expect(byName['Lean mass'].value).toBeCloseTo(60, 1)
    expect(byName.Knee.value).toBe(38.1)
    expect(byName['Visceral fat']).toMatchObject({ value: 0, unit: 'none' })
    // and each field reads the same as on the profile it came from
    for (const c of custom) {
      const to = S.customMeasurements.find(x => x.name === c.name).id
      expect(measurementSeries(S, 'other:' + to).map(p => p.y)).toEqual(measurementSeries(state(), 'other:' + c.id).map(p => p.y))
    }
  })

  it('files a column under the field of that name, converting within its kind, and leaves a clashing one out', () => {
    const csv = 'date,weight_kg,Lean mass (kg),Muscle ratio (kg)\n2026-10-02,,61,50\n'
    const S = state()
    const res = mergeImport(S, parseBodyweight(csv, { unit: 'kg' }))
    expect(res.measurements).toBe(1)
    expect(S.customMeasurements).toHaveLength(4)
    const day = S.measurements.find(e => e.d === '2026-10-02')
    expect(day.other.find(o => o.id === 'lean')).toMatchObject({ value: 61, unit: 'lb' })
    expect(day.other.find(o => o.id === 'ratio').value).toBeNull()
  })

  it('leaves a day that already has measurements alone, and imports a measurements-only file', () => {
    const S = state()
    const parsed = parseBodyweight('date,weight_kg,waist_cm\n2026-10-01,,90\n2026-10-03,,83\n', { unit: 'kg' })
    expect(parsed.error).toBeUndefined()
    expect(parsed.bodyweight).toEqual([])
    expect(parsed).toMatchObject({ from: '2026-10-01', to: '2026-10-03' })
    expect(mergeImport(S, parsed).measurements).toBe(1)
    expect(S.measurements.map(e => [e.d, e.waist])).toEqual([['2026-10-01', 84.5], ['2026-10-03', 83]])
  })

  it('does not read another app\'s extra columns as measurements', () => {
    const parsed = parseBodyweight('Date,Weight,Notes\n2026-10-01,80,after coffee\n', { unit: 'kg' })
    expect(parsed.bodyweight).toHaveLength(1)
    expect(parsed.measurements || []).toEqual([])
    expect(mergeImport(state(), parsed)).not.toHaveProperty('measurements')
  })

  it('skips a day whose only values no field can hold', () => {
    const S = state()
    const res = mergeImport(S, parseBodyweight('date,weight_kg,Muscle ratio (%)\n2026-10-05,,140\n', { unit: 'kg' }))
    expect(res.measurements).toBe(0)
    expect(S.measurements.map(e => e.d)).toEqual(['2026-10-01'])
  })
})
