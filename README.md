# Wanderguild — one-thumb MMO-lite (prototype)

An MMO you play with one thumb, in portrait, on a crowded bus.

- **Tap anywhere to move** (drag to steer). Your hero auto-attacks whatever's in range.
- **One big cooldown button** — your class's signature ability — is the only other input.
- Depth lives in *decisions*, not execution: positioning, gear loadouts, which zone band to farm, showing up for the world boss.

## What's in this prototype

- Three classes (Knight / Ranger / Mage) with distinct auto-attacks and abilities
- Emberlea Vale: an open zone with difficulty bands radiating out from the guild camp
- XP / levels, gold, and gear drops (4 rarities, auto-equip-or-scrap)
- **Bramblehorn**, a scheduled world boss with telegraphed slams and an epic drop
- **Guild camp**: donate gold to level it up — more tents, faster regen, persists between sessions
- Simulated zone population: named "players" with guild tags who wander, farm mobs, converge on the boss, and chat
- Saves to `localStorage` (class, level, gold, gear, camp level)

Plain vanilla JS + canvas, zero dependencies. Open `index.html` and play — same code
runs on the web and on Android via WebView (the Pocket Arcade packaging path).

## Deployment

This repo is the source of truth. The live playable build is a copy served from the
studio site (`thebillyman-publisher/wanderguild/` → https://thebillymangames.com/wanderguild/).
For now, deploying = copying `index.html` + `game.js` into that folder and pushing.

## The multiplayer seam

Everything "massively multiplayer" in this build is faked locally by the `Sim` module
in `game.js` (search `SIM PLAYERS`). It exposes exactly the surface a real presence
layer needs to provide:

| Sim today | Real backend later |
|---|---|
| `Sim.bots` (positions, names, guild tags) | Zone presence / state sync (Nakama match or Firebase RTDB) |
| Random chat lines into the feed | Zone chat channel |
| `onBossSpawn` / `onBossDown` convergence | Server-scheduled world boss events |
| `onCampUpgrade` reactions | Shared guild-camp state (server-authoritative) |

Recommended path: start async-first (shared camp + chat via Firebase, ghosts instead of
live positions) to validate the loop cheaply, then move to Nakama if live zone presence
earns its server bill.

## Tuning knobs

All balance lives at the top of `game.js`: `CLASSES`, `MOB_TYPES`, `RARITIES`,
`BOSS_INTERVAL`, and the spawn-band radii in `tierAt()`.
