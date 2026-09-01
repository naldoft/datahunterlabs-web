/**
 * Cloudflare Worker — Monitor USDT/BOB Binance P2P
 * Versión 4: Reemplaza Google News (HTTP 503) por RSS directos de medios.
 *
 * Endpoints:
 *   GET  /                      → CSV histórico completo
 *   GET  /latest                → JSON con el último precio
 *   GET  /criptoya              → Proxy a CriptoYa USDT/BOB
 *   GET  /news?q=QUERY          → DEPRECATED — proxy Google News (suele dar 503)
 *   GET  /news/bolivia          → Noticias de medios bolivianos filtradas
 *   GET  /news/internacional    → Noticias de Reuters/BBC filtradas
 *   POST /import                → Importar CSV histórico (con token)
 */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(actualizarDatos(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
      "Cache-Control": "public, max-age=60"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // === Endpoint raíz: CSV completo ===
    if (url.pathname === "/") {
      let csv = await env.P2P_DATA.get("data_csv");
      if (!csv) csv = "Todavia no hay datos. Espera la primera ejecucion.";
      return new Response(csv, {
        headers: { ...corsHeaders, "Content-Type": "text/plain;charset=UTF-8" }
      });
    }

    // === Endpoint /latest ===
    if (url.pathname === "/latest") {
      let csv = await env.P2P_DATA.get("data_csv");
      if (!csv) {
        return new Response(JSON.stringify({ error: "Sin datos aun" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      const lineas = csv.trim().split('\n');
      const lineaCruda = lineas[lineas.length - 1];
      const partes = lineaCruda.replace(/,"/g, '|').replace(/"/g, '').split('|');
      return new Response(JSON.stringify({
        fecha: partes[0],
        oficial_compra: partes[1],
        oficial_venta: partes[2],
        p2p_compra: partes[3],
        p2p_venta: partes[4]
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // === Endpoint /criptoya ===
    if (url.pathname === "/criptoya") {
      try {
        const resp = await fetch('https://criptoya.com/api/usdt/bob/1', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
          }
        });
        if (!resp.ok) {
          return new Response(JSON.stringify({ error: 'CriptoYa returned ' + resp.status }), {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        return new Response(await resp.text(), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // === Endpoint /news/bolivia — RSS bolivianos filtrados ===
    if (url.pathname === "/news/bolivia") {
      return await fetchBolivianNews(corsHeaders);
    }

    // === Endpoint /news/internacional — Reuters/BBC filtrados ===
    if (url.pathname === "/news/internacional") {
      return await fetchInternationalNews(corsHeaders);
    }

    // === Endpoint /news (legacy Google News, suele dar 503) ===
    if (url.pathname === "/news") {
      const query = url.searchParams.get('q');
      if (!query) {
        return new Response(JSON.stringify({ error: 'missing q parameter' }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      try {
        const newsUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}+when:7d&hl=es-419&gl=BO&ceid=BO:es-419`;
        const resp = await fetch(newsUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml,application/xml,text/xml' }
        });
        if (!resp.ok) {
          return new Response(JSON.stringify({ error: 'Google News returned ' + resp.status }), {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        return new Response(await resp.text(), {
          headers: { ...corsHeaders, "Content-Type": "application/xml;charset=UTF-8", "Cache-Control": "public, max-age=600" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // === Endpoint /import (protegido) ===
    if (url.pathname === "/import" && request.method === "POST") {
      const token = request.headers.get("X-Admin-Token");
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      try {
        const body = await request.text();
        if (!body || body.length < 10) {
          return new Response(JSON.stringify({ error: "empty body" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        let current = await env.P2P_DATA.get("data_csv") || "";
        const importedLines = body.split(/\r?\n/).filter(l => l.trim());
        const currentLines = current.split(/\r?\n/).filter(l => l.trim());
        const byKey = new Map();
        for (const line of importedLines) byKey.set(extractKey(line), line);
        for (const line of currentLines) byKey.set(extractKey(line), line);
        const merged = [...byKey.values()].sort((a, b) => parseDateForSort(a) - parseDateForSort(b));
        await env.P2P_DATA.put("data_csv", merged.join('\n') + '\n');
        return new Response(JSON.stringify({
          ok: true,
          imported_lines: importedLines.length,
          existing_lines: currentLines.length,
          total_after_dedup: merged.length
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    return new Response("Ruta no encontrada", { status: 404, headers: corsHeaders });
  }
};

// ============================================================
// NEWS FETCHING — direct RSS feeds with keyword filtering
// ============================================================

const BOLIVIA_RSS_FEEDS = [
  'https://eldeber.com.bo/rss.xml',
  'https://www.lostiempos.com/rss.xml',
  'https://www.la-razon.com/feed/'
];

const INTERNATIONAL_RSS_FEEDS = [
  'https://feeds.bbci.co.uk/news/business/rss.xml',
  'https://feeds.reuters.com/reuters/businessNews',
  'https://feeds.reuters.com/news/economy'
];

const BOLIVIA_KEYWORDS = [
  'dólar', 'dolar', 'paralelo', 'tipo de cambio', 'BCB', 'banco central',
  'USDT', 'criptomoneda', 'cripto', 'divisas', 'reservas', 'escasez',
  'cambiari', 'cambiario', 'devaluación', 'devaluacion',
  'BID', 'FMI', 'UDAPE', 'ASFI', 'inflación', 'inflacion',
  'p2p', 'binance', 'bolsín', 'bolsin'
];

const INTERNATIONAL_KEYWORDS = [
  'fed', 'federal reserve', 'fomc', 'powell',
  'dollar', 'dxy', 'dollar index',
  'inflation', 'rate', 'rates', 'monetary',
  'imf', 'world bank', 'recession',
  'usdt', 'tether', 'stablecoin', 'crypto',
  'oil price', 'commodities', 'treasury'
];

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml,application/xml,text/xml,*/*',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
};

/**
 * Parse RSS XML and return array of items. Very tolerant to format variations.
 */
function parseRSS(xml, sourceName = 'Unknown') {
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  const matches = [...xml.matchAll(itemRegex)];

  for (const match of matches) {
    const itemXml = match[1];
    const title = extractTag(itemXml, 'title');
    const link = extractTag(itemXml, 'link');
    const pubDate = extractTag(itemXml, 'pubDate') || extractTag(itemXml, 'dc:date') || extractTag(itemXml, 'date');
    const description = extractTag(itemXml, 'description');

    if (!title || !link) continue;

    items.push({
      title: cleanText(title),
      link: link.trim(),
      pubDate: pubDate ? new Date(pubDate.trim()).getTime() : Date.now(),
      description: cleanText(description || ''),
      source: sourceName
    });
  }
  return items;
}

function extractTag(xml, tag) {
  // Handles CDATA and plain text
  const cdataRegex = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
  const plainRegex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1];
  const plainMatch = xml.match(plainRegex);
  if (plainMatch) return plainMatch[1];
  return null;
}

function cleanText(s) {
  if (!s) return '';
  return s
    .replace(/<[^>]+>/g, '')           // strip HTML tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesAnyKeyword(text, keywords) {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  return keywords.some(kw => lowerText.includes(kw.toLowerCase()));
}

function getSourceNameFromURL(url) {
  if (url.includes('eldeber')) return 'El Deber';
  if (url.includes('lostiempos')) return 'Los Tiempos';
  if (url.includes('la-razon')) return 'La Razón';
  if (url.includes('bbci.co.uk')) return 'BBC';
  if (url.includes('reuters')) return 'Reuters';
  return 'Source';
}

async function fetchSingleRSS(url, keywords) {
  try {
    const resp = await fetch(url, { headers: BROWSER_HEADERS });
    if (!resp.ok) return [];
    const xml = await resp.text();
    if (!xml || xml.length < 100) return [];
    const sourceName = getSourceNameFromURL(url);
    const items = parseRSS(xml, sourceName);

    // Filter by keywords on title + description
    return items.filter(item => {
      const haystack = (item.title + ' ' + item.description).toLowerCase();
      return matchesAnyKeyword(haystack, keywords);
    });
  } catch (e) {
    console.warn('RSS fetch failed for', url, e.message);
    return [];
  }
}

async function fetchAggregatedNews(feeds, keywords, corsHeaders) {
  // Fetch all feeds in parallel
  const results = await Promise.all(feeds.map(url => fetchSingleRSS(url, keywords)));
  const allItems = results.flat();

  // Dedupe by link
  const byLink = new Map();
  for (const item of allItems) {
    if (!byLink.has(item.link)) byLink.set(item.link, item);
  }

  // Sort by pubDate (newest first)
  const sorted = [...byLink.values()].sort((a, b) => b.pubDate - a.pubDate);

  // Take top 8
  const top = sorted.slice(0, 8);

  if (!top.length) {
    return new Response(JSON.stringify({ error: 'no matching news', count_unfiltered: allItems.length }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Build a synthetic RSS for compatibility with the existing dashboard parser
  const itemsXml = top.map(item => `
    <item>
      <title><![CDATA[${item.title}]]></title>
      <link>${escapeXml(item.link)}</link>
      <pubDate>${new Date(item.pubDate).toUTCString()}</pubDate>
      <source>${escapeXml(item.source)}</source>
      <description><![CDATA[${item.description.slice(0, 200)}]]></description>
    </item>
  `).join('\n');

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Aggregated News</title>
  <link>https://monitor-p2p-bolivia.workers.dev</link>
  <description>Filtered news from multiple sources</description>
  ${itemsXml}
</channel></rss>`;

  return new Response(rss, {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/xml;charset=UTF-8",
      "Cache-Control": "public, max-age=900"  // 15 min cache
    }
  });
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchBolivianNews(corsHeaders) {
  return await fetchAggregatedNews(BOLIVIA_RSS_FEEDS, BOLIVIA_KEYWORDS, corsHeaders);
}

async function fetchInternationalNews(corsHeaders) {
  return await fetchAggregatedNews(INTERNATIONAL_RSS_FEEDS, INTERNATIONAL_KEYWORDS, corsHeaders);
}

// ============================================================
// HELPERS for /import endpoint
// ============================================================

function extractKey(line) {
  const m = line.match(/^([^,]+)/);
  return m ? m[1].trim() : line;
}

function parseDateForSort(line) {
  const m = line.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!m) return 0;
  let yyyy = m[3];
  if (yyyy.length === 2) yyyy = '20' + yyyy;
  const iso = `${yyyy}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}T${(m[4]||'00').padStart(2,'0')}:${(m[5]||'00').padStart(2,'0')}:${(m[6]||'00').padStart(2,'0')}`;
  return new Date(iso).getTime() || 0;
}

// ============================================================
// BINANCE P2P SCRAPING (cron job)
// ============================================================

async function fetchBinanceP2P(tradeType, rows = 5) {
  const url = "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search";
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Origin": "https://p2p.binance.com",
    "Referer": "https://p2p.binance.com/"
  };
  const payload = JSON.stringify({
    fiat: "BOB", page: 1, rows: rows, asset: "USDT",
    tradeType: tradeType, payTypes: []
  });
  try {
    const resp = await fetch(url, { method: 'POST', headers, body: payload });
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.data && Array.isArray(data.data) && data.data.length) return data.data;
    }
  } catch (e) {
    console.warn("Binance directo falló:", e.message);
  }
  try {
    const proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(url);
    const resp = await fetch(proxyUrl, { method: 'POST', headers, body: payload });
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.data && Array.isArray(data.data) && data.data.length) return data.data;
    }
  } catch (e) {
    console.warn("Binance vía proxy falló:", e.message);
  }
  return null;
}

function promediarPrecios(ads) {
  if (!ads || !ads.length) return null;
  const precios = ads
    .map(item => parseFloat(item.adv && item.adv.price))
    .filter(p => isFinite(p) && p > 0);
  if (!precios.length) return null;
  return precios.reduce((s, p) => s + p, 0) / precios.length;
}

async function actualizarDatos(env) {
  try {
    const [adsCompra, adsVenta] = await Promise.all([
      fetchBinanceP2P("BUY", 5),
      fetchBinanceP2P("SELL", 5)
    ]);
    const precioCompra = promediarPrecios(adsCompra);
    const precioVenta = promediarPrecios(adsVenta);
    if (precioCompra == null || precioVenta == null) {
      console.error("No se pudieron obtener precios válidos — ciclo saltado");
      return;
    }
    let fecha = new Intl.DateTimeFormat('es-BO', {
      timeZone: 'America/La_Paz',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date());
    fecha = fecha.replace(',', '');
    const fmt = (num) => `"${num.toFixed(2).replace('.', ',')}"`;
    const nuevaFila = `${fecha},"6,86","6,96",${fmt(precioCompra)},${fmt(precioVenta)}\n`;
    let historialActual = await env.P2P_DATA.get("data_csv");
    if (!historialActual) historialActual = "";
    historialActual += nuevaFila;
    await env.P2P_DATA.put("data_csv", historialActual);
    console.log(`✓ ${fecha} | compra=${precioCompra.toFixed(2)} (${adsCompra.length}) | venta=${precioVenta.toFixed(2)} (${adsVenta.length})`);
  } catch (error) {
    console.error("Error en actualizarDatos:", error.message);
  }
}
