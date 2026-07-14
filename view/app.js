/* Boomtown spectator board. Polls ./state.json and renders the two mayors' cities
 * across a river — four axis-towers each (population/income/prestige/stability)
 * growing with builds, a prosperity readout, the round, boom/bust event flashes,
 * live odds, and the winner overlay. Read-only, offline, procedural. Dispatches on
 * data.game === "boomtown". */
(function () {
  const W = 780, H = 560;
  const cv = document.getElementById("c"), ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const statusEl = document.getElementById("status");
  const AXES = ["population", "income", "prestige", "stability"];
  const AXCOL = ["#38bdf8", "#fbbf24", "#a855f7", "#34d399"];
  let data = null, shownPro = [0, 0], evtFlash = 0, lastEvtRound = -1;

  // Replay bridge (replay-shim.js): recorded frames replace the live poll.
  const MODE_LABEL = window.AIWARS_REPLAY && AIWARS_REPLAY.active ? "Replay" : "Live";

  function apply(j) {
    if (j.game !== "boomtown") { statusEl.innerHTML = `<span class="off">unsupported game: ${j.game || "?"}</span>`; data = null; return; }
    data = j;
    const m = data.mayors;
    statusEl.textContent = data.winner
      ? `Final — ${data.winner} wins (${data.win_reason}).`
      : `${MODE_LABEL} · round ${data.round}/${data.rounds} · ${m[0].handle} prosperity ${m[0].prosperity} vs ${m[1].handle} ${m[1].prosperity}`;
    if (data.event && data.event.round !== lastEvtRound) { lastEvtRound = data.event.round; evtFlash = 1; }
  }
  async function tick() {
    try {
      const r = await fetch("./state.json", { cache: "no-store" });
      apply(await r.json());
    } catch (e) { statusEl.innerHTML = `<span class="off">waiting for referee…</span>`; }
  }
  if (window.AIWARS_REPLAY && AIWARS_REPLAY.active) AIWARS_REPLAY.onFrame(apply);
  else { setInterval(tick, 1000); tick(); }

  function sky(t) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#0a1230"); g.addColorStop(0.6, "#152043"); g.addColorStop(1, "#27304f");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 40; i++) { const x = (i * 137) % W, y = (i * 53) % 150; ctx.fillStyle = `rgba(200,220,255,${0.1 + 0.3 * (Math.sin(t / 700 + i) * .5 + .5)})`; ctx.fillRect(x, y, 2, 2); }
    // river down the middle
    const rg = ctx.createLinearGradient(W / 2 - 40, 0, W / 2 + 40, 0);
    rg.addColorStop(0, "#0d2c47"); rg.addColorStop(0.5, "#15527d"); rg.addColorStop(1, "#0d2c47");
    ctx.fillStyle = rg; ctx.fillRect(W / 2 - 40, 150, 80, H - 150);
    for (let i = 0; i < 20; i++) { ctx.strokeStyle = `rgba(120,200,255,${0.06 + 0.06 * (Math.sin(t / 500 + i) * .5 + .5)})`; ctx.beginPath(); ctx.moveTo(W / 2 - 40, 170 + i * 18); ctx.lineTo(W / 2 + 40, 170 + i * 18 + Math.sin(t / 400 + i) * 3); ctx.stroke(); }
    // bridge
    ctx.fillStyle = "#3a4256"; rrect(W / 2 - 46, 300, 92, 10, 3); ctx.fill();
  }
  function cityPlot(ox, mayor, col, soft, idx) {
    // ground plate
    ctx.fillStyle = "#13351f"; rrect(ox + 14, 360, 300, 150, 10); ctx.fill();
    ctx.fillStyle = "#0e2718"; rrect(ox + 14, 502, 300, 8, 4); ctx.fill();
    // 4 axis-towers
    const axv = [mayor.population, mayor.income, mayor.prestige, mayor.stability];
    for (let a = 0; a < 4; a++) {
      const bx = ox + 40 + a * 66, bw = 44;
      const hgt = Math.min(150, axv[a] * 6 + 6), by = 496 - hgt;
      // building body
      ctx.fillStyle = "#0e1626"; rrect(bx, by, bw, hgt, 3); ctx.fill();
      ctx.fillStyle = AXCOL[a] + "cc"; rrect(bx, by, bw, 4, 2); ctx.fill();
      // lit windows
      for (let wy = by + 8; wy < 492; wy += 12) for (let wx = bx + 6; wx < bx + bw - 6; wx += 11) {
        ctx.fillStyle = ((wx + wy) % 3) ? "#1a2438" : (AXCOL[a] + "88"); ctx.fillRect(wx, wy, 5, 6);
      }
      label(bx + bw / 2, 508, AXES[a].slice(0, 4).toUpperCase(), 7, "#7C8AA0", "center");
      label(bx + bw / 2, by - 4, String(axv[a]), 9, AXCOL[a], "center");
    }
    // header: name + prosperity
    ctx.fillStyle = "rgba(8,14,26,.8)"; rrect(ox + 14, 168, 300, 54, 9); ctx.fill();
    label(ox + 28, 192, mayor.handle.toUpperCase().slice(0, 14), 13, soft, "left");
    label(ox + 28, 210, "weak: " + (mayor.weakest || "—"), 9, "#fb5d5d", "left");
    label(ox + 300, 200, String(mayor.prosperity), 30, soft, "right");
    label(ox + 300, 214, "PROSPERITY", 8, "#7C8AA0", "right");
    // exposed-axis pulse on the strongest tower (what a shock hits)
    if (!data.winner) {
      const si = AXES.indexOf(mayor.strongest); if (si >= 0) {
        const bx = ox + 40 + si * 66; ctx.strokeStyle = "rgba(251,93,93,.6)"; ctx.lineWidth = 2;
        rrect(bx - 2, 496 - Math.min(150, [mayor.population, mayor.income, mayor.prestige, mayor.stability][si] * 6 + 6) - 2, 48, 6, 3); ctx.stroke();
      }
    }
  }
  function eventBanner(t) {
    if (!data || !data.event || evtFlash <= 0.02) return;
    evtFlash *= 0.96;
    const e = data.event, bust = e.bust;
    ctx.globalAlpha = Math.min(0.9, evtFlash);
    ctx.fillStyle = bust ? "rgba(120,20,30,.5)" : "rgba(20,90,60,.5)"; ctx.fillRect(0, 250, W, 60);
    ctx.globalAlpha = 1;
    label(W / 2, 282, `${bust ? "💥 BUST" : "📈 BOOM"} · ${e.side} ${e.axis} ${e.delta > 0 ? "+" : ""}${e.delta}`, 16, bust ? "#ff6d7d" : "#5eead4", "center");
  }
  function oddsA() {
    if (!data) return 0.5; const m = data.mayors;
    const d = (m[0].prosperity - m[1].prosperity) / 18; const f = (x) => 1 / (1 + Math.exp(-x));
    const a = f(d), b = f(-d); return a / (a + b);
  }
  function chrome() {
    if (!data) return;
    // round badge top-left (clear of the odds pill)
    ctx.fillStyle = "rgba(8,14,26,.85)"; rrect(12, 44, 130, 26, 8); ctx.fill();
    label(20, 61, `ROUND ${data.round} / ${data.rounds}`, 11, "#22d3ee", "left");
    // odds pill top-center
    const a = oddsA(), pa = Math.round(a * 100), bw = 248, x = (W - bw) / 2;
    ctx.fillStyle = "rgba(7,11,20,.82)"; rrect(x, 7, bw, 30, 9); ctx.fill();
    label(W / 2, 19, "◷ LIVE ODDS", 8, "#7C8AA0", "center");
    label(x + 12, 19, data.mayors[0].handle.toUpperCase() + " " + pa + "%", 9, "#5eead4", "left");
    label(x + bw - 12, 19, (100 - pa) + "% " + data.mayors[1].handle.toUpperCase(), 9, "#c4b5fd", "right");
    const aw = Math.max(2, (bw - 24) * a); ctx.fillStyle = "#10b981"; rrect(x + 12, 25, aw, 7, 3); ctx.fill();
    ctx.fillStyle = "#8b5cf6"; rrect(x + 12 + aw, 25, bw - 24 - aw, 7, 3); ctx.fill();
  }
  function finish() {
    if (!data || (!data.winner && data.status !== "draw")) return;
    ctx.fillStyle = "rgba(3,6,12,.6)"; ctx.fillRect(0, 0, W, H);
    const draw = !data.winner, col = draw ? "#9aa2b6" : data.winner === data.mayors[0].handle ? "#34d399" : "#a855f7";
    ctx.fillStyle = "rgba(5,9,16,.75)"; rrect(W / 2 - 220, H / 2 - 46, 440, 92, 14); ctx.fill();
    label(W / 2, H / 2 - 4, draw ? "DEADLOCK" : "BOOMTOWN", 34, col, "center");
    label(W / 2, H / 2 + 26, draw ? "Equal prosperity" : data.winner + " — most prosperous city", 15, "#e9ecf5", "center");
  }
  function frame(t) {
    sky(t);
    if (data) {
      cityPlot(0, data.mayors[0], "#10b981", "#5eead4", 0);
      cityPlot(W / 2 + 6, data.mayors[1], "#8b5cf6", "#c4b5fd", 1);
      eventBanner(t); chrome(); finish();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  function rrect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function label(x, y, t, px, c, al) { ctx.fillStyle = c; ctx.textAlign = al || "left"; ctx.font = `700 ${px}px ui-monospace,monospace`; ctx.fillText(t, x, y); }
})();
