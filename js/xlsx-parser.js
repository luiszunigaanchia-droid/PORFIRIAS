import { WAVELENGTHS } from './config.js';

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIR = 0x02014b50;
const ZIP_END_OF_CENTRAL = 0x06054b50;

function findEndOfCentralDir(view) {
  for (let i = view.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === ZIP_END_OF_CENTRAL) {
      return {
        totalEntries: view.getUint16(i + 10, true),
        centralDirSize: view.getUint32(i + 12, true),
        centralDirOffset: view.getUint32(i + 16, true)
      };
    }
  }
  throw new Error('No se encontró un archivo XLSX válido (sin directorio central ZIP).');
}

function readCentralDirectory(view, buffer, eocd) {
  const entries = new Map();
  let offset = eocd.centralDirOffset;

  for (let i = 0; i < eocd.totalEntries; i++) {
    if (view.getUint32(offset, true) !== ZIP_CENTRAL_DIR) break;

    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    const nameBytes = new Uint8Array(buffer, offset + 46, nameLength);
    const filename = new TextDecoder().decode(nameBytes);

    entries.set(filename, {
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function extractLocalFileData(view, buffer, entry) {
  const offset = entry.localHeaderOffset;
  if (view.getUint32(offset, true) !== ZIP_LOCAL_HEADER) {
    throw new Error('Cabecera local ZIP inválida.');
  }
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataOffset = offset + 30 + nameLength + extraLength;
  return new Uint8Array(buffer, dataOffset, entry.compressedSize);
}

async function inflateRaw(compressed) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      'Este navegador no admite DecompressionStream. ' +
      'Use Chrome 80+, Edge 80+, Safari 16.4+ o Firefox 113+ para importar archivos Excel.'
    );
  }

  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  const writePromise = writer.write(compressed).then(() => writer.close());

  const chunks = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.byteLength;
  }

  await writePromise;

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function extractFile(view, buffer, entries, filename) {
  const entry = entries.get(filename);
  if (!entry) return null;

  const raw = extractLocalFileData(view, buffer, entry);

  if (entry.compressionMethod === 0) {
    return new TextDecoder().decode(raw);
  }

  if (entry.compressionMethod === 8) {
    const decompressed = await inflateRaw(raw);
    return new TextDecoder().decode(decompressed);
  }

  throw new Error(`Método de compresión ${entry.compressionMethod} no soportado.`);
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const siElements = doc.getElementsByTagName('si');
  const strings = [];

  for (const si of siElements) {
    const tElements = si.getElementsByTagName('t');
    let text = '';
    for (const t of tElements) {
      text += t.textContent || '';
    }
    strings.push(text);
  }

  return strings;
}

function parseSheetData(xml, sharedStrings) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const rows = doc.getElementsByTagName('row');
  const data = [];

  for (const row of rows) {
    const cells = row.getElementsByTagName('c');
    const rowData = [];

    for (const cell of cells) {
      const type = cell.getAttribute('t');
      const vElement = cell.getElementsByTagName('v')[0];
      let value = vElement ? vElement.textContent : '';

      if (type === 's') {
        const index = parseInt(value, 10);
        value = sharedStrings[index] ?? '';
      } else if (type === 'b') {
        value = value === '1';
      } else if (!type || type === 'n') {
        const num = parseFloat(value);
        value = Number.isFinite(num) ? num : value;
      }

      rowData.push(value);
    }

    data.push(rowData);
  }

  return data;
}

function listSheets(workbookXml) {
  if (!workbookXml) return [];
  const doc = new DOMParser().parseFromString(workbookXml, 'application/xml');
  const sheets = doc.getElementsByTagName('sheet');
  return Array.from(sheets).map(s => s.getAttribute('name') || '');
}

/**
 * Procesa un ArrayBuffer con estructura OOXML (.xlsx) y extrae las parejas de longitud de onda y absorbancia.
 *
 * @param {ArrayBuffer} arrayBuffer - Contenido binario del archivo Excel
 * @returns {Promise<{spectrum: Array<{wavelength: number, absorbance: number}>, metadata: Object, warnings: string[]}>}
 */
