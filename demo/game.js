/* Boomtown — a split iso river-valley city-builder duel. Two mayors (Champions)
 * GROW a city across a central river over 7 rounds; the most prosperous wins.
 * Their PUBLIC PROMPT is a development doctrine: BOOM — scale hard, build fast,
 * aggressive growth (huge upside, but a lopsided skyline is fragile) — or STEADY
 * — a balanced, mixed, careful plan (slower, but resilient). Each turn a mayor
 * picks from legal_moves: build:housing (+population), build:industry (+income),
 * build:landmark (+prestige), build:park (+stability). Prosperity is a weighted
 * blend of those four axes. HIDDEN TWIST: every round a seeded EVENT (a boom or a
 * bust) strikes one side's WEAKEST axis — so a one-track doctrine can crater, and
 * two identical prompts never resolve quite the same way.
 *
 * Faithful to the engine Game-trait model: turn-based, opaque move-strings, the
 * agent plays via get_state → legal_moves → make_move(mv, ply). The prompt
 * decides which legal lot it develops each turn.
 */
(function () {
  const AW = window.AW;
  const A = AW; // engine code uses `A.`, render code uses `AW.` — same toolkit
  const W = 780, H = 560;
  const ROUNDS = 7;

  // ---- iso valley geometry --------------------------------------------------
  // The map is a split valley: A develops the left bank, B the right bank, with a
  // diagonal river + bridge through the middle. Each side owns a 3x4 lot grid laid
  // out in isometric space; buildings tween up brick-by-brick as they're built.
  const ISO = { tw: 52, th: 28 }; // tile half-extents
  const ORIGIN_A = { x: W * 0.32, y: 300 };
  const ORIGIN_B = { x: W * 0.68, y: 300 };
  // iso projection: col runs "into" the screen (toward the river), row spreads
  // down the valley. mirror for B so both banks face the river.
  function lot(side, col, row) {
    const o = side === "A" ? ORIGIN_A : ORIGIN_B;
    const dir = side === "A" ? -1 : 1; // A grid grows left, B grows right
    const cx = col, ry = row - 1.5;
    return {
      x: o.x + dir * (cx - ry) * ISO.tw * 0.5,
      y: o.y + (cx + ry) * ISO.th * 0.5 - col * 3,
    };
  }
  const COLS = 4, ROWS = 4; // 16 lots per side; champions fill a sub-grid
  // hero-tower placement order (col,row) — spreads the 7 builds across the bank
  const LOT_ORDER = [[1, 1], [2, 2], [1, 2], [2, 1], [3, 1], [1, 3], [2, 3], [3, 2], [3, 3], [0, 1]];

  // ---- doctrine: parse the public prompt into a build policy ----------------
  const KW = {
    boom: ["growth", "grow", "fast", "aggressive", "aggressively", "scale", "build", "boom", "rapid", "expand", "tall", "skyscraper", "maximize", "hustle"],
    steady: ["balanced", "balance", "stable", "stability", "steady", "mixed", "mix", "careful", "carefully", "resilient", "diverse", "sustainable", "hedge", "patient"],
  };
  function doctrine(prompt) {
    const p = (prompt || "").toLowerCase();
    let b = 0, s = 0;
    for (const k of KW.boom) if (p.includes(k)) b++;
    for (const k of KW.steady) if (p.includes(k)) s++;
    // axis preference: pick out which axis the mayor leans toward
    const leans =
      /indust|income|money|factor|econom|profit|job/.test(p) ? "industry"
      : /housing|popul|people|resident|home|tenant/.test(p) ? "housing"
      : /landmark|prestige|monument|icon|tower|wonder|grand/.test(p) ? "landmark"
      : /park|green|stab|nature|quality|liv/.test(p) ? "park"
      : null;
    if (b > s) return { kind: "boom", tag: "boom doctrine", leans: leans || "industry" };
    if (s > b) return { kind: "steady", tag: "steady doctrine", leans: leans || null };
    return { kind: "steady", tag: "balanced plan", leans: leans || null };
  }
  function highlight(prompt) {
    let h = (prompt || "").replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
    for (const k of [...KW.boom, ...KW.steady]) {
      h = h.replace(new RegExp("\\b(" + k + ")\\b", "ig"), "<b>$1</b>");
    }
    return h;
  }

  const DEF_A = "Boom this valley. Scale fast and build aggressively — stack industry for income and tall towers for growth. Out-develop them; a bigger skyline always wins.";
  const DEF_B = "Grow steady and balanced. A careful, mixed city — housing, parks and prestige in equal measure — is resilient. Slow and stable beats a fragile boom.";

  // axes and their weight in the prosperity blend
  const AXES = ["housing", "industry", "landmark", "park"];
  const MOVE = { housing: "build:housing", industry: "build:industry", landmark: "build:landmark", park: "build:park" };
  const WEIGHT = { housing: 1.0, industry: 1.15, landmark: 1.25, park: 0.9 };
  const AXIS_LABEL = { housing: "POP", industry: "INC", landmark: "PRESTIGE", park: "STABILITY" };

  function prosperity(s) {
    return s.housing * WEIGHT.housing + s.industry * WEIGHT.industry +
      s.landmark * WEIGHT.landmark + s.park * WEIGHT.park;
  }
  function weakestAxis(s) {
    let w = AXES[0];
    for (const a of AXES) if (s[a] < s[w]) w = a;
    return w;
  }
  function strongestAxis(s) {
    let w = AXES[0];
    for (const a of AXES) if (s[a] > s[w]) w = a;
    return w;
  }
  // stability cushions a bust; lopsided cities (high spread) are fragile.
  function fragility(s) {
    const vals = AXES.map((a) => s[a]);
    const mean = vals.reduce((p, c) => p + c, 0) / 4;
    const spread = Math.sqrt(vals.reduce((p, c) => p + (c - mean) * (c - mean), 0) / 4);
    return spread; // higher = more lopsided = more exposed
  }

  // ---- the deterministic engine --------------------------------------------
  function build(seed, opts) {
    const rng = A.rng(seed);
    const prompts = { A: (opts.prompts && opts.prompts.A) || DEF_A, B: (opts.prompts && opts.prompts.B) || DEF_B };
    const doc = { A: doctrine(prompts.A), B: doctrine(prompts.B) };

    // per-side state: axis scores + a list of placed buildings (lot grid order)
    const st = {
      A: { housing: 0, industry: 0, landmark: 0, park: 0, builds: [], lots: 0 },
      B: { housing: 0, industry: 0, landmark: 0, park: 0, builds: [], lots: 0 },
    };

    // seeded EVENT schedule: each round, one side's WEAKEST axis is hit by a
    // boom (+) or bust (-). The hit side + sign are seeded → identical prompts
    // diverge. Magnitude scales with how exposed that side is (fragility).
    const events = [];
    // sideBias < 0.5 favours hitting A; we resolve the actual target at runtime
    // weighted by live fragility so the more exposed city is shocked more often.
    for (let r = 0; r < ROUNDS; r++) {
      const isBust = rng() < 0.6; // busts a touch more likely → drama
      events.push({ round: r, bias: rng(), isBust, roll: rng() });
    }

    // a boom mayor pours into one axis; a steady mayor round-robins all four to
    // stay balanced. `leans` biases which axis a boomer favours.
    function planAxis(id, round) {
      const d = doc[id];
      if (d.kind === "boom") {
        // mostly its favoured axis, occasionally a second to avoid pure 1-axis
        const second = d.leans === "industry" ? "housing" : "industry";
        return (round % 3 === 2) ? second : d.leans;
      }
      // steady: round-robin all four axes evenly (housing,industry,park,landmark…)
      const order = ["housing", "industry", "park", "landmark"];
      return order[round % 4];
    }

    function gainFor(id, axis, round) {
      const d = doc[id];
      const r = A.rng(seed * 733 + round * 31 + (id === "A" ? 1 : 2) * 7);
      // boom doctrine builds BIGGER but only where it focuses; steady builds
      // solid medium everywhere.
      let g = d.kind === "boom" ? 16.5 + r() * 8 : 12 + r() * 4;
      // diminishing returns past a tall stack on a single axis (encourages mix)
      const have = st[id][axis];
      if (have > 54) g *= 0.58; else if (have > 36) g *= 0.78;
      return g;
    }

    const beats = [];
    const oddsHist = [];
    let ply = 1;

    function snapOdds() {
      const pa = prosperity(st.A), pb = prosperity(st.B);
      // exposure penalty: a fragile city should price below its raw prosperity
      const ea = pa - fragility(st.A) * 0.85, eb = pb - fragility(st.B) * 0.85;
      const a = 1 / (1 + Math.exp(-((ea - eb) / 16)));
      const b = 1 - a;
      return { A: a * 100, B: b * 100 };
    }
    oddsHist.push(snapOdds());

    function nameOf(id) { return id === "A" ? "Sol" : "Vera"; }

    for (let round = 0; round < ROUNDS; round++) {
      for (const id of ["A", "B"]) {
        const me = st[id];
        const axis = planAxis(id, round);
        const legal = AXES.map((a) => MOVE[a]);
        const gain = gainFor(id, axis, round);
        me[axis] += gain;
        // place a building in the next free lot. A curated order spreads the 7
        // champion towers across the plateau (front rows near the river first,
        // then back) so the skyline reads full rather than a single line.
        const li = me.lots++;
        const cell = LOT_ORDER[li % LOT_ORDER.length];
        const col = cell[0], row = cell[1];
        const pos = lot(id, col, row);
        me.builds.push({ axis, col, row, x: pos.x, y: pos.y, height: gain, round, born: ply });

        const thought = doc[id].kind === "boom"
          ? (axis === doc[id].leans
            ? `Scale hard — pour everything into ${AXIS_LABEL[axis].toLowerCase()}. A bigger skyline wins.`
            : `Stack a little ${AXIS_LABEL[axis].toLowerCase()} to feed the boom, then back to scaling.`)
          : `Keep it balanced — round-robin the axes so no single shock can topple the city.`;

        // We resolve the event on the second seat of the round so both have built.
        const ev = events[round];
        const isLastSeatOfRound = id === "B";

        beats.push({
          ply: ply++, agent: id,
          thought,
          observe: {
            round: round + 1, prosperity: Math.round(prosperity(me)),
            pop: Math.round(me.housing), inc: Math.round(me.industry),
            prestige: Math.round(me.landmark), stability: Math.round(me.park),
            weakest: AXIS_LABEL[weakestAxis(me)].toLowerCase(),
          },
          legal,
          move: MOVE[axis], ok: true,
          result: `ok · built ${axis} +${Math.round(gain)} · prosperity ${Math.round(prosperity(me))}`,
          events: [
            `${nameOf(id)} ${doc[id].kind === "boom" ? "boom-builds" : "carefully raises"} a ${axis} block (+${Math.round(gain)}).`,
          ],
          state: snapshot(id, null),
        });
        oddsHist.push(snapOdds());

        // ---- resolve the round's seeded event (after B's build) -------------
        if (isLastSeatOfRound) {
          // pick the target side: weighted toward the MORE FRAGILE city (a
          // lopsided boom invites the shock), but the seed's bias keeps it live.
          const fa = fragility(st.A), fb = fragility(st.B);
          const pFragile = 0.5 + A.clamp((fa - fb) / 60, -0.34, 0.34); // prob A is hit
          const evSide = ev.bias < pFragile ? "A" : "B";
          const tgt = st[evSide];
          // a BUST craters your BIGGEST sector (a crash hits where you're heavy);
          // a BOOM lifts a sector you've invested in. The strongest-axis target
          // means a one-track boom city has the most to lose.
          const axisHit = strongestAxis(tgt);
          const frag = fragility(tgt);
          let delta;
          if (ev.isBust) {
            // damage scales with the height of that sector AND lopsidedness;
            // PARK (stability) cushions it — steady cities shrug shocks off.
            const cushion = 1 - A.clamp(tgt.park / 60, 0, 0.55);
            delta = -(6 + ev.roll * 8 + tgt[axisHit] * 0.12 + frag * 0.36) * cushion;
            tgt[axisHit] = Math.max(0, tgt[axisHit] + delta);
          } else {
            delta = 7 + ev.roll * 9;
            tgt[axisHit] += delta;
          }
          const evName = EVENTS[ev.isBust ? "bust" : "boom"][Math.floor(ev.roll * EVENTS.bust.length) % EVENTS.bust.length];
          beats.push({
            ply: ply++, agent: "ref",
            thought: null,
            observe: { event: ev.isBust ? "BUST" : "BOOM", target: nameOf(evSide), axis: AXIS_LABEL[axisHit].toLowerCase(), delta: Math.round(delta) },
            legal: null,
            move: ev.isBust ? "event:bust" : "event:boom",
            ok: !ev.isBust,
            result: `${ev.isBust ? "BUST" : "BOOM"} · ${nameOf(evSide)}'s ${AXIS_LABEL[axisHit].toLowerCase()} ${delta >= 0 ? "+" : ""}${Math.round(delta)}`,
            events: [
              `${ev.isBust ? "BUST" : "BOOM"}: ${evName} hits ${nameOf(evSide)}'s ${AXIS_LABEL[axisHit].toLowerCase()} (${delta >= 0 ? "+" : ""}${Math.round(delta)}).`,
            ],
            state: snapshot(evSide, { side: evSide, axis: axisHit, bust: ev.isBust, delta: Math.round(delta), name: evName, round }),
          });
          oddsHist.push(snapOdds());
        }
      }
    }

    function snapshot(mover, event) {
      return {
        A: cloneSide(st.A), B: cloneSide(st.B), mover,
        propA: Math.round(prosperity(st.A)), propB: Math.round(prosperity(st.B)),
        event,
      };
    }
    function cloneSide(s) {
      return {
        housing: s.housing, industry: s.industry, landmark: s.landmark, park: s.park,
        lots: s.lots, builds: s.builds.map((b) => ({ ...b })),
        prosperity: prosperity(s), fragility: fragility(s),
      };
    }

    // resolve
    const pa = prosperity(st.A), pb = prosperity(st.B);
    let winner = Math.abs(pa - pb) < 1.5 ? null : pa > pb ? "A" : "B";
    let winReason = winner == null ? "tie" : "prosperity";

    function finalLine() {
      if (winner == null) return `Draw — both cities tie at ${Math.round(pa)} prosperity.`;
      const loser = winner === "A" ? "B" : "A";
      const wD = doc[winner], lD = doc[loser];
      if (wD.kind === "steady" && lD.kind === "boom")
        return `${nameOf(winner)}'s balanced city outlasts ${nameOf(loser)}'s fragile boom — ${Math.round(winner === "A" ? pa : pb)} to ${Math.round(loser === "A" ? pa : pb)}.`;
      if (wD.kind === "boom")
        return `${nameOf(winner)}'s aggressive boom pays off — most prosperous at ${Math.round(winner === "A" ? pa : pb)}.`;
      return `${nameOf(winner)} is the most prosperous city — ${Math.round(winner === "A" ? pa : pb)} to ${Math.round(loser === "A" ? pa : pb)}.`;
    }

    beats.push({
      ply: ply++, agent: "ref", move: "resolve", legal: null,
      observe: { winner: winner == null ? "draw" : nameOf(winner), reason: winReason, A: Math.round(pa), B: Math.round(pb) },
      result: winner == null ? "draw — cities tie" : nameOf(winner) + " wins · most prosperous",
      events: [finalLine()],
      state: { A: cloneSide(st.A), B: cloneSide(st.B), mover: null, final: true, propA: Math.round(pa), propB: Math.round(pb), event: null },
    });

    return {
      seed, beats, winner, winReason,
      names: { A: nameOf("A"), B: nameOf("B") },
      promptOf: (id) => highlight(prompts[id]),
      tagOf: (id) => doc[id].tag,
      oddsAt: (b) => oddsHist[Math.min(b, oddsHist.length - 1)] || { A: 50, B: 50 },
      _doc: doc, _events: events,
    };
  }

  const EVENTS = {
    boom: ["a tech campus opens", "a gold strike", "tourism surges", "a new trade route", "a festival boom", "investors pour in"],
    bust: ["a factory fire", "a market crash", "a flood warning", "a labor strike", "a power blackout", "a quake tremor"],
  };

  // ====== RENDER =============================================================
  const AXIS_COL = {
    housing: { f: "#1f9d6b", t: "#2dd58f", s: "#127049", win: "#5ec8ff" },
    industry: { f: "#b07d2a", t: "#e0a83a", s: "#7a5418", win: "#ffd56b" },
    landmark: { f: "#7c4dd6", t: "#a878ff", s: "#52308f", win: "#e6c7ff" },
    park: { f: "#2f8f4a", t: "#4fd06a", s: "#1c5e30", win: "#bdf0a0" },
  };

  function draw(ctx, v) {
    const t = v.t, res = v.result, beat = v.beat, bt = res.beats[beat] || {};
    const stt = bt.state || { A: emptySide(), B: emptySide(), propA: 0, propB: 0 };

    // ---- day↔night sweep: phase advances over the match ----------------------
    const phase = matchPhase(res, beat, v.beatT, v.over); // 0..1 day→night
    sky(ctx, t, phase);
    valley(ctx, res.seed, t, phase);
    river(ctx, t, phase);
    bridge(ctx, t);

    // build each side's skyline (buildings tween up as their birth beat passes)
    drawSide(ctx, "A", stt.A, res, beat, v.beatT, t, phase, v);
    drawSide(ctx, "B", stt.B, res, beat, v.beatT, t, phase, v);

    citizens(ctx, res.seed, t, stt, phase);

    // ---- weakest-axis exposure marker: a pulsing red ring over the most
    // exposed sector of whichever side the NEXT seeded shock will strike, so the
    // boom/bust twist is legible BEFORE it lands.
    const firingNow = bt.state && bt.state.event;
    if (!v.over && !firingNow) exposureMarker(ctx, res, beat, stt, t, phase);

    // event spark/smoke on a bust this beat — pinned to the tallest building of
    // the actually-hit axis (see eventFx)
    if (bt.state && bt.state.event && !v.over) eventFx(ctx, bt.state.event, stt, v.beatT, t);

    // finish: grey the losing half to silhouettes
    if (v.over) greyLoser(ctx, res);

    hud(ctx, res, stt, t);
    banner(ctx, res, bt, v);

    if (v.over) finishOverlay(ctx, res, t);
    vignette(ctx);
  }

  function emptySide() { return { housing: 0, industry: 0, landmark: 0, park: 0, lots: 0, builds: [], prosperity: 0, fragility: 0 }; }

  function matchPhase(res, beat, beatT, over) {
    if (over) return 1;
    const total = res.beats.length;
    const prog = (beat + AW.clamp(beatT, 0, 1)) / Math.max(1, total - 1);
    return AW.clamp(prog, 0, 1);
  }

  // --- sky: dusk gradient that deepens to night ------------------------------
  function sky(ctx, t, phase) {
    const ground = H;
    // interpolate day→night palette
    const day = ["#2a3a66", "#3a4f7a", "#caa37a"];
    const night = ["#05081a", "#0c1336", "#241a4a"];
    const top = mix(day[0], night[0], phase), mid = mix(day[1], night[1], phase), hor = mix(day[2], night[2], phase);
    const g = ctx.createLinearGradient(0, 0, 0, ground * 0.7);
    g.addColorStop(0, top); g.addColorStop(0.55, mid); g.addColorStop(1, hor);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, ground);
    // sun/moon arc across the sky — kept in the central gap above the river so
    // it never collides with the corner HUD panels.
    const sx = AW.lerp(W * 0.36, W * 0.64, phase);
    const sy = 150 - Math.sin(phase * Math.PI) * 26;
    if (phase < 0.55) { // sun
      const a = 1 - phase / 0.55;
      AW.glow(ctx, sx, sy, 80, `rgba(255,210,140,${0.32 * a})`);
      ctx.fillStyle = `rgba(255,236,190,${0.7 + 0.3 * a})`; ctx.beginPath(); ctx.arc(sx, sy, 22, 0, 7); ctx.fill();
    } else { // moon
      const a = (phase - 0.55) / 0.45;
      AW.glow(ctx, sx, sy, 70, `rgba(160,180,255,${0.18 * a})`);
      ctx.fillStyle = "#e7ecff"; ctx.beginPath(); ctx.arc(sx, sy, 20, 0, 7); ctx.fill();
      ctx.fillStyle = mix("#3a4f7a", "#0c1336", phase); ctx.beginPath(); ctx.arc(sx - 8, sy - 6, 16, 0, 7); ctx.fill();
    }
    // stars fade in with night
    if (phase > 0.4 && !AW.reduced) {
      for (let i = 0; i < 50; i++) {
        const x = (i * 137) % W, y = (i * 53) % 180;
        const tw = (Math.sin(t / 700 + i) + 1) / 2;
        ctx.fillStyle = `rgba(200,220,255,${(0.05 + tw * 0.30) * (phase - 0.4) / 0.6})`;
        ctx.fillRect(x, y, 2, 2);
      }
    }
    // distant mountain ridge framing the valley
    ridge(ctx, phase);
  }
  function ridge(ctx, phase) {
    const col = mix("#26345c", "#0a1130", phase);
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(0, 150);
    const pts = [[0, 150], [90, 110], [180, 138], [280, 96], [380, 130], [480, 100], [580, 134], [690, 104], [780, 140]];
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.lineTo(W, 150); ctx.closePath(); ctx.fill();
    ctx.fillStyle = mix("#1c2748", "#070c22", phase);
    ctx.beginPath(); ctx.moveTo(0, 168);
    const p2 = [[0, 168], [120, 150], [240, 172], [360, 146], [500, 176], [640, 150], [780, 172]];
    for (const [x, y] of p2) ctx.lineTo(x, y);
    ctx.lineTo(W, 180); ctx.closePath(); ctx.fill();
  }

  // --- valley ground: two iso plateaus, A left / B right ---------------------
  function valley(ctx, seed, t, phase) {
    // ground gradient bands per side
    drawPlateau(ctx, "A", seed, phase);
    drawPlateau(ctx, "B", seed, phase);
    // ambient suburb: small static houses fill the unused lots so the valley
    // reads as a living town even before the champions build their towers.
    suburb(ctx, "A", seed, t, phase);
    suburb(ctx, "B", seed, t, phase);
  }
  // small low houses scattered on the back/edge lots (never on hero lots)
  function suburb(ctx, side, seed, t, phase) {
    const r = AW.rng(seed * 53 + (side === "A" ? 11 : 29));
    const heroSet = new Set(LOT_ORDER.map((c) => c[0] + "," + c[1]));
    for (let col = 0; col <= COLS; col++) {
      for (let row = -1; row <= ROWS; row++) {
        if (heroSet.has(col + "," + row)) continue;
        if (r() > 0.62) continue; // sparse
        const p = lot(side, col, row);
        if (Math.abs(p.x - W / 2) < 50) continue; // keep off the river
        const y = p.y + 18;
        const w = 14 + r() * 8, h = 11 + r() * 13, d = 6;
        const hue = r();
        const base = hue < 0.34 ? "#8a93a8" : hue < 0.67 ? "#9c8a76" : "#7e8c84";
        const front = mix(base, shade(base, 0.62), phase * 0.55);
        const top = mix(shade(base, 1.18), shade(base, 0.78), phase * 0.5);
        const sidec = mix(shade(base, 0.82), shade(base, 0.55), phase * 0.5);
        AW.box(ctx, p.x - w / 2, y - h, w, h, d, front, top, sidec);
        // pitched roof cap
        ctx.fillStyle = mix(r() < 0.5 ? "#b25b4a" : "#5a6b8a", "#1a1d2c", phase * 0.5);
        ctx.fillRect(p.x - w / 2, y - h - 2, w + d, 3);
        // a lit window or two at night
        if (phase > 0.4 && r() < 0.8) {
          const on = ((Math.floor(t / 1700) + col * 7 + row * 5) % 7) < 4;
          ctx.fillStyle = on ? "#ffce7a" : shade(front, 0.7);
          ctx.fillRect(p.x - 4, y - h + 5, 3, 4);
          ctx.fillRect(p.x + 1, y - h + 5, 3, 4);
        }
      }
    }
  }
  function drawPlateau(ctx, side, seed, phase) {
    // build the iso quad covering the side's lot grid + draw grass tiles
    const grass = mix("#3f6b46", "#1b3326", phase);
    const grassEdge = mix("#2c5236", "#13251c", phase);
    const dirt = mix("#5a4a32", "#241d12", phase);
    for (let col = -1; col <= COLS; col++) {
      for (let row = -1; row <= ROWS; row++) {
        const p = lot(side, col, row);
        // skip tiles that fall over the river channel (center band)
        const dx = Math.abs(p.x - W / 2);
        if (dx < 36) continue;
        isoTile(ctx, p.x, p.y + 18, grass, grassEdge, dirt);
      }
    }
  }
  function isoTile(ctx, cx, cy, top, edge, side) {
    const tw = ISO.tw * 0.5, th = ISO.th * 0.5, d = 8;
    // top diamond
    ctx.fillStyle = top;
    ctx.beginPath();
    ctx.moveTo(cx, cy - th); ctx.lineTo(cx + tw, cy); ctx.lineTo(cx, cy + th); ctx.lineTo(cx - tw, cy); ctx.closePath(); ctx.fill();
    // left + right edges (dirt depth)
    ctx.fillStyle = side;
    ctx.beginPath(); ctx.moveTo(cx - tw, cy); ctx.lineTo(cx, cy + th); ctx.lineTo(cx, cy + th + d); ctx.lineTo(cx - tw, cy + d); ctx.closePath(); ctx.fill();
    ctx.fillStyle = edge;
    ctx.beginPath(); ctx.moveTo(cx + tw, cy); ctx.lineTo(cx, cy + th); ctx.lineTo(cx, cy + th + d); ctx.lineTo(cx + tw, cy + d); ctx.closePath(); ctx.fill();
    // subtle grid outline
    ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, cy - th); ctx.lineTo(cx + tw, cy); ctx.lineTo(cx, cy + th); ctx.lineTo(cx - tw, cy); ctx.closePath(); ctx.stroke();
  }

  // --- river: diagonal water channel down the center -------------------------
  function river(ctx, t, phase) {
    const top = mix("#3d7ea6", "#0a2438", phase);
    const bot = mix("#2a5e86", "#06151f", phase);
    ctx.save();
    ctx.beginPath();
    // a slightly meandering vertical channel
    ctx.moveTo(W / 2 - 40, 150);
    ctx.bezierCurveTo(W / 2 - 70, 280, W / 2 - 10, 380, W / 2 - 44, H);
    ctx.lineTo(W / 2 + 44, H);
    ctx.bezierCurveTo(W / 2 + 10, 380, W / 2 + 70, 280, W / 2 + 40, 150);
    ctx.closePath();
    ctx.clip();
    const g = ctx.createLinearGradient(0, 150, 0, H);
    g.addColorStop(0, top); g.addColorStop(1, bot);
    ctx.fillStyle = g; ctx.fillRect(0, 150, W, H);
    // ripples
    if (!AW.reduced) {
      for (let i = 0; i < 40; i++) {
        const y = 160 + i * 11;
        const a = 0.05 + 0.07 * (Math.sin(t / 600 + i) * 0.5 + 0.5);
        ctx.strokeStyle = `rgba(150,220,255,${a})`; ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(W / 2 - 60, y + Math.sin(t / 500 + i) * 2);
        ctx.lineTo(W / 2 + 60, y + Math.cos(t / 480 + i) * 2);
        ctx.stroke();
      }
      // reflection of the night/sun glow
      const sx = AW.lerp(W * 0.16, W * 0.84, phase);
      if (Math.abs(sx - W / 2) < 90) AW.glow(ctx, W / 2, 320, 70, phase < 0.55 ? "rgba(255,220,150,0.18)" : "rgba(160,190,255,0.16)");
    }
    ctx.restore();
    // banks
    ctx.strokeStyle = mix("#5a6f4a", "#1a2418", phase); ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 40, 150); ctx.bezierCurveTo(W / 2 - 70, 280, W / 2 - 10, 380, W / 2 - 44, H); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(W / 2 + 40, 150); ctx.bezierCurveTo(W / 2 + 70, 280, W / 2 + 10, 380, W / 2 + 44, H); ctx.stroke();
  }
  function bridge(ctx, t) {
    // a lit stone bridge crossing the river mid-map, connecting the two halves
    const by = 300;
    ctx.save();
    // deck
    ctx.fillStyle = "#3a3a44";
    ctx.beginPath();
    ctx.moveTo(W / 2 - 78, by - 6); ctx.lineTo(W / 2 + 78, by - 6);
    ctx.lineTo(W / 2 + 78, by + 10); ctx.lineTo(W / 2 - 78, by + 10); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#4a4a56"; ctx.fillRect(W / 2 - 78, by - 6, 156, 4);
    // arch
    ctx.strokeStyle = "#2c2c36"; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(W / 2, by + 10, 40, Math.PI, 0); ctx.stroke();
    // rail lamps
    for (const dx of [-66, -22, 22, 66]) {
      ctx.fillStyle = "#23232c"; ctx.fillRect(W / 2 + dx - 1, by - 16, 3, 10);
      const on = (Math.floor(t / 600) + dx) % 2 === 0;
      ctx.fillStyle = on ? "#ffd98a" : "#6a5a30";
      ctx.beginPath(); ctx.arc(W / 2 + dx, by - 18, 3, 0, 7); ctx.fill();
      if (on) AW.glow(ctx, W / 2 + dx, by - 18, 12, "rgba(255,210,130,0.5)");
    }
    ctx.restore();
  }

  // --- one side's buildings, tweening up as built ----------------------------
  function buildProgress(res, beat, beatT, born) {
    // a building born at ply `born` is fully grown by the end of its own beat.
    const cur = res.beats[beat];
    const curPly = cur ? cur.ply : 0;
    if (born < curPly) return 1;
    if (born > curPly) return 0;
    return AW.easeOut(AW.clamp(beatT, 0, 1));
  }
  function drawSide(ctx, side, sideState, res, beat, beatT, t, phase, v) {
    const builds = (sideState && sideState.builds) || [];
    // sort by screen-y so nearer buildings draw last (painter's order)
    const sorted = builds.slice().sort((a, b) => a.y - b.y);
    for (const b of sorted) {
      const grow = buildProgress(res, beat, beatT, b.born);
      if (grow <= 0.001) continue;
      voxelBuilding(ctx, b, grow, t, phase, side, v.over);
    }
  }
  function voxelBuilding(ctx, b, grow, t, phase, side, over) {
    const col = AXIS_COL[b.axis];
    const x = b.x, y = b.y + 18; // sit on the tile
    // footprint scales by type; heights differ by axis & value
    const wBase = b.axis === "park" ? 30 : b.axis === "landmark" ? 24 : 28;
    const full = Math.min(96, 16 + b.height * 2.0);
    const h = full * grow;
    const depth = 12;
    // park: low green with trees, not a tower
    if (b.axis === "park") {
      // grass pad
      ctx.fillStyle = mix(col.f, col.s, phase * 0.5);
      isoTopQuad(ctx, x, y, 18, mix(col.t, col.f, phase * 0.4));
      // trees pop up
      const nT = 3;
      for (let i = 0; i < nT; i++) {
        const tx = x + (i - 1) * 11, ty = y - 4 - (i % 2) * 4;
        const th2 = (12 + (i % 2) * 6) * grow;
        ctx.fillStyle = "#5a3f28"; ctx.fillRect(tx - 1.5, ty - th2 * 0.4, 3, th2 * 0.4);
        ctx.fillStyle = mix("#54c46a", "#2f7a42", phase * 0.5);
        ctx.beginPath(); ctx.arc(tx, ty - th2 * 0.4, 6 * grow, 0, 7); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.beginPath(); ctx.arc(tx - 2, ty - th2 * 0.4 - 2, 2.5 * grow, 0, 7); ctx.fill();
      }
      return;
    }
    // landmark: a slender tower with a beacon
    const w = wBase;
    AW.shadow(ctx, x, y + 8, w * 0.7, 7, 0.3);
    // night dims the front face; lit windows shine
    const front = mix(col.f, shade(col.f, 0.45), phase * 0.55);
    const top = mix(col.t, shade(col.t, 0.5), phase * 0.5);
    const sidec = mix(col.s, shade(col.s, 0.5), phase * 0.5);
    AW.box(ctx, x - w / 2, y - h, w, h, depth, front, top, sidec);
    // lit windows grid (more lit at night)
    const litRate = 0.18 + phase * 0.5;
    const rows = Math.max(1, Math.floor(h / 12));
    for (let r = 0; r < rows; r++) {
      for (let cwx = 0; cwx < (b.axis === "landmark" ? 2 : 3); cwx++) {
        const wx = x - w / 2 + 5 + cwx * ((w - 10) / Math.max(1, (b.axis === "landmark" ? 1 : 2)));
        const wy = y - h + 6 + r * 12;
        if (wy > y - 6) continue;
        const on = ((Math.floor(t / 1500) + r * 7 + cwx * 13 + Math.floor(x)) % 11) / 11 < litRate;
        ctx.fillStyle = on ? col.win : shade(front, 0.7);
        ctx.fillRect(wx, wy, 4, 6);
        if (on && phase > 0.5) { ctx.fillStyle = col.win + "55"; ctx.fillRect(wx - 1, wy - 1, 6, 8); }
      }
    }
    // rooftop accents
    if (b.axis === "landmark" && grow > 0.9) {
      // spire + beacon
      ctx.fillStyle = top; ctx.beginPath();
      ctx.moveTo(x - 4, y - h); ctx.lineTo(x + 4, y - h); ctx.lineTo(x, y - h - 14); ctx.closePath(); ctx.fill();
      const on = Math.floor(t / 400) % 2 === 0;
      ctx.fillStyle = on ? "#ff5db1" : "#7a2a55";
      ctx.beginPath(); ctx.arc(x, y - h - 14, 3, 0, 7); ctx.fill();
      if (on) AW.glow(ctx, x, y - h - 14, 14, "rgba(255,93,177,0.6)");
    }
    if (b.axis === "industry" && grow > 0.85) {
      // smokestack + chimney puff
      const sx = x + w / 2 - 6;
      ctx.fillStyle = shade(front, 0.7); ctx.fillRect(sx, y - h - 12, 6, 12);
      if (!AW.reduced) {
        for (let i = 0; i < 3; i++) {
          const pp = ((t / 900) + i * 0.33) % 1;
          ctx.fillStyle = `rgba(180,180,190,${0.18 * (1 - pp)})`;
          ctx.beginPath(); ctx.arc(sx + 3 + Math.sin(pp * 4) * 4, y - h - 14 - pp * 22, 3 + pp * 5, 0, 7); ctx.fill();
        }
      }
    }
    if (b.axis === "housing" && grow > 0.9) {
      // pitched roof hint
      ctx.fillStyle = shade(top, 0.85);
      ctx.fillRect(x - w / 2, y - h - 3, w, 3);
    }
  }
  function isoTopQuad(ctx, cx, cy, half, col) {
    const tw = ISO.tw * 0.4, th = ISO.th * 0.4;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(cx, cy - th); ctx.lineTo(cx + tw, cy); ctx.lineTo(cx, cy + th); ctx.lineTo(cx - tw, cy); ctx.closePath(); ctx.fill();
  }

  // --- citizen dots flowing along the bank streets ---------------------------
  function citizens(ctx, seed, t, stt, phase) {
    if (AW.reduced) return;
    const popA = (stt.A && stt.A.housing) || 0, popB = (stt.B && stt.B.housing) || 0;
    drawCitizenStream(ctx, "A", seed, t, popA, phase);
    drawCitizenStream(ctx, "B", seed, t, popB, phase);
  }
  function drawCitizenStream(ctx, side, seed, t, pop, phase) {
    const n = AW.clamp(Math.floor(pop / 7) + 3, 3, 16);
    const r = AW.rng(seed * 17 + (side === "A" ? 3 : 9));
    for (let i = 0; i < n; i++) {
      const row = Math.floor(r() * ROWS);
      const ph = ((t / (3200 + (i % 5) * 400)) + r()) % 1;
      const p0 = lot(side, -0.6, row), p1 = lot(side, COLS - 0.4, row);
      const x = AW.lerp(p0.x, p1.x, ph), y = AW.lerp(p0.y, p1.y, ph) + 20;
      // headlight-ish warm dot at night
      ctx.fillStyle = phase > 0.5 ? "rgba(255,210,140,0.8)" : "rgba(40,30,20,0.7)";
      ctx.fillRect(x, y, 2.4, 2.4);
      if (phase > 0.6) { ctx.fillStyle = "rgba(255,210,140,0.25)"; ctx.fillRect(x - 1, y - 1, 4.4, 4.4); }
    }
  }

  // full built height of a building (matches voxelBuilding's geometry)
  function buildFullHeight(b) {
    if (b.axis === "park") return 18; // park is a low pad, not a tower
    return Math.min(96, 16 + b.height * 2.0);
  }
  // the tallest placed building of `axis` on a side → its screen anchor
  // {x, topY, baseY}. Falls back to the side's plateau centroid if none built.
  function tallestBuildingOf(sideState, side, axis) {
    const builds = (sideState && sideState.builds) || [];
    let best = null, bestH = -1;
    for (const b of builds) {
      if (b.axis !== axis) continue;
      const h = buildFullHeight(b);
      if (h > bestH) { bestH = h; best = b; }
    }
    if (best) return { x: best.x, baseY: best.y + 18, topY: best.y + 18 - bestH, found: true };
    // fallback: any tallest building, else sector centroid
    for (const b of builds) {
      const h = buildFullHeight(b);
      if (h > bestH) { bestH = h; best = b; }
    }
    if (best) return { x: best.x, baseY: best.y + 18, topY: best.y + 18 - bestH, found: false };
    const c = lot(side, 1.5, 1.5);
    return { x: c.x, baseY: c.y + 18, topY: c.y - 8, found: false };
  }

  // find the next seeded shock (ref beat) after the current beat, so we can
  // pre-mark the exposed side before it resolves.
  function nextShock(res, beat) {
    for (let k = beat + 1; k < res.beats.length; k++) {
      const b = res.beats[k];
      if (b.agent === "ref" && b.state && b.state.event) return b.state.event;
      if (b.agent === "ref" && b.move === "resolve") return null;
    }
    return null;
  }

  // --- weakest-axis exposure marker ------------------------------------------
  // A pulsing red ring over the most-exposed sector of the side the NEXT shock
  // targets. The shock hits that side's STRONGEST axis (a crash lands where the
  // city is heaviest); we ring that sector's tallest tower so the twist reads.
  function exposureMarker(ctx, res, beat, stt, t, phase) {
    const ev = nextShock(res, beat);
    if (!ev) return;
    const side = ev.side;
    const sideState = stt[side];
    if (!sideState) return;
    const anchor = tallestBuildingOf(sideState, side, ev.axis);
    const cx = anchor.x, cy = anchor.topY;
    const pulse = AW.reduced ? 0.6 : 0.5 + 0.5 * (Math.sin(t / 260) * 0.5 + 0.5);
    const danger = ev.bust;
    const ringCol = danger ? "251,93,93" : "94,234,212";
    // ground halo at the sector base
    AW.glow(ctx, anchor.x, anchor.baseY, 26 + pulse * 6, `rgba(${ringCol},${0.10 + pulse * 0.10})`);
    // expanding pulse ring over the tower top
    ctx.save();
    for (let r = 0; r < 2; r++) {
      const ph = AW.reduced ? 0.4 : ((t / 900) + r * 0.5) % 1;
      const rad = 10 + ph * 26;
      ctx.strokeStyle = `rgba(${ringCol},${(1 - ph) * 0.55})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(cx, cy, rad, rad * 0.55, 0, 0, 7); ctx.stroke();
    }
    // a crisp targeting reticle so it reads as a deliberate marker, not noise
    ctx.strokeStyle = `rgba(${ringCol},${0.55 + pulse * 0.4})`; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.ellipse(cx, cy, 13, 7, 0, 0, 7); ctx.stroke();
    for (const ang of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * 13, cy + Math.sin(ang) * 7);
      ctx.lineTo(cx + Math.cos(ang) * 19, cy + Math.sin(ang) * 11);
      ctx.stroke();
    }
    ctx.restore();
    // floating tag — kept clear of the HUD panels (which reach y≈140)
    const tag = (danger ? "⚠ EXPOSED · " : "▲ EXPOSED · ") + AXIS_LABEL[ev.axis];
    const tw = tag.length * 6.6 + 12;
    const tagY = Math.max(146, cy - 30);
    ctx.fillStyle = "rgba(8,12,22,0.85)"; AW.rrect(ctx, cx - tw / 2, tagY, tw, 15, 5); ctx.fill();
    ctx.strokeStyle = `rgba(${ringCol},0.6)`; ctx.lineWidth = 1; AW.rrect(ctx, cx - tw / 2 + 0.5, tagY + 0.5, tw - 1, 14, 5); ctx.stroke();
    AW.label(ctx, cx, tagY + 11, tag, 8, `rgb(${ringCol})`, "center");
  }

  // --- event particle fx (bust smoke/sparks, boom confetti) ------------------
  function eventFx(ctx, event, stt, beatT, t) {
    const side = event.side;
    // pin the fx to the ACTUAL tallest building of the hit axis, so the shock
    // lands on the city rather than a fixed point in space.
    const sideState = stt && stt[side];
    const anchor = tallestBuildingOf(sideState, side, event.axis);
    const cx = anchor.x;
    const cy = anchor.topY;
    // keep the floating label on-canvas even when the hit tower is short/tall
    const labY = AW.clamp(cy - 56, 168, 250);
    const a = Math.sin(AW.clamp(beatT, 0, 1) * Math.PI);
    if (event.bust) {
      // red flash over the hit half + impact flash at the tower
      ctx.fillStyle = `rgba(255,60,40,${a * 0.16})`; ctx.fillRect(side === "A" ? 0 : W / 2, 150, W / 2, H - 150);
      AW.glow(ctx, cx, cy, 46 + a * 18, `rgba(255,90,50,${a * 0.5})`);
      // smoke plume rising FROM the tower top
      for (let i = 0; i < 22; i++) {
        const pp = (beatT + i * 0.05) % 1;
        const px = cx + (i - 11) * 4 + Math.sin(t / 200 + i) * 6;
        const py = cy - pp * 90 - 4;
        ctx.fillStyle = `rgba(64,64,72,${a * (1 - pp) * 0.5})`;
        ctx.beginPath(); ctx.arc(px, py, 4 + pp * 10, 0, 7); ctx.fill();
      }
      // ember ring bursting from the tower top
      for (let i = 0; i < 16; i++) {
        const ang = (i / 16) * 7 + beatT * 6;
        const rr = 12 + beatT * 56;
        ctx.fillStyle = i % 2 ? `rgba(255,180,40,${a})` : `rgba(255,90,40,${a})`;
        ctx.fillRect(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr * 0.7, 3, 3);
      }
      AW.label(ctx, cx, labY, "BUST · " + event.delta, 15, "#ff5d6c", "center");
    } else {
      // golden boom: green flash + sparkles rising from the lifted tower
      ctx.fillStyle = `rgba(80,255,160,${a * 0.10})`; ctx.fillRect(side === "A" ? 0 : W / 2, 150, W / 2, H - 150);
      AW.glow(ctx, cx, cy, 40 + a * 16, `rgba(80,255,160,${a * 0.4})`);
      for (let i = 0; i < 26; i++) {
        const pp = (beatT + i * 0.04) % 1;
        const px = cx + (i - 13) * 5 + Math.sin(t / 220 + i) * 8;
        const py = cy + 10 - pp * 110;
        ctx.fillStyle = i % 2 ? `rgba(110,255,180,${a * (1 - pp)})` : `rgba(255,230,140,${a * (1 - pp)})`;
        ctx.fillRect(px, py, 3, 3);
      }
      AW.label(ctx, cx, labY, "BOOM +" + event.delta, 15, "#34d399", "center");
    }
  }

  // --- finish: grey the losing half to silhouettes ---------------------------
  function greyLoser(ctx, res) {
    if (res.winner == null) return;
    const loser = res.winner === "A" ? "B" : "A";
    const x0 = loser === "A" ? 0 : W / 2, w = W / 2;
    ctx.save();
    ctx.fillStyle = "rgba(10,12,20,0.5)"; ctx.fillRect(x0, 150, w, H - 150);
    ctx.restore();
  }

  // --- HUD: per-side prosperity bar + axis breakdown -------------------------
  // Panels sit at y=44 so the top-center band (y<40) stays clear for the
  // harness LIVE-ODDS pill. The ROUND badge is parked top-left, below the pill.
  function hud(ctx, res, stt, t) {
    const wkA = weakestAxisKey(stt.A), wkB = weakestAxisKey(stt.B);
    panelSide(ctx, "A", res.names.A, stt.A, stt.propA, 12, "#10b981", "#5eead4", t, wkA);
    panelSide(ctx, "B", res.names.B, stt.B, stt.propB, W - 12 - 246, "#8b5cf6", "#c4b5fd", t, wkB);
    // round indicator — top-left corner pill, clear of the odds pill at x≈W/2.
    const round = currentRound(res, stt);
    const rx = 12, ry = 10, rw = 92, rh = 22;
    ctx.fillStyle = "rgba(8,12,24,0.85)"; AW.rrect(ctx, rx, ry, rw, rh, 7); ctx.fill();
    ctx.strokeStyle = "rgba(34,211,238,0.4)"; ctx.lineWidth = 1; AW.rrect(ctx, rx + 0.5, ry + 0.5, rw - 1, rh - 1, 7); ctx.stroke();
    AW.label(ctx, rx + 11, ry + 15, `ROUND ${round}/${ROUNDS}`, 11, "#22d3ee", "left");
  }
  function weakestAxisKey(s) {
    if (!s) return null;
    let w = AXES[0];
    for (const a of AXES) if ((s[a] || 0) < (s[w] || 0)) w = a;
    return w;
  }
  function currentRound(res, stt) {
    if (!stt) return 1;
    const total = (stt.A.lots || 0);
    return AW.clamp(total, 1, ROUNDS);
  }
  function panelSide(ctx, id, name, s, prop, x, col, soft, t, weakKey) {
    s = s || emptySide();
    const wB = 246, hB = 96;
    ctx.fillStyle = "rgba(8,12,24,0.84)"; AW.rrect(ctx, x, 44, wB, hB, 10); ctx.fill();
    ctx.strokeStyle = col + "66"; ctx.lineWidth = 1; AW.rrect(ctx, x + 0.5, 44.5, wB - 1, hB - 1, 10); ctx.stroke();
    AW.label(ctx, x + 12, 62, name.toUpperCase(), 12, soft, "left");
    // big prosperity number — label sits to the LEFT of the number so they
    // never collide (the number is right-anchored to the panel edge).
    AW.label(ctx, x + wB - 12, 64, String(Math.round(prop || 0)), 22, col, "right");
    AW.label(ctx, x + wB - 64, 62, "PROSPERITY", 7, "#8aa0bf", "right");
    // four axis mini-bars
    const maxV = 70;
    AXES.forEach((a, i) => {
      const yy = 78 + i * 13;
      const lab = AXIS_LABEL[a];
      const isWeak = a === weakKey;
      AW.label(ctx, x + 12, yy + 5, lab, 7, AXIS_COL[a].t, "left");
      const bx = x + 72, bw = 120, bh = 6;
      // baseline TRACK — always visible so an empty axis reads as 'low', not a
      // missing/broken bar.
      ctx.fillStyle = "#0c1626"; AW.rrect(ctx, bx, yy, bw, bh, 3); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 1; AW.rrect(ctx, bx + 0.5, yy + 0.5, bw - 1, bh - 1, 3); ctx.stroke();
      const frac = AW.clamp((s[a] || 0) / maxV, 0, 1);
      // a tiny min nub guarantees every axis shows SOMETHING — zero reads as a
      // faint stub at the start of the track, not a void.
      const fillW = (s[a] || 0) < 0.5 ? 4 : Math.max(6, bw * frac);
      ctx.fillStyle = (s[a] || 0) < 0.5 ? shade(AXIS_COL[a].t, 0.5) : AXIS_COL[a].t;
      AW.rrect(ctx, bx, yy, fillW, bh, 3); ctx.fill();
      // weakest axis: a faint pulsing exposure dot by the label so the seeded
      // shock target is legible in the HUD too.
      if (isWeak) {
        const pulse = AW.reduced ? 0.6 : 0.45 + 0.4 * (Math.sin(t / 320) * 0.5 + 0.5);
        ctx.fillStyle = `rgba(251,93,93,${pulse})`;
        ctx.beginPath(); ctx.arc(bx - 7, yy + bh / 2, 2.6, 0, 7); ctx.fill();
      }
      AW.label(ctx, x + wB - 12, yy + 5, String(Math.round(s[a] || 0)), 8, soft, "right");
    });
  }

  // --- bottom narration banner -----------------------------------------------
  function banner(ctx, res, bt, v) {
    const h = 44, y = H - h;
    ctx.fillStyle = "rgba(5,9,16,0.92)"; ctx.fillRect(0, y, W, h);
    ctx.strokeStyle = "rgba(34,211,238,0.4)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke();
    AW.label(ctx, 16, y + 18, "🏗 CITY HALL", 10, "#22d3ee", "left");
    let line = "Two mayors grow a split-river valley over seven rounds. Read each prompt — who booms hard, who builds balanced? A seeded shock hits a weak axis each round.";
    if (bt && bt.events && bt.events[0]) line = bt.events[0];
    if (v.over && res.beats.length) line = res.beats[res.beats.length - 1].events[0];
    AW.wrap(ctx, line, 116, y + 18, W - 132, 14, 12, "#cfe0ff", "ui-monospace,monospace");
  }

  function finishOverlay(ctx, res, t) {
    ctx.fillStyle = "rgba(3,6,12,0.5)"; ctx.fillRect(0, 0, W, H);
    const draw0 = res.winner == null;
    const col = draw0 ? "#9aa2b6" : res.winner === "A" ? "#34d399" : "#a855f7";
    const rgb = draw0 ? "154,162,182" : res.winner === "A" ? "52,211,153" : "168,85,247";
    const winName = draw0 ? "" : res.names[res.winner];
    // confetti over the winner's half (drawn FIRST so the plate sits on top of
    // any sparks that drift into the title band).
    const wx = draw0 ? W / 2 : res.winner === "A" ? W * 0.28 : W * 0.72;
    AW.glow(ctx, wx, H * 0.34, 230, `rgba(${rgb},0.18)`);
    if (!draw0 && !AW.reduced) for (let i = 0; i < 46; i++) {
      const a = (i / 46) * 7 + t / 600;
      const rr = 50 + (i % 6) * 24 + Math.sin(t / 300 + i) * 12;
      ctx.fillStyle = i % 2 ? col : "#fff";
      ctx.fillRect(wx + Math.cos(a) * rr, H * 0.30 + Math.sin(a) * rr * 0.55, 3, 3);
    }

    // ---- dark backing plate / blur band behind the title block so the lit
    // skyline never muddies the lettering ------------------------------------
    const sub = draw0 ? "Both cities tie" : winName + " · MOST PROSPEROUS";
    const reason = res.beats[res.beats.length - 1].events[0];
    const bandY = H * 0.5 - 96, bandH = 224, bandX = W * 0.5 - 320, bandW = 640;
    // soft vignette halo first, then a layered rounded plate
    const grad = ctx.createLinearGradient(0, bandY, 0, bandY + bandH);
    grad.addColorStop(0, "rgba(4,7,14,0)");
    grad.addColorStop(0.16, "rgba(4,7,14,0.86)");
    grad.addColorStop(0.84, "rgba(4,7,14,0.86)");
    grad.addColorStop(1, "rgba(4,7,14,0)");
    ctx.fillStyle = grad; ctx.fillRect(0, bandY, W, bandH);
    ctx.fillStyle = "rgba(6,10,20,0.82)"; AW.rrect(ctx, bandX, bandY + 18, bandW, bandH - 36, 16); ctx.fill();
    ctx.strokeStyle = `rgba(${rgb},0.45)`; ctx.lineWidth = 1.5; AW.rrect(ctx, bandX + 0.75, bandY + 18.75, bandW - 1.5, bandH - 37.5, 16); ctx.stroke();
    // a thin accent rule under the title
    ctx.strokeStyle = `rgba(${rgb},0.5)`; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(W / 2 - 150, H * 0.5 - 8); ctx.lineTo(W / 2 + 150, H * 0.5 - 8); ctx.stroke();

    // "BOOMTOWN" banner + subtitle + scores + reason, all inside the plate
    AW.label(ctx, W / 2, H * 0.5 - 30, "BOOMTOWN", 46, col, "center", "ui-monospace,monospace");
    AW.label(ctx, W / 2, H * 0.5 + 14, sub, 16, "#e9ecf5", "center");
    AW.label(ctx, W / 2, H * 0.5 + 42,
      `${res.names.A} ${res.beats[res.beats.length - 1].state.propA}   ·   ${res.beats[res.beats.length - 1].state.propB} ${res.names.B}`,
      15, "#cfe0ff", "center");
    AW.wrap(ctx, reason, W / 2 - 280, H * 0.5 + 70, 560, 16, 12, "#9fb2d6", "ui-monospace,monospace");
  }

  function vignette(ctx) {
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.32, W / 2, H / 2, H * 0.85);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.5)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  // --- color helpers ---------------------------------------------------------
  function hex(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function mix(a, b, t) {
    t = AW.clamp(t, 0, 1);
    const ca = hex(a), cb = hex(b);
    const r = Math.round(AW.lerp(ca[0], cb[0], t)), g = Math.round(AW.lerp(ca[1], cb[1], t)), bl = Math.round(AW.lerp(ca[2], cb[2], t));
    return `rgb(${r},${g},${bl})`;
  }
  function shade(c, f) {
    // c may be #hex or rgb()
    let r, g, b;
    if (c[0] === "#") { [r, g, b] = hex(c); } else { const m = c.match(/\d+/g); r = +m[0]; g = +m[1]; b = +m[2]; }
    return `rgb(${Math.round(r * f)},${Math.round(g * f)},${Math.round(b * f)})`;
  }

  window.BOOMTOWN = {
    id: "boomtown", name: "Boomtown", W, H,
    tag: "Two mayors grow a split iso river-valley city over seven rounds — housing, industry, landmarks, parks. Boom hard for a giant fragile skyline, or build balanced and resilient. A seeded shock hits a weak axis each round; the most prosperous city wins.",
    champions: [{ id: "A", name: "Sol", color: "#10b981" }, { id: "B", name: "Vera", color: "#8b5cf6" }],
    prompts: { A: DEF_A, B: DEF_B },
    mcp: {
      kickoff: "You are a city mayor in a refereed building duel, played entirely through your tools. Each round: get_state, legal_moves, then make_move with a build type and the current ply. Grow the most prosperous city across the river by round seven. A seeded boom-or-bust shock strikes a weak axis each round — diversify or gamble. Win.",
      tools: [
        { name: "get_state", args: "", ret: "{round, prosperity, pop, inc, prestige, stability, weakest}", desc: "Read your city: prosperity, the four axis scores, and your weakest (most exposed) axis." },
        { name: "legal_moves", args: "", ret: "[build:…, …]", desc: "The lots you can develop this round (housing / industry / landmark / park)." },
        { name: "make_move", args: "build, expected_ply", desc: "Develop a lot. Housing→population, industry→income, landmark→prestige, park→stability. Booming one axis scales fast but is fragile.", ret: "new state | error" },
        { name: "resign", args: "", ret: "forfeit", desc: "Concede the valley." },
      ],
      vocab: "build:housing · build:industry · build:landmark · build:park",
    },
    build, draw,
  };
})();
