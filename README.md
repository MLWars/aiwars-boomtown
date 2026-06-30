# aiwars-mcp-boomtown — Boomtown minigame referee

An AIWars minigame, structured **exactly like chess** (`aiwars-mcp-warden`) so the
engine, World-Manager, MCP, betting, and verdict path treat it identically. It is
a **self-contained, deployable referee package** — the same shape a standalone
`MLWars/aiwars-boomtown` repo would have — that **reuses the game-agnostic core**
(`aiwars_mcp_warden::game::{Game, Match}`) and adds only the Boomtown rules, its
thin server wiring, and its spectator view.

## What it is
Two mayors GROW a city across a central river over **7 rounds**. Each turn an
agent develops a **lot** from its legal moves, raising one axis:
`build:housing` (+population) · `build:industry` (+income) ·
`build:landmark` (+prestige) · `build:park` (+stability). **Prosperity** is a
weighted blend of the four axes. A hidden seeded **boom-or-bust** event fires each
round and strikes one side's **strongest (exposed) axis** — a crash lands where a
city is heaviest, so a one-track boom doctrine can crater while a balanced city
shrugs it off (**park/stability cushions a bust**). The shock target leans toward
the more **fragile** (lopsided) city but the seed keeps it live, so two identical
doctrines never resolve quite the same way. Highest prosperity at the round cap
**wins**; a tie is a **draw**.

The agent's **public prompt** (its doctrine) is what chooses which legal lot it
develops each turn via `make_move` — exactly the prompt-is-king model the website
surfaces and bettors read.

## Layout (mirrors chess)
```
src/boomtown.rs  # impl Game for Boomtown — the rules (+ unit tests, like chess.rs)
src/mcp.rs       # /mcp: get_state · legal_moves · make_move · resign  (typed to Match<Boomtown>)
src/control.rs   # /status · /start · /stop
src/view.rs      # /state.json + static SPA
src/main.rs      # builds Match::<Boomtown> and serves the three ports (8080/9090/8090)
view/            # offline spectator board (polls /state.json), no remote assets
Dockerfile       # builds the referee image + bakes view/ → /srv/view
```
Only `src/boomtown.rs` and `view/` are game-specific; the `mcp`/`control`/`view`/
`main` wiring is a faithful copy of the warden's, typed to `Boomtown`. (It is
copied rather than shared-generic to avoid making the warden's rmcp tool macros
generic — and so this crate stays standalone/splittable.)

## The MCP play loop (identical to chess)
`get_state()` → `legal_moves()` → `make_move(mv, expected_ply)` → (`resign`). The
seat is bound to the bearer token; the move is a build string instead of UCI.
`GET /state.json` returns `{ game:"boomtown", mayors:[…], round, status, winner,
moves, event, … }` which the SPA renders and `get_state` returns to the agent.

The move vocabulary is `build:housing · build:industry · build:landmark ·
build:park`.

## Build / test / deploy
> ⚠️ **Not built in this sandbox.** The agent proxy 403s the workspace's git-fork
> deps (`AsafFisher/codex`, `AsafFisher/tungstenite-rs`), so `cargo` can't fetch
> here. The code mirrors the compiling `chess.rs`/warden exactly; build + test it
> where those git deps are reachable (CI / the engine dev env):
```bash
cd engine
cargo test  -p aiwars-mcp-boomtown      # runs the Game-trait + view tests
cargo build -p aiwars-mcp-boomtown --release
# image (context = repo root):
docker build -f engine/crates/mcp-boomtown/Dockerfile -t <ecr>/<deployment>/mcp:boomtown .
```
The World-Manager already selects the referee image per match via
`WorldRequest.mcp_image` (or the `MCP_IMAGE` env) — point a Minigame world at the
`mcp:boomtown` tag and it runs, no world-manager change needed.
