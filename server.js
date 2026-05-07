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
  MAP_W: 80, MAP_H: 50, TICK_MS: 300,
  TROOP_GEN: 0.28, CITY_TROOP_MULT: 3, START_TROOPS: 25,
  MIN_SEND: 4, SEND_RATIO: 0.5, MAX_PLAYERS: 8, MAX_PATH: 160,
  ROOM_TTL: 1000 * 60 * 60 * 2,
  START_GOLD: 120,
  GOLD_PER_TILE: 0.03, GOLD_PER_CITY: 0.35, GOLD_FROM_POP: 0.0008,
  TRADE_ROUTE_BASE: 0.25, TRADE_ROUTE_MAX_DIST: 45,
  CITY_COST: 200, FORT_COST: 80, FORT_DEFENSE: 2.0,
  POP_GROWTH_BASE: 0.06, POP_GROWTH_NEAR_CITY: 0.25,
  POP_MAX: 100, POP_CITY_RADIUS: 5,
  EVENT_TICK_MIN: 220, EVENT_TICK_MAX: 450,
};

const COLORS = ['#c0392b','#2471a3','#1e8449','#d35400','#7d3c98','#148f77','#b7950b','#922b21'];

// ─── TECH TREE ────────────────────────────────────────────────────────────────
const TECH_DEFS = {
  mil1:{id:'mil1',branch:'military',tier:1,name:'Iron Discipline',icon:'⚔',cost:120,
    desc:'Troops regenerate 30% faster across your realm.',requires:[]},
  mil2:{id:'mil2',branch:'military',tier:2,name:'Siege Mastery',icon:'🏹',cost:250,
    desc:'Attacking troops deal 40% more damage.',requires:['mil1']},
  mil3:{id:'mil3',branch:'military',tier:3,name:'Grand Army',icon:'👑',cost:450,
    desc:'Send 70% of troops instead of 50%.',requires:['mil2']},
  eco1:{id:'eco1',branch:'economic',tier:1,name:'Tax Reform',icon:'📜',cost:120,
    desc:'Gold income per tile +60%.',requires:[]},
  eco2:{id:'eco2',branch:'economic',tier:2,name:'Guild Charter',icon:'🏛',cost:250,
    desc:'City gold income tripled.',requires:['eco1']},
  eco3:{id:'eco3',branch:'economic',tier:3,name:'Merchant Empire',icon:'🚢',cost:450,
    desc:'Trade route income doubled. Population grows 40% faster.',requires:['eco2']},
  dip1:{id:'dip1',branch:'diplomatic',tier:1,name:'Ambassadors',icon:'🤝',cost:120,
    desc:'Unlocks the ability to propose alliances.',requires:[]},
  dip2:{id:'dip2',branch:'diplomatic',tier:2,name:'Espionage',icon:'🔍',cost:250,
    desc:'See all players\' gold and tech levels at all times.',requires:['dip1']},
  dip3:{id:'dip3',branch:'diplomatic',tier:3,name:'Suzerainty',icon:'🌐',cost:450,
    desc:'Enemies attacking your tiles lose 20% more troops.',requires:['dip2']},
};

