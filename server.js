const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CFG = {
  MAP_W: 80,
  MAP_H: 50,
  TICK_MS: 300,          // game loop interval
  TROOP_GEN: 0.3,        // troops generated per owned land tile per tick
  START_TROOPS: 20,      // troops at spawn
  MIN_SEND: 4,           // minimum troops needed to issue a march
  SEND_RATIO: 0.5,       // fraction of source tile troops sent
  MAX_PLAYERS: 8,
  MAX_PATH: 160,         // max BFS search depth
  ROOM_TTL: 1000 * 60 * 60, // clean up rooms after 1h
};

const COLORS = [
  '#e74c3c', '#3498db', '#27ae60', '#e67e22',
  '#9b59b6', '#16a085', '#e91e63', '#f39c12',
];

const rooms = new Map();

// ─── MAP GENERATION ───────────────────────────────────────────────────────────
function noise(x, y, seed) {
  const s = seed || 0;
  return (
    Math.sin(x * 0.09 + s + 1.2) * Math.cos(y * 0.09 + s * 0.7 + 2.1) * 0.50 +
    Math.sin(x * 0.17 + s * 1.3 + 3.7) * Math.cos(y * 0.21 + s * 0.4 + 0.5) * 0.30 +
    Math.sin(x * 0.31 + s * 0.8 + 0.9) * Math.cos(y * 0.28 + s * 1.1 + 1.8) * 0.20
  );
}

function generateMap(seed) {
  const { MAP_W: W, MAP_H: H } = CFG;
  const tiles = new Array(W * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const n = noise(x, y, seed);
      // Fade toward water at edges so map feels like an island/continent
      const ex = Math.min(x, W - 1 - x) / (W * 0.13);
      const ey = Math.min(y, H - 1 - y) / (H * 0.13);
      const fade = Math.min(1, ex) * Math.min(1, ey);
      const val = n * fade;

      // 0=water, 1=land, 2=mountain
      const terrain = val < -0.05 ? 0 : val > 0.52 ? 2 : 1;
      tiles[y * W + x] = { x, y, terrain, owner: null, troops: 0 };
    }
  }
  return tiles;
}

// ─── PATHFINDING (BFS) ────────────────────────────────────────────────────────
function adj4(x, y) {
  const { MAP_W: W, MAP_H: H } = CFG;
  const result = [];
  if (x > 0)     result.push([x - 1, y]);
  if (x < W - 1) result.push([x + 1, y]);
  if (y > 0)     result.push([x, y - 1]);
  if (y < H - 1) result.push([x, y + 1]);
  return result;
}

function tidx(x, y) { return y * CFG.MAP_W + x; }

function findPath(tiles, sx, sy, tx, ty) {
  if (sx === tx && sy === ty) return [];
  const W = CFG.MAP_W;
  const visited = new Set();
  visited.add(sy * W + sx);
  // Queue entries: [path array of [x,y] pairs]
  const queue = [[[sx, sy]]];

  while (queue.length > 0) {
    const path = queue.shift();
    if (path.length > CFG.MAX_PATH) continue;

    const [cx, cy] = path[path.length - 1];
    for (const [nx, ny] of adj4(cx, cy)) {
      const k = ny * W + nx;
      if (visited.has(k)) continue;
      const tile = tiles[k];
      // Troops can only march over land (not water; mountains passable but slow)
      if (!tile || tile.terrain === 0) continue;

      visited.add(k);
      const np = [...path, [nx, ny]];
      if (nx === tx && ny === ty) return np.slice(1); // exclude start tile
      queue.push(np);
    }
  }
  return null; // no path found
}

// ─── ROOM HELPERS ─────────────────────────────────────────────────────────────
function findSpawn(tiles, existingSpawns) {
  const land = tiles.filter(t => t.terrain === 1);
  let best = null, bestDist = -1;

  // Sample candidates and pick the one farthest from existing spawns
  const sample = land.sort(() => Math.random() - 0.5).slice(0, 300);
  for (const t of sample) {
    let minD = Infinity;
    for (const [ex, ey] of existingSpawns) {
      const d = Math.abs(t.x - ex) + Math.abs(t.y - ey);
      if (d < minD) minD = d;
    }
    if (existingSpawns.length === 0) minD = 1;
    if (minD > bestDist) { bestDist = minD; best = t; }
  }
  return best;
}

