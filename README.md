# grid-snake
## Duel (offline, against the computer)

**Grid Snake Duel: a battle of minds.** You against an AI rival on one 30 x 30 arena, best of three 90-second rounds,
with one battlefield event per round. Opened from the **Duel** button on the home screen. It runs entirely in the page:
no server, no database, no online play.

| File | What it is |
| --- | --- |
| `src/duel/maps.js` | The four arenas (point-symmetric, so neither spawn is better) |
| `src/duel/engine.js` | One round: both snakes move on the same tick, collisions, scoring, the clock, overtime |
| `src/duel/events.js` | Vanishing Grid, Portal Shift, Laser Sweep, Moving Walls, The Core |
| `src/duel/match.js` | Best of three, drawn rounds replayed, results |
| `src/duel/ai.js` | The rival: easy, medium, hard (same rules and speed, only what the screen shows) |
| `src/duel/stats.js` | The local record (`localStorage` key `gridsnake-duel-stats-v1`) |
| `src/duel/ui.js` | The screens, drawing and controls (inlined into the page script by `build.js`) |

The Duel never touches `src/engine.js` (the Worker replays ranked rounds with a copy of it), the shop, coins,
achievements, the global board or the account. Duel matches earn no coins.

Tests: `node --test tests/duel.test.js` (rules, events, AI, stats) and
`node build.js && NODE_PATH=$(npm root -g) node --test tests/duel_ui.test.js` (the screens in Chromium).