// ─── EVENTS ───────────────────────────────────────────────────────────────────
const EVENTS = [
  {id:'harvest',title:'Bumper Harvest',icon:'🌾',
   flavour:'"The granaries overflow. The people rejoice in the streets."',
   choices:[{id:'tax',label:'Tax the surplus',effect:'+150 gold'},
            {id:'feast',label:'Hold a grand feast',effect:'+80 gold, population grows faster'}]},
  {id:'plague',title:'Bubonic Plague',icon:'☠',
   flavour:'"Black boils appear on your subjects. Carts of the dead choke the roads."',
   choices:[{id:'quarantine',label:'Enforce quarantine',effect:'-60 gold, less population loss'},
            {id:'pray',label:'Call for divine mercy',effect:'Population takes heavy losses'}]},
  {id:'mercenaries',title:'Mercenary Company',icon:'⚔',
   flavour:'"The Black Swords, veterans of a dozen wars, offer their blades for coin."',
   choices:[{id:'hire',label:'Hire them (80 gold)',effect:'+350 troops on your capital'},
            {id:'decline',label:'Send them away',effect:'Nothing happens'}]},
  {id:'rebellion',title:'Noble Rebellion',icon:'🏹',
   flavour:'"Three great lords have raised their banners in defiance of your rule."',
   choices:[{id:'crush',label:'Crush the rebels (-100g)',effect:'Keep all territory'},
            {id:'negotiate',label:'Grant concessions',effect:'Lose 2-3 border tiles'}]},
  {id:'tradewindfall',title:'Trade Windfall',icon:'💰',
   flavour:'"Foreign merchants arrive with exotic goods, flooding your treasury."',
   choices:[{id:'open',label:'Open your markets',effect:'+120 gold, trade routes +60%'},
            {id:'tariff',label:'Impose tariffs',effect:'+200 gold'}]},
  {id:'innovation',title:'Military Innovation',icon:'⚗',
   flavour:'"Your master engineer presents revolutionary plans."',
   choices:[{id:'fund',label:'Fund the project (-60g)',effect:'Free tier-1 military tech'},
            {id:'export',label:'Sell the plans',effect:'+90 gold'}]},
  {id:'famine',title:'Great Famine',icon:'🦴',
   flavour:'"Crops wither in the fields. Your people starve in the streets."',
   choices:[{id:'import',label:'Import grain (-80g)',effect:'Minimal population loss'},
            {id:'ration',label:'Enforce rationing',effect:'Moderate pop loss, keep gold'}]},
  {id:'goldstrike',title:'Gold Strike',icon:'⛏',
   flavour:'"Miners have struck a vast vein of gold in your eastern territories!"',
   choices:[{id:'mine',label:'Mine aggressively',effect:'+180 gold'},
            {id:'careful',label:'Mine carefully',effect:'+100 gold, no downside'}]},
];

// ─── TECH HELPERS ─────────────────────────────────────────────────────────────
const has = (p,t) => p?.techs?.includes(t)??false;
const troopGen   = p => CFG.TROOP_GEN*(has(p,'mil1')?1.3:1);
const sendRatio  = p => has(p,'mil3')?0.70:CFG.SEND_RATIO;
const atkBonus   = p => has(p,'mil2')?1.40:1;
const defBonus   = p => has(p,'dip3')?1.20:1;
const gldTile    = p => CFG.GOLD_PER_TILE*(has(p,'eco1')?1.6:1);
const gldCity    = p => CFG.GOLD_PER_CITY*(has(p,'eco2')?3.0:1);
const tradeGld   = p => CFG.TRADE_ROUTE_BASE*(has(p,'eco3')?2.0:1);
const popMult    = p => has(p,'eco3')?1.4:1;

const rooms = new Map();

// ─── MAP GEN ─────────────────────────────────────────────────────────────────
function noise(x,y,s){
  return Math.sin(x*.09+s+1.2)*Math.cos(y*.09+s*.7+2.1)*.5
        +Math.sin(x*.17+s*1.3+3.7)*Math.cos(y*.21+s*.4+.5)*.3
        +Math.sin(x*.31+s*.8+.9)*Math.cos(y*.28+s*1.1+1.8)*.2;
}
function generateMap(seed){
  const {MAP_W:W,MAP_H:H}=CFG;
  const tiles=new Array(W*H);
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    const n=noise(x,y,seed);
    const fade=Math.min(1,Math.min(x,W-1-x)/(W*.13))*Math.min(1,Math.min(y,H-1-y)/(H*.13));
    const val=n*fade;
    let terrain=val<-0.05?0:val>0.55?2:(val>0.18&&Math.sin(x*.4+y*.3+seed)>.25?3:1);
    tiles[y*W+x]={x,y,terrain,owner:null,troops:0,building:null,pop:Math.floor(Math.random()*8+2)};
  }
  return tiles;
}
function adj4(x,y){
  const {MAP_W:W,MAP_H:H}=CFG,r=[];
  if(x>0)r.push([x-1,y]);if(x<W-1)r.push([x+1,y]);
  if(y>0)r.push([x,y-1]);if(y<H-1)r.push([x,y+1]);
  return r;
}
function tidx(x,y){return y*CFG.MAP_W+x;}
function findPath(tiles,sx,sy,tx,ty){
  if(sx===tx&&sy===ty)return[];
  const W=CFG.MAP_W,vis=new Set([sy*W+sx]),q=[[[sx,sy]]];
  while(q.length){
    const path=q.shift();if(path.length>CFG.MAX_PATH)continue;
    const[cx,cy]=path[path.length-1];
    for(const[nx,ny]of adj4(cx,cy)){
      const k=ny*W+nx;if(vis.has(k))continue;
      const t=tiles[k];if(!t||t.terrain===0)continue;
      vis.add(k);const np=[...path,[nx,ny]];
      if(nx===tx&&ny===ty)return np.slice(1);
      q.push(np);
    }
  }
  return null;
}
function findSpawn(tiles,existing){
  const land=tiles.filter(t=>t.terrain===1||t.terrain===3);
  let best=null,bestD=-1;
  for(const t of land.sort(()=>Math.random()-.5).slice(0,300)){
    let minD=existing.length?Infinity:1;
    for(const[ex,ey]of existing){const d=Math.abs(t.x-ex)+Math.abs(t.y-ey);if(d<minD)minD=d;}
    if(minD>bestD){bestD=minD;best=t;}
  }
  return best;
}

