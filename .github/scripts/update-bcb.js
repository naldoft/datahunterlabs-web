/**
 * update-bcb.js
 * Descarga el CSV histórico del Tipo de Cambio Oficial (TCO) del BCB, calcula
 * el promedio ponderado diario por fecha de corte y actualiza index.html:
 *   - Reconstruye el Map TCO_DATA con toda la serie (auto-reparable).
 *   - Actualiza las constantes TCO_OFICIAL y TCO_FECHA con el último dato.
 *
 * Contexto: desde el 26 jun 2026 el BCB reemplazó el peg fijo (Bs 6.96) y el
 * "valor referencial" por el TCO — promedio ponderado de las operaciones de
 * COMPRA de dólares de los bancos con sus clientes (flexibilización cambiaria).
 *
 * Uso: node .github/scripts/update-bcb.js
 * Salida:
 *   exit 0 — index.html actualizado (hay dato nuevo)
 *   exit 2 — ya estaba al día (sin cambios)
 *   exit 1 — error de red o parseo
 */

'use strict';
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const TCO_CSV_URL = 'https://www.bcb.gob.bo/bcb_tco_publico_descargar_csv.php';
const INDEX_PATH  = path.join(__dirname, '..', '..', 'index.html');

// ── Fetch con timeout ───────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DataHunterLabs-bot/1.0)' }
    }, res => {
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Parse número BCB: "10.107" (miles) o "9,73" (decimal) ───────────────────
function num(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (!s || s === '-') return null;
  // Formato del CSV: TC usa coma decimal (9,73); montos usan punto de miles (10.107)
  s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

// ── Calcular promedio ponderado diario del TCO desde el CSV ─────────────────
// Cada fila de datos: Fecha;Vigencia;TC;...(bancos: N°;Monto)...;TOTAL N°;TOTAL Monto
// TCO_dia = Σ(TC × MontoTotal) / Σ(MontoTotal)
function parseTcoCsv(csv) {
  const lines = csv.split(/\r?\n/);
  const agg = {}; // fecha -> { w: Σ(TC×monto), m: Σ(monto) }
  for (const ln of lines) {
    if (!/^\d{4}-\d{2}-\d{2};/.test(ln)) continue; // solo filas de datos
    const c = ln.split(';');
    const fecha = c[0];
    const tc = num(c[2]);
    const montoTotal = num(c[c.length - 1]); // última columna = TOTAL BANCOS Monto
    if (tc == null || montoTotal == null || montoTotal <= 0) continue;
    if (!agg[fecha]) agg[fecha] = { w: 0, m: 0 };
    agg[fecha].w += tc * montoTotal;
    agg[fecha].m += montoTotal;
  }
  const fechas = Object.keys(agg).sort();
  const serie = fechas.map(f => [f, +(agg[f].w / agg[f].m).toFixed(2)]);
  return serie; // [ ['2026-06-26', 9.73], ... ]
}

// ── Generar el bloque de código del Map TCO_DATA (4 pares por línea) ────────
function buildTcoMapCode(serie) {
  let body = '';
  for (let i = 0; i < serie.length; i += 4) {
    const chunk = serie.slice(i, i + 4)
      .map(([f, v]) => `['${f}',${v}]`).join(',');
    body += '  ' + chunk + (i + 4 < serie.length ? ',' : '') + '\n';
  }
  return 'const TCO_DATA = new Map([\n' + body + ']);';
}

// ── Actualizar index.html ───────────────────────────────────────────────────
function updateIndex(html, serie) {
  const [ultFecha, ultValor] = serie[serie.length - 1];

  // 1. Reemplazar el Map TCO_DATA completo
  const mapRe = /const TCO_DATA = new Map\(\[[\s\S]*?\]\);/;
  if (!mapRe.test(html))
    throw new Error('No se encontró el Map TCO_DATA en index.html');
  const newMap = buildTcoMapCode(serie);

  // 2. Reemplazar TCO_OFICIAL y TCO_FECHA
  const oficialRe = /const TCO_OFICIAL = [\d.]+;.*$/m;
  const fechaRe   = /const TCO_FECHA\s*= '[^']*';.*$/m;
  if (!oficialRe.test(html) || !fechaRe.test(html))
    throw new Error('No se encontraron las constantes TCO_OFICIAL / TCO_FECHA');

  let updated = html
    .replace(mapRe, newMap)
    .replace(oficialRe, `const TCO_OFICIAL = ${ultValor};              // último TCO publicado (${ultFecha}) — actualizar vía cron`)
    .replace(fechaRe,   `const TCO_FECHA   = '${ultFecha}';       // fecha de corte del último TCO — actualizar vía cron`);

  return { updated, ultFecha, ultValor };
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  try {
    console.log('📡 Descargando CSV del TCO (BCB)...');
    const csv = await fetchUrl(TCO_CSV_URL);
    const serie = parseTcoCsv(csv);

    if (!serie.length) throw new Error('CSV sin filas de datos TCO válidas');
    const [ultFecha, ultValor] = serie[serie.length - 1];
    console.log(`✅ TCO: ${serie.length} días · último ${ultFecha} = Bs ${ultValor}`);

    const html = fs.readFileSync(INDEX_PATH, 'utf8').replace(/\r\n/g, '\n');
    const { updated } = updateIndex(html, serie);

    if (updated === html) {
      console.log('✅ index.html ya está al día (TCO sin cambios).');
      process.exit(2);
    }

    fs.writeFileSync(INDEX_PATH, updated, 'utf8');
    console.log(`🚀 index.html actualizado — TCO ${ultFecha}: Bs ${ultValor}`);

    const envFile = process.env.GITHUB_OUTPUT;
    if (envFile) {
      fs.appendFileSync(envFile, `fecha=${ultFecha}\n`);
      fs.appendFileSync(envFile, `valor=${ultValor}\n`);
    }
    process.exit(0);

  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
