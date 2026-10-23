import { ANALYTICAL_CONFIG, ANALYTICAL_STATUS, WAVELENGTHS } from './config.js';

export { ANALYTICAL_STATUS };

export class ValidationError extends Error {
  constructor(message, field = '') {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

export function roundNumber(value, decimals = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function interpolateLinear(x0, y0, x1, y1, x) {
  if (![x0, y0, x1, y1, x].every(Number.isFinite)) {
    throw new ValidationError('La interpolación recibió valores no numéricos.');
  }
  if (x0 === x1) {
    throw new ValidationError('No se puede interpolar entre longitudes de onda iguales.');
  }
  return y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
}

function assertFiniteRange(value, min, max, label, field) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(`${label} debe estar entre ${min} y ${max}.`, field);
  }
}

export function validateSpectrum(spectrum) {
  if (!Array.isArray(spectrum) || spectrum.length !== WAVELENGTHS.length) {
    throw new ValidationError('El espectro debe contener todas las longitudes de onda configuradas.', 'spectrum');
  }

  return spectrum.map((point, index) => {
    const wavelength = Number(point?.wavelength);
    const expectedWavelength = WAVELENGTHS[index];
    const rawAbsorbance = point?.absorbance;
    if (rawAbsorbance === null || rawAbsorbance === undefined ||
        (typeof rawAbsorbance === 'string' && rawAbsorbance.trim() === '')) {
      throw new ValidationError(`Falta la absorbancia a ${expectedWavelength} nm.`, `spectrum-${expectedWavelength}`);
    }
    const absorbance = Number(rawAbsorbance);

    if (wavelength !== expectedWavelength) {
      throw new ValidationError(`Se esperaba la longitud de onda ${expectedWavelength} nm.`, 'spectrum');
    }
    assertFiniteRange(
      absorbance,
      0,
      ANALYTICAL_CONFIG.absorbanceMaximum,
      `La absorbancia a ${wavelength} nm`,
      `spectrum-${wavelength}`
    );

    return { wavelength, absorbance };
  });
}

/**
 * Realiza el análisis espectral detectando la posición del máximo,
 * la línea base interpolada y el estado analítico de la señal corregida.
 */
export function analyzeSpectralPeak(spectrum) {
  const firstPoint = spectrum[0];
  const lastPoint = spectrum[spectrum.length - 1];

  const peakPoint = spectrum.reduce(
    (currentMax, point) => (point.absorbance > currentMax.absorbance ? point : currentMax),
    spectrum[0]
  );

  const baselineAtPeak = interpolateLinear(
    firstPoint.wavelength,
    firstPoint.absorbance,
    lastPoint.wavelength,
    lastPoint.absorbance,
    peakPoint.wavelength
  );

  const rawCorrectedSignal = peakPoint.absorbance - baselineAtPeak;

  const isEndpointMaximum = (
    peakPoint.wavelength === firstPoint.wavelength ||
    peakPoint.wavelength === lastPoint.wavelength
  );

  const hasInternalPeak = !isEndpointMaximum && rawCorrectedSignal > 0;

  let spectralStatus;
  if (isEndpointMaximum) {
    spectralStatus = ANALYTICAL_STATUS.ENDPOINT_MAXIMUM;
  } else if (rawCorrectedSignal <= 0) {
    spectralStatus = ANALYTICAL_STATUS.NO_INTERNAL_PEAK;
  } else {
    spectralStatus = ANALYTICAL_STATUS.QUANTIFIED;
  }

  return {
    peak: peakPoint,
    peakWavelength: peakPoint.wavelength,
    peakAbsorbance: peakPoint.absorbance,
    baselineAtPeak,
    rawCorrectedSignal,
    isEndpointMaximum,
    hasInternalPeak,
    spectralStatus
  };
}

/**
 * Construye un objeto estructurado de resultado analítico con tipado y estado explícito.
 */
function createAnalyticalResult({
  analyte,
  numericValue,
  qualifier,
  reportingLimit,
  unit,
  analyticalStatus,
  referenceLimit,
  displayDecimals = 2,
  warnings = []
}) {
  let displayValue;

  if (analyticalStatus === ANALYTICAL_STATUS.QUANTIFIED && numericValue !== null && Number.isFinite(numericValue)) {
    displayValue = numericValue.toFixed(displayDecimals);
  } else if (qualifier === '<' && reportingLimit !== null && Number.isFinite(reportingLimit)) {
    const formattedLimit = Number.isInteger(reportingLimit)
      ? String(reportingLimit)
      : reportingLimit.toFixed(displayDecimals);
    displayValue = `<${formattedLimit}`;
  } else if (analyticalStatus === ANALYTICAL_STATUS.MISSING_INPUT) {
    displayValue = 'No calculable';
  } else {
    displayValue = 'No calculable';
  }

  return Object.freeze({
    analyte,
    numericValue,
    qualifier,
    reportingLimit,
    unit,
    analyticalStatus,
    displayValue,
    referenceLimit,
    warnings: Object.freeze([...warnings])
  });
}

/**
 * Evalúa las porfirinas totales y su relación con creatinina aplicando límites de reporte.
 */
function determinePorphyrinsResult(spectralAnalysis, creatinineMmolL) {
  const reportingLimit = ANALYTICAL_CONFIG.reportingLimits.porphyrinsNmolDl;
  const referenceLimit = ANALYTICAL_CONFIG.references.porphyrinsNmolDlUpper;
  const ratioReferenceLimit = ANALYTICAL_CONFIG.references.porphyrinsCreatinineUpper;

  const resultWarnings = [];
  const ratioWarnings = [];

  let porphyrinsResult;

  if (spectralAnalysis.hasInternalPeak) {
    const concentrationNmolDl = spectralAnalysis.rawCorrectedSignal * ANALYTICAL_CONFIG.porphyrinsNmolDlFactor;

    if (concentrationNmolDl < reportingLimit) {
      porphyrinsResult = createAnalyticalResult({
        analyte: 'Porfirinas totales',
        numericValue: null,
        qualifier: '<',
        reportingLimit,
        unit: 'nmol/dL',
        analyticalStatus: ANALYTICAL_STATUS.BELOW_REPORTING_LIMIT,
        referenceLimit,
        displayDecimals: 1,
        warnings: resultWarnings
      });
    } else {
      porphyrinsResult = createAnalyticalResult({
        analyte: 'Porfirinas totales',
        numericValue: concentrationNmolDl,
        qualifier: null,
        reportingLimit,
        unit: 'nmol/dL',
        analyticalStatus: ANALYTICAL_STATUS.QUANTIFIED,
        referenceLimit,
        displayDecimals: 1,
        warnings: resultWarnings
      });
    }
  } else {
    if (spectralAnalysis.isEndpointMaximum) {
      resultWarnings.push(
        `No se identificó un pico espectral interno cuantificable. El máximo se encuentra en ${spectralAnalysis.peakWavelength} nm (extremo del intervalo medido). ` +
        'El resultado se reporta por debajo del límite analítico configurado y requiere revisión del espectro conforme al procedimiento local.'
      );
    } else {
      resultWarnings.push(
        'La corrección de línea base no produjo una señal neta positiva. ' +
        'El resultado se reporta por debajo del límite analítico configurado.'
      );
    }

    porphyrinsResult = createAnalyticalResult({
      analyte: 'Porfirinas totales',
      numericValue: null,
      qualifier: '<',
      reportingLimit,
      unit: 'nmol/dL',
      analyticalStatus: ANALYTICAL_STATUS.BELOW_REPORTING_LIMIT,
      referenceLimit,
      displayDecimals: 1,
      warnings: resultWarnings
    });
  }

  let porphyrinsRatioResult;

  if (!Number.isFinite(creatinineMmolL) || creatinineMmolL <= 0) {
    ratioWarnings.push('La creatinina no es válida. No es posible calcular la relación porfirinas/creatinina.');
    porphyrinsRatioResult = createAnalyticalResult({
      analyte: 'Porfirinas / creatinina',
      numericValue: null,
      qualifier: null,
      reportingLimit: null,
      unit: 'nmol/mmol',
      analyticalStatus: ANALYTICAL_STATUS.MISSING_INPUT,
      referenceLimit: ratioReferenceLimit,
      displayDecimals: 2,
      warnings: ratioWarnings
    });
  } else if (porphyrinsResult.analyticalStatus === ANALYTICAL_STATUS.QUANTIFIED) {
    const creatinineMmolDl = creatinineMmolL / 10;
    const ratioNmolMmol = porphyrinsResult.numericValue / creatinineMmolDl;

    porphyrinsRatioResult = createAnalyticalResult({
      analyte: 'Porfirinas / creatinina',
      numericValue: ratioNmolMmol,
      qualifier: null,
      reportingLimit: null,
      unit: 'nmol/mmol',
      analyticalStatus: ANALYTICAL_STATUS.QUANTIFIED,
      referenceLimit: ratioReferenceLimit,
      displayDecimals: 2,
      warnings: ratioWarnings
    });
  } else {
    const creatinineMmolDl = creatinineMmolL / 10;
    const ratioReportingLimit = reportingLimit / creatinineMmolDl;

    porphyrinsRatioResult = createAnalyticalResult({
      analyte: 'Porfirinas / creatinina',
      numericValue: null,
      qualifier: '<',
      reportingLimit: ratioReportingLimit,
      unit: 'nmol/mmol',
      analyticalStatus: ANALYTICAL_STATUS.BELOW_REPORTING_LIMIT,
      referenceLimit: ratioReferenceLimit,
      displayDecimals: 2,
      warnings: ratioWarnings
    });
  }

  return { porphyrinsResult, porphyrinsRatioResult };
}

/**
 * Clasifica el patrón analítico en función de los límites clínicos configurados.
 */
function classifyResult(values, porphyrinsResult, porphyrinsRatioResult) {
  const ref = ANALYTICAL_CONFIG.references;

  const pbgHigh = values.pbgUgMl > ref.pbgUgMlUpper || values.pbgCreatinine > ref.pbgCreatinineUpper;

  const porphyrinsHigh =
    (porphyrinsResult.analyticalStatus === ANALYTICAL_STATUS.QUANTIFIED &&
     porphyrinsResult.numericValue > ref.porphyrinsNmolDlUpper) ||
    (porphyrinsRatioResult.analyticalStatus === ANALYTICAL_STATUS.QUANTIFIED &&
     porphyrinsRatioResult.numericValue > ref.porphyrinsCreatinineUpper);

  if (pbgHigh && porphyrinsHigh) {
    return {
      code: 'both-elevated',
      level: 'critical',
      title: 'PBG y porfirinas por encima de los límites configurados',
      text: 'El patrón requiere revisión analítica, correlación clínica y pruebas confirmatorias según el protocolo del laboratorio. Esta herramienta no determina un diagnóstico.'
    };
  }

  if (pbgHigh) {
    return {
      code: 'pbg-elevated',
      level: 'critical',
      title: 'PBG por encima de los límites configurados',
      text: 'Verifique linealidad, dilución, identificación de muestra y control de calidad. Considere el algoritmo confirmatorio para porfirias hepáticas agudas según el protocolo local.'
    };
  }

  if (porphyrinsHigh) {
    return {
      code: 'porphyrins-elevated',
      level: 'warning',
      title: 'Porfirinas totales por encima de los límites configurados',
      text: 'La elevación de porfirinas totales es inespecífica. Requiere fraccionamiento y evaluación clínica antes de atribuir un subtipo de porfiria.'
    };
  }

  return {
    code: 'within-configured-limits',
    level: 'normal',
    title: 'Resultados dentro de los límites configurados',
    text: 'No se detectaron elevaciones con los factores e intervalos configurados. El resultado debe validarse junto con controles, condiciones preanalíticas y contexto clínico.'
  };
}

/**
 * Compila advertencias analíticas e instrumentales relevantes.
 */
function buildWarnings({ absorbancePbg, spectrum, spectralAnalysis, porphyrinsResult, porphyrinsRatioResult }) {
  const warnings = [];

  if (absorbancePbg > ANALYTICAL_CONFIG.absorbanceWarning) {
    warnings.push('La absorbancia de PBG supera 2.0 D.O.; confirme linealidad y considere dilución según el método validado.');
  }

  const highSpectrumPoints = spectrum.filter(point => point.absorbance > ANALYTICAL_CONFIG.absorbanceWarning);
  if (highSpectrumPoints.length > 0) {
    warnings.push(`El espectro contiene ${highSpectrumPoints.length} punto(s) por encima de 2.0 D.O.; confirme linealidad instrumental.`);
  }

  if (spectralAnalysis.isEndpointMaximum) {
    warnings.push(
      `El máximo espectral se encuentra en ${spectralAnalysis.peakWavelength} nm (extremo del intervalo). ` +
      'El rango medido podría no contener el pico espectral completo.'
    );
  }

  if (!spectralAnalysis.hasInternalPeak && spectralAnalysis.rawCorrectedSignal <= 0 && !spectralAnalysis.isEndpointMaximum) {
    warnings.push('La corrección de línea base produjo una señal neta no positiva; revise el espectro y los puntos extremos.');
  }

  porphyrinsResult.warnings.forEach(w => warnings.push(w));
  porphyrinsRatioResult.warnings.forEach(w => warnings.push(w));

  return warnings;
}

/**
 * Función principal de cálculo analítico para porfirinas y PBG.
 *
 * @param {Object} input - Datos de entrada del análisis
 * @param {number} input.absorbancePbg - Absorbancia a 555 nm
 * @param {number} input.creatinineMgDl - Concentración de creatinina en mg/dL
 * @param {Array<{wavelength: number, absorbance: number}>} input.spectrum - Espectro 370–440 nm
 * @returns {Object} Estructura completa de resultados calculados
 */
export function calculateAnalysis(input) {
  const absorbancePbg = Number(input?.absorbancePbg);
  const creatinineMgDl = Number(input?.creatinineMgDl);

  assertFiniteRange(
    absorbancePbg,
    0,
    ANALYTICAL_CONFIG.absorbanceMaximum,
    'La absorbancia de PBG',
    'absorbancePbg'
  );
  assertFiniteRange(creatinineMgDl, 0.01, 1000, 'La creatinina', 'creatinineMgDl');

  const spectrum = validateSpectrum(input?.spectrum);

  const spectralAnalysis = analyzeSpectralPeak(spectrum);

  const creatinineMmolL = creatinineMgDl * ANALYTICAL_CONFIG.creatinineMgDlToMmolL;
  const pbgUgMl = absorbancePbg * ANALYTICAL_CONFIG.pbgUgMlFactor;
  const pbgUmolDl = absorbancePbg * ANALYTICAL_CONFIG.pbgUmolDlFactor;
  const pbgCreatinine = (pbgUmolDl * 10) / creatinineMmolL;

  const { porphyrinsResult, porphyrinsRatioResult } = determinePorphyrinsResult(spectralAnalysis, creatinineMmolL);

  const porphyrinsNmolDl = porphyrinsResult.numericValue;
  const porphyrinsCreatinine = porphyrinsRatioResult.numericValue;

  const values = {
    pbgUgMl,
    pbgUmolDl,
    pbgCreatinine,
    porphyrinsNmolDl,
    porphyrinsCreatinine,
    creatinineMmolL,
    baselineAtPeak: spectralAnalysis.baselineAtPeak,
    correctedPeak: spectralAnalysis.rawCorrectedSignal,
    peakWavelength: spectralAnalysis.peakWavelength,
    peakAbsorbance: spectralAnalysis.peakAbsorbance
  };

  return {
    raw: values,
    display: {
      pbgUgMl: pbgUgMl.toFixed(2),
      pbgUmolDl: pbgUmolDl.toFixed(2),
      pbgCreatinine: pbgCreatinine.toFixed(2),
      porphyrinsNmolDl: porphyrinsResult.displayValue,
      porphyrinsCreatinine: porphyrinsRatioResult.displayValue,
      baselineAtPeak: spectralAnalysis.baselineAtPeak.toFixed(4),
      correctedPeak: spectralAnalysis.rawCorrectedSignal.toFixed(4),
      peakWavelength: String(spectralAnalysis.peakWavelength)
    },
    porphyrinsResult,
    porphyrinsRatioResult,
    spectralAnalysis: Object.freeze({
      peakWavelength: spectralAnalysis.peakWavelength,
      peakAbsorbance: spectralAnalysis.peakAbsorbance,
      baselineAtPeak: spectralAnalysis.baselineAtPeak,
      rawCorrectedSignal: spectralAnalysis.rawCorrectedSignal,
      isEndpointMaximum: spectralAnalysis.isEndpointMaximum,
      hasInternalPeak: spectralAnalysis.hasInternalPeak,
      spectralStatus: spectralAnalysis.spectralStatus
    }),
    spectrum,
    interpretation: classifyResult(values, porphyrinsResult, porphyrinsRatioResult),
    warnings: buildWarnings({ absorbancePbg, spectrum, spectralAnalysis, porphyrinsResult, porphyrinsRatioResult })
  };
}

export function isAboveReference(metric, value) {
  const referenceMap = {
    pbgUgMl: ANALYTICAL_CONFIG.references.pbgUgMlUpper,
    pbgUmolDl: ANALYTICAL_CONFIG.references.pbgUmolDlUpper,
    pbgCreatinine: ANALYTICAL_CONFIG.references.pbgCreatinineUpper,
    porphyrinsNmolDl: ANALYTICAL_CONFIG.references.porphyrinsNmolDlUpper,
    porphyrinsCreatinine: ANALYTICAL_CONFIG.references.porphyrinsCreatinineUpper
  };
  return Number.isFinite(value) && value > referenceMap[metric];
}