// ─── TRADE ROUTES ─────────────────────────────────────────────────────────────
function calcTrade(room){
  const routes=[];
  for(const[pid]of Object.entries(room.players)){
    const cities=room.tiles.filter(t=>t.owner===pid&&t.building==='city');
    for(let i=0;i<cities.length;i++)for(let j=i+1;j<cities.length;j++){
      const d=Math.abs(cities[i].x-cities[j].x)+Math.abs(cities[i].y-cities[j].y);
      if(d<=CFG.TRADE_ROUTE_MAX_DIST)
        routes.push({pid,x1:cities[i].x,y1:cities[i].y,x2:cities[j].x,y2:cities[j].y});
    }
  }
  return routes;
}

// ─── POP GROWTH ───────────────────────────────────────────────────────────────
function growPop(room){
  const cities=room.tiles.filter(t=>t.building==='city').map(t=>({x:t.x,y:t.y,owner:t.owner}));
  for(const tile of room.tiles){
    if(!tile.owner||tile.terrain===0)continue;
    const player=room.players[tile.owner];if(!player)continue;
    let rate=CFG.POP_GROWTH_BASE;
    for(const c of cities){
      if(c.owner===tile.owner&&Math.abs(c.x-tile.x)+Math.abs(c.y-tile.y)<=CFG.POP_CITY_RADIUS){rate+=CFG.POP_GROWTH_NEAR_CITY;break;}
    }
    if(player.popBonus?.ticks>0)rate*=player.popBonus.mult;
    rate*=popMult(player);
    tile.pop=Math.min(CFG.POP_MAX,(tile.pop||0)+rate);
  }
}

// ─── EVENTS ───────────────────────────────────────────────────────────────────
function fireEvent(room,pid){
  const player=room.players[pid];if(!player?.alive)return;
  const evt=EVENTS[Math.floor(Math.random()*EVENTS.length)];
  player.pendingEvent=evt.id;
  io.to(pid).emit('event',{id:evt.id,title:evt.title,icon:evt.icon,flavour:evt.flavour,choices:evt.choices});
}

