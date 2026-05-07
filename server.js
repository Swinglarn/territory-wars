const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const CFG = {
  MAP_W: 80, MAP_H: 50, TICK_MS: 300, TROOP_GEN: 0.3,
  START_TROOPS: 20, MIN_SEND: 4, SEND_RATIO: 0.5,
  MAX_PLAYERS: 8, MAX_PATH: 160, ROOM_TTL: 1000 * 60 * 60,
};

const COLORS = ['#e74c3c','#3498db','#27ae60','#e67e22','#9b59b6','#16a085','#e91e63','#f39c12'];
const rooms = new Map();

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
      const ex = Math.min(x, W - 1 - x) / (W * 0.13);
      const ey = Math.min(y, H - 1 - y) / (H * 0.13);
      const fade = Math.min(1, ex) * Math.min(1, ey);
      const val = n * fade;
      const terrain = val < -0.05 ? 0 : val > 0.52 ? 2 : 1;
      tiles[y * W + x] = { x, y, terrain, owner: null, troops: 0 };
    }
  }
  return tiles;
}

function adj4(x, y) {
  const { MAP_W: W, MAP_H: H } = CFG;
  const result = [];
  if (x > 0) result.push([x - 1, y]);
  if (x < W - 1) result.push([x + 1, y]);
  if (y > 0) result.push([x, y - 1]);
  if (y < H - 1) result.push([x, y + 1]);
  return result;
}

function tidx(x, y) { return y * CFG.MAP_W + x; }

function findPath(tiles, sx, sy, tx, ty) {
  if (sx === tx && sy === ty) return [];
  const W = CFG.MAP_W;
  const visited = new Set();
  visited.add(sy * W + sx);
  const queue = [[[sx, sy]]];
  while (queue.length > 0) {
    const path = queue.shift();
    if (path.length > CFG.MAX_PATH) continue;
    const [cx, cy] = path[path.length - 1];
    for (const [nx, ny] of adj4(cx, cy)) {
      const k = ny * W + nx;
      if (visited.has(k)) continue;
      const tile = tiles[k];
      if (!tile || tile.terrain === 0) continue;
      visited.add(k);
      const np = [...path, [nx, ny]];
      if (nx === tx && ny === ty) return np.slice(1);
      queue.push(np);
    }
  }
  return null;
}

function findSpawn(tiles, existingSpawns) {
  const land = tiles.filter(t => t.terrain === 1);
  let best = null, bestDist = -1;
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
    id, tiles,
    prev: tiles.map(t => ({ owner: t.owner, troops: 0 })),
    players: {}, playerOrder: [], marches: [],
    started: false, over: false, ticker: null,
    createdAt: Date.now(), chat: [],
  };
}

function tick(room) {
  if (room.over) return;
  for (const tile of room.tiles) {
    if (tile.owner && tile.terrain === 1) tile.troops += CFG.TROOP_GEN;
  }
  const remove = new Set();
  for (const march of room.marches) {
    if (march.step >= march.path.length) { remove.add(march.id); continue; }
    const [nx, ny] = march.path[march.step];
    const tile = room.tiles[tidx(nx, ny)];
    if (!tile || tile.terrain === 0) { remove.add(march.id); continue; }
    if (tile.owner === march.owner) {
      if (march.step === march.path.length - 1) { tile.troops += march.troops; remove.add(march.id); }
    } else if (tile.owner === null) {
      tile.owner = march.owner;
      tile.troops = Math.max(1, Math.ceil(march.troops * 0.25));
      march.troops = Math.max(1, march.troops - 1);
      if (march.step === march.path.length - 1 || march.troops <= 0) remove.add(march.id);
    } else {
      const atk = march.troops, def = tile.troops;
      if (atk > def + 1) {
        tile.owner = march.owner;
        tile.troops = Math.floor(atk - def * 0.8);
        march.troops = tile.troops;
        if (march.step === march.path.length - 1 || march.troops <= 0) remove.add(march.id);
      } else {
        tile.troops = Math.max(0, Math.floor(def - atk * 0.8));
        remove.add(march.id);
      }
    }
    march.step++;
  }
  room.marches = room.marches.filter(m => !remove.has(m.id));
  const alive = {};
  for (const tile of room.tiles) { if (tile.owner) alive[tile.owner] = true; }
  for (const [pid, player] of Object.entries(room.players)) {
    if (player.alive && !alive[pid]) {
      player.alive = false;
      room.marches = room.marches.filter(m => m.owner !== pid);
      io.to(room.id).emit('eliminated', { playerId: pid, name: player.name });
    }
  }
  const survivors = Object.values(room.players).filter(p => p.alive);
  if (survivors.length === 1) {
    room.over = true;
    clearInterval(room.ticker);
    io.to(room.id).emit('game_over', { winner: survivors[0] });
    return;
  }
  const changed = [];
  for (let i = 0; i < room.tiles.length; i++) {
    const t = room.tiles[i], p = room.prev[i];
    const tf = Math.floor(t.troops);
    if (t.owner !== p.owner || tf !== p.troops) {
      changed.push([i, t.owner ? room.playerOrder.indexOf(t.owner) : -1, tf]);
      p.owner = t.owner; p.troops = tf;
    }
  }
  const marchSnap = room.marches.map(m => {
    const pos = m.path[Math.min(m.step, m.path.length - 1)];
    return [m.id, room.playerOrder.indexOf(m.owner), Math.floor(m.troops), pos[0], pos[1]];
  });
  const stats = {};
  for (const pid of Object.keys(room.players)) stats[pid] = { tiles: 0, troops: 0 };
  for (const tile of room.tiles) {
    if (tile.owner && stats[tile.owner]) {
      stats[tile.owner].tiles++;
      stats[tile.owner].troops += Math.floor(tile.troops);
    }
  }
  io.to(room.id).emit('tick', { changed, marches: marchSnap, stats });
}

