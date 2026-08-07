import { STORAGE } from './config.js';

let databasePromise;

function openDatabase() {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('Este navegador no admite IndexedDB.'));
      return;
    }

    const request = indexedDB.open(STORAGE.databaseName, STORAGE.databaseVersion);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORAGE.storeName)) {
        const store = db.createObjectStore(STORAGE.storeName, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('patientId', 'patient.idNumber', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('No se pudo abrir la base de datos local.'));
    request.onblocked = () => reject(new Error('La base de datos está bloqueada por otra pestaña de la aplicación.'));
  });

  return databasePromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Falló una operación de almacenamiento.'));
  });
}

async function withStore(mode, callback) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORAGE.storeName, mode);
    const store = transaction.objectStore(STORAGE.storeName);
    let callbackResult;

    try {
      callbackResult = callback(store, transaction);
    } catch (error) {
      reject(error);
      return;
    }

    transaction.oncomplete = async () => {
      try {
        resolve(await callbackResult);
      } catch (error) {
        reject(error);
      }
    };
    transaction.onerror = () => reject(transaction.error || new Error('La transacción local falló.'));
    transaction.onabort = () => reject(transaction.error || new Error('La transacción local fue cancelada.'));
  });
}

export async function listRecords() {
  const records = await withStore('readonly', store => requestToPromise(store.getAll()));
  return records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function getRecord(id) {
  return withStore('readonly', store => requestToPromise(store.get(id)));
}

export async function saveRecord(record) {
  await withStore('readwrite', store => requestToPromise(store.put(record)));
  return record;
}

export async function deleteRecord(id) {
  await withStore('readwrite', store => requestToPromise(store.delete(id)));
}

export async function clearRecords() {
  await withStore('readwrite', store => requestToPromise(store.clear()));
}

export async function importRecords(records, mode = 'merge') {
  if (!Array.isArray(records)) throw new Error('El respaldo no contiene una lista de registros.');

  await withStore('readwrite', store => {
    if (mode === 'replace') store.clear();
    records.forEach(record => store.put(record));
  });
}

function legacyRecordToCurrent(record) {
  const createdAt = record.createdAt || `${record.fecha || new Date().toISOString().slice(0, 10)}T12:00:00.000Z`;
  const id = typeof record.id === 'string'
    ? record.id
    : `legacy-${String(record.id || Date.now())}-${Math.random().toString(36).slice(2, 8)}`;

  const spectrum = Array.isArray(record.espectro)
    ? record.espectro.map(point => ({
        wavelength: Number(point.wl ?? point.wavelength),
        absorbance: Number(point.abs ?? point.absorbance)
      }))
    : [];

  return {
    id,
    schemaVersion: 1,
    createdAt,
    updatedAt: createdAt,
    patient: {
      idNumber: String(record.cedula || ''),
      name: String(record.nombre || ''),
      analysisDate: String(record.fecha || '').slice(0, 10)
    },
    inputs: {
      absorbancePbg: Number(record.absPBG || 0),
      creatinineMgDl: Number(record.creatinina || 0),
      spectrum
    },
    result: {
      display: {
        pbgUgMl: String(record.pbg_ug ?? ''),
        pbgUmolDl: String(record.pbg_umol ?? ''),
        pbgCreatinine: String(record.ratioPbg ?? ''),
        porphyrinsNmolDl: String(record.porf ?? ''),
        porphyrinsCreatinine: String(record.ratioPorf ?? ''),
        peakWavelength: '',
        correctedPeak: '',
        baselineAtPeak: ''
      },
      raw: {},
      interpretation: {
        code: 'legacy',
        level: 'info',
        title: String(record.interpretacion || 'Registro migrado'),
        text: 'Registro migrado desde una versión anterior. Revise los datos antes de emitir un informe.'
      },
      warnings: ['Registro migrado desde localStorage. Verifique los resultados y la configuración analítica.']
    }
  };
}

export async function migrateLegacyStorage() {
  if (localStorage.getItem(STORAGE.migrationMarkerKey) === 'true') return { migrated: 0 };

  let legacy;
  try {
    legacy = JSON.parse(localStorage.getItem(STORAGE.legacyKey) || '[]');
  } catch {
    localStorage.setItem(STORAGE.migrationMarkerKey, 'true');
    return { migrated: 0, warning: 'El historial antiguo estaba dañado y no pudo migrarse.' };
  }

  if (!Array.isArray(legacy) || legacy.length === 0) {
    localStorage.setItem(STORAGE.migrationMarkerKey, 'true');
    return { migrated: 0 };
  }

  const converted = legacy.map(legacyRecordToCurrent);
  await importRecords(converted, 'merge');
  localStorage.setItem(STORAGE.migrationMarkerKey, 'true');
  localStorage.removeItem(STORAGE.legacyKey);
  return { migrated: converted.length };
}
