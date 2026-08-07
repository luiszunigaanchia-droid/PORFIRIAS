import { APP_VERSION, ALGORITHM_VERSION, ANALYTICAL_CONFIG, ANALYTICAL_STATUS, BACKUP_SCHEMA, BACKUP_VERSION, WAVELENGTHS } from './config.js';
import { calculateAnalysis, isAboveReference, ValidationError } from './calculations.js';
import { parseSpectralXlsx } from './xlsx-parser.js';
import {
  clearRecords,
  deleteRecord,
  getRecord,
  importRecords,
  listRecords,
  migrateLegacyStorage,
  saveRecord
} from './storage.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const elements = {
  patientId: document.querySelector('#patient-id'),
  patientName: document.querySelector('#patient-name'),
  analysisDate: document.querySelector('#analysis-date'),
  operatorName: document.querySelector('#operator-name'),
  pbgAbsorbance: document.querySelector('#pbg-absorbance'),
  creatinine: document.querySelector('#creatinine'),
  spectrumBody: document.querySelector('#spectrum-body'),
  spectrumTemplate: document.querySelector('#spectrum-row-template'),
  calculateButton: document.querySelector('#calculate-button'),
  clearFormButton: document.querySelector('#clear-form-button'),
  resetSpectrumButton: document.querySelector('#reset-spectrum-button'),
  importSpectrumButton: document.querySelector('#import-spectrum-button'),
  spectrumFileInput: document.querySelector('#spectrum-file-input'),
  spectrumFileInfo: document.querySelector('#spectrum-file-info'),
  calculationState: document.querySelector('#calculation-state'),
  resultsSection: document.querySelector('#results-section'),
  metricsGrid: document.querySelector('#metrics-grid'),
  spectrumChart: document.querySelector('#spectrum-chart'),
  interpretationCard: document.querySelector('#interpretation-card'),
  warningsList: document.querySelector('#warnings-list'),
  printPatientSummary: document.querySelector('#print-patient-summary'),
  saveButton: document.querySelector('#save-button'),
  printButton: document.querySelector('#print-button'),
  historyBody: document.querySelector('#history-body'),
  historySearch: document.querySelector('#history-search'),
  recordCount: document.querySelector('#record-count'),
  exportJsonButton: document.querySelector('#export-json-button'),
  exportCsvButton: document.querySelector('#export-csv-button'),
  importButton: document.querySelector('#import-button'),
  importInput: document.querySelector('#import-input'),
  deleteAllButton: document.querySelector('#delete-all-button'),
  importDialog: document.querySelector('#import-dialog'),
  importDialogSummary: document.querySelector('#import-dialog-summary'),
  importMergeButton: document.querySelector('#import-merge-button'),
  importReplaceButton: document.querySelector('#import-replace-button'),
  importCancelButton: document.querySelector('#import-cancel-button'),
  toastRegion: document.querySelector('#toast-region'),
  installButton: document.querySelector('#install-button'),
  connectionStatus: document.querySelector('#connection-status'),
  updateBanner: document.querySelector('#update-banner'),
  updateButton: document.querySelector('#update-button'),
  appVersion: document.querySelector('#app-version')
};

const state = {
  records: [],
  latestCalculation: null,
  currentRecordId: null,
  loadedPatientSignature: null,
  pendingImport: null,
  deferredInstallPrompt: null,
  waitingWorker: null,
  reloadingForUpdate: false,
  importedSpectrumFile: null
};

function localDateString(date = new Date()) {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

function createId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `record-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.textContent = String(message);
  elements.toastRegion.append(toast);

  window.setTimeout(() => toast.remove(), 4500);
}

function setError(input, message = '') {
  if (!input) return;
  const errorElement = document.querySelector(`#${input.id}-error`);
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
  if (errorElement) errorElement.textContent = message;
}

