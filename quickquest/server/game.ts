import { randomBytes, randomUUID, createHash } from 'node:crypto';

export type Mode = 'unscramble' | 'sprint';
export type Phase = 'lobby' | 'playing' | 'results' | 'finished';
export const AVATARS = [
  { emoji: '🦊', name: 'Fox' }, { emoji: '🐼', name: 'Panda' }, { emoji: '🐸', name: 'Frog' },
  { emoji: '🦉', name: 'Owl' }, { emoji: '🐙', name: 'Octopus' }, { emoji: '🐧', name: 'Penguin' },
  { emoji: '🐯', name: 'Tiger' }, { emoji: '🦄', name: 'Unicorn' },
] as const;
export type Player = { id: string; name: string; avatar: string; score: number; connected: boolean; ready: boolean; host: boolean; lastSeen: number };
export type PublicRoom = { code: string; phase: Phase; players: Player[]; hostId: string; round: number; rounds: number; mode: Mode; category: string; deadline: number | null; serverNow: number; prompt: string; hint: string; submitted: string[]; answer: string | null; roundScores: Record<string, number>; locked: boolean; roundId: string | null };
type Seat = Player & { tokenHash: string; socketId: string | null; disconnectedAt: number | null };
export type Room = PublicRoom & { createdAt: number; seats: Map<string, Seat>; submissions: Map<string, { answer: string; at: number; correct: boolean; points: number }>; acceptedSprint: Set<string>; timer: ReturnType<typeof setTimeout> | null; lastReaction: Map<string, number> };
export const CATEGORIES: Record<string, string[]> = {
  Animals: ['otter', 'falcon', 'badger', 'rabbit', 'panther', 'dolphin', 'turtle', 'hamster', 'raccoon', 'penguin', 'leopard', 'squirrel'],
  Food: ['pancake', 'avocado', 'pretzel', 'blueberry', 'omelette', 'sandwich', 'cinnamon', 'watermelon', 'broccoli', 'chocolate'],
  Nature: ['rainbow', 'mountain', 'volcano', 'meadow', 'waterfall', 'thunder', 'glacier', 'wildflower', 'forest', 'seashell'],
  Objects: ['backpack', 'lantern', 'keychain', 'umbrella', 'notebook', 'telescope', 'headphones', 'suitcase', 'toothbrush', 'skateboard'],
  Places: ['airport', 'castle', 'hospital', 'library', 'museum', 'station', 'stadium', 'school', 'village', 'hotel', 'market', 'bridge'],
  Travel: ['journey', 'passport', 'luggage', 'suitcase', 'boarding', 'highway', 'ticket', 'cruise', 'airplane', 'backpack', 'itinerary', 'tourist'],
  Sports: ['soccer', 'tennis', 'baseball', 'cricket', 'hockey', 'volleyball', 'badminton', 'basketball', 'swimming', 'golf', 'rugby', 'skiing'],
};
const norm = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const cleanName = (s: string) => s.trim().replace(/[<>\u0000-\u001f]/g, '').slice(0,18);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const codeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newCode() { let code = ''; for (let i=0;i<5;i++) code += codeChars[randomBytes(1)[0] % codeChars.length]; return code; }
function scrambled(word: string) {
  const a = word.split('');
  for (let i=a.length-1;i>0;i--) { const j = randomBytes(2).readUInt16BE() % (i+1); [a[i],a[j]]=[a[j],a[i]]; }
  if (a.join('') === word && a.length > 1) [a[0], a[1]] = [a[1], a[0]];
  return a.join('').toUpperCase();
}
export function makeRoom(code: string, id: string, name: string, token: string): Room {
  const nickname=cleanName(name); if(!nickname) throw Error('Choose a nickname.');
  const host: Seat = { id, name:nickname, avatar:AVATARS[0].emoji, score: 0, connected: true, ready: true, host: true, lastSeen: Date.now(), tokenHash: digest(token), socketId: null, disconnectedAt: null };
  return { code, phase: 'lobby', players: [], createdAt: Date.now(), hostId: id, round: 0, rounds: 5, mode: 'unscramble', category: 'Animals', deadline: null, serverNow: Date.now(), prompt: '', hint: '', submitted: [], answer: null, roundScores: {}, locked: false, roundId: null, seats: new Map([[id, host]]), submissions: new Map(), acceptedSprint: new Set(), timer: null, lastReaction: new Map() };
}
export function publicState(room: Room): PublicRoom {
  return { code: room.code, phase: room.phase, players: [...room.seats.values()].map(({tokenHash:_, socketId:__, disconnectedAt:___, ...p})=>({...p})), hostId: room.hostId, round: room.round, rounds: room.rounds, mode: room.mode, category: room.category, deadline: room.deadline, serverNow: Date.now(), prompt: room.prompt, hint: room.hint, submitted: [...room.submissions.keys()], answer: room.phase === 'results' || room.phase === 'finished' || (room.phase === 'playing' && room.mode === 'sprint') ? room.answer : null, roundScores: room.phase === 'results' || room.phase === 'finished' ? room.roundScores : {}, locked: room.locked, roundId: room.roundId };
}
export function joinRoom(room: Room, id: string, name: string, token: string, socketId: string, graceMs: number) {
  const n = cleanName(name);
  if (!n) throw Error('Choose a nickname.');
  const existing = room.seats.get(id);
  if (existing) {
    if (existing.tokenHash !== digest(token) || (existing.disconnectedAt && Date.now()-existing.disconnectedAt > graceMs)) throw Error('Reconnect link expired. Join with a new nickname.');
    existing.socketId = socketId; existing.connected = true; existing.disconnectedAt = null; existing.lastSeen = Date.now();
    const host=room.seats.get(room.hostId); if(!host?.connected){if(host)host.host=false;room.hostId=existing.id;existing.host=true;}
    return existing;
  }
  if (room.locked || room.phase !== 'lobby') throw Error('This room is locked or the game has already started.');
  if (room.seats.size >= 8) throw Error('This room is full (8 players max).');
  if ([...room.seats.values()].some(p=>p.name.toLowerCase()===n.toLowerCase())) throw Error('That nickname is already taken.');
  const p: Seat = { id, name:n, avatar:AVATARS[room.seats.size % AVATARS.length].emoji, score:0, connected:true, ready:false, host:false, lastSeen:Date.now(), tokenHash:digest(token), socketId, disconnectedAt:null };
  const host=room.seats.get(room.hostId); if(!host?.connected){if(host)host.host=false;room.hostId=p.id;p.host=true;}
  room.seats.set(id,p); return p;
}
export function startRound(room: Room, now=Date.now()) {
  room.phase = 'playing'; room.round++; room.roundId = randomUUID(); room.submissions.clear(); room.acceptedSprint.clear(); room.roundScores = {}; room.answer = null;
  room.mode = room.round % 2 ? 'unscramble' : 'sprint';
  const list = CATEGORIES[room.category] ?? CATEGORIES.Animals;
  if (room.mode === 'unscramble') {
    const words = list.filter(w=>w.length>=5); room.answer = words[randomBytes(2).readUInt16BE() % words.length];
    room.prompt = scrambled(room.answer); room.hint = `${room.category} · ${room.answer.length} letters`;
  } else {
    const initials = [...new Set(list.map(word => word[0].toUpperCase()))]; const starting = initials[randomBytes(1)[0] % initials.length]; room.prompt = `Name a ${room.category.toLowerCase()} word starting with ${starting}`; room.hint = `${room.category} · starts with ${starting}`; room.answer = starting;
  }
  room.deadline = now + 30_000;
}
export function submitAnswer(room: Room, playerId: string, raw: unknown, now=Date.now()) {
  if (room.phase !== 'playing' || !room.deadline || now >= room.deadline) throw Error('Time is up.');
  if (!room.roundId) throw Error('Round is not ready.');
  const player = room.seats.get(playerId); if (!player?.connected) throw Error('You are not in this room.');
  if (room.submissions.has(playerId)) throw Error('You already submitted this round.');
  if (typeof raw !== 'string' || raw.length > 40) throw Error('Answer must be 1–40 characters.');
  const answer = norm(raw); if (!answer || answer.length > 28) throw Error('Enter a valid word.');
  let correct: boolean;
  if (room.mode === 'unscramble') correct = answer === norm(room.answer ?? '');
  else {
    const words = (CATEGORIES[room.category] ?? []).map(norm);
    correct = answer.startsWith(norm(room.answer ?? '')) && words.includes(answer) && !room.acceptedSprint.has(answer);
  }
  if (correct && room.mode === 'sprint') room.acceptedSprint.add(answer);
  const points = correct ? 20 + (now <= (room.deadline - 20_000) ? 5 : 0) : 0;
  const row = { answer, at: now, correct, points }; room.submissions.set(playerId, row); player.score += points; room.roundScores[playerId] = points;
  return { correct, points, acceptedCount: room.submissions.size, // send only submitter's own feedback; never echo answer to other players
    feedback: correct ? `Nice! +${points}` : room.mode === 'unscramble' ? 'Not quite. Your answer is locked in.' : 'That word does not fit or was already accepted.' };
}
export function disconnectPlayer(room: Room, id: string, now=Date.now()) {
  const p = room.seats.get(id); if (!p) return;
  p.connected = false; p.disconnectedAt = now; p.socketId = null;
  if (room.hostId === id) {
    const next = [...room.seats.values()].find(x=>x.connected);
    if (next) { room.hostId = next.id; next.host = true; p.host = false; }
  }
}
