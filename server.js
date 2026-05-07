const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CFG = {
  MAP_W: 80, MAP_H: 50,
  TICK_MS: 300,
  TROOP_GEN: 0.3,          // troops per land tile per tick
  CITY_TROOP_MULT: 3,      // cities generate 3x troops
  START_TROOPS: 20,
  MIN_SEND: 4,
  SEND_RATIO: 0.5,
  MAX_PLAYERS: 8,
  MAX_PATH: 160,
  ROOM_TTL: 1000 * 60 * 60,
  // Economy
  START_GOLD: 80,
  GOLD_PER_TILE: 0.04,     // gold per owned tile per tick
  GOLD_PER_CITY: 0.4,      // bonus gold per city per tick
  CITY_COST: 200,           // gold to build a city
  FORT_COST: 80,            // gold to build a fort (defensive bonus)
  FORT_DEFENSE_BONUS: 2,   // forts make tile 2x harder to capture
};

const COLORS = [
  '#c0392b','#2980b9','#27ae60','#d35400',
  '#8e44ad','#16a085','#c0392b','#f39c12',
];

const rooms = new Map();

// ─── MAP GENERATION ───────────────────────────────────────────────────────────
function noise(x, y, s) {
  return (
    Math.sin(x*.09+s+1.2)*Math.cos(y*.09+s*.7+2.1)*.5 +
    Math.sin(x*.17+s*1.3+3.7)*Math.cos(y*.21+s*.4+.5)*.3 +
    Math.sin(x*.31+s*.8+.9)*Math.cos(y*.28+s*1.1+1.8)*.2
  );
}

function generateMap(seed) {
  const { MAP_W: W, MAP_H: H } = CFG;
  const tiles = new Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const n = noise(x, y, seed);
      const ex = Math.min(x, W-1-x)/(W*.13);
      const ey = Math.min(y, H-1-y)/(H*.13);
      const fade = Math.min(1,ex)*Math.min(1,ey);
      const val = n * fade;
      // terrain: 0=water, 1=plains, 2=mountain, 3=forest
      let terrain;
      if (val < -0.05) terrain = 0;
      else if (val > 0.55) terrain = 2;
      else if (val > 0.15 && Math.sin(x*.4+y*.3+seed)>.3) terrain = 3;
      else terrain = 1;
      tiles[y*W+x] = { x, y, terrain, owner:null, troops:0, building:null };
    }
  }
  return tiles;
}

function adj4(x, y) {
  const { MAP_W:W, MAP_H:H } = CFG;
  const r=[];
  if(x>0) r.push([x-1,y]);
  if(x<W-1) r.push([x+1,y]);
  if(y>0) r.push([x,y-1]);
  if(y<H-1) r.push([x,y+1]);
  return r;
}

function tidx(x,y){ return y*CFG.MAP_W+x; }

function findPath(tiles, sx, sy, tx, ty) {
  if(sx===tx&&sy===ty) return [];
  const W=CFG.MAP_W;
  const vis=new Set([sy*W+sx]);
  const q=[[[sx,sy]]];
  while(q.length){
    const path=q.shift();
    if(path.length>CFG.MAX_PATH) continue;
    const [cx,cy]=path[path.length-1];
    for(const [nx,ny] of adj4(cx,cy)){
      const k=ny*W+nx;
      if(vis.has(k)) continue;
      const t=tiles[k];
      if(!t||t.terrain===0) continue;
      vis.add(k);
      const np=[...path,[nx,ny]];
      if(nx===tx&&ny===ty) return np.slice(1);
      q.push(np);
    }
  }
  return null;
}

function findSpawn(tiles, existing) {
  const land=tiles.filter(t=>t.terrain===1||t.terrain===3);
  let best=null, bestD=-1;
  const sample=land.sort(()=>Math.random()-.5).slice(0,300);
  for(const t of sample){
    let minD=Infinity;
    for(const [ex,ey] of existing){
      const d=Math.abs(t.x-ex)+Math.abs(t.y-ey);
      if(d<minD) minD=d;
    }
    if(existing.length===0) minD=1;
    if(minD>bestD){bestD=minD;best=t;}
  }
  return best;
}

// ─── ROOM MANAGEMENT ─────────────────────────────────────────────────────────
function createRoom(id) {
  const seed=Math.random()*999;
  const tiles=generateMap(seed);
  return {
    id, tiles,
    prev: tiles.map(t=>({owner:t.owner,troops:0,building:null})),
    players:{}, playerOrder:[], marches:[],
    started:false, over:false, ticker:null,
    createdAt:Date.now(), chat:[],
  };
}

