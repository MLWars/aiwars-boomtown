//! Boomtown — a turn-based city-builder duel refereed exactly like chess.
//!
//! Two mayors GROW a city across a central river over `ROUNDS` rounds. On each of
//! its turns an agent develops a LOT from its legal moves, raising one axis:
//!   - `build:housing`  — +population
//!   - `build:industry` — +income
//!   - `build:landmark` — +prestige
//!   - `build:park`     — +stability
//! Prosperity is a weighted blend of those four axes. HIDDEN TWIST: every round a
//! seeded EVENT (a boom or a bust) strikes one side's STRONGEST (exposed) axis —
//! a crash lands where a city is heaviest, so a one-track boom doctrine can crater
//! while a balanced city shrugs it off (PARK/stability cushions a bust). The event
//! target is weighted toward the more FRAGILE (lopsided) city but kept live by the
//! seed, so two identical doctrines never resolve quite the same way. Highest
//! prosperity at the round cap wins; a tie (within `TIE_EPS`) is a draw.
//!
//! This is the engine-side rules ONLY — the agent's PUBLIC PROMPT (its doctrine)
//! is what chooses which legal lot it develops each turn, via `make_move`. Same
//! seed ⇒ identical event schedule + build gains (deterministic / replayable),
//! mirroring how `chess.rs` derives everything from the authoritative position.

use serde_json::{json, Value};

use aiwars_mcp_warden::game::{Game, MatchError};

const ROUNDS: u32 = 7;
/// Prosperity gap below which the match is scored a draw (scaled ×10, see below).
const TIE_EPS: i64 = 15;

/// The four build axes, in a stable order.
const AXES: [&str; 4] = ["housing", "industry", "landmark", "park"];
const MOVES: [&str; 4] = ["build:housing", "build:industry", "build:landmark", "build:park"];
/// Axis prosperity weights (×100 to stay in integer arithmetic): housing 1.00,
/// industry 1.15, landmark 1.25, park 0.90 — mirrors the POC's WEIGHT table.
const WEIGHT: [i64; 4] = [100, 115, 125, 90];

/// Deterministic PRNG mix (mulberry32-ish), matching the POC/getaway engine so the
/// web demo and the referee agree on a seed's event schedule and build gains.
fn rng_u32(mut a: u32) -> u32 {
    a = a.wrapping_add(0x6d2b79f5);
    let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
    t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
    (t ^ (t >> 14)) >> 0
}
/// A 0..1 float from a (seed, round, salt) tuple.
fn frac(seed: u64, round: u32, salt: u32) -> f64 {
    let mixed = (seed as u32)
        .wrapping_mul(977)
        .wrapping_add(round.wrapping_mul(131))
        .wrapping_add(salt.wrapping_mul(7));
    (rng_u32(mixed) as f64) / (u32::MAX as f64)
}

