/* ALPHA MEME frontend */
const $ = (s) => document.querySelector(s);
const grid = $("#grid"), statusEl = $("#status");
let TAB = "top", TIMER = null, LAST = [];

const BLACK = new Set(JSON.parse(localStorage.getItem("am_black") || "[]"));
function saveBlack() { localStorage.setItem("am_black", JSON.stringify([...BLACK])); }

const fmtUsd = (n) => {
  n = Number(n) || 0;
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "k";
  return "$" + n.toFixed(n < 1 ? 4 : 0);
};
const fmtPct = (n) => {
  n = Number(n) || 0;
  const cls = n >= 0 ? "up" : "dn";
  return `<b class="${cls}">${n >= 0 ? "+" : ""}${n.toFixed(1)}%</b>`;
};
const fmtAge = (h) => {
  if (h == null) return "—";
  if (h < 1) return Math.round(h * 60) + "m";
  if (h < 48) return h.toFixed(1) + "h";
  return (h / 24).toFixed(1) + "d";
};
const badgeCls = (s) =>
  s.startsWith("OKX") ? "okx" :
  s === "HOT BUYS" ? "hot" :
  s === "WHALE ALERT" ? "whale" :
  s === "SMART TRADER" ? "smart" : "fresh";
const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ------------------------------------------------------------- feed */
async function loadFeed() {
  const minLiq = $("#minLiq").value, maxAgeH = $("#maxAge").value;
  statusEl.textContent = "Scanning chain…";
  try {
    const r = await fetch(`/api/alpha?tab=${TAB}&minLiq=${minLiq}&maxAgeH=${maxAgeH}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    LAST = (data.items || []).filter((x) => !BLACK.has(x.address));
    $("#funnel-scanned").textContent = data.scanned ?? "—";
    $("#funnel-passed").textContent = data.passed ?? "—";
    statusEl.textContent = `${LAST.length} tokens in ${TAB.toUpperCase()} · OKX feed: ${data.okxLive ? "live" : "offline (heuristic mode)"} · auto-refresh 30s`;
    render(LAST);
  } catch (e) {
    statusEl.textContent = "Scan failed: " + e.message + " — retrying on next cycle.";
  }
}

function render(items) {
  if (!items.length) {
    grid.innerHTML = `<div class="empty">Nothing passed the filter for this signal right now. The gates are strict on purpose — check back in a minute or loosen liquidity/age above.</div>`;
    return;
  }
  grid.innerHTML = items.map((x) => {
    const p = x.pair || {};
    const badges = (x.signals || []).map((s) => `<span class="badge ${badgeCls(s)}">${esc(s)}</span>`).join("");
    const streak = x.streak >= 2 ? `<span class="badge streak">×${x.streak} scans</span>` : "";
    const gates = (x.gates || []).map((g) => `<i class="gate ${g.pass ? "" : "fail"}" title="${esc(g.label)}: ${esc(g.detail)}"></i>`).join("");
    return `
    <div class="card" tabindex="0" data-addr="${esc(x.address)}" data-pool="${esc(p.pairAddress || "")}">
      <div class="card-top">
        ${x.logo ? `<img class="logo" src="${esc(x.logo)}" alt="" onerror="this.style.visibility='hidden'">` : `<div class="logo"></div>`}
        <div class="ident">
          <div class="sym">${esc(x.symbol)}</div>
          <div class="nm">${esc(x.name)}</div>
        </div>
        <div class="score-blk">
          <div class="score-num">${x.alphaScore}</div>
          <div class="score-lab">ALPHA</div>
        </div>
      </div>
      <div class="pressure"><i style="width:${x.alphaScore}%"></i></div>
      <div class="badges">${badges}${streak}</div>
      <div class="stats">
        <div class="stat"><b>${fmtUsd(p.marketCap)}</b><span>MCAP</span></div>
        <div class="stat"><b>${fmtUsd(p.liquidity)}</b><span>LIQ</span></div>
        <div class="stat">${fmtPct(p.ch1h)}<span>1H</span></div>
        <div class="stat"><b>${fmtAge(p.ageH)}</b><span>AGE</span></div>
      </div>
      <div class="gatestrip">${gates}</div>
      <div class="gate-legend">8/8 GATES PASSED · ${p.b1 || 0}B/${p.s1 || 0}S 1H</div>
    </div>`;
  }).join("");

  grid.querySelectorAll(".card").forEach((el) => {
    el.addEventListener("click", () => openDrawer(el.dataset.addr, el.dataset.pool));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") openDrawer(el.dataset.addr, el.dataset.pool); });
  });
}

/* ----------------------------------------------------------- drawer */
const drawer = $("#drawer"), scrim = $("#scrim");
function closeDrawer() {
  drawer.classList.remove("open");
  scrim.classList.remove("on");
  drawer.setAttribute("aria-hidden", "true");
  $("#d-chart").src = "about:blank";
}
$("#d-close").addEventListener("click", closeDrawer);
scrim.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

async function openDrawer(address, poolAddress) {
  drawer.classList.add("open");
  scrim.classList.add("on");
  drawer.setAttribute("aria-hidden", "false");
  $("#d-ident").innerHTML = `<div class="sym">Loading…</div>`;
  $("#d-score").innerHTML = "";
  $("#d-gates").innerHTML = "";
  $("#d-links").innerHTML = "";
  if (poolAddress) {
    $("#d-chart").src = `https://www.geckoterminal.com/solana/pools/${encodeURIComponent(poolAddress)}?embed=1&info=0&swaps=0&light_chart=0`;
  }
  try {
    const r = await fetch(`/api/token/${encodeURIComponent(address)}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const p = d.pair || {};
    if (!poolAddress && p.pairAddress) {
      $("#d-chart").src = `https://www.geckoterminal.com/solana/pools/${encodeURIComponent(p.pairAddress)}?embed=1&info=0&swaps=0&light_chart=0`;
    }
    $("#d-ident").innerHTML = `
      ${d.logo ? `<img src="${esc(d.logo)}" alt="">` : ""}
      <div>
        <div class="sym">${esc(d.symbol)} <span style="color:var(--muted);font-size:12px">${esc(d.name)}</span></div>
        <div class="ca" title="Copy CA" data-ca="${esc(d.address)}">${esc(d.address.slice(0, 6))}…${esc(d.address.slice(-6))} ⧉</div>
      </div>`;
    $("#d-ident .ca").addEventListener("click", (e) => {
      navigator.clipboard?.writeText(e.currentTarget.dataset.ca);
      e.currentTarget.textContent = "copied ✓";
    });

    const parts = (d.scoreParts || []).map((x) => `
      <div class="part">
        <span class="k">${esc(x.k)}</span>
        <span class="bar"><i style="width:${x.max ? (x.v / x.max) * 100 : 0}%"></i></span>
        <span class="v">${x.v}/${x.max}</span>
      </div>`).join("");
    $("#d-score").innerHTML = `<h4>ALPHA SCORE — ${d.alphaScore}/100</h4>${parts}`;

    const gates = (d.gates || []).map((g) => `
      <div class="gaterow ${g.pass ? "" : "fail"}">
        <span class="dot"></span><span class="gl">${esc(g.label)}</span>
        <span class="gd">${esc(g.detail)}</span>
      </div>`).join("");
    $("#d-gates").innerHTML = `<h4>FILTER GATES</h4>${gates}`;

    $("#d-links").innerHTML = `
      <a href="https://dexscreener.com/solana/${esc(d.address)}" target="_blank" rel="noopener">DexScreener ↗</a>
      <a href="https://www.geckoterminal.com/solana/pools/${esc(p.pairAddress || "")}" target="_blank" rel="noopener">GeckoTerminal ↗</a>
      <a href="https://app.bubblemaps.io/solana/token/${esc(d.address)}" target="_blank" rel="noopener">Bubblemaps ↗</a>
      <a href="#" id="d-black">Hide token</a>`;
    $("#d-black").addEventListener("click", (e) => {
      e.preventDefault();
      BLACK.add(d.address);
      saveBlack();
      closeDrawer();
      render(LAST.filter((x) => !BLACK.has(x.address)));
    });
  } catch (e) {
    $("#d-ident").innerHTML = `<div class="sym">Load failed: ${esc(e.message)}</div>`;
  }
}

/* -------------------------------------------------------- tabs/search */
$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  TAB = btn.dataset.tab;
  loadFeed();
});
$("#minLiq").addEventListener("change", loadFeed);
$("#maxAge").addEventListener("change", loadFeed);

let searchT = null;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchT);
  const q = e.target.value.trim();
  if (!q) { render(LAST); return; }
  searchT = setTimeout(async () => {
    statusEl.textContent = `Searching “${q}”…`;
    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const d = await r.json();
      const items = (d.items || []).map((x) => ({
        ...x, alphaScore: 0, signals: [], gates: [], streak: 0,
        pair: { ...x.pair, ageH: null }
      }));
      statusEl.textContent = `${items.length} search results (unfiltered — open a token for its gate report)`;
      render(items);
    } catch (_) { statusEl.textContent = "Search failed."; }
  }, 350);
});

/* --------------------------------------------------------------- go */
function startTimer() {
  clearInterval(TIMER);
  TIMER = setInterval(() => { if (!$("#search").value.trim()) loadFeed(); }, 30000);
}
loadFeed();
startTimer();
