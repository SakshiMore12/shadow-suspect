# Shadow Suspect

A responsive, real-time multiplayer detective word game built with React + TypeScript and a Netlify Function API. Netlify Blobs stores the room state. The UI polls the function every two seconds so players on separate devices see updates.

## Gameplay

- 2–8 players, three rounds, one randomly selected undercover suspect per round.
- Detectives receive one word; the suspect receives a related word.
- Each player gets a 30-second clue turn, then the room has two minutes to discuss and 30 seconds to vote privately.
- If caught, the suspect gets 30 seconds for one final guess.
- Scoring: suspect escapes = +2 suspect points; caught and guesses the detective word = +3 suspect points; caught and misses/times out = +2 points for each detective.
- A tied vote gets one tie-break vote. A second tie means the suspect escapes.

## Requirements

- Node.js 20 or newer
- npm
- A Netlify account for deployed persistence
- Netlify CLI is included in the project dependencies for local end-to-end testing

## Run locally

```bash
npm ci
npm test
npm run build
```

The game API requires Netlify Functions and Blobs, so use the unified local server for API-backed testing:

```bash
netlify login
netlify link
npm run netlify:dev
```

Linking a Netlify site lets the local CLI use that site's Blobs environment. Do not use production rooms for testing; create a separate Netlify test site if possible.

## Deploy

1. Push this folder to a Git repository.
2. In Netlify, import the repository.
3. Build command: `npm run build`; publish directory: `dist`. `netlify.toml` already contains these values and points to `netlify/functions`.
4. Deploy. Netlify provisions the function; the app uses `/.netlify/functions/game` directly.
5. Open the deployed URL on two separate browsers/devices and test create, join, all phases, reconnect, scoring, and rematch.

## State and security notes

- The API generates a cryptographically random per-player session token. The browser stores it locally and sends it in an Authorization header; the server stores only its SHA-256 hash. Nickname alone cannot authenticate a player.
- Roles and secret words are not returned to other players before the round result. Votes are not exposed during the vote phase.
- Timers are checked by the server whenever a client polls or submits an action. They are not trusted to client-provided timestamps.
- Netlify Blobs is configured for strong consistency and the entire room is stored as one JSON object. This implementation serializes writes within a warm function instance, but the Blobs API does not provide a portable cross-instance compare-and-swap transaction in this code. Therefore, concurrent writes arriving at different function instances can still race. Treat this as a prototype, not a hardened competitive game backend; use a transactional database/atomic coordination service before relying on it for high-concurrency production play.
- This project has not been deployed from this environment. A public URL is intentionally not included.

## Commands

```bash
npm test
npm run build
npm run netlify:dev
```