fn clampf(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

/// Per-mayor city state. Axis scores are held ×10 (one decimal of precision in
/// integer arithmetic) so prosperity/fragility stay exactly reproducible.
#[derive(Clone)]
struct City {
    /// Axis scores ×10, indexed by `AXES` order.
    axis: [i64; 4],
    /// How many lots this mayor has developed (== rounds it has acted in).
    lots: u32,
    /// Per-build log for the spectator view (axis index, gain ×10, round).
    builds: Vec<Build>,
}
#[derive(Clone)]
struct Build {
    axis: usize,
    gain: i64,
    round: u32,
}
impl City {
    fn new() -> Self {
        Self { axis: [0; 4], lots: 0, builds: Vec::new() }
    }
    /// Weighted prosperity blend (×10, matching axis scale).
    fn prosperity(&self) -> i64 {
        let mut p = 0i64;
        for i in 0..4 {
            p += self.axis[i] * WEIGHT[i] / 100;
        }
        p
    }
    /// Standard deviation of the four axes (×10) — higher = lopsided = exposed.
    fn fragility(&self) -> i64 {
        let mean = (self.axis[0] + self.axis[1] + self.axis[2] + self.axis[3]) as f64 / 4.0;
        let var = self
            .axis
            .iter()
            .map(|&v| {
                let d = v as f64 - mean;
                d * d
            })
            .sum::<f64>()
            / 4.0;
        var.sqrt() as i64
    }
    /// Index of the strongest axis (the EVENT target). Ties resolve to lowest index.
    fn strongest(&self) -> usize {
        let mut w = 0;
        for i in 1..4 {
            if self.axis[i] > self.axis[w] {
                w = i;
            }
        }
        w
    }
    /// Index of the weakest axis (surfaced to the agent as its exposure read).
    fn weakest(&self) -> usize {
        let mut w = 0;
        for i in 1..4 {
            if self.axis[i] < self.axis[w] {
                w = i;
            }
        }
        w
    }
}

/// A seeded boom/bust shock that fires at the end of a round.
#[derive(Clone)]
struct Shock {
    round: u32,
    /// Which side took the hit (mayor index).
    side: usize,
    /// Axis index struck.
    axis: usize,
    /// Signed delta applied (×10).
    delta: i64,
    /// `true` if a bust (downward), `false` if a boom (lift).
    bust: bool,
    /// A flavour name for the event.
    name: &'static str,
}

const BOOM_NAMES: [&str; 6] = [
    "a tech campus opens",
    "a gold strike",
    "tourism surges",
    "a new trade route",
    "a festival boom",
    "investors pour in",
];
const BUST_NAMES: [&str; 6] = [
    "a factory fire",
    "a market crash",
    "a flood warning",
    "a labor strike",
    "a power blackout",
    "a quake tremor",
];

/// The two-player Boomtown game.
pub struct Boomtown {
    cities: [City; 2],
    to_move: usize,
    ply: u32,
    /// Round currently in progress (0-based). Each round both mayors build once,
    /// then a seeded shock resolves.
    round: u32,
    seed: u64,
    /// The shock log, appended as each round's event fires.
    shocks: Vec<Shock>,
    resigned_by: Option<usize>,
    /// Cached terminal result once resolved (so it's stable after the last move).
    winner_idx: Option<usize>,
    win_reason: &'static str,
    resolved: bool,
}

impl Boomtown {
    /// The (deterministic) gain for `agent` developing `axis` in `round`, ×10.
    /// Mirrors the POC's `gainFor`: a solid base + seeded jitter, with diminishing
    /// returns past a tall single-axis stack (which nudges toward a mix).
    fn gain_for(&self, agent: usize, axis: usize, round: u32) -> i64 {
        let salt = 200 + (agent as u32) * 13 + (axis as u32) * 3;
        let r = frac(self.seed, round, salt);
        // base 130..210 (×10 ⇒ 13.0..21.0 raw), faithful to the POC's spread.
        let mut g = 130.0 + r * 80.0;
        let have = self.cities[agent].axis[axis];
        if have > 540 {
            g *= 0.58;
        } else if have > 360 {
            g *= 0.78;
        }
        g as i64
    }

    /// The four build options (always all legal until the game resolves).
    fn build_moves(&self) -> Vec<String> {
        if self.resolved {
            return Vec::new();
        }
        MOVES.iter().map(|m| m.to_string()).collect()
    }

    /// Advance `to_move` to the other mayor.
    fn advance_turn(&mut self) {
        self.to_move = 1 - self.to_move;
    }

    /// Resolve the round's seeded boom/bust after the second mayor has built, then
    /// advance the round counter (or resolve the match at the cap).
    fn resolve_round_event(&mut self) {
        let round = self.round;
        // Pick the target side: weighted toward the MORE FRAGILE (lopsided) city,
        // but the seed's bias keeps it live (mirrors the POC's pFragile logic).
        let fa = self.cities[0].fragility() as f64;
        let fb = self.cities[1].fragility() as f64;
        let p_fragile = 0.5 + clampf((fa - fb) / 600.0, -0.34, 0.34); // prob side 0 is hit
        let bias = frac(self.seed, round, 11);
        let side = if bias < p_fragile { 0 } else { 1 };
        let is_bust = frac(self.seed, round, 13) < 0.6; // busts a touch more likely → drama
        let roll = frac(self.seed, round, 17);

        let axis = self.cities[side].strongest();
        let tgt_axis = self.cities[side].axis[axis];
        let frag = self.cities[side].fragility() as f64;

        let delta: i64;
        if is_bust {
            // Damage scales with the sector's height AND lopsidedness; PARK
            // (stability, axis 3) cushions it — steady cities shrug shocks off.
            let cushion = 1.0 - clampf(self.cities[side].axis[3] as f64 / 600.0, 0.0, 0.55);
            let raw = (60.0 + roll * 80.0 + tgt_axis as f64 * 0.12 + frag * 0.36) * cushion;
            delta = -(raw as i64);
            let v = (tgt_axis + delta).max(0);
            self.cities[side].axis[axis] = v;
        } else {
            delta = (70.0 + roll * 90.0) as i64;
            self.cities[side].axis[axis] += delta;
        }
        let name = if is_bust {
            BUST_NAMES[(roll * BUST_NAMES.len() as f64) as usize % BUST_NAMES.len()]
        } else {
            BOOM_NAMES[(roll * BOOM_NAMES.len() as f64) as usize % BOOM_NAMES.len()]
        };
        self.shocks.push(Shock { round, side, axis, delta, bust: is_bust, name });

        // Advance the round; resolve the match at the cap.
        self.round += 1;
        if self.round >= ROUNDS {
            self.try_resolve();
        }
    }

    /// Resolve the match if a terminal condition is met (idempotent).
    fn try_resolve(&mut self) {
        if self.resolved {
            return;
        }
        if let Some(r) = self.resigned_by {
            self.winner_idx = Some(1 - r);
            self.win_reason = "resign";
            self.resolved = true;
            return;
        }
        if self.round < ROUNDS {
            return;
        }
        let pa = self.cities[0].prosperity();
        let pb = self.cities[1].prosperity();
        if (pa - pb).abs() < TIE_EPS {
            self.winner_idx = None;
            self.win_reason = "tie";
        } else {
            self.winner_idx = Some(if pa > pb { 0 } else { 1 });
            self.win_reason = "prosperity";
        }
        self.resolved = true;
    }

    fn status_str(&self) -> &'static str {
        if self.resigned_by.is_some() {
            "resigned"
        } else if self.resolved {
            self.win_reason
        } else {
            "playing"
        }
    }
}