export async function parseSpectralXlsx(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength === 0) {
    throw new Error('El archivo está vacío.');
  }

  if (arrayBuffer.byteLength > 10 * 1024 * 1024) {
    throw new Error('El archivo supera el límite de 10 MB.');
  }

  const view = new DataView(arrayBuffer);
  const eocd = findEndOfCentralDir(view);
  const entries = readCentralDirectory(view, arrayBuffer, eocd);

  const workbookXml = await extractFile(view, arrayBuffer, entries, 'xl/workbook.xml');
  const sheetNames = listSheets(workbookXml);

  if (sheetNames.length === 0) {
    throw new Error('El archivo XLSX no contiene hojas de cálculo.');
  }

  const ssXml = await extractFile(view, arrayBuffer, entries, 'xl/sharedStrings.xml');
  const sharedStrings = parseSharedStrings(ssXml);

  const sheetXml = await extractFile(view, arrayBuffer, entries, 'xl/worksheets/sheet1.xml');
  if (!sheetXml) {
    throw new Error('No se encontró la primera hoja del libro.');
  }

  const data = parseSheetData(sheetXml, sharedStrings);

  if (data.length === 0) {
    throw new Error('La hoja de cálculo está vacía.');
  }

  const warnings = [];
  let startRow = 0;
  const firstRow = data[0];

  if (firstRow.length >= 2) {
    const firstVal = firstRow[0];
    const secondVal = firstRow[1];
    if (typeof firstVal === 'string' && !Number.isFinite(parseFloat(firstVal))) {
      startRow = 1;
    } else if (typeof secondVal === 'string' && !Number.isFinite(parseFloat(secondVal))) {
      startRow = 1;
    }
  }

  const rawPairs = [];
  const invalidRows = [];

  for (let i = startRow; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length < 2) continue;

    const wl = typeof row[0] === 'number' ? row[0] : parseFloat(String(row[0]).replace(',', '.'));
    const abs = typeof row[1] === 'number' ? row[1] : parseFloat(String(row[1]).replace(',', '.'));

    if (!Number.isFinite(wl) || !Number.isFinite(abs)) {
      invalidRows.push(i + 1);
      continue;
    }

    rawPairs.push({ wavelength: wl, absorbance: abs });
  }

  if (invalidRows.length > 0) {
    warnings.push(`Se ignoraron ${invalidRows.length} fila(s) con datos no numéricos (filas: ${invalidRows.slice(0, 5).join(', ')}${invalidRows.length > 5 ? '…' : ''}).`);
  }

  if (rawPairs.length === 0) {
    throw new Error('No se encontraron pares numéricos de longitud de onda y absorbancia.');
  }

  rawPairs.sort((a, b) => a.wavelength - b.wavelength);

  const seen = new Set();
  const duplicates = [];
  for (const pair of rawPairs) {
    if (seen.has(pair.wavelength)) {
      duplicates.push(pair.wavelength);
    }
    seen.add(pair.wavelength);
  }

  if (duplicates.length > 0) {
    throw new Error(`Longitudes de onda duplicadas: ${duplicates.join(', ')} nm.`);
  }

  const wlMin = rawPairs[0].wavelength;
  const wlMax = rawPairs[rawPairs.length - 1].wavelength;

  if (wlMin > WAVELENGTHS[0] || wlMax < WAVELENGTHS[WAVELENGTHS.length - 1]) {
    throw new Error(
      `El rango de longitudes de onda (${wlMin}–${wlMax} nm) no cubre el intervalo requerido ` +
      `(${WAVELENGTHS[0]}–${WAVELENGTHS[WAVELENGTHS.length - 1]} nm).`
    );
  }

  const spectrum = [];
  const wlMap = new Map(rawPairs.map(p => [p.wavelength, p.absorbance]));

  for (const targetWl of WAVELENGTHS) {
    if (wlMap.has(targetWl)) {
      spectrum.push({ wavelength: targetWl, absorbance: wlMap.get(targetWl) });
    } else {
      let lower = null;
      let upper = null;

      for (const pair of rawPairs) {
        if (pair.wavelength <= targetWl) lower = pair;
        if (pair.wavelength >= targetWl && !upper) upper = pair;
      }

      if (lower && upper && lower.wavelength !== upper.wavelength) {
        const interpolated = lower.absorbance +
          (upper.absorbance - lower.absorbance) *
          ((targetWl - lower.wavelength) / (upper.wavelength - lower.wavelength));
        spectrum.push({ wavelength: targetWl, absorbance: interpolated });
        warnings.push(
          `La longitud de onda ${targetWl} nm no está en el archivo. ` +
          `Se interpoló a partir de ${lower.wavelength} y ${upper.wavelength} nm.`
        );
      } else {
        throw new Error(
          `No se puede determinar la absorbancia para ${targetWl} nm. ` +
          `Verifique que el archivo contenga datos en el rango ${WAVELENGTHS[0]}–${WAVELENGTHS[WAVELENGTHS.length - 1]} nm.`
        );
      }
    }
  }

  for (const point of spectrum) {
    if (point.absorbance < 0) {
      throw new Error(
        `La absorbancia a ${point.wavelength} nm es negativa (${point.absorbance.toFixed(4)}). ` +
        'Verifique la calibración del instrumento y el blanco.'
      );
    }
  }

  return {
    spectrum,
    metadata: {
      sheetName: sheetNames[0] || 'Desconocida',
      totalDataRows: rawPairs.length,
      wavelengthRange: `${wlMin}–${wlMax} nm`,
      importedAt: new Date().toISOString()
    },
    warnings
  };
}
