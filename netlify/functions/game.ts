import type { Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

type Phase = 'lobby' | 'clues' | 'discussion' | 'voting' | 'guess' | 'roundResult' | 'finished';
type Player = { id: string; name: string; tokenHash: string; isHost: boolean; connected: boolean; score: number; joinedAt: number; lastSeenAt: number };
type ChatMessage = { id: string; playerId: string; name: string; text: string; at: number; kind: 'clue' | 'chat' | 'system' };
type VoteMap = Record<string, string>;
type RoundRecord = { round: number; suspectId: string; detectiveWord: string; suspectWord: string; caught: boolean; guessedCorrectly: boolean | null; votes: Record<string, number>; points: Record<string, number> };
type Room = {
  code: string; createdAt: number; updatedAt: number; version: number; hostId: string; phase: Phase; round: number; maxRounds: number;
  players: Player[]; suspectId: string | null; detectiveWord: string | null; suspectWord: string | null; clueOrder: string[]; clueIndex: number;
  clues: ChatMessage[]; chat: ChatMessage[]; votes: VoteMap; voteCounts: Record<string, number>; guessDeadline: number | null;
  phaseEndsAt: number | null; voteAttempts: number; roundHistory: RoundRecord[]; lastResult: { caught: boolean; guessedCorrectly: boolean | null; suspectId: string; detectiveWord: string; suspectWord: string; points: Record<string, number>; message: string } | null;
  lastActivityAt: number;
};
type ActionBody = { action?: string; roomCode?: string; nickname?: string; token?: string; text?: string; targetId?: string; guess?: string };

const WORD_PAIRS: Array<[string, string]> = [
  ['Moon', 'Sun'], ['Coffee', 'Tea'], ['Ocean', 'Lake'], ['Castle', 'Palace'], ['Guitar', 'Violin'],
  ['Tiger', 'Lion'], ['Pizza', 'Burger'], ['Desert', 'Beach'], ['Train', 'Bus'], ['Doctor', 'Nurse'],
  ['Snow', 'Rain'], ['Library', 'Bookstore'], ['Eagle', 'Falcon'], ['Candle', 'Lantern'], ['Volcano', 'Mountain'],
  ['Cinema', 'Theatre'], ['Astronaut', 'Pilot'], ['Honey', 'Maple syrup'], ['Jungle', 'Forest'], ['Piano', 'Keyboard'],
  ['Camera', 'Binoculars'], ['River', 'Waterfall'], ['Robot', 'Android'], ['Diamond', 'Crystal'], ['Bicycle', 'Scooter']
];
const store = () => getStore({ name: 'shadow-suspect-rooms', consistency: 'strong' });
const randomToken = () => randomBytes(32).toString('base64url');
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = () => Array.from(randomBytes(6) as Uint8Array, (b: number) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const cleanName = (s: unknown) => typeof s === 'string' ? s.trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 18) : '';
const cleanText = (s: unknown, max = 220) => typeof s === 'string' ? s.trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, max) : '';
const safeEqual = (a: string, b: string) => {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const fail = (message: string, status = 400) => json({ error: message }, status);
const logRequestError = (context: string, error: unknown) => {
  const details = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error;
  console.error('[shadow-suspect-game]', context, details);
};

async function readRoom(roomCode: string): Promise<Room | null> {
  try {
    const entry = await store().getWithMetadata(roomCode, { type: 'json' });
    if (!entry?.data) return null;
    return entry.data as Room;
  } catch { return null; }
}
async function writeRoom(room: Room): Promise<void> {
  room.updatedAt = Date.now(); room.lastActivityAt = Date.now(); room.version += 1;
  await store().setJSON(room.code, room);
}
const roomQueues = new Map<string, Promise<unknown>>();
async function withRoomLock(roomCode: string, task: () => Promise<Response>): Promise<Response> {
  const previous = roomQueues.get(roomCode) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => current);
  roomQueues.set(roomCode, queued);
  await previous;
  try { return await task(); } finally { release(); if (roomQueues.get(roomCode) === queued) roomQueues.delete(roomCode); }
}
async function authenticate(room: Room, token: string | undefined): Promise<Player | null> {
  if (!token) return null;
  const hash = await hashToken(token);
  const player = room.players.find(p => safeEqual(p.tokenHash, hash));
  return player ?? null;
}
function publicRoom(room: Room, viewer: Player) {
  const reveal = room.phase === 'roundResult' || room.phase === 'finished';
  return {
    code: room.code, phase: room.phase, round: room.round, maxRounds: room.maxRounds, version: room.version,
    players: room.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, connected: p.connected, score: p.score })),
    isHost: viewer.isHost, selfId: viewer.id,
    role: room.suspectId ? (room.suspectId === viewer.id ? 'suspect' : 'detective') : null,
    secretWord: room.phase === 'lobby' ? null : room.suspectId === viewer.id ? room.suspectWord : room.detectiveWord,
    suspectId: reveal ? room.suspectId : null,
    clueOrder: room.clueOrder, clueIndex: room.clueIndex,
    clues: room.clues.map(({ id, playerId, name, text, at }) => ({ id, playerId, name, text, at })),
    chat: room.chat.slice(-100).map(({ id, playerId, name, text, at, kind }) => ({ id, playerId, name, text, at, kind })),
    myVote: room.votes[viewer.id] ?? null, voteCounts: room.phase === 'roundResult' || room.phase === 'finished' ? room.voteCounts : {},
    votesSubmitted: Object.keys(room.votes).length, tieBreak: room.voteAttempts > 0, phaseEndsAt: room.phaseEndsAt, guessDeadline: room.guessDeadline,
    lastResult: room.lastResult, roundHistory: room.roundHistory,
    leaderboard: [...room.players].sort((a,b) => b.score - a.score).map(p => ({ id:p.id, name:p.name, score:p.score })),
    connectedCount: room.players.filter(p => p.connected).length,
  };
}
function addSystem(room: Room, text: string) {
  room.chat.push({ id: randomBytes(8).toString('hex'), playerId: 'system', name: 'CASE DISPATCH', text, at: Date.now(), kind: 'system' });
}
function transition(room: Room, phase: Phase, seconds: number | null) {
  room.phase = phase; room.phaseEndsAt = seconds === null ? null : Date.now() + seconds * 1000;
}
function beginRound(room: Room) {
  const active = room.players.filter(p => p.connected);
  if (active.length < 2) throw new Error('At least two connected players are needed.');
  room.suspectId = active[randomInt(active.length)].id;
  const pair = WORD_PAIRS[randomInt(WORD_PAIRS.length)];
  const flip = randomInt(2) === 1;
  room.detectiveWord = pair[flip ? 1 : 0]; room.suspectWord = pair[flip ? 0 : 1];
  room.clueOrder = [...active].sort((a,b) => a.joinedAt - b.joinedAt).map(p => p.id);
  room.clueIndex = 0; room.clues = []; room.votes = {}; room.voteCounts = {}; room.voteAttempts = 0; room.lastResult = null; room.guessDeadline = null;
  transition(room, 'clues', 30);
  addSystem(room, `Round ${room.round} is live. Give one short clue each. Keep your word classified.`);
}
function currentCluePlayer(room: Room) { return room.clueOrder[room.clueIndex] ?? null; }
function resolveVote(room: Room) {
  const connected = room.players.filter(p => p.connected);
  const counts: Record<string, number> = {};
  for (const target of Object.values(room.votes)) counts[target] = (counts[target] ?? 0) + 1;
  room.voteCounts = counts;
  const highest = Math.max(0, ...Object.values(counts));
  const leaders = Object.entries(counts).filter(([, n]) => n === highest && highest > 0).map(([id]) => id);
  if (leaders.length !== 1) {
    // One tie-break vote; a second tie means the suspect escapes.
    if (room.voteAttempts >= 1) { finishRound(room, false, null); return; }
    room.voteAttempts += 1; room.votes = {}; room.voteCounts = {};
    room.chat.push({ id: randomBytes(8).toString('hex'), playerId:'system', name:'CASE DISPATCH', text:'The vote is tied. Tie-break vote: choose only among the tied suspects. A second tie means the suspect escapes.', at:Date.now(), kind:'system' });
    room.clueOrder = leaders.length ? leaders : connected.map(p => p.id);
    transition(room, 'voting', 30); return;
  }
  const accused = leaders[0];
  if (accused === room.suspectId) {
    room.guessDeadline = Date.now() + 30000;
    transition(room, 'guess', 30);
    addSystem(room, 'The suspect has been identified. They have 30 seconds to guess the detectives’ word.');
  } else {
    finishRound(room, false, null);
  }
}
function finishRound(room: Room, caught: boolean, guessedCorrectly: boolean | null) {
  const suspectId = room.suspectId!;
  const points: Record<string, number> = {};
  for (const p of room.players) {
    let earned = 0;
    if (p.id === suspectId) earned = !caught ? 2 : guessedCorrectly ? 3 : 0;
    else earned = caught && !guessedCorrectly ? 2 : 0;
    p.score += earned; points[p.id] = earned;
  }
  const message = !caught ? 'The suspect escaped detection.' : guessedCorrectly ? 'Caught — but the suspect cracked the secret word!' : 'Case closed. The suspect was caught and failed the final guess.';
  room.lastResult = { caught, guessedCorrectly, suspectId, detectiveWord: room.detectiveWord!, suspectWord: room.suspectWord!, points, message };
  room.roundHistory.push({ round: room.round, suspectId, detectiveWord: room.detectiveWord!, suspectWord: room.suspectWord!, caught, guessedCorrectly, votes: { ...room.voteCounts }, points: { ...points } });
  transition(room, 'roundResult', null); room.guessDeadline = null;
  addSystem(room, message);
}
function expirePhase(room: Room): boolean {
  if (!room.phaseEndsAt || Date.now() < room.phaseEndsAt) return false;
  if (room.phase === 'clues') {
    // A missed turn advances without allowing a client to control the clock.
    room.clueIndex += 1;
    if (room.clueIndex >= room.clueOrder.length) { transition(room, 'discussion', 120); addSystem(room, 'Clue phase ended. Discuss the evidence, then vote.'); }
    else { transition(room, 'clues', 30); addSystem(room, 'A clue turn timed out. The next player is up.'); }
  } else if (room.phase === 'discussion') {
    transition(room, 'voting', 30); room.votes = {}; room.voteCounts = {}; addSystem(room, 'Discussion ended. Cast your private vote.');
  } else if (room.phase === 'voting') {
    resolveVote(room);
  } else if (room.phase === 'guess') {
    finishRound(room, true, false);
  }
  return true;
}