impl Game for Boomtown {
    fn new(players: usize, settings: &Value) -> Result<Self, MatchError> {
        if players != 2 {
            return Err(MatchError::WrongPlayerCount { want: 2..=2, got: players });
        }
        let seed = settings.get("seed").and_then(|v| v.as_u64()).unwrap_or(1);
        Ok(Self {
            cities: [City::new(), City::new()],
            to_move: 0,
            ply: 0,
            round: 0,
            seed,
            shocks: Vec::new(),
            resigned_by: None,
            winner_idx: None,
            win_reason: "playing",
            resolved: false,
        })
    }

    fn turn_agent(&self) -> usize {
        self.to_move
    }

    fn ply(&self) -> u32 {
        self.ply
    }

    fn legal_moves(&self) -> Vec<String> {
        self.build_moves()
    }

    fn apply(&mut self, agent: usize, mv: &str) -> Result<(), MatchError> {
        if self.resolved {
            return Err(MatchError::GameOver);
        }
        if self.to_move != agent {
            return Err(MatchError::NotYourTurn);
        }
        let axis = MOVES
            .iter()
            .position(|m| *m == mv)
            .ok_or_else(|| MatchError::IllegalMove(format!("'{mv}' is not a build here")))?;

        let round = self.round;
        let gain = self.gain_for(agent, axis, round);
        let me = &mut self.cities[agent];
        me.axis[axis] += gain;
        me.lots += 1;
        me.builds.push(Build { axis, gain, round });

        // The second seat of the round (the mayor who is NOT first this round)
        // triggers the seeded shock once both have built. Mayor 0 always opens.
        let last_seat_of_round = agent == 1;

        self.ply += 1;
        self.advance_turn();
        if last_seat_of_round {
            self.resolve_round_event();
        }
        self.try_resolve();
        Ok(())
    }