io.on('connection', socket => {
  socket.on('join_room', ({ roomId, name }) => {
    if (!rooms.has(roomId)) rooms.set(roomId, createRoom(roomId));
    const room = rooms.get(roomId);
    if (room.started) return socket.emit('err', { msg: 'Game already in progress' });
    if (Object.keys(room.players).length >= CFG.MAX_PLAYERS) return socket.emit('err', { msg: 'Room is full' });
    const colorIdx = room.playerOrder.length;
    const player = { id: socket.id, name: (name || 'Player ' + (colorIdx + 1)).slice(0, 20), color: COLORS[colorIdx], colorIdx, alive: true };
    room.players[socket.id] = player;
    room.playerOrder.push(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit('joined', { playerId: socket.id, player, players: room.players, playerOrder: room.playerOrder });
    io.to(roomId).emit('lobby_update', { players: room.players, playerOrder: room.playerOrder });
  });

  socket.on('start_game', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.started) return;
    if (Object.keys(room.players).length < 2) return socket.emit('err', { msg: 'Need at least 2 players' });
    room.started = true;
    const spawns = [];
    for (const [pid, player] of Object.entries(room.players)) {
      const spawn = findSpawn(room.tiles, spawns);
      if (!spawn) continue;
      spawns.push([spawn.x, spawn.y]);
      spawn.owner = pid; spawn.troops = CFG.START_TROOPS;
      adj4(spawn.x, spawn.y).map(([x, y]) => room.tiles[tidx(x, y)]).filter(t => t && t.terrain === 1 && !t.owner).slice(0, 4).forEach(t => { t.owner = pid; t.troops = 5; });
    }
    room.prev = room.tiles.map(t => ({ owner: t.owner, troops: Math.floor(t.troops) }));
    const initTiles = room.tiles.map(t => [t.terrain, t.owner ? room.playerOrder.indexOf(t.owner) : -1, Math.floor(t.troops)]);
    io.to(room.id).emit('game_start', { tiles: initTiles, players: room.players, playerOrder: room.playerOrder, mapW: CFG.MAP_W, mapH: CFG.MAP_H });
    room.ticker = setInterval(() => tick(room), CFG.TICK_MS);
  });

  socket.on('march', ({ fromX, fromY, toX, toY }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.started || room.over) return;
    const from = room.tiles[tidx(fromX, fromY)];
    if (!from || from.owner !== socket.id || from.troops < CFG.MIN_SEND) return;
    const to = room.tiles[tidx(toX, toY)];
    if (!to || to.terrain === 0) return;
    const path = findPath(room.tiles, fromX, fromY, toX, toY);
    if (!path || path.length === 0) return;
    const sendTroops = Math.floor(from.troops * CFG.SEND_RATIO);
    if (sendTroops < 1) return;
    from.troops -= sendTroops;
    room.marches.push({ id: socket.id.slice(0, 4) + '-' + Date.now(), owner: socket.id, path, troops: sendTroops, step: 0 });
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
    if (room.started) {
      for (const tile of room.tiles) { if (tile.owner === socket.id) { tile.owner = null; tile.troops = 0; } }
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

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > CFG.ROOM_TTL) { if (room.ticker) clearInterval(room.ticker); rooms.delete(id); }
  }
}, 1000 * 60 * 10);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Territory Wars running on port ' + PORT));