function applyEvent(room,pid,eventId,choiceId){
  const player=room.players[pid];if(!player)return;
  player.pendingEvent=null;
  player.nextEventTick=room.tickCount+CFG.EVENT_TICK_MIN+Math.floor(Math.random()*(CFG.EVENT_TICK_MAX-CFG.EVENT_TICK_MIN));
  const ownedTiles=room.tiles.filter(t=>t.owner===pid);
  switch(eventId){
    case'harvest':
      player.gold+=choiceId==='tax'?150:80;
      if(choiceId==='feast')player.popBonus={mult:1.8,ticks:60};
      break;
    case'plague':
      if(choiceId==='quarantine'){player.gold=Math.max(0,player.gold-60);ownedTiles.forEach(t=>t.pop=Math.max(0,(t.pop||0)*.85));}
      else ownedTiles.forEach(t=>t.pop=Math.max(0,(t.pop||0)*.60));
      break;
    case'mercenaries':
      if(choiceId==='hire'&&player.gold>=80){
        player.gold-=80;
        const cap=room.tiles.find(t=>t.owner===pid&&t.building==='city');
        if(cap)cap.troops+=350;
      }
      break;
    case'rebellion':
      if(choiceId==='crush'){player.gold=Math.max(0,player.gold-100);}
      else{const noncity=ownedTiles.filter(t=>!t.building);for(let i=0;i<Math.min(3,noncity.length);i++){const t=noncity[Math.floor(Math.random()*noncity.length)];t.owner=null;t.troops=0;}}
      break;
    case'tradewindfall':
      if(choiceId==='open'){player.gold+=120;player.tradeBonus={mult:1.6,ticks:40};}
      else player.gold+=200;
      break;
    case'innovation':
      if(choiceId==='fund'&&player.gold>=60){player.gold-=60;if(!has(player,'mil1'))player.techs.push('mil1');}
      else player.gold+=90;
      break;
    case'famine':
      if(choiceId==='import'){player.gold=Math.max(0,player.gold-80);ownedTiles.forEach(t=>t.pop=Math.max(0,(t.pop||0)*.92));}
      else ownedTiles.forEach(t=>t.pop=Math.max(0,(t.pop||0)*.75));
      break;
    case'goldstrike':
      player.gold+=choiceId==='mine'?180:100;
      break;
  }
  io.to(pid).emit('event_resolved',{eventId,choiceId});
}

// ─── STATS ────────────────────────────────────────────────────────────────────
function buildStats(room){
  const stats={};
  for(const[pid,p]of Object.entries(room.players)){
    stats[pid]={tiles:0,troops:0,gold:Math.floor(p.gold),cities:0,pop:0,
      techs:p.techs,allies:[...p.allies]};
  }
  for(const t of room.tiles){
    if(!t.owner||!stats[t.owner])continue;
    stats[t.owner].tiles++;
    stats[t.owner].troops+=Math.floor(t.troops);
    if(t.building==='city')stats[t.owner].cities++;
    stats[t.owner].pop+=Math.floor(t.pop||0);
  }
  return stats;
}

