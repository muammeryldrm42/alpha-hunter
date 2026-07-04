/**
 * ALPHA MEME — Solana new-token alpha scanner
 * Discovery: GeckoTerminal (new + trending pools) + DexScreener (profiles/boosts)
 * Signals:   OKX Wallet signal feed (best-effort) + on-chain flow heuristics
 * Core:      ALPHA FILTER v1 — 8 hard gates + weighted 0-100 alpha score
 */
const express = require("express");
const cors = require("cors");
const path = require("path");
global.fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* ---------------------------------------------------------------- cache */
const cache = new Map();
const now = () => Date.now();
function getCached(key) {
  const hit = cache.get(key);
  if (!hit || now() > hit.exp) return null;
  return hit.val;
}
function setCached(key, val, ttlMs) {
  cache.set(key, { val, exp: now() + ttlMs });
  return val;
}
async function fetchJson(url, ttlMs = 15000, opts = {}) {
  const cached = getCached(url);
  if (cached) return cached;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 9000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        accept: "application/json",
        "user-agent": "alpha-meme/1.0",
        ...(opts.headers || {})
      }
    });
    if (!res.ok) throw new Error(`Upstream ${res.status}`);
    const data = await res.json();
    return setCached(url, data, ttlMs);
  } finally {
    clearTimeout(t);
  }
}
const safeNum = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