function normalizeWhitespace(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function validatePatient() {
  let valid = true;
  const idNumber = normalizeWhitespace(elements.patientId.value);
  const name = normalizeWhitespace(elements.patientName.value);
  const analysisDate = elements.analysisDate.value;

  if (idNumber && !/^[\p{L}\p{N} ./_-]{5,24}$/u.test(idNumber)) {
    setError(elements.patientId, 'Use entre 5 y 24 caracteres: letras, números, espacios, punto, guion o barra.');
    valid = false;
  } else {
    setError(elements.patientId);
  }

  if (name.length < 2) {
    setError(elements.patientName, 'Indique el nombre del paciente.');
    valid = false;
  } else if (name.length > 120) {
    setError(elements.patientName, 'El nombre supera el máximo de 120 caracteres.');
    valid = false;
  } else {
    setError(elements.patientName);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(analysisDate)) {
    setError(elements.analysisDate, 'Seleccione una fecha válida.');
    valid = false;
  } else {
    setError(elements.analysisDate);
  }

  return valid;
}

function buildSpectrumRows(values = {}) {
  elements.spectrumBody.replaceChildren();

  WAVELENGTHS.forEach(wavelength => {
    const fragment = elements.spectrumTemplate.content.cloneNode(true);
    const rowHeader = fragment.querySelector('th');
    const input = fragment.querySelector('input');
    const error = fragment.querySelector('.field-error');

    rowHeader.textContent = `${wavelength} nm`;
    input.id = `spectrum-${wavelength}`;
    input.dataset.wavelength = String(wavelength);
    input.value = Number(values[wavelength] ?? 0).toFixed(4);
    error.id = `${input.id}-error`;

    elements.spectrumBody.append(fragment);
  });
}

function getSpectrumInputs() {
  return [...document.querySelectorAll('.spectrum-input')];
}

function collectAnalyticalInputs() {
  return {
    absorbancePbg: Number(elements.pbgAbsorbance.value),
    creatinineMgDl: Number(elements.creatinine.value),
    spectrum: getSpectrumInputs().map(input => ({
      wavelength: Number(input.dataset.wavelength),
      absorbance: Number(input.value)
    }))
  };
}

function clearAnalyticalErrors() {
  setError(elements.pbgAbsorbance);
  setError(elements.creatinine);
  getSpectrumInputs().forEach(input => setError(input));
}

function displayValidationError(error) {
  clearAnalyticalErrors();
  const field = error.field || '';

  if (field === 'absorbancePbg') setError(elements.pbgAbsorbance, error.message);
  else if (field === 'creatinineMgDl') setError(elements.creatinine, error.message);
  else if (field.startsWith('spectrum-')) {
    const input = document.querySelector(`#${CSS.escape(field)}`);
    if (input) setError(input, error.message);
  }

  showToast(error.message, 'error');
}

function markCalculationDirty() {
  if (!state.latestCalculation) return;
  state.latestCalculation = null;
  elements.saveButton.disabled = true;
  elements.calculationState.textContent = 'Hay cambios sin recalcular. Calcule de nuevo antes de guardar.';
  elements.calculationState.classList.add('dirty');
}

function statusIcon(status) {
  switch (status) {
    case ANALYTICAL_STATUS.BELOW_REPORTING_LIMIT:
      return '⬇';
    case ANALYTICAL_STATUS.QUANTIFIED:
      return '';
    case ANALYTICAL_STATUS.MISSING_INPUT:
    case ANALYTICAL_STATUS.INVALID_SPECTRUM:
    case ANALYTICAL_STATUS.CALCULATION_ERROR:
      return '⚠';
    default:
      return '';
  }
}

function statusLabel(status) {
  switch (status) {
    case ANALYTICAL_STATUS.BELOW_REPORTING_LIMIT:
      return 'Inferior al límite de reporte';
    case ANALYTICAL_STATUS.QUANTIFIED:
      return 'Cuantificado';
    case ANALYTICAL_STATUS.MISSING_INPUT:
      return 'No calculable';
    case ANALYTICAL_STATUS.ENDPOINT_MAXIMUM:
      return 'Máximo en extremo';
    case ANALYTICAL_STATUS.INVALID_SPECTRUM:
      return 'Espectro inválido';
    case ANALYTICAL_STATUS.CALCULATION_ERROR:
      return 'Error de cálculo';
    default:
      return '';
  }
}

function createMetricCard(label, value, unit, reference, aboveReference, options = {}) {
  const { analyticalStatus, reportingLimit } = options;
  const card = document.createElement('article');

  let cardClass = 'metric-card';
  if (aboveReference) cardClass += ' above-reference';
  if (analyticalStatus === ANALYTICAL_STATUS.BELOW_REPORTING_LIMIT) cardClass += ' below-limit';
  if (analyticalStatus === ANALYTICAL_STATUS.MISSING_INPUT) cardClass += ' not-calculable';
  if (analyticalStatus === ANALYTICAL_STATUS.INVALID_SPECTRUM) cardClass += ' invalid-spectrum';
  card.className = cardClass;

  const ariaLabel = `${label}: ${value} ${unit}. ${statusLabel(analyticalStatus) || 'Cuantificado'}`;
  card.setAttribute('aria-label', ariaLabel);

  const labelElement = document.createElement('span');
  labelElement.textContent = label;

  const valueElement = document.createElement('strong');
  const icon = statusIcon(analyticalStatus);
  valueElement.textContent = `${icon ? `${icon} ` : ''}${value} ${unit}`;

  const statusText = statusLabel(analyticalStatus);
  if (statusText && analyticalStatus !== ANALYTICAL_STATUS.QUANTIFIED) {
    const statusTag = document.createElement('em');
    statusTag.className = 'metric-status-tag';
    statusTag.textContent = statusText;
    statusTag.setAttribute('aria-hidden', 'true');
    card.append(labelElement, valueElement, statusTag);
  } else {
    card.append(labelElement, valueElement);
  }

  const referenceElement = document.createElement('small');
  referenceElement.textContent = `Límite de referencia: < ${reference} ${unit}`;
  card.append(referenceElement);

  if (reportingLimit !== undefined && reportingLimit !== null && reportingLimit !== reference) {
    const rlElement = document.createElement('small');
    rlElement.className = 'reporting-limit-note';
    const formattedRL = Number.isInteger(reportingLimit) ? String(reportingLimit) : reportingLimit.toFixed(2);
    rlElement.textContent = `Límite de reporte: ${formattedRL} ${unit}`;
    card.append(rlElement);
  }

  return card;
}

function renderMetrics(calculation) {
  const ref = ANALYTICAL_CONFIG.references;
  const porphyrinsResult = calculation.porphyrinsResult;
  const porphyrinsRatioResult = calculation.porphyrinsRatioResult;

  const pbgMetrics = [
    ['PBG cuantitativo', calculation.display.pbgUgMl, 'µg/mL', ref.pbgUgMlUpper, 'pbgUgMl', {}],
    ['PBG urinario', calculation.display.pbgUmolDl, 'µmol/dL', ref.pbgUmolDlUpper, 'pbgUmolDl', {}],
    ['PBG / creatinina', calculation.display.pbgCreatinine, 'µmol/mmol', ref.pbgCreatinineUpper, 'pbgCreatinine', {}]
  ];

  const porphyrinsMetrics = [
    [
      'Porfirinas totales',
      porphyrinsResult.displayValue,
      porphyrinsResult.unit,
      ref.porphyrinsNmolDlUpper,
      'porphyrinsNmolDl',
      {
        analyticalStatus: porphyrinsResult.analyticalStatus,
        qualifier: porphyrinsResult.qualifier,
        reportingLimit: porphyrinsResult.reportingLimit
      }
    ],
    [
      'Porfirinas / creatinina',
      porphyrinsRatioResult.displayValue,
      porphyrinsRatioResult.unit,
      ref.porphyrinsCreatinineUpper,
      'porphyrinsCreatinine',
      {
        analyticalStatus: porphyrinsRatioResult.analyticalStatus,
        qualifier: porphyrinsRatioResult.qualifier,
        reportingLimit: porphyrinsRatioResult.reportingLimit
      }
    ]
  ];

  const allMetrics = [...pbgMetrics, ...porphyrinsMetrics];

  elements.metricsGrid.replaceChildren(...allMetrics.map(([label, value, unit, reference, metric, options]) => {
    const numericVal = Number(String(value).replace('<', ''));
    const above = options.analyticalStatus === ANALYTICAL_STATUS.QUANTIFIED
      ? isAboveReference(metric, numericVal)
      : false;
    return createMetricCard(label, value, unit, reference, above, options);
  }));
}

function svgElement(name, attributes = {}, text = '') {
  const element = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  if (text) element.textContent = text;
  return element;
}

function renderChart(calculation) {
  const svg = elements.spectrumChart;
  svg.replaceChildren();

  const width = 900;
  const height = 360;
  const padding = { left: 72, right: 38, top: 32, bottom: 58 };
  const spectrum = calculation.spectrum;
  const sa = calculation.spectralAnalysis;
  const xMin = spectrum[0].wavelength;
  const xMax = spectrum[spectrum.length - 1].wavelength;
  const yMaxActual = Math.max(
    ...spectrum.map(point => point.absorbance),
    sa.baselineAtPeak,
    0.05
  );
  const yMax = yMaxActual * 1.15;

  const xScale = value => padding.left + ((value - xMin) / (xMax - xMin)) * (width - padding.left - padding.right);
  const yScale = value => height - padding.bottom - (value / yMax) * (height - padding.top - padding.bottom);

  const background = svgElement('rect', {
    x: 0, y: 0, width, height, rx: 12, fill: '#ffffff'
  });
  svg.append(background);

  for (let i = 0; i <= 5; i += 1) {
    const value = (yMax / 5) * i;
    const y = yScale(value);
    svg.append(
      svgElement('line', { x1: padding.left, y1: y, x2: width - padding.right, y2: y, stroke: '#e2e8f0', 'stroke-width': 1 }),
      svgElement('text', { x: padding.left - 10, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#64748b' }, value.toFixed(3))
    );
  }

  spectrum.forEach(point => {
    const x = xScale(point.wavelength);
    svg.append(
      svgElement('line', { x1: x, y1: padding.top, x2: x, y2: height - padding.bottom, stroke: '#f1f5f9', 'stroke-width': 1 }),
      svgElement('text', { x, y: height - padding.bottom + 20, 'text-anchor': 'middle', 'font-size': 11, fill: '#64748b' }, String(point.wavelength))
    );
  });

  svg.append(
    svgElement('line', { x1: padding.left, y1: height - padding.bottom, x2: width - padding.right, y2: height - padding.bottom, stroke: '#94a3b8', 'stroke-width': 2 }),
    svgElement('line', { x1: padding.left, y1: padding.top, x2: padding.left, y2: height - padding.bottom, stroke: '#94a3b8', 'stroke-width': 2 }),
    svgElement('text', { x: width / 2, y: height - 12, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: '#475569' }, 'Longitud de onda (nm)'),
    svgElement('text', { x: 18, y: height / 2, transform: `rotate(-90 18 ${height / 2})`, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: '#475569' }, 'Absorbancia (D.O.)')
  );

  const measuredPath = spectrum.map((point, index) =>
    `${index === 0 ? 'M' : 'L'} ${xScale(point.wavelength)} ${yScale(point.absorbance)}`
  ).join(' ');
  svg.append(svgElement('path', {
    d: measuredPath,
    fill: 'none',
    stroke: '#075985',
    'stroke-width': 3,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round'
  }));

  const first = spectrum[0];
  const last = spectrum[spectrum.length - 1];
  svg.append(svgElement('line', {
    x1: xScale(first.wavelength), y1: yScale(first.absorbance),
    x2: xScale(last.wavelength), y2: yScale(last.absorbance),
    stroke: '#b91c1c', 'stroke-width': 2, 'stroke-dasharray': '7 5'
  }));

  const peakX = xScale(sa.peakWavelength);
  if (sa.hasInternalPeak && sa.rawCorrectedSignal > 0) {
    svg.append(svgElement('line', {
      x1: peakX, y1: yScale(sa.baselineAtPeak),
      x2: peakX, y2: yScale(sa.peakAbsorbance),
      stroke: '#047857', 'stroke-width': 3, 'stroke-dasharray': '3 4'
    }));
  }

  spectrum.forEach(point => {
    const isPeak = point.wavelength === sa.peakWavelength;
    svg.append(svgElement('circle', {
      cx: xScale(point.wavelength),
      cy: yScale(point.absorbance),
      r: isPeak ? 6 : 4,
      fill: isPeak ? (sa.isEndpointMaximum ? '#d97706' : '#0c4a6e') : '#0284c7',
      stroke: '#fff',
      'stroke-width': 2
    }));
  });

  const peakLabelY = Math.max(padding.top + 15, yScale(sa.peakAbsorbance) - 16);

  if (sa.isEndpointMaximum) {
    const labelText = `Máx. ${sa.peakWavelength} nm — extremo`;
    const labelWidth = Math.max(labelText.length * 6.5, 140);
    svg.append(
      svgElement('rect', { x: peakX - labelWidth / 2, y: peakLabelY - 17, width: labelWidth, height: 24, rx: 5, fill: '#92400e' }),
      svgElement('text', { x: peakX, y: peakLabelY, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 800, fill: '#fff' }, labelText)
    );
  } else {
    svg.append(
      svgElement('rect', { x: peakX - 46, y: peakLabelY - 17, width: 92, height: 24, rx: 5, fill: '#0c4a6e' }),
      svgElement('text', { x: peakX, y: peakLabelY, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 800, fill: '#fff' }, `Pico ${sa.peakWavelength} nm`)
    );
  }

  if (!sa.hasInternalPeak) {
    const statusNote = sa.isEndpointMaximum
      ? 'Sin pico interno cuantificable — máximo en extremo del intervalo'
      : 'Sin pico interno cuantificable — señal corregida no positiva';
    svg.append(
      svgElement('text', {
        x: width / 2, y: padding.top - 8,
        'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: '#92400e'
      }, statusNote)
    );
  }
}

function renderInterpretation(calculation) {
  elements.interpretationCard.className = `interpretation-card ${calculation.interpretation.level}`;
  elements.interpretationCard.replaceChildren();

  const title = document.createElement('h3');
  title.textContent = calculation.interpretation.title;
  const text = document.createElement('p');
  text.textContent = calculation.interpretation.text;
  elements.interpretationCard.append(title, text);

  elements.warningsList.replaceChildren();
  if (calculation.warnings.length === 0) {
    elements.warningsList.classList.add('hidden');
    return;
  }

  const warningTitle = document.createElement('h3');
  warningTitle.textContent = 'Advertencias analíticas';
  const list = document.createElement('ul');
  list.setAttribute('role', 'list');
  calculation.warnings.forEach(warning => {
    const item = document.createElement('li');
    item.textContent = warning;
    list.append(item);
  });
  elements.warningsList.append(warningTitle, list);
  elements.warningsList.classList.remove('hidden');
}

function renderPrintPatientSummary() {
  const operator = elements.operatorName ? normalizeWhitespace(elements.operatorName.value) : '';
  const items = [
    ['Identificación', normalizeWhitespace(elements.patientId.value) || 'No indicada'],
    ['Fecha del análisis', elements.analysisDate.value || 'No indicada'],
    ['Paciente', normalizeWhitespace(elements.patientName.value) || 'No indicado'],
    ['Operador / responsable', operator || 'No indicado'],
    ['Archivo espectral', state.importedSpectrumFile || 'Ingreso manual'],
    ['Versión de la aplicación', APP_VERSION],
    ['Versión del algoritmo', ALGORITHM_VERSION],
    ['Fecha de generación', new Date().toLocaleString('es-CR')]
  ];

  elements.printPatientSummary.replaceChildren(...items.map(([label, value]) => {
    const wrapper = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = `${label}: `;
    const text = document.createTextNode(value);
    wrapper.append(strong, text);
    return wrapper;
  }));

  const hasId = normalizeWhitespace(elements.patientId.value).length > 0;
  const hasName = normalizeWhitespace(elements.patientName.value).length >= 2;
  const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(elements.analysisDate.value);
  const hasOperator = operator.length >= 2;
  const isComplete = hasId && hasName && hasDate && hasOperator && state.latestCalculation;

  elements.resultsSection.classList.toggle('draft-report', !isComplete);
}

function calculateAndRender({ silent = false } = {}) {
  clearAnalyticalErrors();
  let calculation;

  try {
    calculation = calculateAnalysis(collectAnalyticalInputs());
  } catch (error) {
    state.latestCalculation = null;
    elements.saveButton.disabled = true;
    if (error instanceof ValidationError) displayValidationError(error);
    else {
      showToast('No fue posible completar el cálculo.', 'error');
    }
    return null;
  }

  state.latestCalculation = calculation;
  renderMetrics(calculation);
  renderChart(calculation);
  renderInterpretation(calculation);
  renderPrintPatientSummary();
  elements.resultsSection.classList.remove('hidden');
  elements.saveButton.disabled = false;
  elements.calculationState.classList.remove('dirty');
  const patientChangedFromLoaded = state.currentRecordId && state.loadedPatientSignature !== patientSignature();
  elements.calculationState.textContent = patientChangedFromLoaded
    ? 'Los datos del paciente cambiaron. Guardar creará un registro nuevo.'
    : state.currentRecordId
      ? 'Cálculo actualizado. Guardar modificará el registro cargado.'
      : 'Cálculo actualizado y listo para guardar.';

  if (!silent) {
    showToast('Cálculo finalizado.', 'success');
    elements.resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return calculation;
}

function currentPatientData() {
  const operator = elements.operatorName ? normalizeWhitespace(elements.operatorName.value) : '';
  return {
    idNumber: normalizeWhitespace(elements.patientId.value),
    name: normalizeWhitespace(elements.patientName.value),
    analysisDate: elements.analysisDate.value,
    operator
  };
}

function patientSignature(patient = currentPatientData()) {
  return [patient.idNumber, patient.name, patient.analysisDate]
    .map(value => normalizeWhitespace(value).toLocaleLowerCase('es'))
    .join('|');
}

function buildRecord(calculation, existing = null) {
  const now = new Date().toISOString();
  return {
    id: existing?.id || createId(),
    schemaVersion: 2,
    algorithmVersion: ALGORITHM_VERSION,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    patient: currentPatientData(),
    inputs: collectAnalyticalInputs(),
    spectralFileName: state.importedSpectrumFile || null,
    result: calculation
  };
}

async function saveCurrentRecord() {
  if (!validatePatient()) {
    showToast('Corrija los datos del paciente antes de guardar.', 'error');
    return;
  }

  const calculation = calculateAndRender({ silent: true });
  if (!calculation) return;

  try {
    const loadedRecord = state.currentRecordId ? await getRecord(state.currentRecordId) : null;
    const patientChanged = loadedRecord && state.loadedPatientSignature !== patientSignature();
    const existing = patientChanged ? null : loadedRecord;
    const record = buildRecord(calculation, existing);
    await saveRecord(record);
    state.currentRecordId = record.id;
    state.loadedPatientSignature = patientSignature(record.patient);
    await refreshHistory();
    elements.calculationState.textContent = 'Registro guardado. Los cambios posteriores requerirán recalcular.';
    showToast(existing ? 'Registro actualizado.' : patientChanged ? 'Los datos del paciente cambiaron; se creó un registro nuevo.' : 'Registro guardado en este dispositivo.', 'success');
  } catch (error) {
    showToast(`No se pudo guardar: ${error.message}`, 'error');
  }
}

function clearForm({ preserveDate = true } = {}) {
  elements.patientId.value = '';
  elements.patientName.value = '';
  elements.analysisDate.value = preserveDate ? localDateString() : '';
  if (elements.operatorName) elements.operatorName.value = '';
  elements.pbgAbsorbance.value = '0.0200';
  elements.creatinine.value = '76.00';
  buildSpectrumRows();
  clearAnalyticalErrors();
  setError(elements.patientId);
  setError(elements.patientName);
  setError(elements.analysisDate);
  state.latestCalculation = null;
  state.currentRecordId = null;
  state.loadedPatientSignature = null;
  state.importedSpectrumFile = null;
  if (elements.spectrumFileInfo) elements.spectrumFileInfo.textContent = '';
  elements.resultsSection.classList.add('hidden');
  elements.saveButton.disabled = true;
  elements.calculationState.textContent = 'Los resultados se actualizarán al calcular.';
  elements.calculationState.classList.remove('dirty');
}

const DEMO_CASES = Object.freeze({
  normal: {
    patientId: 'DEMO-001',
    patientName: 'Control de calidad interno',
    absorbancePbg: 0.0003,
    creatinine: 110,
    spectrum: { 370: 0.0050, 380: 0.0045, 390: 0.0040, 400: 0.0038, 410: 0.0035, 420: 0.0030, 425: 0.0028, 440: 0.0022 }
  },
  pbg: {
    patientId: 'DEMO-002',
    patientName: 'Muestra sintética PBG elevado',
    absorbancePbg: 0.0120,
    creatinine: 80,
    spectrum: { 370: 0.0120, 380: 0.0140, 390: 0.0180, 400: 0.0260, 410: 0.0240, 420: 0.0190, 425: 0.0160, 440: 0.0110 }
  },
  porphyrins: {
    patientId: 'DEMO-003',
    patientName: 'Muestra sintética porfirinas elevadas',
    absorbancePbg: 0.0004,
    creatinine: 95,
    spectrum: { 370: 0.0220, 380: 0.0380, 390: 0.0950, 400: 0.3800, 410: 0.1950, 420: 0.0750, 425: 0.0510, 440: 0.0180 }
  }
});

function loadDemo(type) {
  const demo = DEMO_CASES[type];
  if (!demo) return;

  state.currentRecordId = null;
  state.loadedPatientSignature = null;
  state.importedSpectrumFile = null;
  elements.patientId.value = demo.patientId;
  elements.patientName.value = demo.patientName;
  elements.analysisDate.value = localDateString();
  elements.pbgAbsorbance.value = demo.absorbancePbg.toFixed(4);
  elements.creatinine.value = demo.creatinine.toFixed(2);
  buildSpectrumRows(demo.spectrum);
  validatePatient();
  calculateAndRender({ silent: true });
  showToast('Datos de demostración cargados.', 'info');
}

function recordSearchText(record) {
  return [
    record.patient?.analysisDate,
    record.patient?.idNumber,
    record.patient?.name,
    record.result?.interpretation?.title
  ].map(value => String(value || '').toLocaleLowerCase('es')).join(' ');
}

function createActionButton(label, className, action, id) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button small ${className}`;
  button.dataset.action = action;
  button.dataset.id = id;
  button.textContent = label;
  return button;
}

function renderHistory() {
  const query = normalizeWhitespace(elements.historySearch.value).toLocaleLowerCase('es');
  const visibleRecords = query
    ? state.records.filter(record => recordSearchText(record).includes(query))
    : state.records;

  elements.historyBody.replaceChildren();
  elements.recordCount.textContent = `${visibleRecords.length} de ${state.records.length} registro${state.records.length === 1 ? '' : 's'}`;

  if (visibleRecords.length === 0) {
    const row = document.createElement('tr');
    row.className = 'empty-row';
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.textContent = state.records.length === 0
      ? 'No hay registros guardados en este dispositivo.'
      : 'No hay registros que coincidan con la búsqueda.';
    row.append(cell);
    elements.historyBody.append(row);
    return;
  }

  visibleRecords.forEach(record => {
    const row = document.createElement('tr');

    const porphDisplay = record.result?.porphyrinsResult?.displayValue
      ?? record.result?.display?.porphyrinsNmolDl
      ?? '';

    const values = [
      record.patient?.analysisDate || '',
      record.patient?.idNumber || 'Sin identificación',
      record.patient?.name || '',
      record.result?.display?.pbgUgMl || '',
      porphDisplay
    ];

    values.forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      row.append(cell);
    });

    const interpretationCell = document.createElement('td');
    const badge = document.createElement('span');
    const level = record.result?.interpretation?.level || 'info';
    badge.className = `interpretation-badge ${level}`;
    badge.textContent = record.result?.interpretation?.title || 'Sin interpretación';
    interpretationCell.append(badge);
    row.append(interpretationCell);

    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions-cell';
    actionsCell.append(
      createActionButton('Cargar', 'secondary', 'load', record.id),
      document.createTextNode(' '),
      createActionButton('Eliminar', 'danger', 'delete', record.id)
    );
    row.append(actionsCell);
    elements.historyBody.append(row);
  });
}

async function refreshHistory() {
  try {
    state.records = await listRecords();
    renderHistory();
  } catch (error) {
    showToast(`No se pudo leer el historial: ${error.message}`, 'error');
  }
}

async function loadRecordIntoForm(id) {
  try {
    const record = await getRecord(id);
    if (!record) {
      showToast('El registro ya no existe.', 'error');
      await refreshHistory();
      return;
    }

    state.currentRecordId = record.id;
    state.loadedPatientSignature = patientSignature(record.patient);
    state.importedSpectrumFile = record.spectralFileName || null;
    elements.patientId.value = record.patient?.idNumber || '';
    elements.patientName.value = record.patient?.name || '';
    elements.analysisDate.value = record.patient?.analysisDate || localDateString();
    if (elements.operatorName) elements.operatorName.value = record.patient?.operator || '';
    elements.pbgAbsorbance.value = Number(record.inputs?.absorbancePbg ?? 0).toFixed(4);
    elements.creatinine.value = Number(record.inputs?.creatinineMgDl ?? 0).toFixed(2);

    if (elements.spectrumFileInfo) {
      elements.spectrumFileInfo.textContent = state.importedSpectrumFile
        ? `Archivo: ${state.importedSpectrumFile}`
        : '';
    }

    const spectrumMap = Object.fromEntries((record.inputs?.spectrum || []).map(point => [point.wavelength, point.absorbance]));
    buildSpectrumRows(spectrumMap);
    validatePatient();
    calculateAndRender({ silent: true });
    elements.calculationState.textContent = 'Registro cargado. Guardar actualizará este mismo registro.';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    showToast('Registro cargado.', 'success');
  } catch (error) {
    showToast(`No se pudo cargar el registro: ${error.message}`, 'error');
  }
}

async function removeRecord(id) {
  const record = state.records.find(item => item.id === id);
  if (!record) return;
  const confirmed = window.confirm(`¿Eliminar el registro de ${record.patient?.name || 'este paciente'}? Esta acción no se puede deshacer.`);
  if (!confirmed) return;

  try {
    await deleteRecord(id);
    if (state.currentRecordId === id) {
      state.currentRecordId = null;
      state.loadedPatientSignature = null;
    }
    await refreshHistory();
    showToast('Registro eliminado.', 'success');
  } catch (error) {
    showToast(`No se pudo eliminar: ${error.message}`, 'error');
  }
}

function downloadBlob(content, mimeType, filename) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJsonBackup() {
  if (state.records.length === 0) {
    showToast('No hay registros para respaldar.', 'warning');
    return;
  }

  const payload = {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    appVersion: APP_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    exportedAt: new Date().toISOString(),
    records: state.records
  };
  const filename = `porfirias-pbg-respaldo-${localDateString()}.json`;
  downloadBlob(JSON.stringify(payload, null, 2), 'application/json;charset=utf-8', filename);
  showToast('Respaldo JSON generado.', 'success');
}

function protectSpreadsheetCell(value) {
  const text = String(value ?? '');
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  const protectedValue = protectSpreadsheetCell(value).replace(/"/g, '""');
  return `"${protectedValue}"`;
}

function exportCsv() {
  if (state.records.length === 0) {
    showToast('No hay registros para exportar.', 'warning');
    return;
  }

  const headers = [
    'Fecha', 'Identificación', 'Paciente', 'PBG_ug_mL', 'PBG_umol_dL',
    'PBG_Creatinina_umol_mmol', 'Porfirinas_nmol_dL', 'Porfirinas_Calificador',
    'Porfirinas_Creatinina_nmol_mmol', 'Porfirinas_Creatinina_Calificador',
    'Estado_Analitico', 'Absorbancia_PBG_555nm', 'Creatinina_mg_dL',
    'Pico_nm', 'Interpretación', 'Advertencias'
  ];

  const rows = state.records.map(record => {
    const pRes = record.result?.porphyrinsResult;
    const prRes = record.result?.porphyrinsRatioResult;
    return [
      record.patient?.analysisDate,
      record.patient?.idNumber,
      record.patient?.name,
      record.result?.display?.pbgUgMl,
      record.result?.display?.pbgUmolDl,
      record.result?.display?.pbgCreatinine,
      pRes?.displayValue ?? record.result?.display?.porphyrinsNmolDl,
      pRes?.qualifier ?? '',
      prRes?.displayValue ?? record.result?.display?.porphyrinsCreatinine,
      prRes?.qualifier ?? '',
      pRes?.analyticalStatus ?? '',
      record.inputs?.absorbancePbg,
      record.inputs?.creatinineMgDl,
      record.result?.display?.peakWavelength,
      record.result?.interpretation?.title,
      (record.result?.warnings || []).join(' | ')
    ].map(csvCell).join(',');
  });

  const csv = `\uFEFF${headers.map(csvCell).join(',')}\r\n${rows.join('\r\n')}\r\n`;
  downloadBlob(csv, 'text/csv;charset=utf-8', `porfirias-pbg-${localDateString()}.csv`);
  showToast('CSV generado para análisis tabular. Use JSON para restaurar respaldos.', 'success');
}

function safeString(value, maxLength, fallback = '') {
  return normalizeWhitespace(value).slice(0, maxLength) || fallback;
}

function normalizeImportedRecord(record) {
  if (!record || typeof record !== 'object') throw new Error('Se encontró un registro inválido.');

  const name = safeString(record.patient?.name, 120);
  const idNumber = safeString(record.patient?.idNumber, 24);
  const analysisDate = String(record.patient?.analysisDate || '').slice(0, 10);
  if (!name) throw new Error('Un registro no contiene nombre de paciente.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(analysisDate)) throw new Error('Un registro contiene una fecha inválida.');

  const inputs = {
    absorbancePbg: Number(record.inputs?.absorbancePbg),
    creatinineMgDl: Number(record.inputs?.creatinineMgDl),
    spectrum: Array.isArray(record.inputs?.spectrum)
      ? record.inputs.spectrum.map(point => ({
          wavelength: Number(point.wavelength),
          absorbance: Number(point.absorbance)
        }))
      : []
  };

  const recalculated = calculateAnalysis(inputs);
  const createdAt = Number.isFinite(Date.parse(record.createdAt)) ? new Date(record.createdAt).toISOString() : new Date().toISOString();
  const updatedAt = Number.isFinite(Date.parse(record.updatedAt)) ? new Date(record.updatedAt).toISOString() : createdAt;

  return {
    id: safeString(record.id, 120, createId()),
    schemaVersion: 2,
    algorithmVersion: ALGORITHM_VERSION,
    createdAt,
    updatedAt,
    patient: { idNumber, name, analysisDate, operator: safeString(record.patient?.operator, 120) },
    inputs,
    spectralFileName: record.spectralFileName || null,
    result: recalculated
  };
}

async function parseImportFile(file) {
  if (file.size > 10 * 1024 * 1024) throw new Error('El respaldo supera el límite de 10 MB.');
  const text = await file.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('El archivo no contiene JSON válido.');
  }

  if (payload?.schema !== BACKUP_SCHEMA || payload?.version !== BACKUP_VERSION || !Array.isArray(payload.records)) {
    throw new Error('El archivo no corresponde a un respaldo compatible de Porfirinas y PBG.');
  }
  if (payload.records.length > 10000) throw new Error('El respaldo contiene demasiados registros.');

  return payload.records.map(normalizeImportedRecord);
}

async function handleImportFile(file) {
  try {
    const records = await parseImportFile(file);
    state.pendingImport = records;
    elements.importDialogSummary.textContent = `El respaldo contiene ${records.length} registro${records.length === 1 ? '' : 's'}. Puede combinarlo con el historial actual o reemplazar completamente el historial de este dispositivo.`;
    elements.importDialog.showModal();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    elements.importInput.value = '';
  }
}

async function handleSpectrumXlsxImport(file) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const result = await parseSpectralXlsx(arrayBuffer);

    const spectrumMap = Object.fromEntries(
      result.spectrum.map(p => [p.wavelength, p.absorbance])
    );
    buildSpectrumRows(spectrumMap);

    state.importedSpectrumFile = file.name;
    if (elements.spectrumFileInfo) {
      elements.spectrumFileInfo.textContent = `Archivo: ${file.name} · ${result.metadata.totalDataRows} puntos · ${result.metadata.wavelengthRange}`;
    }

    markCalculationDirty();

    if (result.warnings.length > 0) {
      result.warnings.forEach(w => showToast(w, 'warning'));
    }

    showToast(`Espectro importado desde ${file.name}.`, 'success');
  } catch (error) {
    showToast(`Error al importar espectro: ${error.message}`, 'error');
  } finally {
    if (elements.spectrumFileInput) elements.spectrumFileInput.value = '';
  }
}

async function executeImport(mode) {
  if (!state.pendingImport) return;
  try {
    await importRecords(state.pendingImport, mode);
    const count = state.pendingImport.length;
    state.pendingImport = null;
    elements.importDialog.close();
    await refreshHistory();
    showToast(`${count} registro${count === 1 ? '' : 's'} importado${count === 1 ? '' : 's'}.`, 'success');
  } catch (error) {
    showToast(`No se pudo importar: ${error.message}`, 'error');
  }
}

async function deleteAllRecords() {
  if (state.records.length === 0) {
    showToast('El historial ya está vacío.', 'info');
    return;
  }
  const confirmed = window.confirm('¿Eliminar todos los registros locales? Exporte un respaldo JSON antes de continuar. Esta acción no se puede deshacer.');
  if (!confirmed) return;

  try {
    await clearRecords();
    state.currentRecordId = null;
    state.loadedPatientSignature = null;
    await refreshHistory();
    showToast('Todos los registros fueron eliminados.', 'success');
  } catch (error) {
    showToast(`No se pudo vaciar el historial: ${error.message}`, 'error');
  }
}

function updateConnectionStatus() {
  const online = navigator.onLine;
  elements.connectionStatus.textContent = online ? 'En línea' : 'Sin conexión';
  elements.connectionStatus.classList.toggle('online', online);
  elements.connectionStatus.classList.toggle('offline', !online);
}

function showUpdateAvailable(worker) {
  state.waitingWorker = worker;
  elements.updateBanner.classList.remove('hidden');
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });

    if (registration.waiting && navigator.serviceWorker.controller) {
      showUpdateAvailable(registration.waiting);
    }

    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateAvailable(worker);
        }
      });
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (state.reloadingForUpdate) return;
      state.reloadingForUpdate = true;
      window.location.reload();
    });
  } catch {
    showToast('La aplicación funciona, pero el modo offline no pudo activarse.', 'warning');
  }
}

function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    elements.installButton.classList.remove('hidden');
  });

  window.addEventListener('appinstalled', () => {
    state.deferredInstallPrompt = null;
    elements.installButton.classList.add('hidden');
    showToast('Aplicación instalada.', 'success');
  });
}

async function installApp() {
  if (!state.deferredInstallPrompt) return;
  state.deferredInstallPrompt.prompt();
  await state.deferredInstallPrompt.userChoice;
  state.deferredInstallPrompt = null;
  elements.installButton.classList.add('hidden');
}

function attachEventListeners() {
  elements.calculateButton.addEventListener('click', () => calculateAndRender());
  elements.saveButton.addEventListener('click', saveCurrentRecord);
  elements.printButton.addEventListener('click', () => {
    if (!state.latestCalculation) {
      showToast('Calcule los resultados antes de imprimir.', 'warning');
      return;
    }
    renderPrintPatientSummary();
    window.print();
  });
  elements.clearFormButton.addEventListener('click', () => {
    const hasData = normalizeWhitespace(elements.patientName.value) || state.latestCalculation;
    if (!hasData || window.confirm('¿Limpiar el formulario actual? Los registros ya guardados no se eliminarán.')) clearForm();
  });
  elements.resetSpectrumButton.addEventListener('click', () => {
    buildSpectrumRows();
    state.importedSpectrumFile = null;
    if (elements.spectrumFileInfo) elements.spectrumFileInfo.textContent = '';
    markCalculationDirty();
    showToast('Espectro restablecido.', 'info');
  });

  if (elements.importSpectrumButton && elements.spectrumFileInput) {
    elements.importSpectrumButton.addEventListener('click', () => elements.spectrumFileInput.click());
    elements.spectrumFileInput.addEventListener('change', event => {
      const [file] = event.target.files;
      if (file) handleSpectrumXlsxImport(file);
    });
  }

  document.querySelectorAll('.demo-button').forEach(button => {
    button.addEventListener('click', () => loadDemo(button.dataset.demo));
  });

  const dirtyFields = [
    elements.patientId,
    elements.patientName,
    elements.analysisDate,
    elements.pbgAbsorbance,
    elements.creatinine,
    elements.spectrumBody
  ].filter(Boolean);
  dirtyFields.forEach(element => element.addEventListener('input', markCalculationDirty));

  if (elements.operatorName) {
    elements.operatorName.addEventListener('input', markCalculationDirty);
  }

  elements.patientId.addEventListener('blur', validatePatient);
  elements.patientName.addEventListener('blur', validatePatient);
  elements.analysisDate.addEventListener('change', validatePatient);

  elements.historySearch.addEventListener('input', renderHistory);
  elements.historyBody.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'load') loadRecordIntoForm(button.dataset.id);
    if (button.dataset.action === 'delete') removeRecord(button.dataset.id);
  });

  elements.exportJsonButton.addEventListener('click', exportJsonBackup);
  elements.exportCsvButton.addEventListener('click', exportCsv);
  elements.importButton.addEventListener('click', () => elements.importInput.click());
  elements.importInput.addEventListener('change', event => {
    const [file] = event.target.files;
    if (file) handleImportFile(file);
  });
  elements.deleteAllButton.addEventListener('click', deleteAllRecords);
  elements.importMergeButton.addEventListener('click', event => {
    event.preventDefault();
    executeImport('merge');
  });
  elements.importReplaceButton.addEventListener('click', event => {
    event.preventDefault();
    executeImport('replace');
  });
  elements.importCancelButton.addEventListener('click', () => {
    state.pendingImport = null;
  });
  elements.importDialog.addEventListener('cancel', () => {
    state.pendingImport = null;
  });

  elements.installButton.addEventListener('click', installApp);
  elements.updateButton.addEventListener('click', () => {
    if (state.waitingWorker) state.waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  });
  window.addEventListener('online', updateConnectionStatus);
  window.addEventListener('offline', updateConnectionStatus);
}

async function initialize() {
  elements.appVersion.textContent = `Versión ${APP_VERSION}`;
  elements.analysisDate.value = localDateString();
  buildSpectrumRows();
  attachEventListeners();
  updateConnectionStatus();
  setupInstallPrompt();
  registerServiceWorker();

  try {
    const migration = await migrateLegacyStorage();
    if (migration.migrated > 0) {
      showToast(`${migration.migrated} registro${migration.migrated === 1 ? '' : 's'} migrado${migration.migrated === 1 ? '' : 's'} a la base local.`, 'success');
    } else if (migration.warning) {
      showToast(migration.warning, 'warning');
    }
  } catch (error) {
    showToast(`No se pudo migrar el historial anterior: ${error.message}`, 'warning');
  }

  await refreshHistory();
}

initialize();