// ─── TICK ─────────────────────────────────────────────────────────────────────
function tick(room){
  if(room.over)return;
  room.tickCount++;
  if(room.tickCount%3===0)growPop(room);
  const trade=calcTrade(room);

  for(const tile of room.tiles){
    if(!tile.owner||tile.terrain===0)continue;
    const p=room.players[tile.owner];if(!p)continue;
    let gen=troopGen(p);if(tile.building==='city')gen*=CFG.CITY_TROOP_MULT;
    tile.troops+=gen;
    p.gold+=gldTile(p)+(tile.pop||0)*CFG.GOLD_FROM_POP;
    if(tile.building==='city')p.gold+=gldCity(p);
  }
  for(const r of trade){
    const p=room.players[r.pid];if(!p)continue;
    const tm=(p.tradeBonus?.ticks>0)?p.tradeBonus.mult:1;
    p.gold+=tradeGld(p)*tm;
  }
  for(const p of Object.values(room.players)){
    if(p.popBonus?.ticks>0)p.popBonus.ticks--;
    if(p.tradeBonus?.ticks>0)p.tradeBonus.ticks--;
  }

  // Marches
  const remove=new Set();
  for(const march of room.marches){
    if(march.step>=march.path.length){remove.add(march.id);continue;}
    const[nx,ny]=march.path[march.step];
    const tile=room.tiles[tidx(nx,ny)];
    if(!tile||tile.terrain===0){remove.add(march.id);continue;}
    const atk=room.players[march.owner];
    if(tile.owner===march.owner){
      if(march.step===march.path.length-1){tile.troops+=march.troops;remove.add(march.id);}
    }else if(!tile.owner){
      tile.owner=march.owner;tile.troops=Math.max(1,Math.ceil(march.troops*.25));
      march.troops=Math.max(1,march.troops-1);
      if(march.step===march.path.length-1||march.troops<=0)remove.add(march.id);
    }else{
      const def=room.players[tile.owner];
      const defMult=(tile.building==='fort'?CFG.FORT_DEFENSE:1)*defBonus(def);
      const a=march.troops*atkBonus(atk),d=tile.troops*defMult;
      if(a>d+1){
        tile.owner=march.owner;tile.building=null;
        tile.troops=Math.floor(a-d*.8);march.troops=tile.troops;
        if(march.step===march.path.length-1||march.troops<=0)remove.add(march.id);
      }else{tile.troops=Math.max(0,Math.floor(tile.troops-a*.8/defMult));remove.add(march.id);}
    }
    march.step++;
  }
  room.marches=room.marches.filter(m=>!remove.has(m.id));

  // Eliminations
  const alive={};
  for(const t of room.tiles)if(t.owner)alive[t.owner]=true;
  for(const[pid,p]of Object.entries(room.players)){
    if(p.alive&&!alive[pid]){
      p.alive=false;room.marches=room.marches.filter(m=>m.owner!==pid);
      io.to(room.id).emit('eliminated',{playerId:pid,name:p.name});
    }
  }
  const survivors=Object.values(room.players).filter(p=>p.alive);
  if(survivors.length===1){
    room.over=true;clearInterval(room.ticker);
    io.to(room.id).emit('game_over',{winner:survivors[0]});return;
  }

  // Events
  for(const[pid,p]of Object.entries(room.players)){
    if(p.alive&&!p.pendingEvent&&room.tickCount>=p.nextEventTick)fireEvent(room,pid);
  }

  // Delta
  const changed=[];
  for(let i=0;i<room.tiles.length;i++){
    const t=room.tiles[i],p=room.prev[i];
    const tf=Math.floor(t.troops),pf=Math.floor(t.pop||0),bld=t.building||'';
    if(t.owner!==p.owner||tf!==p.troops||bld!==p.building||pf!==p.pop){
      changed.push([i,t.owner?room.playerOrder.indexOf(t.owner):-1,tf,t.building,pf]);
      p.owner=t.owner;p.troops=tf;p.building=t.building;p.pop=pf;
    }
  }
  const marchSnap=room.marches.map(m=>{const pos=m.path[Math.min(m.step,m.path.length-1)];return[m.id,room.playerOrder.indexOf(m.owner),Math.floor(m.troops),pos[0],pos[1]];});
  const tradeSnap=trade.map(r=>[room.playerOrder.indexOf(r.pid),r.x1,r.y1,r.x2,r.y2]);
  io.to(room.id).emit('tick',{changed,marches:marchSnap,stats:buildStats(room),trade:tradeSnap});
}

