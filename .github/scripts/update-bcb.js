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

const TCO_CSV_URL    = 'https://www.bcb.gob.bo/bcb_tco_publico_descargar_csv.php';
const TCO_REPORT_URL = 'https://www.bcb.gob.bo/tco_reporte_ultima_cotizacion.php';
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
function num(s) {
  if (s == null) return null;
  s = String(s).trim();
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
  const words = raw.trim().toLowerCase().split(/\s+/).map(w => {
    const up = w.toUpperCase();
    if (acronimos.has(up)) return up;
    if (up === 'PYME') return 'PyME';
    if (up === 'UNION') return 'Unión';   // el reporte del BCB omite la tilde
    if (conectores.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
  return 'Banco ' + words.join(' ');
}

function parseBanks(reportHtml) {
  const text = reportHtml
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const corteM = text.match(/FECHA DE CORTE:\s*([A-ZÁÉÍÓÚ]+ \d{1,2} DE [A-ZÁÉÍÓÚ]+ DE \d{4})/i);
  const fecha = corteM ? parseFechaLarga(corteM[1]) : null;
  const banks = [...text.matchAll(/BANCO ([A-ZÁÉÍÓÚ ]+?) (\d{1,2},\d{2}) /g)]
    .map(m => [titleCaseBanco(m[1]), parseFloat(m[2].replace(',', '.'))])
    .filter(b => b[1] > 0 && b[1] < 30);
  banks.sort((a, b) => b[1] - a[1]);
  return { fecha, banks };
}

// "JUEVES 20 DE AGOSTO DE 2026" → "2026-08-20"
function parseFechaLarga(s) {
  const MESES = { enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12 };
  const m = s.toLowerCase().match(/(\d{1,2}) de ([a-záéíóú]+) de (\d{4})/);
  if (!m) return null;
  const mes = MESES[m[2]];
  if (!mes) return null;
  return `${m[3]}-${String(mes).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
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

    // 1. TCO (obligatorio)
    console.log('📡 TCO...');
    const tcoSerie = parseTcoCsv(await fetchUrl(TCO_CSV_URL));
    if (!tcoSerie.length) throw new Error('CSV sin filas TCO válidas');
    const [tcoFecha, tcoValor] = tcoSerie[tcoSerie.length - 1];
    const afterTco = updateTco(html, tcoSerie);
    if (afterTco !== html) { html = afterTco; changed.push(`TCO ${tcoFecha}=${tcoValor}`); }
    console.log(`   ${tcoSerie.length} días · último ${tcoFecha} = Bs ${tcoValor}`);

    // 2. Ranking de bancos (best-effort)
    try {
      const { fecha, banks } = parseBanks(await fetchUrl(TCO_REPORT_URL));
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