export default async (request: Request, _context: Context) => {
  try {
    if (request.method === 'GET') {
      const url = new URL(request.url); const roomCode = (url.searchParams.get('roomCode') ?? '').toUpperCase(); const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (!/^[A-Z0-9]{6}$/.test(roomCode)) return fail('Enter a valid 6-character room code.');
      return withRoomLock(roomCode, async () => {
        const room = await readRoom(roomCode); if (!room) return fail('Room not found. Ask the host for a new code.', 404);
        const player = await authenticate(room, token); if (!player) return fail('This session token is not valid for this room. Rejoin with the original device.', 401);
        const expired = expirePhase(room); const now = Date.now(); let presenceChanged = false;
        for (const other of room.players) {
          if (other.id !== player.id && other.connected && now - other.lastSeenAt > 15000) { other.connected = false; presenceChanged = true; }
        }
        const reconnected = !player.connected; player.connected = true;
        const heartbeatDue = now - player.lastSeenAt > 6000; if (heartbeatDue) player.lastSeenAt = now;
        if (expired || reconnected || presenceChanged || heartbeatDue) await writeRoom(room);
        return json({ room: publicRoom(room, player) });
      });
    }
    if (request.method !== 'POST') return fail('Use GET to sync the room or POST to perform an action.', 405);
    let body: ActionBody;
    try { body = await request.json() as ActionBody; } catch { return fail('Request body must be valid JSON.'); }
    const action = body.action;
    if (action === 'create') {
      const nickname = cleanName(body.nickname); if (nickname.length < 2) return fail('Nickname must be at least 2 characters.');
      let roomCode = code(); let room = await readRoom(roomCode);
      for (let i=0; room && i<5; i++) { roomCode = code(); room = await readRoom(roomCode); }
      if (room) return fail('Could not create a unique room. Try again.', 503);
      const token = randomToken(); const id = randomBytes(8).toString('hex'); const now = Date.now();
      const player: Player = { id, name: nickname, tokenHash: await hashToken(token), isHost: true, connected: true, score: 0, joinedAt: now, lastSeenAt: now };
      const created: Room = { code:roomCode, createdAt:now, updatedAt:now, version:1, hostId:id, phase:'lobby', round:0, maxRounds:3, players:[player], suspectId:null, detectiveWord:null, suspectWord:null, clueOrder:[], clueIndex:0, clues:[], chat:[], votes:{}, voteCounts:{}, guessDeadline:null, phaseEndsAt:null, voteAttempts:0, roundHistory:[], lastResult:null, lastActivityAt:now };
      await store().setJSON(roomCode, created);
      return json({ room: publicRoom(created, player), token, playerId:id }, 201);
    }
    const roomCode = (body.roomCode ?? '').toUpperCase(); if (!/^[A-Z0-9]{6}$/.test(roomCode)) return fail('Enter a valid 6-character room code.');
    return withRoomLock(roomCode, async () => {
      const room = await readRoom(roomCode); if (!room) return fail('Room not found. Ask the host for a new code.', 404);
      if (action === 'join' && !body.token) {
        if (room.phase !== 'lobby' && room.phase !== 'finished') return fail('This case has started. New players cannot join until the match ends.');
        if (room.players.length >= 8) return fail('This room is full (maximum 8 players).');
        const nickname = cleanName(body.nickname); if (nickname.length < 2) return fail('Nickname must be at least 2 characters.');
        if (room.players.some(p => p.name.toLowerCase() === nickname.toLowerCase())) return fail('That nickname is already taken in this room.');
        const token = randomToken(); const id = randomBytes(8).toString('hex');
        const newPlayer: Player = { id, name:nickname, tokenHash:await hashToken(token), isHost:false, connected:true, score:0, joinedAt:Date.now(), lastSeenAt:Date.now() };
        room.players.push(newPlayer); await writeRoom(room); return json({ room:publicRoom(room, newPlayer), token, playerId:id }, 201);
      }
      const player = await authenticate(room, body.token); if (!player) return fail('Invalid session token. Nickname alone cannot restore a player.', 401);
      const now = Date.now(); for (const other of room.players) if (other.id !== player.id && other.connected && now - other.lastSeenAt > 15000) other.connected = false;
      player.connected = true; if (now - player.lastSeenAt > 6000) player.lastSeenAt = now;
      expirePhase(room);
      if (action === 'join') { player.connected = true; await writeRoom(room); return json({ room:publicRoom(room, player) }); }
      if (action === 'leave') { player.connected = false; await writeRoom(room); return json({ room:publicRoom(room, player) }); }
      if (action === 'start') {
        if (!player.isHost) return fail('Only the host can start the case.', 403);
        if (room.phase !== 'lobby') return fail('The match has already started.');
        if (room.players.filter(p => p.connected).length < 2) return fail('At least two connected players are needed.');
        if (room.players.length > 8) return fail('A room can have no more than 8 players.');
        room.players.forEach(p => { p.score = 0; }); room.round = 1; room.roundHistory = []; beginRound(room); await writeRoom(room); return json({ room:publicRoom(room, player) });
      }
      if (action === 'addPlayer') {
        // The join flow is intentionally separate so a new token is minted only for a new player.
        return fail('Use the Join Room screen to add a new player.', 400);
      }
      if (action === 'clue') {
        if (room.phase !== 'clues') return fail('Clues are closed for this phase.');
        if (currentCluePlayer(room) !== player.id) return fail('Wait for your turn to give a clue.');
        const text = cleanText(body.text, 100); if (!text) return fail('Enter a short clue first.');
        room.clues.push({ id:randomBytes(8).toString('hex'), playerId:player.id, name:player.name, text, at:Date.now(), kind:'clue' });
        room.chat.push(room.clues[room.clues.length-1]); room.clueIndex += 1;
        if (room.clueIndex >= room.clueOrder.length) { transition(room, 'discussion', 120); addSystem(room, 'Everyone has given a clue. Discussion is open for 2 minutes.'); }
        else { transition(room, 'clues', 30); }
        await writeRoom(room); return json({ room:publicRoom(room, player) });
      }
      if (action === 'chat') {
        if (!['clues','discussion','voting'].includes(room.phase)) return fail('Chat is not available right now.');
        const text = cleanText(body.text, 220); if (!text) return fail('Message cannot be empty.');
        room.chat.push({ id:randomBytes(8).toString('hex'), playerId:player.id, name:player.name, text, at:Date.now(), kind:'chat' });
        await writeRoom(room); return json({ room:publicRoom(room, player) });
      }
      if (action === 'vote') {
        if (room.phase !== 'voting') return fail('Voting is not open.');
        if (player.id === room.suspectId) return fail('The suspect cannot vote.');
        const target = room.players.find(p => p.id === body.targetId && p.connected);
        if (!target || target.id === player.id) return fail('Choose another active player.');
        if (room.voteAttempts > 0 && !room.clueOrder.includes(target.id)) return fail('Tie-break votes must target one of the tied suspects.');
        if (room.votes[player.id]) return fail('Your vote has already been recorded.');
        if (room.clueOrder.length && !room.clueOrder.includes(target.id) && !room.players.some(p=>p.id===target.id)) return fail('Invalid target.');
        room.votes[player.id] = target.id;
        const eligible = room.players.filter(p => p.connected && p.id !== room.suspectId);
        if (eligible.every(p => room.votes[p.id])) resolveVote(room);
        await writeRoom(room); return json({ room:publicRoom(room, player) });
      }
      if (action === 'guess') {
        if (room.phase !== 'guess' || player.id !== room.suspectId) return fail('Only the caught suspect can make the final guess.');
        const guess = cleanText(body.guess, 100); if (!guess) return fail('Enter your final guess.');
        const correct = guess.localeCompare(room.detectiveWord!, undefined, { sensitivity:'accent' }) === 0 || guess.toLowerCase() === room.detectiveWord!.toLowerCase();
        finishRound(room, true, correct); await writeRoom(room); return json({ room:publicRoom(room, player) });
      }
      if (action === 'nextRound') {
        if (!player.isHost) return fail('Only the host can continue.');
        if (room.phase !== 'roundResult') return fail('This round has not finished.');
        if (room.round >= room.maxRounds) { transition(room, 'finished', null); addSystem(room, 'All three rounds are complete. The final leaderboard is ready.'); }
        else { room.round += 1; beginRound(room); }
        await writeRoom(room); return json({ room:publicRoom(room, player) });
      }
      if (action === 'playAgain') {
        if (!player.isHost) return fail('Only the host can start a rematch.');
        if (room.phase !== 'finished') return fail('Finish all three rounds before a rematch.');
        room.players.forEach(p => p.score = 0); room.round = 1; room.roundHistory = []; room.lastResult = null; beginRound(room); await writeRoom(room); return json({ room:publicRoom(room, player) });
      }
      if (action === 'removePlayer') {
        if (!player.isHost) return fail('Only the host can remove a player.', 403);
        if (room.phase !== 'lobby' && room.phase !== 'finished') return fail('Players can only be removed between matches.');
        const target = room.players.find(p => p.id === body.targetId);
        if (!target || target.id === player.id) return fail('Choose another player.');
        room.players = room.players.filter(p => p.id !== target.id); await writeRoom(room); return json({ room:publicRoom(room, player) });
      }
      return fail('Unknown action.');
    });
  } catch (error) {
    logRequestError('Unhandled request failure', error);
    return json({ error: 'The game server is unavailable. Start the Netlify backend and confirm the site is linked for Netlify Blobs.' }, 500);
  }
};