// ─── SOCKETS ─────────────────────────────────────────────────────────────────
io.on('connection',socket=>{
  socket.on('join_room',({roomId,name})=>{
    if(!rooms.has(roomId))rooms.set(roomId,createRoom(roomId));
    const room=rooms.get(roomId);
    if(room.started)return socket.emit('err',{msg:'Game in progress'});
    if(Object.keys(room.players).length>=CFG.MAX_PLAYERS)return socket.emit('err',{msg:'Room full'});
    const ci=room.playerOrder.length;
    const player={id:socket.id,name:(name||'Player '+(ci+1)).slice(0,20),color:COLORS[ci%8],
      colorIdx:ci,alive:true,gold:CFG.START_GOLD,techs:[],allies:new Set(),
      allianceRequests:{},pendingEvent:null,nextEventTick:0,popBonus:null,tradeBonus:null};
    room.players[socket.id]=player;room.playerOrder.push(socket.id);
    socket.join(roomId);socket.data.roomId=roomId;
    socket.emit('joined',{playerId:socket.id,player,players:room.players,playerOrder:room.playerOrder,cfg:CFG,techDefs:TECH_DEFS});
    io.to(roomId).emit('lobby_update',{players:room.players,playerOrder:room.playerOrder});
  });

  socket.on('start_game',()=>{
    const room=rooms.get(socket.data.roomId);
    if(!room||room.started)return;
    if(Object.keys(room.players).length<2)return socket.emit('err',{msg:'Need at least 2 players'});
    room.started=true;
    const spawns=[];
    let ci=0;
    for(const[pid,player]of Object.entries(room.players)){
      const spawn=findSpawn(room.tiles,spawns);if(!spawn)continue;
      spawns.push([spawn.x,spawn.y]);
      spawn.owner=pid;spawn.troops=CFG.START_TROOPS;spawn.building='city';spawn.pop=30;
      adj4(spawn.x,spawn.y).map(([x,y])=>room.tiles[tidx(x,y)])
        .filter(t=>t&&t.terrain!==0&&!t.owner).slice(0,4)
        .forEach(t=>{t.owner=pid;t.troops=8;t.pop=10;});
      player.nextEventTick=CFG.EVENT_TICK_MIN+Math.floor(Math.random()*(CFG.EVENT_TICK_MAX-CFG.EVENT_TICK_MIN))+(ci++)*40;
    }
    room.prev=room.tiles.map(t=>({owner:t.owner,troops:Math.floor(t.troops),building:t.building,pop:Math.floor(t.pop||0)}));
    const initTiles=room.tiles.map(t=>[t.terrain,t.owner?room.playerOrder.indexOf(t.owner):-1,Math.floor(t.troops),t.building,Math.floor(t.pop||0)]);
    io.to(room.id).emit('game_start',{tiles:initTiles,players:room.players,playerOrder:room.playerOrder,mapW:CFG.MAP_W,mapH:CFG.MAP_H,cfg:CFG,techDefs:TECH_DEFS});
    room.ticker=setInterval(()=>tick(room),CFG.TICK_MS);
  });

  socket.on('march',({fromX,fromY,toX,toY})=>{
    const room=rooms.get(socket.data.roomId);
    if(!room||!room.started||room.over)return;
    const from=room.tiles[tidx(fromX,fromY)];
    if(!from||from.owner!==socket.id||from.troops<CFG.MIN_SEND)return;
    const to=room.tiles[tidx(toX,toY)];if(!to||to.terrain===0)return;
    const player=room.players[socket.id];
    if(to.owner&&player?.allies?.has(to.owner))return socket.emit('err',{msg:'Cannot attack allies!'});
    const path=findPath(room.tiles,fromX,fromY,toX,toY);
    if(!path||!path.length)return;
    const send=Math.floor(from.troops*sendRatio(player));if(send<1)return;
    from.troops-=send;
    room.marches.push({id:socket.id.slice(0,4)+'-'+Date.now(),owner:socket.id,path,troops:send,step:0});
  });

  socket.on('build',({x,y,type})=>{
    const room=rooms.get(socket.data.roomId);if(!room||!room.started||room.over)return;
    const tile=room.tiles[tidx(x,y)];
    if(!tile||tile.owner!==socket.id||tile.terrain===0||tile.building)return;
    const player=room.players[socket.id];
    const cost=type==='city'?CFG.CITY_COST:type==='fort'?CFG.FORT_COST:0;if(!cost)return;
    if(player.gold<cost)return socket.emit('err',{msg:`Need ${cost} gold`});
    player.gold-=cost;tile.building=type;
    const oi=room.playerOrder.indexOf(socket.id);
    const trade=calcTrade(room);
    io.to(room.id).emit('tick',{changed:[[tidx(x,y),oi,Math.floor(tile.troops),type,Math.floor(tile.pop||0)]],marches:[],stats:buildStats(room),trade:trade.map(r=>[room.playerOrder.indexOf(r.pid),r.x1,r.y1,r.x2,r.y2])});
  });

  socket.on('research',({techId})=>{
    const room=rooms.get(socket.data.roomId);if(!room||!room.started)return;
    const player=room.players[socket.id];if(!player)return;
    const tech=TECH_DEFS[techId];if(!tech)return;
    if(player.techs.includes(techId))return socket.emit('err',{msg:'Already researched'});
    for(const req of tech.requires)if(!player.techs.includes(req))return socket.emit('err',{msg:'Prerequisites not met'});
    if(player.gold<tech.cost)return socket.emit('err',{msg:`Need ${tech.cost} gold`});
    player.gold-=tech.cost;player.techs.push(techId);
    socket.emit('tech_unlocked',{techId,playerGold:Math.floor(player.gold)});
    io.to(room.id).emit('chat',{name:'Chronicle',color:'#c8960c',text:`${player.name} researched ${tech.name}!`});
  });

  socket.on('event_choice',({eventId,choiceId})=>{
    const room=rooms.get(socket.data.roomId);if(room)applyEvent(room,socket.id,eventId,choiceId);
  });

  socket.on('propose_alliance',({targetId})=>{
    const room=rooms.get(socket.data.roomId);if(!room||!room.started)return;
    const player=room.players[socket.id];
    if(!has(player,'dip1'))return socket.emit('err',{msg:'Research Ambassadors first'});
    const target=room.players[targetId];if(!target)return;
    target.allianceRequests[socket.id]=Date.now();
    io.to(targetId).emit('alliance_offer',{fromId:socket.id,fromName:player.name,fromColor:player.color});
  });

  socket.on('respond_alliance',({fromId,accept})=>{
    const room=rooms.get(socket.data.roomId);if(!room)return;
    const player=room.players[socket.id],other=room.players[fromId];
    if(!player||!other)return;
    delete player.allianceRequests[fromId];
    if(accept){
      player.allies.add(fromId);other.allies.add(socket.id);
      io.to(socket.id).emit('alliance_formed',{withId:fromId,withName:other.name,withColor:other.color});
      io.to(fromId).emit('alliance_formed',{withId:socket.id,withName:player.name,withColor:player.color});
      io.to(room.id).emit('chat',{name:'Chronicle',color:'#c8960c',text:`${player.name} and ${other.name} have formed an alliance!`});
    }else{
      io.to(fromId).emit('alliance_declined',{byName:player.name});
    }
  });

  socket.on('break_alliance',({targetId})=>{
    const room=rooms.get(socket.data.roomId);if(!room)return;
    const p=room.players[socket.id],o=room.players[targetId];
    if(p)p.allies.delete(targetId);if(o)o.allies.delete(socket.id);
    io.to(socket.id).emit('alliance_broken',{withId:targetId});
    io.to(targetId).emit('alliance_broken',{withId:socket.id});
  });

  socket.on('chat',({message})=>{
    const room=rooms.get(socket.data.roomId);if(!room)return;
    const player=room.players[socket.id];if(!player)return;
    const msg={name:player.name,color:player.color,text:message.slice(0,200),ts:Date.now()};
    room.chat.push(msg);if(room.chat.length>100)room.chat.shift();
    io.to(socket.data.roomId).emit('chat',msg);
  });

  socket.on('disconnect',()=>{
    const room=rooms.get(socket.data.roomId);if(!room)return;
    const player=room.players[socket.id];if(!player)return;
    if(room.started){
      for(const t of room.tiles)if(t.owner===socket.id){t.owner=null;t.troops=0;}
      room.marches=room.marches.filter(m=>m.owner!==socket.id);
      for(const p of Object.values(room.players))p.allies?.delete(socket.id);
      player.alive=false;
      io.to(room.id).emit('eliminated',{playerId:socket.id,name:player.name});
    }else{
      delete room.players[socket.id];
      const idx=room.playerOrder.indexOf(socket.id);
      if(idx!==-1)room.playerOrder.splice(idx,1);
      io.to(room.id).emit('lobby_update',{players:room.players,playerOrder:room.playerOrder});
    }
  });
});

function createRoom(id){
  const seed=Math.random()*999,tiles=generateMap(seed);
  return{id,tiles,prev:tiles.map(t=>({owner:t.owner,troops:0,building:null,pop:Math.floor(t.pop)})),
    players:{},playerOrder:[],marches:[],started:false,over:false,ticker:null,createdAt:Date.now(),chat:[],tickCount:0};
}

setInterval(()=>{const now=Date.now();for(const[id,room]of rooms)if(now-room.createdAt>CFG.ROOM_TTL){if(room.ticker)clearInterval(room.ticker);rooms.delete(id);}},1000*60*15);
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Territory Wars running on port ${PORT}`));
