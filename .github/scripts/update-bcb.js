/**
 * update-bcb.js
 * Descarga el SVG del BCB, extrae el último valor referencial de venta
 * y actualiza index.html con el nuevo dato.
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

const SVG_URL    = 'https://www.bcb.gob.bo/valor_referencial_venta_svg.php';
const INDEX_PATH = path.join(__dirname, '..', '..', 'index.html');

// Meses en español → número
const MESES = {
  enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6,
  julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12
};

// ── Fetch con timeout ───────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, res => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Parser SVG → { fecha: 'YYYY-MM-DD', valor: number } ────────────────────
function parseLastEntry(svg) {
  // La última fila siempre tiene class "cell-text--highlight" y "cell-value--highlight"
  const dateMatch  = svg.match(/class="cell-text--highlight">([^<]+)</);
  const valueMatch = svg.match(/class="cell-value--highlight">([^<]+)</);

  if (!dateMatch || !valueMatch) {
    throw new Error('No se encontró la fila destacada en el SVG');
  }

  // Parsear fecha: "21 de mayo de 2026" → "2026-05-21"
  const parts = dateMatch[1].trim().split(' ');  // ["21","de","mayo","de","2026"]
  const day   = parts[0].padStart(2, '0');
  const mes   = MESES[parts[2].toLowerCase()];
  if (!mes) throw new Error(`Mes desconocido: ${parts[2]}`);
  const year  = parts[4];
  const fecha = `${year}-${String(mes).padStart(2,'0')}-${day}`;

  // Parsear valor: "10,13" → 10.13
  const valor = parseFloat(valueMatch[1].replace(',', '.'));
  if (isNaN(valor)) throw new Error(`Valor inválido: ${valueMatch[1]}`);

  return { fecha, valor };
}

// ── Actualizar index.html ───────────────────────────────────────────────────
function updateIndex(html, fecha, valor) {
  // 1. Verificar si la fecha ya existe en REFERENCIAL_DATA
  if (html.includes(`['${fecha}',`)) {
    console.log(`ℹ️  ${fecha} ya está en REFERENCIAL_DATA. Sin cambios.`);
    return null;
  }

  // 2. Agregar nueva entrada al final del Map
  //    La última entrada NO tiene coma al final, seguida de \n]);
  //    Ej: ['2026-05-21',10.13]\n]);
  const mapCloseRegex = /(\['20\d{2}-\d{2}-\d{2}',[\d.]+\])\n\]\);/;
  if (!mapCloseRegex.test(html)) {
    throw new Error('No se encontró el cierre del REFERENCIAL_DATA Map en index.html');
  }

  html = html.replace(mapCloseRegex, `$1,['${fecha}',${valor}]\n]);`);

  // 3. Actualizar REFERENCIAL_VENTA
  const mesCorto = fecha.slice(0, 7); // "2026-05"
  html = html.replace(
    /const REFERENCIAL_VENTA = [\d.]+;.*$/m,
    `const REFERENCIAL_VENTA = ${valor};  // BCB ${fecha} — fuente: bcb.gob.bo (actualizar vía cron)`
  );

  // 4. Actualizar comentario de última actualización
  html = html.replace(
    /\/\/ Última actualización: \d{4}-\d{2}-\d{2}/,
    `// Última actualización: ${fecha}`
  );

  return html;
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  try {
    console.log(`📡 Descargando SVG desde ${SVG_URL}...`);
    const svg = await fetchUrl(SVG_URL);

    console.log('🔍 Parseando último valor...');
    const { fecha, valor } = parseLastEntry(svg);
    console.log(`✅ Último dato BCB: ${fecha} → Bs ${valor}`);

    console.log(`📝 Leyendo ${INDEX_PATH}...`);
    // Normalizar a LF para que los regex funcionen igual en Windows y Linux
    const html = fs.readFileSync(INDEX_PATH, 'utf8').replace(/\r\n/g, '\n');

    const updated = updateIndex(html, fecha, valor);

    if (updated === null) {
      console.log('✅ index.html ya está al día.');
      process.exit(2);  // Señal de "sin cambios" para el workflow
    }

    fs.writeFileSync(INDEX_PATH, updated, 'utf8');
    console.log(`🚀 index.html actualizado: ${fecha} = Bs ${valor}`);

    // Exportar variables para el step siguiente del workflow
    const envFile = process.env.GITHUB_OUTPUT;
    if (envFile) {
      fs.appendFileSync(envFile, `fecha=${fecha}\n`);
      fs.appendFileSync(envFile, `valor=${valor}\n`);
    }

    process.exit(0);  // Hay cambios → el workflow hace commit

  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