// ─── GAME TICK ────────────────────────────────────────────────────────────────
function tick(room) {
  if(room.over) return;

  // Generate troops + gold
  for(const tile of room.tiles){
    if(tile.owner && tile.terrain!==0){
      const player=room.players[tile.owner];
      if(!player) continue;
      // Troop generation
      let gen=CFG.TROOP_GEN;
      if(tile.building==='city') gen*=CFG.CITY_TROOP_MULT;
      tile.troops+=gen;
      // Gold generation
      player.gold+=CFG.GOLD_PER_TILE;
      if(tile.building==='city') player.gold+=CFG.GOLD_PER_CITY;
    }
  }

  // Advance marches
  const remove=new Set();
  for(const march of room.marches){
    if(march.step>=march.path.length){remove.add(march.id);continue;}
    const [nx,ny]=march.path[march.step];
    const tile=room.tiles[tidx(nx,ny)];
    if(!tile||tile.terrain===0){remove.add(march.id);continue;}

    if(tile.owner===march.owner){
      if(march.step===march.path.length-1){tile.troops+=march.troops;remove.add(march.id);}
    } else if(tile.owner===null){
      tile.owner=march.owner;
      tile.troops=Math.max(1,Math.ceil(march.troops*.25));
      march.troops=Math.max(1,march.troops-1);
      if(march.step===march.path.length-1||march.troops<=0) remove.add(march.id);
    } else {
      // Combat — forts increase defense
      const defMult=tile.building==='fort'?CFG.FORT_DEFENSE_BONUS:1;
      const atk=march.troops;
      const def=tile.troops*defMult;
      if(atk>def+1){
        tile.owner=march.owner;
        tile.troops=Math.floor(atk-def*.8);
        // Capturing a tile with a building destroys it
        tile.building=null;
        march.troops=tile.troops;
        if(march.step===march.path.length-1||march.troops<=0) remove.add(march.id);
      } else {
        tile.troops=Math.max(0,Math.floor(tile.troops-atk*.8/defMult));
        remove.add(march.id);
      }
    }
    march.step++;
  }
  room.marches=room.marches.filter(m=>!remove.has(m.id));

  // Check eliminations
  const alive={};
  for(const tile of room.tiles){if(tile.owner) alive[tile.owner]=true;}
  for(const [pid,player] of Object.entries(room.players)){
    if(player.alive&&!alive[pid]){
      player.alive=false;
      room.marches=room.marches.filter(m=>m.owner!==pid);
      io.to(room.id).emit('eliminated',{playerId:pid,name:player.name});
    }
  }

  // Check win
  const survivors=Object.values(room.players).filter(p=>p.alive);
  if(survivors.length===1){
    room.over=true;
    clearInterval(room.ticker);
    io.to(room.id).emit('game_over',{winner:survivors[0]});
    return;
  }

  // Build delta (only changed tiles)
  const changed=[];
  for(let i=0;i<room.tiles.length;i++){
    const t=room.tiles[i], p=room.prev[i];
    const tf=Math.floor(t.troops);
    const bld=t.building||'';
    if(t.owner!==p.owner||tf!==p.troops||bld!==p.building){
      const oi=t.owner?room.playerOrder.indexOf(t.owner):-1;
      changed.push([i,oi,tf,t.building]);
      p.owner=t.owner;p.troops=tf;p.building=t.building;
    }
  }

  const marchSnap=room.marches.map(m=>{
    const pos=m.path[Math.min(m.step,m.path.length-1)];
    return [m.id,room.playerOrder.indexOf(m.owner),Math.floor(m.troops),pos[0],pos[1]];
  });

  const stats={};
  for(const [pid,player] of Object.entries(room.players)){
    stats[pid]={tiles:0,troops:0,gold:Math.floor(player.gold),cities:0};
  }
  for(const tile of room.tiles){
    if(tile.owner&&stats[tile.owner]){
      stats[tile.owner].tiles++;
      stats[tile.owner].troops+=Math.floor(tile.troops);
      if(tile.building==='city') stats[tile.owner].cities++;
    }
  }

  io.to(room.id).emit('tick',{changed,marches:marchSnap,stats});
}