/* ------------------------------------------------- persistent-ish state */
// Rug blacklist: MC collapse ~8x from a >=20k base = permanent blacklist (runtime).
const mcSeen = new Map();      // address -> { mc, ts }
const mcBlack = new Set();
// Continuity tracker: how many consecutive scans a token kept passing gates.
const streaks = new Map();     // address -> { streak, lastTs, lastScore }
/* ----------------------------------------------------------- telegram */
const TG_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TG_CHAT = String(process.env.TELEGRAM_CHAT_ID || "").trim();
const tgSent = new Set();
async function tgNotify(item) {
  if (!TG_TOKEN || !TG_CHAT) return;
  const key = `top:${item.address}`;
  if (tgSent.has(key)) return;
  tgSent.add(key);
  const p = item.pair || {};
  const text = [
    `🦅 *ALPHA MEME — TOP ALPHA*`,
    `*${item.name}* (${item.symbol}) — Score ${item.alphaScore}`,
    `CA: \`${item.address}\``,
    `Signal MC: $${Math.round(safeNum(p.marketCap)).toLocaleString("en-US")}`,
    `1h: ${safeNum(p.ch1h).toFixed(1)}% | 24h vol: $${Math.round(safeNum(p.vol24)).toLocaleString("en-US")}`,
    `Liq: $${Math.round(safeNum(p.liquidity)).toLocaleString("en-US")}`,
    `Vol24h: $${Math.round(safeNum(p.vol24)).toLocaleString("en-US")}`,
    `Signals: ${item.signals.join(", ") || "—"}`,
    `https://dexscreener.com/solana/${item.address}`
  ].join("\n");
  try {
    await fetch(`https://api.telegram.org/bot${encodeURIComponent(TG_TOKEN)}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "Markdown" })
    });
  } catch (_) { /* never break API on TG failure */ }
}

/* ----------------------------------------------------- OKX best effort */
/**
 * OKX Wallet "Signals" feed adapter. These are the wallet's internal (priapi)
 * endpoints — undocumented and occasionally reshuffled, so we probe a list of
 * candidates once, remember the first that answers, and merge its tokens as
 * extra discovery seeds + "OKX" signal badges. If nothing answers, the whole
 * layer silently disables itself (okxLive:false in /api/health).
 */
const OKX_CANDIDATES = [
  // chainId 501 = Solana in OKX web3 routing
  "https://web3.okx.com/priapi/v1/dx/market/v2/signal/token/list?chainId=501&pageNum=1&pageSize=50",
  "https://web3.okx.com/priapi/v1/dx/market/v2/signal/list?chainId=501&pageNum=1&pageSize=50",
  "https://www.okx.com/priapi/v1/dx/market/v2/signal/token/list?chainId=501&pageNum=1&pageSize=50",
  "https://web3.okx.com/priapi/v1/dx/market/v2/advanced/ranking/content?chainId=501&rankType=5&pageNum=1&pageSize=50"
];
let okxUrl = null;       // resolved working endpoint
let okxProbedAt = 0;
let okxTokens = [];      // [{ address, tag }]

function extractOkxTokens(payload) {
  // OKX priapi payloads vary; walk the tree for objects that look like tokens.
  const out = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const addr = node.tokenContractAddress || node.tokenAddress || node.contractAddress || node.address;
    if (typeof addr === "string" && addr.length >= 32 && addr.length <= 44 && !seen.has(addr)) {
      seen.add(addr);
      const tag =
        node.signalType === 2 || /whale/i.test(String(node.signalName || "")) ? "OKX WHALE" :
        node.signalType === 3 || /smart/i.test(String(node.signalName || "")) ? "OKX SMART" :
        "OKX SIGNAL";
      out.push({ address: addr, tag });
    }
    Object.values(node).forEach(walk);
  };
  walk(payload);
  return out.slice(0, 60);
}

async function refreshOkx() {
  if (now() - okxProbedAt < 60000) return; // probe at most once/min
  okxProbedAt = now();
  const tryUrl = async (url) => {
    const data = await fetchJson(url, 45000, { timeout: 6000, headers: { referer: "https://web3.okx.com/" } });
    const tokens = extractOkxTokens(data);
    if (tokens.length === 0) throw new Error("empty");
    return tokens;
  };
  if (okxUrl) {
    try { okxTokens = await tryUrl(okxUrl); return; } catch (_) { okxUrl = null; }
  }
  for (const url of OKX_CANDIDATES) {
    try {
      okxTokens = await tryUrl(url);
      okxUrl = url;
      return;
    } catch (_) { /* next candidate */ }
  }
  okxTokens = [];
}

/* ------------------------------------------------------- discovery */
const GT = "https://api.geckoterminal.com/api/v2";

function gtPoolToSeed(p) {
  const a = p?.attributes || {};
  const rel = p?.relationships || {};
  const baseId = rel?.base_token?.data?.id || ""; // "solana_<mint>"
  const address = baseId.includes("_") ? baseId.split("_").slice(1).join("_") : "";
  return address ? { address, poolAddress: (a.address || ""), source: "gt" } : null;
}

async function gtNewPools() {
  const data = await fetchJson(`${GT}/networks/solana/new_pools?page=1`, 30000);
  return (data?.data || []).map(gtPoolToSeed).filter(Boolean);
}
async function gtTrendingPools() {
  const data = await fetchJson(`${GT}/networks/solana/trending_pools?page=1`, 45000);
  return (data?.data || []).map(gtPoolToSeed).filter(Boolean);
}
async function dsLatestProfiles() {
  const data = await fetchJson("https://api.dexscreener.com/token-profiles/latest/v1", 45000);
  return (Array.isArray(data) ? data : [])
    .filter((x) => x?.chainId === "solana")
    .map((x) => ({ address: String(x.tokenAddress || ""), source: "ds-profile" }))
    .filter((x) => x.address);
}
async function dsBoosts() {
  const [latest, top] = await Promise.all([
    fetchJson("https://api.dexscreener.com/token-boosts/latest/v1", 45000).catch(() => []),
    fetchJson("https://api.dexscreener.com/token-boosts/top/v1", 60000).catch(() => [])
  ]);
  const all = [...(Array.isArray(latest) ? latest : []), ...(Array.isArray(top) ? top : [])];
  return all
    .filter((x) => x?.chainId === "solana")
    .map((x) => ({ address: String(x.tokenAddress || ""), source: "ds-boost" }))
    .filter((x) => x.address);
}

/* ----------------------------------------------------- enrichment */
function pickBestPair(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const score = (p) =>
    safeNum(p?.liquidity?.usd) * 1e6 + safeNum(p?.volume?.h24) * 10 +
    safeNum(p?.txns?.h24?.buys) + safeNum(p?.txns?.h24?.sells);
  return [...pairs].sort((a, b) => score(b) - score(a))[0];
}

async function tokenPairs(address) {
  const url = `https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(address)}`;
  const raw = await fetchJson(url, 12000);
  return Array.isArray(raw) ? raw : [];
}

function flatten(bp) {
  if (!bp) return null;
  const tx = bp.txns || {};
  return {
    pairAddress: bp.pairAddress || "",
    dexId: bp.dexId || "",
    url: bp.url || "",
    priceUsd: safeNum(bp.priceUsd),
    marketCap: safeNum(bp.marketCap || bp.fdv),
    liquidity: safeNum(bp?.liquidity?.usd),
    vol5m: safeNum(bp?.volume?.m5),
    vol1h: safeNum(bp?.volume?.h1),
    vol6h: safeNum(bp?.volume?.h6),
    vol24: safeNum(bp?.volume?.h24),
    ch5: safeNum(bp?.priceChange?.m5),
    ch1h: safeNum(bp?.priceChange?.h1),
    ch6h: safeNum(bp?.priceChange?.h6),
    ch24: safeNum(bp?.priceChange?.h24),
    b5: safeNum(tx?.m5?.buys), s5: safeNum(tx?.m5?.sells),
    b1: safeNum(tx?.h1?.buys), s1: safeNum(tx?.h1?.sells),
    b6: safeNum(tx?.h6?.buys), s6: safeNum(tx?.h6?.sells),
    b24: safeNum(tx?.h24?.buys), s24: safeNum(tx?.h24?.sells),
    createdAt: safeNum(bp.pairCreatedAt),
    logo: bp?.info?.imageUrl || "",
    name: bp?.baseToken?.name || "Token",
    symbol: bp?.baseToken?.symbol || "?"
  };
}

/* ------------------------------------------------ ALPHA FILTER v1 */
/**
 * 8 hard gates. A token must pass ALL to enter any feed.
 * Every gate is returned with pass/fail + reason so the UI can render
 * the filter strip and users can see exactly why something was cut.
 */
function runGates(p, opts = {}) {
  const minLiq = safeNum(opts.minLiq) || 10000;
  const maxAgeH = safeNum(opts.maxAgeH) || 168; // 7d default
  const minAgeMin = 20;

  const ageH = p.createdAt > 0 ? (now() - p.createdAt) / 3600000 : null;
  const buys1 = p.b1, sells1 = p.s1, tot1 = buys1 + sells1;
  const buyRatio1 = (buys1 + 1) / (tot1 + 2);
  const volLiq = p.liquidity > 0 ? p.vol24 / p.liquidity : 0;
  const liqMc = p.marketCap > 0 ? p.liquidity / p.marketCap : 0;
  const knife = p.ch1h < -10 && p.ch6h < -18 && p.ch24 < -35;

  const gates = [
    { id: "LIQ",   label: "Liquidity",   pass: p.liquidity >= minLiq,
      detail: `$${Math.round(p.liquidity).toLocaleString("en-US")} (min $${minLiq.toLocaleString("en-US")})` },
    { id: "VOL",   label: "Volume",      pass: p.vol24 >= 25000 && volLiq >= 0.4,
      detail: `24h $${Math.round(p.vol24).toLocaleString("en-US")}, vol/liq ${volLiq.toFixed(2)}` },
    { id: "AGE",   label: "Age window",  pass: ageH === null ? false : ageH >= minAgeMin / 60 && ageH <= maxAgeH,
      detail: ageH === null ? "unknown age" : `${ageH < 1 ? Math.round(ageH * 60) + "m" : ageH.toFixed(1) + "h"} (20m–${maxAgeH}h)` },
    { id: "ACT",   label: "Activity",    pass: tot1 >= 30,
      detail: `${tot1} txns / 1h (min 30)` },
    { id: "WASH",  label: "Wash check",  pass: !(tot1 >= 40 && (buyRatio1 > 0.93 || buyRatio1 < 0.12)),
      detail: `buy ratio ${(buyRatio1 * 100).toFixed(0)}%` },
    { id: "KNIFE", label: "No knife",    pass: !knife,
      detail: knife ? "falling knife pattern" : "trend intact" },
    { id: "RUG",   label: "Rug guard",   pass: !mcBlack.has(p ? p.__addr : "") && liqMc >= 0.02,
      detail: mcBlack.has(p.__addr) ? "MC crash blacklisted" : `liq/MC ${(liqMc * 100).toFixed(1)}% (min 2%)` },
    { id: "SPIKE", label: "Volatility",  pass: Math.abs(p.ch5) <= 45,
      detail: `5m move ${p.ch5.toFixed(1)}%` }
  ];
  return { gates, passed: gates.every((g) => g.pass), ageH, buyRatio1, tot1, volLiq, liqMc };
}

function computeAlphaScore(p, g, extras) {
  let score = 0;
  const parts = [];

  // Momentum alignment (0-20): each aligned positive timeframe adds.
  let mo = 0;
  if (p.ch5 > 0) mo += 5;
  if (p.ch1h > 0) mo += 5;
  if (p.ch6h > 0) mo += 5;
  if (p.ch24 > 0) mo += 5;
  score += mo; parts.push({ k: "Momentum", v: mo, max: 20 });

  // Flow acceleration (0-15): 5m buy rate vs 1h buy rate.
  const rate5 = p.b5 / 5, rate1h = p.b1 / 60;
  let acc = 0;
  if (rate1h > 0) {
    const x = rate5 / rate1h;
    acc = x >= 3 ? 15 : x >= 2 ? 11 : x >= 1.4 ? 7 : x >= 1 ? 3 : 0;
  }
  score += acc; parts.push({ k: "Acceleration", v: acc, max: 15 });

  // Buy dominance 1h (0-15).
  const br = g.buyRatio1;
  const dom = br >= 0.72 ? 15 : br >= 0.64 ? 11 : br >= 0.56 ? 7 : br >= 0.5 ? 3 : 0;
  score += dom; parts.push({ k: "Buy dominance", v: dom, max: 15 });

  // Volume / liquidity turnover (0-15).
  const vl = g.volLiq;
  const turn = vl >= 5 ? 15 : vl >= 3 ? 12 : vl >= 1.5 ? 9 : vl >= 0.8 ? 5 : 2;
  score += turn; parts.push({ k: "Turnover", v: turn, max: 15 });

  // Liquidity depth (0-10): deeper = safer alpha.
  const lq = p.liquidity;
  const depth = lq >= 250000 ? 10 : lq >= 100000 ? 8 : lq >= 50000 ? 6 : lq >= 25000 ? 4 : 2;
  score += depth; parts.push({ k: "Depth", v: depth, max: 10 });

  // Trending / boost / OKX presence (0-15).
  let pres = 0;
  if (extras.trending) pres += 7;
  if (extras.boosted) pres += 3;
  if (extras.okxTag) pres += 5;
  score += pres; parts.push({ k: "Radar presence", v: pres, max: 15 });

  // Continuity streak (0-10): survived multiple scans.
  const st = extras.streak || 0;
  const cont = st >= 6 ? 10 : st >= 4 ? 7 : st >= 2 ? 4 : 0;
  score += cont; parts.push({ k: "Continuity", v: cont, max: 10 });

  return { score: Math.max(0, Math.min(100, Math.round(score))), parts };
}

function computeSignals(p, g, extras) {
  const signals = [];
  // HOT BUYS: burst of buys right now with real price response.
  if (p.b5 >= 15 && (p.b5 + 1) / (p.b5 + p.s5 + 2) >= 0.68 && p.ch5 > 0) signals.push("HOT BUYS");
  // WHALE ALERT: big average clip or 5m volume that is heavy vs pool depth.
  const avgClip1h = g.tot1 > 0 ? p.vol1h / g.tot1 : 0;
  if ((avgClip1h >= 1200 && p.b1 > p.s1) || (p.liquidity > 0 && p.vol5m / p.liquidity >= 0.08 && p.b5 >= p.s5)) signals.push("WHALE ALERT");
  // SMART TRADER: controlled accumulation persisting across scans.
  if ((extras.streak || 0) >= 2 && Math.abs(p.ch5) <= 12 && g.buyRatio1 >= 0.58 && g.buyRatio1 <= 0.88 && p.ch1h > -3) signals.push("SMART TRADER");
  // FRESH ALPHA: young + already through all gates.
  if (g.ageH !== null && g.ageH <= 24) signals.push("FRESH ALPHA");
  if (extras.okxTag) signals.push(extras.okxTag);
  return signals;
}

/* ------------------------------------------------------ pipeline */
async function mapLimit(arr, limit, fn) {
  const ret = [];
  let i = 0;
  await Promise.all(
    new Array(Math.max(1, limit)).fill(0).map(async () => {
      while (i < arr.length) {
        const idx = i++;
        try { ret[idx] = await fn(arr[idx], idx); } catch (_) { ret[idx] = null; }
      }
    })
  );
  return ret.filter(Boolean);
}

async function buildFeed(opts = {}) {
  refreshOkx().catch(() => {});
  const [fresh, trending, profiles, boosts] = await Promise.all([
    gtNewPools().catch(() => []),
    gtTrendingPools().catch(() => []),
    dsLatestProfiles().catch(() => []),
    dsBoosts().catch(() => [])
  ]);
  const trendingSet = new Set(trending.map((x) => x.address));
  const boostSet = new Set(boosts.map((x) => x.address));
  const okxMap = new Map(okxTokens.map((x) => [x.address, x.tag]));

  // Merge unique seeds; cap enrichment fan-out.
  const seen = new Set();
  const seeds = [];
  for (const s of [...fresh, ...trending, ...profiles, ...boosts, ...okxTokens]) {
    const a = s.address;
    if (!a || seen.has(a) || mcBlack.has(a)) continue;
    seen.add(a);
    seeds.push(a);
    if (seeds.length >= 70) break;
  }

  const items = await mapLimit(seeds, 6, async (address) => {
    const pairs = await tokenPairs(address);
    const bp = pickBestPair(pairs);
    if (!bp) return null;
    const p = flatten(bp);
    p.__addr = address;
    if (updateMcCrash(address, p.marketCap)) return null;

    const g = runGates(p, opts);
    if (!g.passed) return null;

    const extras = {
      trending: trendingSet.has(address),
      boosted: boostSet.has(address),
      okxTag: okxMap.get(address) || null,
      streak: 0
    };
    // Streak counts only for gate-passing tokens.
    extras.streak = bumpStreak(address, 0);

    const { score, parts } = computeAlphaScore(p, g, extras);
    const signals = computeSignals(p, g, extras);

    return {
      address,
      name: p.name,
      symbol: p.symbol,
      logo: p.logo,
      alphaScore: score,
      scoreParts: parts,
      signals,
      gates: g.gates,
      streak: extras.streak,
      pair: {
        pairAddress: p.pairAddress, dexId: p.dexId, url: p.url,
        priceUsd: p.priceUsd, marketCap: p.marketCap, liquidity: p.liquidity,
        vol24: p.vol24, vol1h: p.vol1h,
        ch5: p.ch5, ch1h: p.ch1h, ch6h: p.ch6h, ch24: p.ch24,
        b1: p.b1, s1: p.s1, b5: p.b5, s5: p.s5,
        ageH: g.ageH
      }
    };
  });

  const sorted = items.sort((a, b) => b.alphaScore - a.alphaScore);
  sorted.__scanned = seeds.length;
  // Fire-and-forget Telegram alerts for elite scores.
  const tgMin = safeNum(process.env.ALPHA_TG_MIN) || 70;
  for (const it of sorted) if (it.alphaScore >= tgMin) tgNotify(it);
  return sorted;
}

function filterTab(items, tab) {
  switch (String(tab || "top")) {
    case "hot":   return items.filter((x) => x.signals.includes("HOT BUYS"));
    case "whale": return items.filter((x) => x.signals.includes("WHALE ALERT"));
    case "smart": return items.filter((x) => x.signals.includes("SMART TRADER"));
    case "fresh": return items.filter((x) => x.signals.includes("FRESH ALPHA"));
    case "okx":   return items.filter((x) => x.signals.some((s) => s.startsWith("OKX")));
    default:      return items; // top = everything that survived, score-sorted
  }
}

/* -------------------------------------------------------- routes */
app.get("/api/health", (req, res) =>
  res.json({ ok: true, name: "alpha-meme", okxLive: !!okxUrl, tgLive: !!(TG_TOKEN && TG_CHAT), blacklisted: mcBlack.size })
);

let feedInflight = null;
app.get("/api/alpha", async (req, res) => {
  try {
    const opts = {
      minLiq: safeNum(req.query.minLiq) || undefined,
      maxAgeH: safeNum(req.query.maxAgeH) || undefined
    };
    const key = `feed:${opts.minLiq || 0}:${opts.maxAgeH || 0}`;
    let items = getCached(key);
    if (!items) {
      if (!feedInflight) feedInflight = buildFeed(opts).finally(() => (feedInflight = null));
      items = await feedInflight;
      setCached(key, items, 25000);
    }
    const tab = String(req.query.tab || "top");
    const out = filterTab(items, tab).slice(0, 40);
    res.json({ tab, count: out.length, scanned: items.__scanned || 0, passed: items.length, okxLive: !!okxUrl, items: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/token/:address", async (req, res) => {
  try {
    const address = String(req.params.address || "").trim();
    const pairs = await tokenPairs(address);
    const bp = pickBestPair(pairs);
    if (!bp) return res.status(404).json({ error: "No pair data" });
    const p = flatten(bp);
    p.__addr = address;
    const g = runGates(p, { maxAgeH: 99999 }); // detail view: no age cut
    const extras = { trending: false, boosted: false, okxTag: null, streak: (streaks.get(address) || {}).streak || 0 };
    const { score, parts } = computeAlphaScore(p, g, extras);
    const signals = computeSignals(p, g, extras);
    res.json({
      address, name: p.name, symbol: p.symbol, logo: p.logo,
      alphaScore: score, scoreParts: parts, signals, gates: g.gates,
      pair: {
        pairAddress: p.pairAddress, dexId: p.dexId, url: p.url,
        priceUsd: p.priceUsd, marketCap: p.marketCap, liquidity: p.liquidity,
        vol24: p.vol24, vol1h: p.vol1h,
        ch5: p.ch5, ch1h: p.ch1h, ch6h: p.ch6h, ch24: p.ch24,
        b1: p.b1, s1: p.s1, b5: p.b5, s5: p.s5, ageH: g.ageH
      },
      otherPairs: pairs.slice(0, 10).map((x) => ({
        dexId: x.dexId, pairAddress: x.pairAddress, liq: safeNum(x?.liquidity?.usd)
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Missing q" });
    const data = await fetchJson("https://api.dexscreener.com/latest/dex/search?q=" + encodeURIComponent(q), 10000);
    const by = new Map();
    for (const pr of (data?.pairs || []).filter((x) => x?.chainId === "solana")) {
      const addr = pr?.baseToken?.address;
      if (!addr) continue;
      const cur = by.get(addr);
      if (!cur || safeNum(pr?.liquidity?.usd) > safeNum(cur?.liquidity?.usd)) by.set(addr, pr);
    }
    const items = [...by.entries()].slice(0, 25).map(([address, bp]) => {
      const p = flatten(bp);
      return {
        address, name: p.name, symbol: p.symbol, logo: p.logo,
        pair: { marketCap: p.marketCap, liquidity: p.liquidity, ch24: p.ch24, pairAddress: p.pairAddress }
      };
    });
    res.json({ q, count: items.length, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

module.exports = app;