    fn is_over(&self) -> bool {
        self.resolved
    }

    fn winner(&self) -> Option<usize> {
        self.winner_idx
    }

    fn resign(&mut self, agent: usize) {
        if !self.resolved {
            self.resigned_by = Some(agent);
            self.try_resolve();
        }
    }

    fn state(&self, handles: &[String]) -> Value {
        let h = |i: usize| handles.get(i).cloned().unwrap_or_default();
        let winner = self
            .winner_idx
            .filter(|_| self.resolved)
            .map(h)
            .map(Value::String)
            .unwrap_or(Value::Null);

        // The most recent shock, surfaced for the view's event FX.
        let last_event = self.shocks.last().map(|s| {
            json!({
                "round": s.round + 1,
                "side": h(s.side),
                "side_idx": s.side,
                "axis": AXES[s.axis],
                "delta": s.delta,
                "bust": s.bust,
                "name": s.name,
            })
        });

        let mayor_json = |i: usize| {
            let c = &self.cities[i];
            let builds: Vec<Value> = c
                .builds
                .iter()
                .map(|b| {
                    json!({
                        "axis": AXES[b.axis],
                        "gain": b.gain,
                        "round": b.round + 1,
                    })
                })
                .collect();
            json!({
                "handle": h(i),
                // axis scores rounded to whole points for display.
                "population": (c.axis[0] + 5) / 10,
                "income": (c.axis[1] + 5) / 10,
                "prestige": (c.axis[2] + 5) / 10,
                "stability": (c.axis[3] + 5) / 10,
                "prosperity": (c.prosperity() + 5) / 10,
                "fragility": (c.fragility() + 5) / 10,
                "weakest": AXES[c.weakest()],
                "strongest": AXES[c.strongest()],
                "lots": c.lots,
                "builds": builds,
            })
        };

        json!({
            "game": "boomtown",
            "rounds": ROUNDS,
            "round": (self.round + 1).min(ROUNDS),
            "seed": self.seed,
            "to_move": h(self.to_move),
            "to_move_idx": self.to_move,
            "ply": self.ply,
            "status": self.status_str(),
            "winner": winner,
            "win_reason": if self.resolved { self.win_reason } else { "" },
            "moves": self.legal_moves(),
            "event": last_event.unwrap_or(Value::Null),
            "mayors": [mayor_json(0), mayor_json(1)],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiwars_mcp_warden::game::Match;
    use serde_json::json;

    fn handles() -> Vec<String> {
        vec!["sol".to_string(), "vera".to_string()]
    }

    #[test]
    fn rejects_wrong_player_count() {
        for n in [1usize, 3] {
            let hs: Vec<String> = (0..n).map(|i| format!("p{i}")).collect();
            match Match::<Boomtown>::new(hs, &json!({})) {
                Err(MatchError::WrongPlayerCount { want, got }) => {
                    assert_eq!(want, 2..=2);
                    assert_eq!(got, n);
                }
                _ => panic!("expected WrongPlayerCount for {n} players"),
            }
        }
    }

    #[test]
    fn first_move_advances_ply_and_passes_turn() {
        let mut m = Match::<Boomtown>::new(handles(), &json!({ "seed": 7 })).unwrap();
        m.start();
        assert_eq!(m.state_json()["ply"], 0);
        assert_eq!(m.state_json()["to_move_idx"], 0);
        let legal = m.turn_info(0)["moves"].as_array().unwrap().len();
        assert_eq!(legal, 4, "four build options each turn");
        let st = m.make_move(0, "build:housing", 0).unwrap();
        assert_eq!(st["ply"], 1);
        assert_eq!(st["to_move_idx"], 1, "turn passes to the rival");
        assert!(st["mayors"][0]["population"].as_i64().unwrap() > 0);
        assert!(st["mayors"][0]["prosperity"].as_i64().unwrap() > 0);
    }

    #[test]
    fn illegal_and_out_of_turn_rejected_without_change() {
        let mut m = Match::<Boomtown>::new(handles(), &json!({ "seed": 7 })).unwrap();
        m.start();
        let before = m.state_json();
        // wrong agent
        assert_eq!(m.make_move(1, "build:housing", 0).unwrap_err(), MatchError::NotYourTurn);
        // bogus build
        assert!(matches!(
            m.make_move(0, "build:casino", 0).unwrap_err(),
            MatchError::IllegalMove(_)
        ));
        assert_eq!(m.state_json(), before, "no state change on a rejected move");
    }

    #[test]
    fn stale_ply_rejected() {
        let mut m = Match::<Boomtown>::new(handles(), &json!({ "seed": 7 })).unwrap();
        m.start();
        assert_eq!(m.make_move(0, "build:housing", 9).unwrap_err(), MatchError::StalePly);
    }

    #[test]
    fn a_full_game_resolves_to_winner_or_draw() {
        // Both mayors build to the seeded plan; a decisive result must emerge with
        // a concrete winner or a draw by the round cap.
        let mut m = Match::<Boomtown>::new(handles(), &json!({ "seed": 7 })).unwrap();
        m.start();
        let mut guard = 0;
        while !m.is_resolved() && guard < 64 {
            let seat = m.state_json()["to_move_idx"].as_u64().unwrap() as usize;
            let ply = m.state_json()["ply"].as_u64().unwrap() as u32;
            // round-robin the axes so neither city is purely one-track
            let mv = m.turn_info(seat)["moves"][(ply as usize) % 4]
                .as_str()
                .unwrap()
                .to_string();
            let _ = m.make_move(seat, &mv, ply);
            guard += 1;
        }
        assert!(m.is_resolved(), "match must resolve within the round cap");
        let result = m.result().expect("resolved match has a result");
        assert!(result.outcome == "Winner" || result.outcome == "Draw");
    }

    #[test]
    fn full_game_runs_exactly_two_builds_per_round() {
        let mut m = Match::<Boomtown>::new(handles(), &json!({ "seed": 5 })).unwrap();
        m.start();
        let mut plies = 0u32;
        while !m.is_resolved() && plies < 64 {
            let seat = m.state_json()["to_move_idx"].as_u64().unwrap() as usize;
            let ply = m.state_json()["ply"].as_u64().unwrap() as u32;
            let mv = m.turn_info(seat)["moves"][(plies as usize) % 4]
                .as_str()
                .unwrap()
                .to_string();
            m.make_move(seat, &mv, ply).unwrap();
            plies += 1;
        }
        // ROUNDS rounds × 2 mayors = exactly 2*ROUNDS builds (plies).
        assert_eq!(plies, 2 * ROUNDS, "one build per mayor per round");
        let st = m.state_json();
        assert_eq!(st["mayors"][0]["lots"], ROUNDS);
        assert_eq!(st["mayors"][1]["lots"], ROUNDS);
    }

    #[test]
    fn resign_awards_opponent() {
        let mut m = Match::<Boomtown>::new(handles(), &json!({ "seed": 3 })).unwrap();
        m.start();
        let st = m.resign(0);
        assert_eq!(st["status"], "resigned");
        assert!(m.is_resolved());
        let result = m.result().unwrap();
        assert_eq!(result.outcome, "Winner");
        assert_eq!(result.winner.as_deref(), Some("vera"));
    }

    #[test]
    fn same_seed_same_outcome() {
        let play = |seed: u64| {
            let mut m = Match::<Boomtown>::new(handles(), &json!({ "seed": seed })).unwrap();
            m.start();
            let mut plies = 0u32;
            while !m.is_resolved() && plies < 64 {
                let seat = m.state_json()["to_move_idx"].as_u64().unwrap() as usize;
                let ply = m.state_json()["ply"].as_u64().unwrap() as u32;
                let mv = m.turn_info(seat)["moves"][(plies as usize) % 4]
                    .as_str()
                    .unwrap()
                    .to_string();
                m.make_move(seat, &mv, ply).unwrap();
                plies += 1;
            }
            m.state_json()
        };
        let a = play(42);
        let b = play(42);
        assert_eq!(a, b, "same seed + same moves ⇒ identical final state");
    }
}
