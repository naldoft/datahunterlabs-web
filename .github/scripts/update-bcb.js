/**
 * update-bcb.js
 * Actualiza index.html con datos del BCB en una sola corrida idempotente:
 *   1. TCO (Tipo de Cambio Oficial) — promedio ponderado diario → TCO_DATA / TCO_OFICIAL / TCO_FECHA
 *   2. Ranking de bancos — tasa de compra por entidad → BANK_RANKING / BANK_RANKING_FECHA
 *   3. RIN (Reservas Internacionales Netas) — serie mensual → RIN_DATA
 *
 * Cada bloque se reconstruye completo desde la fuente (auto-reparable). Si nada
 * cambió, el script sale con exit 2 y no genera commit. TCO es obligatorio;
 * bancos y RIN son best-effort (si su fuente falla, no rompen la corrida).
 *
 * Cadencias reales: TCO y bancos = diario (días hábiles); RIN = mensual.
 * Por eso corre cada hora pero solo commitea cuando hay dato nuevo.
 *
 * Uso: node .github/scripts/update-bcb.js
 * Salida: exit 0 (actualizado) · exit 2 (sin cambios) · exit 1 (error de red/parseo TCO)
 */

'use strict';
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// Desde oct-2026 el CSV sin parámetros solo devuelve los últimos 2 días.
// Pasando ?desde=<inicio TCO>&hasta=<hoy+5d> recupera la serie completa.
const TCO_INICIO     = '2026-06-26';
const _hasta = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
const TCO_CSV_URL    = `https://www.bcb.gob.bo/bcb_tco_publico_descargar_csv.php?desde=${TCO_INICIO}&hasta=${_hasta}`;
const RIN_CSV_URL    = 'https://www.bcb.gob.bo/webdocs/bcb_semanal/data/reservas.csv';
const INDEX_PATH     = path.join(__dirname, '..', '..', 'index.html');

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
// Desde oct-2026 el BCB envuelve los montos en fórmula Excel: ="2.167.201"
// (con comillas dobladas). Hay que quitar los caracteres = y " antes de parsear.
function num(s) {
  if (s == null) return null;
  s = String(s).trim().replace(/[="]/g, '');
  if (!s || s === '-') return null;
  s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

/* ═══════════════ 1. TCO ═══════════════ */
// Cada fila: Fecha;Vigencia;TC;...(bancos)...;TOTAL N°;TOTAL Monto
// TCO_dia = Σ(TC × MontoTotal) / Σ(MontoTotal)
function parseTcoCsv(csv) {
  const lines = csv.split(/\r?\n/);
  const agg = {};
  for (const ln of lines) {
    if (!/^\d{4}-\d{2}-\d{2};/.test(ln)) continue;
    const c = ln.split(';');
    const fecha = c[0];
    const tc = num(c[2]);
    const montoTotal = num(c[c.length - 1]);
    if (tc == null || montoTotal == null || montoTotal <= 0) continue;
    if (!agg[fecha]) agg[fecha] = { w: 0, m: 0 };
    agg[fecha].w += tc * montoTotal;
    agg[fecha].m += montoTotal;
  }
  const fechas = Object.keys(agg).sort();
  return fechas.map(f => [f, +(agg[f].w / agg[f].m).toFixed(2)]);
}

function buildTcoMapCode(serie) {
  let body = '';
  for (let i = 0; i < serie.length; i += 4) {
    const chunk = serie.slice(i, i + 4).map(([f, v]) => `['${f}',${v}]`).join(',');
    body += '  ' + chunk + (i + 4 < serie.length ? ',' : '') + '\n';
  }
  return 'const TCO_DATA = new Map([\n' + body + ']);';
}

function updateTco(html, serie) {
  const [ultFecha, ultValor] = serie[serie.length - 1];
  const mapRe = /const TCO_DATA = new Map\(\[[\s\S]*?\]\);/;
  if (!mapRe.test(html)) throw new Error('No se encontró el Map TCO_DATA');
  const oficialRe = /const TCO_OFICIAL = [\d.]+;.*$/m;
  const fechaRe   = /const TCO_FECHA\s*= '[^']*';.*$/m;
  if (!oficialRe.test(html) || !fechaRe.test(html))
    throw new Error('No se encontraron TCO_OFICIAL / TCO_FECHA');
  return html
    .replace(mapRe, buildTcoMapCode(serie))
    .replace(oficialRe, `const TCO_OFICIAL = ${ultValor};              // último TCO publicado (${ultFecha}) — actualizar vía cron`)
    .replace(fechaRe,   `const TCO_FECHA   = '${ultFecha}';       // fecha de corte del último TCO — actualizar vía cron`);
}

/* ═══════════════ 2. RANKING DE BANCOS ═══════════════ */
function titleCaseBanco(raw) {
  // "Banco " se antepone siempre, así que los conectores van en minúscula en cualquier posición.
  const conectores = new Set(['de', 'la', 'del', 'y', 'las', 'los']);
  const acronimos  = new Set(['BISA', 'FIE', 'BNB']);
  const tildes = { 'union':'Unión', 'economico':'Económico', 'credito':'Crédito' };
  const words = raw.trim().toLowerCase().split(/\s+/).map(w => {
    const up = w.toUpperCase();
    if (acronimos.has(up)) return up;
    if (up === 'PYME') return 'PyME';
    if (tildes[w]) return tildes[w];   // el CSV del BCB omite las tildes
    if (conectores.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
  return 'Banco ' + words.join(' ');
}

// Ranking de bancos calculado desde el MISMO CSV del TCO (el reporte
// tco_reporte_ultima_cotizacion.php quedó congelado en ago-2026 del lado del BCB).
// Para la última fecha de corte, cada banco = promedio ponderado de sus operaciones.
function parseBanksCsv(csv) {
  const lines = csv.split(/\r?\n/);
  const hdr = lines.find(l => /^.?"?Fecha de corte"?;Vigencia/i.test(l));
  if (!hdr) return { fecha: null, banks: [] };
  const hc = hdr.split(';');
  const banks = [];
  for (let i = 3; i < hc.length; i++) {
    const name = hc[i].replace(/"/g, '').trim();
    if (/^BANCO /i.test(name)) banks.push({ name: name.replace(/^BANCO /i, ''), montoCol: i + 1 });
  }
  const dataLines = lines.filter(l => /^\d{4}-\d{2}-\d{2};/.test(l));
  if (!dataLines.length) return { fecha: null, banks: [] };
  const fecha = dataLines[dataLines.length - 1].split(';')[0];
  const rows = dataLines.filter(l => l.startsWith(fecha + ';')).map(l => l.split(';'));
  const rank = [];
  for (const b of banks) {
    let w = 0, m = 0;
    for (const c of rows) {
      const tc = num(c[2]), mt = num(c[b.montoCol]);
      if (tc != null && mt != null && mt > 0) { w += tc * mt; m += mt; }
    }
    if (m > 0) rank.push([titleCaseBanco(b.name), +(w / m).toFixed(2)]);
  }
  rank.sort((a, b) => b[1] - a[1]);
  return { fecha, banks: rank };
}

function updateBanks(html, fecha, banks) {
  if (!fecha || !banks.length) return html;
  let body = '';
  for (let i = 0; i < banks.length; i += 3) {
    const chunk = banks.slice(i, i + 3).map(([n, v]) => `['${n}',${v}]`).join(',');
    body += '  ' + chunk + (i + 3 < banks.length ? ',' : '') + '\n';
  }
  const arrRe = /const BANK_RANKING = \[[\s\S]*?\n\];/;
  const fechaRe = /const BANK_RANKING_FECHA = '[^']*';/;
  if (!arrRe.test(html) || !fechaRe.test(html)) return html;
  return html
    .replace(fechaRe, `const BANK_RANKING_FECHA = '${fecha}';`)
    .replace(arrRe, 'const BANK_RANKING = [\n' + body + '];');
}

/* ═══════════════ 3. RIN (Reservas Internacionales Netas) ═══════════════ */
function parseReservas(csv) {
  return csv.trim().split(/\r?\n/).slice(1)
    .map(l => { const p = l.split(','); return [p[0], Math.round(parseFloat(p[2]))]; })
    .filter(r => r[0] >= '2006-01-01' && isFinite(r[1]));
}

function updateRin(html, serie) {
  if (serie.length < 12) return html;
  let body = '';
  for (let i = 0; i < serie.length; i += 6) {
    const chunk = serie.slice(i, i + 6).map(([d, v]) => `['${d}',${v}]`).join(',');
    body += '  ' + chunk + (i + 6 < serie.length ? ',' : '') + '\n';
  }
  const arrRe = /const RIN_DATA = \[[\s\S]*?\n\];/;
  if (!arrRe.test(html)) return html;
  return html.replace(arrRe, 'const RIN_DATA = [\n' + body + '];');
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  try {
    let html = fs.readFileSync(INDEX_PATH, 'utf8').replace(/\r\n/g, '\n');
    const original = html;
    const changed = [];

    // 1. TCO + 2. Bancos (ambos del MISMO CSV, un solo fetch)
    console.log('📡 TCO...');
    const tcoCsv = await fetchUrl(TCO_CSV_URL);
    const tcoSerie = parseTcoCsv(tcoCsv);
    if (!tcoSerie.length) throw new Error('CSV sin filas TCO válidas');
    const [tcoFecha, tcoValor] = tcoSerie[tcoSerie.length - 1];
    const afterTco = updateTco(html, tcoSerie);
    if (afterTco !== html) { html = afterTco; changed.push(`TCO ${tcoFecha}=${tcoValor}`); }
    console.log(`   ${tcoSerie.length} días · último ${tcoFecha} = Bs ${tcoValor}`);

    // 2. Ranking de bancos — calculado del mismo CSV (best-effort)
    try {
      const { fecha, banks } = parseBanksCsv(tcoCsv);
      const afterBanks = updateBanks(html, fecha, banks);
      if (afterBanks !== html) { html = afterBanks; changed.push(`bancos ${fecha} (${banks.length})`); }
      console.log(`   bancos: ${banks.length} · corte ${fecha}`);
    } catch (e) { console.warn('   ⚠ bancos falló:', e.message); }

    // 3. RIN (best-effort)
    try {
      const rinSerie = parseReservas(await fetchUrl(RIN_CSV_URL));
      const afterRin = updateRin(html, rinSerie);
      if (afterRin !== html) { html = afterRin; changed.push(`RIN ${rinSerie[rinSerie.length-1][0]}`); }
      console.log(`   RIN: ${rinSerie.length} meses · último ${rinSerie[rinSerie.length-1].join('=')}`);
    } catch (e) { console.warn('   ⚠ RIN falló:', e.message); }

    if (html === original) {
      console.log('✅ index.html ya está al día (sin cambios).');
      process.exit(2);
    }

    fs.writeFileSync(INDEX_PATH, html, 'utf8');
    console.log('🚀 Actualizado: ' + changed.join(' | '));

    const envFile = process.env.GITHUB_OUTPUT;
    if (envFile) {
      fs.appendFileSync(envFile, `fecha=${tcoFecha}\n`);
      fs.appendFileSync(envFile, `valor=${tcoValor}\n`);
    }
    process.exit(0);

  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
