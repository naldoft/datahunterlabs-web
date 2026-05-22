/**
 * update-bcb.js
 * Descarga los SVGs del BCB (venta y compra), extrae los valores del día
 * y actualiza index.html con ambos datos.
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

const SVG_VENTA_URL  = 'https://www.bcb.gob.bo/valor_referencial_venta_svg.php';
const SVG_COMPRA_URL = 'https://www.bcb.gob.bo/valor_referencial_compra_svg.php';
const INDEX_PATH     = path.join(__dirname, '..', '..', 'index.html');

const MESES = {
  enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6,
  julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12
};

// ── Fetch con timeout ───────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, res => {
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

// ── Parser venta SVG → { fecha, valor } ────────────────────────────────────
function parseVentaEntry(svg) {
  const dateMatch  = svg.match(/class="cell-text--highlight">([^<]+)</);
  const valueMatch = svg.match(/class="cell-value--highlight">([^<]+)</);
  if (!dateMatch || !valueMatch)
    throw new Error('No se encontró la fila destacada en el SVG de venta');

  const parts = dateMatch[1].trim().split(' ');
  const day   = parts[0].padStart(2, '0');
  const mes   = MESES[parts[2].toLowerCase()];
  if (!mes) throw new Error(`Mes desconocido: ${parts[2]}`);
  const fecha = `${parts[4]}-${String(mes).padStart(2,'0')}-${day}`;
  const valor = parseFloat(valueMatch[1].replace(',', '.'));
  if (isNaN(valor)) throw new Error(`Valor inválido en venta: ${valueMatch[1]}`);
  return { fecha, valor };
}

// ── Parser compra SVG → valor del last-quote ────────────────────────────────
// El SVG de compra muestra bancos individuales; el resumen es el "last-quote"
function parseCompraEntry(svg) {
  const match = svg.match(/class="last-quote">Bs ([\d,]+)\//);
  if (!match) throw new Error('No se encontró last-quote en el SVG de compra');
  const valor = parseFloat(match[1].replace(',', '.'));
  if (isNaN(valor)) throw new Error(`Valor inválido en compra: ${match[1]}`);
  return valor;
}

// ── Actualizar index.html ───────────────────────────────────────────────────
function updateIndex(html, fecha, valorVenta, valorCompra) {
  // 1. Verificar si ya está al día (fecha ya en REFERENCIAL_DATA)
  if (html.includes(`['${fecha}',`)) {
    console.log(`ℹ️  ${fecha} ya está en REFERENCIAL_DATA.`);

    // Aún así actualizamos REFERENCIAL_COMPRA si cambió
    const currentCompraMatch = html.match(/const REFERENCIAL_COMPRA\s*=\s*([\d.]+);/);
    const currentCompra = currentCompraMatch ? parseFloat(currentCompraMatch[1]) : null;
    if (currentCompra === valorCompra) {
      console.log('ℹ️  REFERENCIAL_COMPRA también al día. Sin cambios.');
      return null;
    }
    console.log(`🔄 REFERENCIAL_COMPRA cambió: ${currentCompra} → ${valorCompra}`);
    return html.replace(
      /const REFERENCIAL_COMPRA\s*=\s*[\d.]+;.*$/m,
      `const REFERENCIAL_COMPRA =  ${valorCompra};  // BCB ref. compra ${fecha} — actualizar vía cron`
    );
  }

  // 2. Agregar nueva entrada de venta al Map (último elemento sin coma → \n]);)
  const mapCloseRegex = /(\['20\d{2}-\d{2}-\d{2}',[\d.]+\])\n\]\);/;
  if (!mapCloseRegex.test(html))
    throw new Error('No se encontró el cierre del REFERENCIAL_DATA Map en index.html');
  html = html.replace(mapCloseRegex, `$1,['${fecha}',${valorVenta}]\n]);`);

  // 3. Actualizar REFERENCIAL_VENTA
  html = html.replace(
    /const REFERENCIAL_VENTA\s*=\s*[\d.]+;.*$/m,
    `const REFERENCIAL_VENTA  = ${valorVenta};  // BCB ref. venta  ${fecha} — actualizar vía cron`
  );

  // 4. Actualizar REFERENCIAL_COMPRA
  html = html.replace(
    /const REFERENCIAL_COMPRA\s*=\s*[\d.]+;.*$/m,
    `const REFERENCIAL_COMPRA =  ${valorCompra};  // BCB ref. compra ${fecha} — actualizar vía cron`
  );

  // 5. Actualizar comentario de última actualización
  html = html.replace(
    /\/\/ Última actualización: \d{4}-\d{2}-\d{2}/,
    `// Última actualización: ${fecha}`
  );

  return html;
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  try {
    // Descargar ambos SVGs en paralelo
    console.log('📡 Descargando SVGs del BCB (venta + compra)...');
    const [svgVenta, svgCompra] = await Promise.all([
      fetchUrl(SVG_VENTA_URL),
      fetchUrl(SVG_COMPRA_URL)
    ]);

    const { fecha, valor: valorVenta } = parseVentaEntry(svgVenta);
    const valorCompra = parseCompraEntry(svgCompra);
    console.log(`✅ BCB Ref Venta:  ${fecha} → Bs ${valorVenta}`);
    console.log(`✅ BCB Ref Compra: ${fecha} → Bs ${valorCompra}`);

    const html    = fs.readFileSync(INDEX_PATH, 'utf8').replace(/\r\n/g, '\n');
    const updated = updateIndex(html, fecha, valorVenta, valorCompra);

    if (updated === null) {
      console.log('✅ index.html ya está al día.');
      process.exit(2);
    }

    fs.writeFileSync(INDEX_PATH, updated, 'utf8');
    console.log(`🚀 index.html actualizado — venta: ${valorVenta} | compra: ${valorCompra}`);

    const envFile = process.env.GITHUB_OUTPUT;
    if (envFile) {
      fs.appendFileSync(envFile, `fecha=${fecha}\n`);
      fs.appendFileSync(envFile, `valor_venta=${valorVenta}\n`);
      fs.appendFileSync(envFile, `valor_compra=${valorCompra}\n`);
    }

    process.exit(0);

  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