function createRoom(id) {
  const seed = Math.random() * 999;
  const tiles = generateMap(seed);
  return {
    id,
    tiles,
    prev: tiles.map(t => ({ owner: t.owner, troops: 0 })),
    players: {},           // socketId → player object
    playerOrder: [],       // ordered list of socket IDs (for color indices)
    marches: [],
    started: false,
    over: false,
    ticker: null,
    createdAt: Date.now(),
    chat: [],
  };
}

// ─── GAME LOOP ────────────────────────────────────────────────────────────────
function tick(room) {
  if (room.over) return;

  // 1. Generate troops for all owned land tiles
  for (const tile of room.tiles) {
    if (tile.owner && tile.terrain === 1) {
      tile.troops += CFG.TROOP_GEN;
    }
  }

  // 2. Advance each march one step
  const remove = new Set();
  for (const march of room.marches) {
    if (march.step >= march.path.length) { remove.add(march.id); continue; }

    const [nx, ny] = march.path[march.step];
    const tile = room.tiles[tidx(nx, ny)];

    if (!tile || tile.terrain === 0) { remove.add(march.id); continue; }

    if (tile.owner === march.owner) {
      // Friendly territory — pass through; deposit if final tile
      if (march.step === march.path.length - 1) {
        tile.troops += march.troops;
        remove.add(march.id);
      }
    } else if (tile.owner === null) {
      // Neutral land — claim it, costs 1 troop
      tile.owner = march.owner;
      tile.troops = Math.max(1, Math.ceil(march.troops * 0.25));
      march.troops = Math.max(1, march.troops - 1);
      if (march.step === march.path.length - 1 || march.troops <= 0) {
        remove.add(march.id);
      }
    } else {
      // Enemy tile — combat
      const atk = march.troops;
      const def = tile.troops;
      if (atk > def + 1) {
        tile.owner = march.owner;
        tile.troops = Math.floor(atk - def * 0.8);
        march.troops = tile.troops;
        if (march.step === march.path.length - 1 || march.troops <= 0) {
          remove.add(march.id);
        }
      } else {
        tile.troops = Math.max(0, Math.floor(def - atk * 0.8));
        remove.add(march.id);
      }
    }

    march.step++;
  }
  room.marches = room.marches.filter(m => !remove.has(m.id));

  // 3. Check eliminations
  const alive = {};
  for (const tile of room.tiles) {
    if (tile.owner) alive[tile.owner] = true;
  }
  for (const [pid, player] of Object.entries(room.players)) {
    if (player.alive && !alive[pid]) {
      player.alive = false;
      room.marches = room.marches.filter(m => m.owner !== pid);
      io.to(room.id).emit('eliminated', { playerId: pid, name: player.name });
    }
  }

  // 4. Check win condition
  const survivors = Object.values(room.players).filter(p => p.alive);
  if (survivors.length === 1) {
    room.over = true;
    clearInterval(room.ticker);
    io.to(room.id).emit('game_over', { winner: survivors[0] });
    return;
  }

  // 5. Build compact delta (only changed tiles)
  const changed = [];
  for (let i = 0; i < room.tiles.length; i++) {
    const t = room.tiles[i];
    const p = room.prev[i];
    const tf = Math.floor(t.troops);
    if (t.owner !== p.owner || tf !== p.troops) {
      const oi = t.owner ? room.playerOrder.indexOf(t.owner) : -1;
      changed.push([i, oi, tf]);
      p.owner = t.owner;
      p.troops = tf;
    }
  }

  // 6. Compact march positions for rendering
  const marchSnap = room.marches.map(m => {
    const pos = m.path[Math.min(m.step, m.path.length - 1)];
    return [m.id, room.playerOrder.indexOf(m.owner), Math.floor(m.troops), pos[0], pos[1]];
  });

  // 7. Player stats (territory count + total troops)
  const stats = {};
  for (const [pid, player] of Object.entries(room.players)) {
    stats[pid] = { tiles: 0, troops: 0 };
  }
  for (const tile of room.tiles) {
    if (tile.owner && stats[tile.owner]) {
      stats[tile.owner].tiles++;
      stats[tile.owner].troops += Math.floor(tile.troops);
    }
  }

  io.to(room.id).emit('tick', { changed, marches: marchSnap, stats });
}

