export const APP_VERSION = '5.0.0';
export const ALGORITHM_VERSION = '5.0.0';

export const WAVELENGTHS = Object.freeze([370, 380, 390, 400, 405, 410, 420, 425, 440]);

export const ANALYTICAL_CONFIG = Object.freeze({
  pbgUgMlFactor: 630,
  pbgUmolDlFactor: 280,
  porphyrinsNmolDlFactor: 1430,
  creatinineMgDlToMmolL: 0.0884,
  creatinineMolecularWeightMg: 113.12,
  absorbanceWarning: 2.0,
  absorbanceMaximum: 2.5,
  reportingLimits: Object.freeze({
    porphyrinsNmolDl: 15
  }),
  references: Object.freeze({
    pbgUgMlUpper: 0.3,
    pbgUmolDlUpper: 0.13,
    pbgCreatinineUpper: 1.5,
    porphyrinsNmolDlUpper: 30,
    porphyrinsCreatinineUpper: 35
  })
});

export const ANALYTICAL_STATUS = Object.freeze({
  QUANTIFIED: 'quantified',
  BELOW_REPORTING_LIMIT: 'below_reporting_limit',
  ENDPOINT_MAXIMUM: 'endpoint_maximum',
  NO_INTERNAL_PEAK: 'no_internal_peak',
  INVALID_SPECTRUM: 'invalid_spectrum',
  CALCULATION_ERROR: 'calculation_error',
  MISSING_INPUT: 'missing_input',
  MANUAL_REVIEW_REQUIRED: 'manual_review_required'
});

export const STORAGE = Object.freeze({
  databaseName: 'porfirias2-pbg-db',
  databaseVersion: 1,
  storeName: 'records',
  legacyKey: 'hematologia_db',
  migrationMarkerKey: 'porfirias2-pbg:migration-v1-complete'
});

export const BACKUP_SCHEMA = 'porfirias-pbg-backup';
export const BACKUP_VERSION = 1;
