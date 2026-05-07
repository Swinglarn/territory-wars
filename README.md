# 🗺 Territory Wars

Real-time multiplayer territory conquest game. Inspired by openfront.io with enhanced mechanics.

## Features

- **Real-time multiplayer** — up to 8 players per room, WebSocket sync
- **Procedural maps** — noise-generated continents with land, water, and mountain terrain
- **Troop marching** — click to select, click to target; troops pathfind via BFS and march tile by tile
- **Combat system** — attack absorbs enemy troops; neutral tiles are claimed as you pass through
- **Live stats** — top bar shows every player's tile count and troop total in real time
- **Elimination** — players are knocked out when they lose all territory
- **Room system** — create any room by entering a code; share the code to invite friends
- **In-game chat** — room-scoped chat visible to all players

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Run the server
npm start
# → Open http://localhost:3000 in multiple tabs to test multiplayer

# 3. (Optional) Dev mode with auto-restart
npm run dev
```

Open multiple browser tabs, enter the same room code, and start the game.

## Deploy to Railway (Free, Public URL)

1. Push this folder to a GitHub repo
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Select your repo — Railway auto-detects Node.js and runs `npm start`
4. Click **Generate Domain** to get a public URL like `https://territory-wars-xxx.up.railway.app`
5. Share that URL with friends — no port forwarding or firewall config needed

## Deploy to Render (Also Free)

1. Push to GitHub
2. Go to https://render.com → New → Web Service
3. Connect repo, set:
   - Build command: `npm install`
   - Start command: `npm start`
4. Free tier spins down after inactivity — first load may take ~30s

## Game Mechanics

| Mechanic | Detail |
|---|---|
| **Map** | 80×50 tiles: water, land, mountain |
| **Tick rate** | 300ms server-side game loop |
| **Troop gen** | 0.3 troops/tile/tick (= ~1/sec) |
| **March** | Sends 50% of source tile's troops |
| **Combat** | Attacker – defender × 0.8; winner takes tile |
| **Neutral claim** | Marching troops claim neutral land on the way |
| **Win** | Last player with territory alive wins |

## Controls

| Action | Control |
|---|---|
| Select own tile | Left-click |
| Issue march | Left-click target after selecting |
| Cancel selection | Right-click |
| Zoom | Scroll wheel |
| Pan | Middle-mouse drag |

## Future Improvements

- [ ] Alliances (can't attack allied players)
- [ ] Fog of war (only see tiles adjacent to your territory)
- [ ] Different unit types (cavalry, siege)
- [ ] Spectator mode
- [ ] Replay system
- [ ] Minimap
- [ ] Mobile touch support
- [ ] Sound effects