// ─── SOCKET EVENTS ────────────────────────────────────────────────────────────
io.on('connection', socket=>{
  socket.on('join_room',({roomId,name})=>{
    if(!rooms.has(roomId)) rooms.set(roomId,createRoom(roomId));
    const room=rooms.get(roomId);
    if(room.started) return socket.emit('err',{msg:'Game in progress'});
    if(Object.keys(room.players).length>=CFG.MAX_PLAYERS) return socket.emit('err',{msg:'Room full'});
    const colorIdx=room.playerOrder.length;
    const player={id:socket.id,name:(name||'Player '+(colorIdx+1)).slice(0,20),color:COLORS[colorIdx%COLORS.length],colorIdx,alive:true,gold:CFG.START_GOLD};
    room.players[socket.id]=player;
    room.playerOrder.push(socket.id);
    socket.join(roomId);socket.data.roomId=roomId;
    socket.emit('joined',{playerId:socket.id,player,players:room.players,playerOrder:room.playerOrder,cfg:CFG});
    io.to(roomId).emit('lobby_update',{players:room.players,playerOrder:room.playerOrder});
  });

  socket.on('start_game',()=>{
    const room=rooms.get(socket.data.roomId);
    if(!room||room.started) return;
    if(Object.keys(room.players).length<2) return socket.emit('err',{msg:'Need at least 2 players'});
    room.started=true;
    const spawns=[];
    for(const [pid,player] of Object.entries(room.players)){
      const spawn=findSpawn(room.tiles,spawns);
      if(!spawn) continue;
      spawns.push([spawn.x,spawn.y]);
      spawn.owner=pid;spawn.troops=CFG.START_TROOPS;
      // Give a capital city at spawn
      spawn.building='city';
      adj4(spawn.x,spawn.y).map(([x,y])=>room.tiles[tidx(x,y)]).filter(t=>t&&t.terrain!==0&&!t.owner).slice(0,4).forEach(t=>{t.owner=pid;t.troops=5;});
    }
    room.prev=room.tiles.map(t=>({owner:t.owner,troops:Math.floor(t.troops),building:t.building}));
    const initTiles=room.tiles.map(t=>[t.terrain,t.owner?room.playerOrder.indexOf(t.owner):-1,Math.floor(t.troops),t.building]);
    io.to(room.id).emit('game_start',{tiles:initTiles,players:room.players,playerOrder:room.playerOrder,mapW:CFG.MAP_W,mapH:CFG.MAP_H,cfg:CFG});
    room.ticker=setInterval(()=>tick(room),CFG.TICK_MS);
  });

  socket.on('march',({fromX,fromY,toX,toY})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room||!room.started||room.over) return;
    const from=room.tiles[tidx(fromX,fromY)];
    if(!from||from.owner!==socket.id||from.troops<CFG.MIN_SEND) return;
    const to=room.tiles[tidx(toX,toY)];
    if(!to||to.terrain===0) return;
    const path=findPath(room.tiles,fromX,fromY,toX,toY);
    if(!path||path.length===0) return;
    const send=Math.floor(from.troops*CFG.SEND_RATIO);
    if(send<1) return;
    from.troops-=send;
    room.marches.push({id:socket.id.slice(0,4)+'-'+Date.now(),owner:socket.id,path,troops:send,step:0});
  });

  socket.on('build',({x,y,type})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room||!room.started||room.over) return;
    const tile=room.tiles[tidx(x,y)];
    if(!tile||tile.owner!==socket.id) return;
    if(tile.terrain===0) return;
    if(tile.building) return socket.emit('err',{msg:'Already has a building'});
    const player=room.players[socket.id];
    const cost=type==='city'?CFG.CITY_COST:type==='fort'?CFG.FORT_COST:0;
    if(!cost) return;
    if(player.gold<cost) return socket.emit('err',{msg:`Need ${cost} gold`});
    player.gold-=cost;
    tile.building=type;
    // Broadcast immediately
    const oi=room.playerOrder.indexOf(socket.id);
    io.to(room.id).emit('tick',{
      changed:[[tidx(x,y),oi,Math.floor(tile.troops),type]],
      marches:[],
      stats:buildStats(room),
    });
  });

  socket.on('chat',({message})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room) return;
    const player=room.players[socket.id];
    if(!player) return;
    const msg={name:player.name,color:player.color,text:message.slice(0,200),ts:Date.now()};
    room.chat.push(msg);if(room.chat.length>100) room.chat.shift();
    io.to(socket.data.roomId).emit('chat',msg);
  });

  socket.on('disconnect',()=>{
    const room=rooms.get(socket.data.roomId);
    if(!room) return;
    const player=room.players[socket.id];
    if(!player) return;
    if(room.started){
      for(const tile of room.tiles){if(tile.owner===socket.id){tile.owner=null;tile.troops=0;}}
      room.marches=room.marches.filter(m=>m.owner!==socket.id);
      player.alive=false;
      io.to(room.id).emit('eliminated',{playerId:socket.id,name:player.name});
    } else {
      delete room.players[socket.id];
      const idx=room.playerOrder.indexOf(socket.id);
      if(idx!==-1) room.playerOrder.splice(idx,1);
      io.to(room.id).emit('lobby_update',{players:room.players,playerOrder:room.playerOrder});
    }
  });
});

function buildStats(room){
  const stats={};
  for(const [pid,player] of Object.entries(room.players)){
    stats[pid]={tiles:0,troops:0,gold:Math.floor(player.gold),cities:0};
  }
  for(const tile of room.tiles){
    if(tile.owner&&stats[tile.owner]){
      stats[tile.owner].tiles++;
      stats[tile.owner].troops+=Math.floor(tile.troops);
      if(tile.building==='city') stats[tile.owner].cities++;
    }
  }
  return stats;
}

setInterval(()=>{
  const now=Date.now();
  for(const[id,room]of rooms){if(now-room.createdAt>CFG.ROOM_TTL){if(room.ticker)clearInterval(room.ticker);rooms.delete(id);}}
},1000*60*10);

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('Territory Wars running on port '+PORT));
