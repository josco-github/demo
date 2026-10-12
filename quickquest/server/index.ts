import express from 'express';
import { createServer } from 'node:http';
import { Server, Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AVATARS, CATEGORIES, disconnectPlayer, joinRoom, makeRoom, newCode, publicState, startRound, submitAnswer, type Room } from './game.js';

const PORT = Number(process.env.PORT || 3001);
const publicHost = process.env.KOYEB_PUBLIC_DOMAIN || process.env.RENDER_EXTERNAL_HOSTNAME;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || (publicHost ? `https://${publicHost}` : 'http://localhost:5173');
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 6 * 60 * 60 * 1000);
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS || 60_000);
const app = express(); app.disable('x-powered-by'); app.get('/health', (_req,res)=>res.json({ok:true, service:'quickquest'}));
const clientDir=resolve(process.cwd(),'dist'), indexFile=resolve(clientDir,'index.html');
if(existsSync(indexFile)){app.use(express.static(clientDir));app.use((req,res,next)=>{if(req.method==='GET'&&!req.path.startsWith('/socket.io'))res.sendFile(indexFile,err=>{if(err)next(err);});else next();});}
const http = createServer(app);
const allowedOrigins = CLIENT_ORIGIN.split(',').map(s=>s.trim());
const io = new Server(http, { cors: { origin: allowedOrigins, methods:['GET','POST'] }, allowRequest: (req, callback) => { const origin=req.headers.origin; callback(null, !origin || allowedOrigins.includes(origin)); }, maxHttpBufferSize: 16_384, pingInterval: 20_000, pingTimeout: 25_000 });
const rooms = new Map<string, Room>();
const peerLimits = new Map<string, { at:number; count:number }>();
function rateOk(key:string, max:number, windowMs:number) { const now=Date.now(), v=peerLimits.get(key); if (!v || now-v.at>windowMs) {peerLimits.set(key,{at:now,count:1});return true;} v.count++; return v.count<=max; }
function roomOf(code: unknown) { if(typeof code!=='string') throw Error('Enter a room code.'); const r=rooms.get(code.trim().toUpperCase()); if(!r) throw Error('Room not found. Check the code and try again.'); return r; }
function emitRoom(room:Room) { io.to(room.code).emit('state', publicState(room)); }
function clearTimer(room:Room) { if(room.timer) clearTimeout(room.timer); room.timer=null; }
function finishRound(room:Room) {
  if(room.phase!=='playing') return;
  clearTimer(room); room.phase='results'; room.deadline=null; emitRoom(room);
  if(room.round>=room.rounds) { room.timer=setTimeout(()=>{ if(room.phase==='results'){room.phase='finished'; emitRoom(room);} }, 7000); }
  else room.timer=setTimeout(()=>nextRound(room), 7000);
}
function nextRound(room:Room) { if(room.phase!=='results')return; clearTimer(room); startRound(room); emitRoom(room); room.timer=setTimeout(()=>finishRound(room),20_000); }
function socketPlayer(socket:Socket, room:Room) { const p=[...room.seats.values()].find(x=>x.socketId===socket.id); if(!p) throw Error('Join this room first.'); return p; }
function setSocket(socket:Socket, room:Room, p:{id:string;socketId:string|null}) { if(p.socketId && p.socketId!==socket.id) io.sockets.sockets.get(p.socketId)?.leave(room.code); p.socketId=socket.id; socket.data.room=room.code; socket.data.playerId=p.id; socket.join(room.code); }
function failure(socket:Socket, event:string, error:unknown, ack?: (value:unknown)=>void) { const message=error instanceof Error?error.message:'That action could not be completed.'; if(ack) ack({ok:false,error:message}); else socket.emit('notice',{event,message}); }
io.on('connection',(socket)=>{
  const ip=socket.handshake.address;
  socket.on('create', (payload:any, ack?:Function)=>{
    try {
      if(!rateOk(`create:${ip}`,8,60_000)) throw Error('Too many room attempts. Try again in a minute.');
      if(typeof payload?.name!=='string'||typeof payload?.token!=='string'||payload.token.length<24) throw Error('Nickname or session key is invalid.');
      let code=''; for(let i=0;i<12;i++){code=newCode();if(!rooms.has(code))break;} if(rooms.has(code))throw Error('Could not reserve a room code. Try again.');
      const id=randomUUID(), room=makeRoom(code,id,payload.name,payload.token); rooms.set(code,room); const p=room.seats.get(id)!; setSocket(socket,room,p); emitRoom(room); ack?.({ok:true,identity:{id,token:payload.token},state:publicState(room)});
    } catch(e){failure(socket,'create',e,ack as any);}
  });
  socket.on('join',(payload:any,ack?:Function)=>{
    try {
      if(!rateOk(`join:${ip}`,12,60_000)) throw Error('Too many join attempts. Try again in a minute.');
      const room=roomOf(payload?.code); if(typeof payload?.token!=='string'||payload.token.length<24)throw Error('Session key is invalid.');
      const id=randomUUID(), p=joinRoom(room,id,payload.name,payload.token,socket.id,RECONNECT_GRACE_MS); setSocket(socket,room,p); emitRoom(room); ack?.({ok:true,identity:{id,token:payload.token},state:publicState(room)});
    }catch(e){failure(socket,'join',e,ack as any);}
  });
  socket.on('reconnect-room',(payload:any,ack?:Function)=>{
    try { const room=roomOf(payload?.code); const p=room.seats.get(payload?.id); if(!p) throw Error('Your seat has expired. Join a new room.');
      joinRoom(room,p.id,p.name,payload.token,socket.id,RECONNECT_GRACE_MS); setSocket(socket,room,p); emitRoom(room); ack?.({ok:true,identity:{id:p.id,token:payload.token},state:publicState(room)});
    } catch(e){failure(socket,'reconnect',e,ack as any);}
  });
  socket.on('host-settings',(payload:any)=>{
    try { const room=roomOf(payload?.code), p=socketPlayer(socket,room); if(p.id!==room.hostId||room.phase!=='lobby')throw Error('Only the host can change lobby settings.');
      if(payload.rounds!==undefined){const n=Number(payload.rounds);if(!Number.isInteger(n)||n<3||n>8)throw Error('Choose 3–8 rounds.');room.rounds=n;}
      if(payload.category!==undefined){if(typeof payload.category!=='string'||!Object.hasOwn(CATEGORIES,payload.category))throw Error('Choose a listed category.');room.category=payload.category;}
      if(payload.locked!==undefined){if(typeof payload.locked!=='boolean')throw Error('Invalid room setting.');room.locked=payload.locked;}
      emitRoom(room);
    }catch(e){failure(socket,'host-settings',e);}
  });
  socket.on('ready', (payload:any)=>{try{const room=roomOf(payload?.code),p=socketPlayer(socket,room);if(room.phase!=='lobby')throw Error('The game has already started.');p.ready=!!payload.ready;emitRoom(room);}catch(e){failure(socket,'ready',e);}});
  socket.on('choose-avatar',(payload:any)=>{try{const room=roomOf(payload?.code),p=socketPlayer(socket,room);if(room.phase!=='lobby')throw Error('Avatars can only be changed before the game starts.');if(!AVATARS.some(a=>a.emoji===payload?.avatar))throw Error('Choose an available avatar.');p.avatar=payload.avatar;emitRoom(room);}catch(e){failure(socket,'choose-avatar',e);}});
  socket.on('start-game',(payload:any)=>{
    try{const room=roomOf(payload?.code),p=socketPlayer(socket,room);if(p.id!==room.hostId)throw Error('Only the host can start.');if(room.phase!=='lobby')throw Error('A game is already in progress.');
      const active=[...room.seats.values()].filter(x=>x.connected); if(active.length<2)throw Error('Invite at least one more player to start.');
      startRound(room);emitRoom(room);room.timer=setTimeout(()=>finishRound(room),20_000);
    }catch(e){failure(socket,'start-game',e);}
  });
  socket.on('submit',(payload:any,ack?:Function)=>{
    try{const room=roomOf(payload?.code),p=socketPlayer(socket,room);if(payload?.roundId!==room.roundId)throw Error('This round has moved on.');
      const result=submitAnswer(room,p.id,payload.answer);ack?.({ok:true,...result});
      // Other players see only that a seat has submitted, never its answer or correctness.
      socket.to(room.code).emit('submission-count',{count:room.submissions.size});emitRoom(room);
      if(room.submissions.size>=[...room.seats.values()].filter(x=>x.connected).length)finishRound(room);
    }catch(e){failure(socket,'submit',e,ack as any);}
  });
  socket.on('next-round',(payload:any)=>{try{const room=roomOf(payload?.code),p=socketPlayer(socket,room);if(p.id!==room.hostId)throw Error('Only the host can continue.');if(room.phase==='results'&&room.round<room.rounds)nextRound(room);}catch(e){failure(socket,'next-round',e);}});
  socket.on('end-game',(payload:any)=>{try{const room=roomOf(payload?.code),p=socketPlayer(socket,room);if(p.id!==room.hostId||!['playing','results'].includes(room.phase))throw Error('Only the host can end an active game.');clearTimer(room);room.phase='finished';room.deadline=null;emitRoom(room);}catch(e){failure(socket,'end-game',e);}});
  socket.on('restart',(payload:any)=>{try{const room=roomOf(payload?.code),p=socketPlayer(socket,room);if(p.id!==room.hostId||!['finished','results'].includes(room.phase))throw Error('Only the host can restart after results.');clearTimer(room);room.phase='lobby';room.round=0;room.deadline=null;room.answer=null;room.prompt='';room.hint='';room.roundId=null;room.submissions.clear();room.acceptedSprint.clear();for(const x of room.seats.values()){x.score=0;x.ready=x.id===room.hostId;}emitRoom(room);}catch(e){failure(socket,'restart',e);}});
  socket.on('reaction',(payload:any)=>{try{const room=roomOf(payload?.code),p=socketPlayer(socket,room),emoji=payload?.emoji;if(!['👏','🔥','🤔','💡','🎉','😅'].includes(emoji))throw Error('Reaction not available.');const t=Date.now();if(t-(room.lastReaction.get(p.id)||0)<1500)throw Error('Slow down on reactions.');room.lastReaction.set(p.id,t);io.to(room.code).emit('reaction',{player:p.name,emoji});}catch(e){failure(socket,'reaction',e);}});
  socket.on('leave',(payload:any)=>{try{const room=roomOf(payload?.code),p=socketPlayer(socket,room);room.seats.delete(p.id);socket.leave(room.code);if(room.hostId===p.id){const n=[...room.seats.values()].find(x=>x.connected);room.hostId=n?.id||'';if(n)n.host=true;}if(room.seats.size===0){clearTimer(room);rooms.delete(room.code);}else emitRoom(room);}catch(e){failure(socket,'leave',e);}});
  socket.on('disconnect',()=>{const code=socket.data.room as string|undefined,id=socket.data.playerId as string|undefined;if(!code||!id)return;const room=rooms.get(code);if(!room)return;const p=room.seats.get(id);if(!p||p.socketId!==socket.id)return;disconnectPlayer(room,id);emitRoom(room);if(room.timer)clearTimer(room);
    if(![...room.seats.values()].some(x=>x.connected)){room.timer=setTimeout(()=>{if(![...room.seats.values()].some(x=>x.connected)){clearTimer(room);rooms.delete(room.code);}},Math.min(RECONNECT_GRACE_MS,ROOM_TTL_MS));}
    else if(room.phase==='playing'){room.timer=setTimeout(()=>finishRound(room),Math.max(0,(room.deadline||Date.now())-Date.now()));}
  });
});
setInterval(()=>{const now=Date.now();for(const [code,room] of rooms){if(now-room.createdAt>=ROOM_TTL_MS){clearTimer(room);rooms.delete(code);continue;}for(const [id,p]of room.seats)if(!p.connected&&p.disconnectedAt&&now-p.disconnectedAt>RECONNECT_GRACE_MS){room.seats.delete(id);if(room.hostId===id){const n=[...room.seats.values()].find(x=>x.connected);room.hostId=n?.id||'';if(n)n.host=true;}}if(room.seats.size===0){clearTimer(room);rooms.delete(code);}}for(const [key,v]of peerLimits)if(now-v.at>120_000)peerLimits.delete(key);},60_000).unref();
http.listen(PORT,'0.0.0.0',()=>console.log(`Quick Quest server listening on ${PORT}`));
