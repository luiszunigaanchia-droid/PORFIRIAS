import assert from 'node:assert/strict';
import test from 'node:test';
import { ANALYTICAL_CONFIG, WAVELENGTHS } from '../js/config.js';
import { ValidationError, calculateAnalysis, interpolateLinear, validateSpectrum } from '../js/calculations.js';

const spectrum = () => WAVELENGTHS.map(wavelength => ({
  wavelength,
  absorbance: wavelength === 405 ? 0.18 : 0.01
}));

test('linear interpolation matches two validated reference points', () => {
  assert.equal(interpolateLinear(370, 0, 430, 6, 400), 3);
  assert.throws(() => interpolateLinear(370, 1, 370, 2, 370), ValidationError);
});

test('spectrum rejects incomplete or nonnumeric measurements', () => {
  const points = spectrum();
  assert.equal(validateSpectrum(points).length, WAVELENGTHS.length);
  assert.throws(() => validateSpectrum(points.slice(1)), ValidationError);
  for (const empty of ['', ' ', null, undefined]) {
    const incomplete = spectrum();
    incomplete[4] = { wavelength: WAVELENGTHS[4], absorbance: empty };
    assert.throws(() => validateSpectrum(incomplete), ValidationError);
  }
  const overLimit = spectrum();
  overLimit[4].absorbance = ANALYTICAL_CONFIG.absorbanceMaximum + 0.1;
  assert.throws(() => validateSpectrum(overLimit), ValidationError);
});

test('PBG calculation retains expected clinical conversion factors', () => {
  const output = calculateAnalysis({ absorbancePbg: 0.01, creatinineMgDl: 100, spectrum: spectrum() });
  assert.ok(Math.abs(output.raw.pbgUgMl - 6.3) < 1e-10);
  assert.ok(Math.abs(output.raw.pbgUmolDl - 2.8) < 1e-10);
  assert.ok(Math.abs(output.raw.creatinineMmolL - 8.84) < 1e-10);
  assert.equal(output.spectralAnalysis.peakWavelength, 405);
  assert.throws(() => calculateAnalysis({ absorbancePbg: 0.01, creatinineMgDl: 0, spectrum: spectrum() }), ValidationError);
});
