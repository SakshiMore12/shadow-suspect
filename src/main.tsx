import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Player = { id:string; name:string; isHost:boolean; connected:boolean; score:number };
type Message = { id:string; playerId:string; name:string; text:string; at:number; kind:'clue'|'chat'|'system' };
type RoundResult = { caught:boolean; guessedCorrectly:boolean|null; suspectId:string; detectiveWord:string; suspectWord:string; points:Record<string,number>; message:string };
type RoomView = {
  code:string; phase:string; round:number; maxRounds:number; version:number; players:Player[]; isHost:boolean; selfId:string; role:'suspect'|'detective'|null; secretWord:string|null;
  suspectId:string|null; clueOrder:string[]; clueIndex:number; clues:Message[]; chat:Message[]; myVote:string|null; voteCounts:Record<string,number>; votesSubmitted:number; tieBreak:boolean;
  phaseEndsAt:number|null; guessDeadline:number|null; lastResult:RoundResult|null; roundHistory:Array<{round:number;suspectId:string;detectiveWord:string;suspectWord:string;caught:boolean;guessedCorrectly:boolean|null;points:Record<string,number>}>;
  leaderboard:Array<{id:string;name:string;score:number}>; connectedCount:number;
};
type ApiReply = { room?:RoomView; token?:string; playerId?:string; error?:string };
const TOKEN_KEY = 'shadow-suspect-token';
const ROOM_KEY = 'shadow-suspect-room';
const api = '/.netlify/functions/game';