// ─── SOCKET EVENTS ────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('+ connect', socket.id);

  socket.on('join_room', ({ roomId, name }) => {
    if (!rooms.has(roomId)) rooms.set(roomId, createRoom(roomId));
    const room = rooms.get(roomId);

    if (room.started) return socket.emit('err', { msg: 'Game already in progress' });
    if (Object.keys(room.players).length >= CFG.MAX_PLAYERS) {
      return socket.emit('err', { msg: 'Room is full (max 8 players)' });
    }

    const colorIdx = room.playerOrder.length;
    const player = {
      id: socket.id,
      name: (name || `Player ${colorIdx + 1}`).slice(0, 20),
      color: COLORS[colorIdx],
      colorIdx,
      alive: true,
    };
    room.players[socket.id] = player;
    room.playerOrder.push(socket.id);

    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit('joined', { playerId: socket.id, player, players: room.players, playerOrder: room.playerOrder });
    io.to(roomId).emit('lobby_update', { players: room.players, playerOrder: room.playerOrder });
    console.log(`  ${player.name} joined room ${roomId}`);
  });

  socket.on('start_game', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.started) return;
    if (Object.keys(room.players).length < 2) {
      return socket.emit('err', { msg: 'Need at least 2 players to start' });
    }

    room.started = true;
    const spawns = [];

    // Assign starting territories
    for (const [pid, player] of Object.entries(room.players)) {
      const spawn = findSpawn(room.tiles, spawns);
      if (!spawn) continue;
      spawns.push([spawn.x, spawn.y]);
      spawn.owner = pid;
      spawn.troops = CFG.START_TROOPS;

      // Give a few surrounding tiles to start with
      const neighbors = adj4(spawn.x, spawn.y)
        .map(([x, y]) => room.tiles[tidx(x, y)])
        .filter(t => t && t.terrain === 1 && !t.owner)
        .slice(0, 4);
      for (const t of neighbors) { t.owner = pid; t.troops = 5; }
    }

    // Sync prev state
    room.prev = room.tiles.map(t => ({ owner: t.owner, troops: Math.floor(t.troops) }));

    // Build initial tile array for client: [terrain, ownerIdx, troops]
    const initTiles = room.tiles.map(t => [
      t.terrain,
      t.owner ? room.playerOrder.indexOf(t.owner) : -1,
      Math.floor(t.troops),
    ]);

    io.to(room.id).emit('game_start', {
      tiles: initTiles,
      players: room.players,
      playerOrder: room.playerOrder,
      mapW: CFG.MAP_W,
      mapH: CFG.MAP_H,
    });

    room.ticker = setInterval(() => tick(room), CFG.TICK_MS);
    console.log(`  Game started in room ${room.id}`);
  });

  socket.on('march', ({ fromX, fromY, toX, toY }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.started || room.over) return;

    const from = room.tiles[tidx(fromX, fromY)];
    if (!from || from.owner !== socket.id) return;
    if (from.troops < CFG.MIN_SEND) return;

    const to = room.tiles[tidx(toX, toY)];
    if (!to || to.terrain === 0) return;

    const path = findPath(room.tiles, fromX, fromY, toX, toY);
    if (!path || path.length === 0) return;

    const sendTroops = Math.floor(from.troops * CFG.SEND_RATIO);
    if (sendTroops < 1) return;
    from.troops -= sendTroops;

    room.marches.push({
      id: `${socket.id.slice(0, 4)}-${Date.now()}`,
      owner: socket.id,
      path,
      troops: sendTroops,
      step: 0,
    });
  });

  socket.on('chat', ({ message }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const msg = { name: player.name, color: player.color, text: message.slice(0, 200), ts: Date.now() };
    room.chat.push(msg);
    if (room.chat.length > 100) room.chat.shift();
    io.to(socket.data.roomId).emit('chat', msg);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;

    console.log(`- disconnect ${player.name} from room ${room.id}`);

    if (room.started) {
      // Release their tiles
      for (const tile of room.tiles) {
        if (tile.owner === socket.id) { tile.owner = null; tile.troops = 0; }
      }
      room.marches = room.marches.filter(m => m.owner !== socket.id);
      player.alive = false;
      io.to(room.id).emit('eliminated', { playerId: socket.id, name: player.name });
    } else {
      delete room.players[socket.id];
      const idx = room.playerOrder.indexOf(socket.id);
      if (idx !== -1) room.playerOrder.splice(idx, 1);
      io.to(room.id).emit('lobby_update', { players: room.players, playerOrder: room.playerOrder });
    }
  });
});

// ─── CLEANUP OLD ROOMS ────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > CFG.ROOM_TTL) {
      if (room.ticker) clearInterval(room.ticker);
      rooms.delete(id);
      console.log(`Cleaned up room ${id}`);
    }
  }
}, 1000 * 60 * 10);

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🗺  Territory Wars server running`);
  console.log(`   http://localhost:${PORT}\n`);
});
