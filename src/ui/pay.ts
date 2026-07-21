export function renderPayPage(p: any, qrDataUrl: string, uri: string, decimals: number) {
  const fmt = (raw: string) =>
    (Number(BigInt(raw)) / 10 ** decimals).toFixed(decimals > 2 ? 6 : 2);

  return /*html*/ `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pagar ${fmt(p.amount_crypto_raw)} ${p.asset}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, sans-serif; background:#f4f5f7; display:flex;
         justify-content:center; padding:2rem 1rem; margin:0; }
  .card { background:#fff; border-radius:16px; box-shadow:0 4px 24px rgba(0,0,0,.08);
          max-width:420px; width:100%; padding:2rem; text-align:center; }
  .amount { font-size:1.6rem; font-weight:700; margin:.25rem 0; }
  .cop { color:#667; font-size:.95rem; }
  img.qr { margin:1rem auto; display:block; border-radius:12px; }
  .addr { font-family:ui-monospace,monospace; font-size:.78rem; background:#f0f1f4;
          border-radius:8px; padding:.6rem; word-break:break-all; cursor:pointer; }
  .pill { display:inline-block; border-radius:999px; padding:.3rem .9rem; font-size:.85rem;
          font-weight:600; margin-top:1rem; }
  .pending { background:#fff4d6; color:#8a6100; }
  .partial { background:#dbeafe; color:#1d4ed8; }
  .paid    { background:#dcfce7; color:#15803d; }
  .dead    { background:#fee2e2; color:#b91c1c; }
  .bar { height:8px; background:#e5e7eb; border-radius:4px; overflow:hidden; margin-top:.8rem; }
  .bar > div { height:100%; background:#2563eb; transition:width .5s; }
  .muted { color:#889; font-size:.8rem; margin-top:.6rem; }
  a.open { display:inline-block; margin-top:1rem; text-decoration:none; background:#111;
           color:#fff; border-radius:10px; padding:.7rem 1.4rem; font-weight:600; }
  .hidden { display:none; }
</style></head><body>
<div class="card">
  <div class="cop">Total a pagar</div>
  <div class="amount">${fmt(p.amount_crypto_raw)} ${p.asset}</div>
  <div class="cop">&asymp; $${Number(p.amount_cop).toLocaleString("es-CO")} COP &middot; red ${p.network}</div>
  <div id="payZone">
    <img class="qr" src="${qrDataUrl}" alt="QR de pago" width="280" height="280">
    <div class="addr" id="addr" title="Clic para copiar">${p.address}</div>
    <a class="open" href="${uri}">Abrir en wallet</a>
    <div class="muted" id="countdown"></div>
  </div>
  <div id="status" class="pill pending">Esperando pago&hellip;</div>
  <div class="bar hidden" id="barWrap"><div id="bar" style="width:0%"></div></div>
  <div class="muted hidden" id="partialInfo"></div>
</div>
<script>
  const required = BigInt("${p.amount_crypto_raw}");
  const decimals = ${decimals};
  const quoteExpires = new Date("${p.quote_expires_at}");
  let graceExpires = ${p.grace_expires_at ? `new Date("${p.grace_expires_at}")` : "null"};
  const fmt = (raw) => (Number(raw) / 10 ** decimals).toFixed(6);
  document.getElementById("addr").onclick = () =>
    navigator.clipboard.writeText("${p.address}");
  function tickCountdown() {
    const target = graceExpires ?? quoteExpires;
    const label = graceExpires ? "Tiempo para completar el pago" : "Cotizaci\\u00f3n v\\u00e1lida por";
    const ms = target - Date.now();
    const el = document.getElementById("countdown");
    if (ms <= 0) { el.textContent = ""; return; }
    const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    el.textContent = label + ": " + m + "m " + String(s).padStart(2, "0") + "s";
  }
  setInterval(tickCountdown, 1000); tickCountdown();
  const statusEl = document.getElementById("status");
  async function poll() {
    const res = await fetch("/public/payments/${p.id}");
    if (!res.ok) return;
    const d = await res.json();
    if (d.grace_expires_at) graceExpires = new Date(d.grace_expires_at);
    const confirmed = BigInt(d.confirmed_raw);
    const pct = required > 0n ? Number((confirmed * 100n) / required) : 0;
    if (d.status === "paid") {
      statusEl.className = "pill paid"; statusEl.textContent = "\\u2705 Pago recibido";
      document.getElementById("payZone").classList.add("hidden");
      clearInterval(pollTimer);
    } else if (d.status === "partially_paid" || d.status === "detecting") {
      statusEl.className = "pill partial";
      statusEl.textContent = d.status === "detecting"
        ? "Pago detectado, confirmando\\u2026"
        : "Pago parcial recibido";
      document.getElementById("barWrap").classList.remove("hidden");
      document.getElementById("bar").style.width = Math.min(pct, 100) + "%";
      const remaining = required - confirmed;
      const info = document.getElementById("partialInfo");
      info.classList.remove("hidden");
      info.textContent = "Recibido " + fmt(confirmed) + " \\u00b7 faltan " +
        fmt(remaining > 0n ? remaining : 0n) +
        " ${p.asset}. Env\\u00eda la diferencia a la misma direcci\\u00f3n antes de que venza el tiempo.";
    } else if (d.status === "expired" || d.status === "underpaid_expired") {
      statusEl.className = "pill dead";
      statusEl.textContent = d.status === "expired"
        ? "\\u23f1 Cotizaci\\u00f3n vencida. Genera un nuevo pago."
        : "\\u26a0\\ufe0f Pago incompleto y tiempo agotado. Contacta soporte.";
      document.getElementById("payZone").classList.add("hidden");
      clearInterval(pollTimer);
    }
  }
  const pollTimer = setInterval(poll, 3000); poll();
</script>
</body></html>`;
}