function App() {
  const [screen, setScreen] = useState<'home'|'room'>('home');
  const [mode, setMode] = useState<'create'|'join'>('create');
  const [nickname, setNickname] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [token, setToken] = useState('');
  const [room, setRoom] = useState<RoomView|null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [guess, setGuess] = useState('');
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const [showRules, setShowRules] = useState(false);

  const request = useCallback(async (action:string, extra:Record<string,unknown> = {}):Promise<ApiReply> => {
    const response = await fetch(api, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ action, roomCode: room?.code ?? roomCode.toUpperCase(), token, ...extra }) });
    const data = await response.json() as ApiReply;
    if (!response.ok) throw new Error(data.error || 'Something went wrong.');
    if (data.room) setRoom(data.room);
    if (data.token) { setToken(data.token); localStorage.setItem(TOKEN_KEY, data.token); }
    if (data.room?.code) { setRoomCode(data.room.code); localStorage.setItem(ROOM_KEY, data.room.code); }
    return data;
  }, [room?.code, roomCode, token]);

  const sync = useCallback(async (code:string, authToken:string) => {
    try {
      const response = await fetch(`${api}?roomCode=${encodeURIComponent(code)}`, { cache:'no-store', headers:{authorization:`Bearer ${authToken}`} });
      const data = await response.json() as ApiReply;
      if (response.ok && data.room) { setRoom(data.room); setScreen('room'); setError(''); }
      else if (response.status === 401 || response.status === 404) { setError(data.error || 'Session could not be restored.'); }
    } catch { /* Temporary offline state: the next poll retries. */ }
  }, []);

  useEffect(() => {
    const savedToken = localStorage.getItem(TOKEN_KEY); const savedRoom = localStorage.getItem(ROOM_KEY);
    if (savedToken && savedRoom) { setToken(savedToken); setRoomCode(savedRoom); void sync(savedRoom, savedToken); }
  }, [sync]);

  useEffect(() => {
    if (screen !== 'room' || !room || !token) return;
    const timer = window.setInterval(() => { setNow(Date.now()); void sync(room.code, token); }, 2000);
    return () => window.clearInterval(timer);
  }, [screen, room?.code, token, sync]);

  const run = async (action:string, extra:Record<string,unknown> = {}) => {
    setBusy(true); setError('');
    try { await request(action, extra); setMessage(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  };

  const enter = async (e:React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const clean = nickname.trim(); if (clean.length < 2) throw new Error('Use a nickname with at least 2 characters.');
      if (mode === 'create') {
        const response = await fetch(api, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({action:'create',nickname:clean}) });
        const data = await response.json() as ApiReply; if (!response.ok || !data.room || !data.token) throw new Error(data.error || 'Could not create room.');
        setToken(data.token); localStorage.setItem(TOKEN_KEY,data.token); setRoomCode(data.room.code); localStorage.setItem(ROOM_KEY,data.room.code); setRoom(data.room); setScreen('room');
      } else {
        const code = roomCode.trim().toUpperCase(); if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('Room code must be 6 characters.');
        const response = await fetch(api, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({action:'join',roomCode:code,nickname:clean}) });
        const data = await response.json() as ApiReply; if (!response.ok || !data.room || !data.token) throw new Error(data.error || 'Could not join room.');
        setToken(data.token); localStorage.setItem(TOKEN_KEY,data.token); setRoomCode(data.room.code); localStorage.setItem(ROOM_KEY,data.room.code); setRoom(data.room); setScreen('room');
      }
    } catch(e) { setError(e instanceof Error ? e.message : 'Could not enter room.'); }
    finally { setBusy(false); }
  };

  const leaveToHome = async () => {
    try { await request('leave'); } catch { /* local exit still works */ }
    setRoom(null); setScreen('home'); setError(''); localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(ROOM_KEY); setToken(''); setRoomCode('');
  };
  const copyCode = async () => {
    if (!room) return;
    try { await navigator.clipboard.writeText(room.code); setCopied(true); window.setTimeout(()=>setCopied(false),1500); }
    catch { setError('Copy was blocked by the browser. You can select the room code and copy it.'); }
  };
  const sendChat = async (e:React.FormEvent) => { e.preventDefault(); if (!message.trim()) return; await run('chat',{text:message.trim()}); };
  const countdown = (deadline:number|null) => deadline ? Math.max(0,Math.ceil((deadline-now)/1000)) : null;
  const seconds = countdown(room?.phaseEndsAt ?? null);
  const currentClueId = room?.clueOrder[room.clueIndex];
  const canClue = room?.phase === 'clues' && currentClueId === room.selfId;
  const sortedPlayers = useMemo(() => room ? [...room.players].sort((a,b)=>b.score-a.score) : [], [room]);

  if (screen === 'home' || !room) return <main className="landing">
    <div className="topbar"><div className="brand"><span className="brand-mark">S<span>•</span></span><span>SHADOW<span className="brand-muted"> SUSPECT</span></span></div><button className="text-button" onClick={()=>setShowRules(!showRules)}>{showRules?'Hide rules':'How to play'} <span>↗</span></button></div>
    <section className="hero">
      <div className="hero-copy"><div className="eyebrow"><span className="pulse-dot"/> CASE FILE 001 · MULTIPLAYER</div><h1>Someone is<br/><span>lying.</span> Find them.</h1><p className="hero-sub">One undercover suspect. A room full of detectives. Two similar words. Trust your instincts — and question everything.</p>
        <div className="hero-stats"><div><strong>02–08</strong><span>PLAYERS</span></div><i/><div><strong>03</strong><span>ROUNDS</span></div><i/><div><strong>100%</strong><span>SUSPICION</span></div></div>
      </div>
      <div className="entry-card"><div className="card-kicker">YOUR NEXT CASE</div><h2>{mode==='create'?'Open a new case':'Join an investigation'}</h2><p className="muted">{mode==='create'?'Create a room, then bring your crew in.':'Got a room code? Enter the case.'}</p>
        <div className="mode-switch"><button className={mode==='create'?'active':''} onClick={()=>{setMode('create');setError('')}}>Create room</button><button className={mode==='join'?'active':''} onClick={()=>{setMode('join');setError('')}}>Join room</button></div>
        <form onSubmit={enter} className="entry-form"><label>DETECTIVE CODENAME<input autoComplete="nickname" maxLength={18} value={nickname} onChange={e=>setNickname(e.target.value)} placeholder="e.g. midnightowl" required minLength={2}/></label>
          {mode==='join' && <label>ROOM CODE<input className="code-input" maxLength={6} value={roomCode} onChange={e=>setRoomCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''))} placeholder="A7K2QX" required/></label>}
          <button className="primary-button" type="submit" disabled={busy}>{busy?'Opening case…':mode==='create'?'Create private room':'Enter the room'} <span>→</span></button>
        </form>{error && <p className="error-text">{error}</p>}<div className="privacy-note"><span>◇</span> Your role and secret word stay private.</div>
      </div>
    </section>
    {showRules && <section className="rules-panel"><div><span className="rule-number">01</span><b>Get your secret word</b><p>Detectives share a word. The suspect gets a related word.</p></div><div><span className="rule-number">02</span><b>Drop a clue</b><p>Everyone gives one short clue, then discuss the suspicious answers.</p></div><div><span className="rule-number">03</span><b>Vote in private</b><p>Catch the suspect — unless they can guess the detectives’ word.</p></div></section>}
    <footer className="landing-footer"><span>CONFIDENTIAL · EYES ONLY</span><span>BUILT FOR DISTANCE. PLAYED TOGETHER.</span></footer>
  </main>;

  const phaseTitle:Record<string,string> = {lobby:'Assemble your team',clues:'Leave a clue',discussion:'Interrogate the evidence',voting:'Choose your suspect',guess:'One last chance',roundResult:'Case debrief',finished:'Case closed'};
  const phaseLabel:Record<string,string> = {lobby:'LOBBY',clues:'CLUE PHASE',discussion:'OPEN DISCUSSION',voting:'PRIVATE VOTE',guess:'FINAL GUESS',roundResult:'ROUND REPORT',finished:'FINAL REPORT'};
  const myName = room.players.find(p=>p.id===room.selfId)?.name ?? 'Detective';
  const roundResult = room.lastResult;
  const suspectName = room.players.find(p=>p.id===roundResult?.suspectId)?.name ?? 'Unknown';
  return <main className="game-shell">
    <header className="game-header"><div className="brand"><span className="brand-mark">S<span>•</span></span><span>SHADOW<span className="brand-muted"> SUSPECT</span></span></div><div className="header-center"><span className="live-pill"><span className="pulse-dot"/>{room.phase==='lobby'?'ROOM OPEN':'CASE ACTIVE'}</span><span className="header-code">ROOM <b>{room.code}</b></span><button className="copy-mini" onClick={copyCode}>{copied?'COPIED ✓':'COPY CODE'}</button></div><button className="text-button" onClick={()=>setShowRules(!showRules)}>Rules <span>↗</span></button></header>
    {showRules && <section className="rules-panel in-game-rules"><div><span className="rule-number">01</span><b>One word, two versions</b><p>The suspect has a related word, not the same one.</p></div><div><span className="rule-number">02</span><b>Clue, discuss, vote</b><p>Clues take 30 seconds per player, discussion 2 minutes, vote 30 seconds.</p></div><div><span className="rule-number">03</span><b>Points matter</b><p>Suspect escapes: +2. Caught and guesses correctly: +3. Caught and fails: each detective +2.</p></div></section>}
    <div className="game-layout"><aside className="side-panel"><div className="panel-heading"><span>THE ROOM</span><span className="count-chip">{room.players.length}/8</span></div><div className="room-code-box"><small>CASE ACCESS CODE</small><strong>{room.code}</strong><button onClick={copyCode}>{copied?'Copied':'Copy invite code'} ↗</button></div><div className="player-list-title">INVESTIGATORS <span>{room.connectedCount} ONLINE</span></div><div className="player-list">{room.players.map((p,i)=><div className="player-row" key={p.id}><div className={`avatar avatar-${i%5}`}>{p.name.slice(0,1).toUpperCase()}</div><div className="player-meta"><b>{p.name}{p.id===room.selfId?' (you)':''}</b><small>{p.isHost?'ROOM HOST':room.phase==='lobby'?'READY':'IN THE CASE'}</small></div>{p.isHost&&<span className="host-star">✦</span>}{room.isHost&&!p.connected&&(room.phase==='lobby'||room.phase==='finished')&&<button className="remove-player" title={`Remove ${p.name}`} onClick={()=>void run('removePlayer',{targetId:p.id})}>×</button>}<strong className="player-score">{p.score}</strong></div>)}</div>
      {room.isHost && room.phase==='lobby' && <button className="primary-button start-button" disabled={busy||room.players.length<2} onClick={()=>void run('start')}>{room.players.length<2?'Waiting for players':'Start the case'} <span>→</span></button>}
      {room.phase==='lobby' && <div className="waiting-note"><span className="waiting-icon">⌁</span><p>{room.isHost?'Share the code with your friends. Start when everyone is in.':'You’re in. Wait for the host to start the case.'}</p></div>}
      <button className="exit-button" onClick={()=>void leaveToHome()}>← Leave room</button>
    </aside>
    <section className="main-panel"><div className="phase-top"><div><div className="eyebrow">{phaseLabel[room.phase] ?? 'CASE UPDATE'} <span className="eyebrow-line"/></div><h1>{phaseTitle[room.phase] ?? 'The investigation'}</h1></div>{room.phase!=='lobby'&&room.phase!=='finished'&&room.phase!=='roundResult'&&<div className={`timer ${seconds!==null&&seconds<10?'timer-warning':''}`}><span>TIME LEFT</span><strong>{String(Math.floor((seconds??0)/60)).padStart(2,'0')}:{String((seconds??0)%60).padStart(2,'0')}</strong></div>}</div>
      {room.phase==='lobby' && <div className="welcome-case"><div className="file-stamp">CASE FILE / 001</div><h2>Keep your friends close.<br/><em>Your clues closer.</em></h2><p>When the host starts the game, your role and secret word will appear here. Don’t show your screen to anyone.</p><div className="welcome-bottom"><span>WAITING FOR HOST AUTHORIZATION</span><span>02—08 PLAYERS</span></div></div>}
      {room.phase!=='lobby' && room.phase!=='finished' && <div className="secret-banner"><div className="secret-icon">◈</div><div><small>YOUR CLASSIFIED WORD</small><strong>{room.secretWord ?? '••••••••'}</strong></div><span className={room.role==='suspect'?'role-tag suspect-tag':'role-tag'}>{room.role==='suspect'?'UNDERCOVER SUSPECT':'DETECTIVE'}</span></div>}
      {room.phase==='clues' && <div className="action-card"><div className="action-card-head"><div><span className="step-chip">01 / 04</span><h3>Say something… not everything.</h3><p>Give one short clue connected to your secret word. Don’t say the word itself.</p></div><div className="clue-counter">{Math.min(room.clueIndex+1,room.clueOrder.length)}<span>/{room.clueOrder.length}</span></div></div>
        {canClue ? <form className="message-form" onSubmit={e=>{e.preventDefault();if(message.trim())void run('clue',{text:message.trim()});}}><input maxLength={100} value={message} onChange={e=>setMessage(e.target.value)} placeholder="Your clue goes here…"/><button className="primary-button" disabled={busy||!message.trim()}>Submit clue →</button></form> : <div className="turn-wait"><span className="spinner"/> Waiting for <b>{room.players.find(p=>p.id===currentClueId)?.name ?? 'the next player'}</b> to leave a clue.</div>}
      </div>}
      {room.phase==='discussion' && <div className="action-card"><span className="step-chip">02 / 04</span><h3>Compare the stories.</h3><p>Talk it out. Which clue felt off? Use chat to question each other before the private vote.</p><div className="discussion-callout">⌁ <span>Discussion closes automatically when the timer hits zero.</span></div></div>}
      {room.phase==='voting' && <div className="action-card"><span className="step-chip">03 / 04</span><h3>Who’s the undercover?</h3><p>Your vote is private. Pick the player whose clues don’t quite fit.</p>{room.role==='suspect'?<div className="turn-wait">You’re the suspect. Keep your cover — you can’t vote.</div>:room.myVote?<div className="turn-wait">Vote locked in. You voted for <b>{room.players.find(p=>p.id===room.myVote)?.name}</b>. Waiting for the others…</div>:<div className="vote-grid">{room.players.filter(p=>p.id!==room.selfId&&p.connected&&p.id!==room.suspectId).filter(p=>!room.tieBreak||room.clueOrder.includes(p.id)).map(p=><button className="vote-option" key={p.id} onClick={()=>void run('vote',{targetId:p.id})} disabled={busy}><span className="avatar avatar-2">{p.name.slice(0,1).toUpperCase()}</span><b>{p.name}</b><span>VOTE →</span></button>)}</div>}<div className="vote-status">{room.votesSubmitted} VOTES RECORDED <span>· RESULTS HIDDEN UNTIL REVEAL</span></div></div>}
      {room.phase==='guess' && <div className="action-card guess-card"><div className="guess-alert">⚠ SUSPECT IDENTIFIED</div><span className="step-chip">04 / 04</span><h3>Last chance to turn the tables.</h3><p>You were caught. Guess the detectives’ secret word within the timer. One guess, no second chances.</p>{room.role==='suspect'?<form className="message-form" onSubmit={e=>{e.preventDefault();if(guess.trim())void run('guess',{guess:guess.trim()});}}><input maxLength={100} value={guess} onChange={e=>setGuess(e.target.value)} placeholder="Guess the secret word…" autoComplete="off"/><button className="primary-button" disabled={busy||!guess.trim()}>Lock final guess →</button></form>:<div className="turn-wait">The suspect is making their final guess. Keep your word classified.</div>}</div>}
      {room.phase==='roundResult' && roundResult && <div className="result-card"><div className="result-icon">{roundResult.caught&&!roundResult.guessedCorrectly?'✓':roundResult.guessedCorrectly?'✦':'↗'}</div><div className="eyebrow">ROUND {room.round} REPORT</div><h2>{roundResult.message}</h2><p>The undercover was <b>{suspectName}</b>. The detectives’ word was <b>{roundResult.detectiveWord}</b>; the suspect’s word was <b>{roundResult.suspectWord}</b>.</p><div className="points-list">{room.players.map(p=><div key={p.id}><span>{p.name}</span><b>{roundResult.points[p.id] != null && roundResult.points[p.id] >= 0 ? '+':''}{roundResult.points[p.id] ?? 0} pts</b></div>)}</div>{room.isHost?<button className="primary-button" onClick={()=>void run('nextRound')}>{room.round>=room.maxRounds?'Reveal final leaderboard':'Start next round'} <span>→</span></button>:<div className="turn-wait">Waiting for the host to continue…</div>}</div>}
      {room.phase==='finished' && <div className="final-card"><div className="final-spark">✦</div><div className="eyebrow">FINAL CASE REPORT</div><h2>Case closed.</h2><p>Three rounds. Plenty of lies. Here’s who came out on top.</p><div className="final-leaderboard">{sortedPlayers.map((p,i)=><div className={`leader-row ${i===0?'leader-first':''}`} key={p.id}><span className="leader-rank">{String(i+1).padStart(2,'0')}</span><div className={`avatar avatar-${i%5}`}>{p.name.slice(0,1).toUpperCase()}</div><div className="leader-name"><b>{p.name}{p.id===room.selfId?' (you)':''}</b><small>{sortedPlayers.filter(x=>x.score===p.score).length>1&&p.score===sortedPlayers[0].score?'JOINT TOP SCORE':i===0?'TOP DETECTIVE':'INVESTIGATOR'}</small></div><strong>{p.score}<small> PTS</small></strong></div>)}</div><div className="round-summary"><b>ROUND-BY-ROUND</b>{room.roundHistory.map(r=><div key={r.round}><span>ROUND {r.round}</span><span>{room.players.find(p=>p.id===r.suspectId)?.name} was undercover</span><span>{r.caught?(r.guessedCorrectly?'WORD CRACKED':'CAUGHT'):'ESCAPED'}</span></div>)}</div>{room.isHost&&<button className="primary-button" onClick={()=>void run('playAgain')}>Play again <span>↻</span></button>}</div>}
      {room.phase!=='lobby' && <div className="feed-card"><div className="feed-heading"><div><span className="step-chip">LIVE FEED</span><h3>Case room chatter</h3></div><span className="feed-secure">◈ LIVE SYNC</span></div><div className="chat-feed">{room.chat.slice(-35).map(m=><div className={`chat-line ${m.kind==='system'?'system-line':''}`} key={m.id}><div className="chat-avatar">{m.kind==='system'?'✦':m.name.slice(0,1).toUpperCase()}</div><div className="chat-body"><div><b>{m.name}</b><time>{new Date(m.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time></div><p>{m.text}</p></div></div>)}{room.chat.length===0&&<div className="empty-feed">No messages yet. Silence can be suspicious.</div>}</div>{['clues','discussion','voting'].includes(room.phase)&&<form className="chat-compose" onSubmit={sendChat}><input maxLength={220} value={message} onChange={e=>setMessage(e.target.value)} placeholder="Send a message to the room…"/><button type="submit" disabled={busy||!message.trim()} aria-label="Send message">↑</button></form>}</div>}
    </section><aside className="evidence-panel"><div className="panel-heading"><span>CASE BOARD</span><span className="board-icon">⌘</span></div><div className="evidence-section"><small>ROUND</small><strong className="round-number">{String(room.round||1).padStart(2,'0')}<span> / {String(room.maxRounds).padStart(2,'0')}</span></strong><div className="round-track">{[1,2,3].map(n=><i key={n} className={n<room.round?'done':n===room.round?'current':''}/>)}</div></div><div className="evidence-section"><small>YOUR STATUS</small><div className="status-row"><span className={`status-light ${room.role==='suspect'?'danger-light':''}`}/><b>{room.role==='suspect'?'UNDERCOVER':'DETECTIVE'}</b></div><p>{room.role==='suspect'?'Blend in. Give a plausible clue. Avoid suspicion.':'Compare the clues. Find the player with the mismatched word.'}</p></div><div className="evidence-section"><small>CLUE BOARD</small>{room.clues.length?room.clues.map((c,i)=><div className="evidence-clue" key={c.id}><span>{String(i+1).padStart(2,'0')}</span><div><b>{c.name}</b><p>{c.text}</p></div></div>):<div className="empty-evidence">Clues will appear here as the team shares them.</div>}</div><div className="evidence-bottom"><span>◈</span><p>Keep it sharp. Keep it secret.<br/>Every detail is evidence.</p></div></aside></div>
    <footer className="game-footer"><span>SHADOW SUSPECT <b>·</b> CLASSIFIED</span><span>SESSION TOKEN PROTECTED</span><span>{myName.toUpperCase()} / PLAYER</span></footer>{error&&<div className="toast-error" role="alert">{error}<button onClick={()=>setError('')}>×</button></div>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
