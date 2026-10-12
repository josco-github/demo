# Quick Quest: Word Arena

A room-code word game for 2–8 players. The browser is a React/Vite client; an Express + Socket.IO process owns each room's canonical state, validates submissions, scores answers, and advances rounds. The client synchronizes its countdown to the server's absolute deadline. There are no player accounts.

## Local setup

Requirements: Node.js 20+ and npm.

```sh
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:5173` in two browser windows/devices. Create a room in one, share its five-character code, then join from the other. Each player chooses a nickname and marks ready; the host starts the match. `npm run dev` runs the client on port 5173 and the Socket.IO server on port 3001. The server health endpoint is `http://localhost:3001/health`.

In production the client and Socket.IO server are served from one origin. For a split frontend/server deployment, set `VITE_SERVER_URL=https://your-api-host` when building and set `CLIENT_ORIGIN` on the server to the exact comma-separated list of allowed browser origins.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP and Socket.IO server port |
| `CLIENT_ORIGIN` | Koyeb or Render hostname when deployed; otherwise `http://localhost:5173` | Allowed browser origin(s), comma-separated |
| `ROOM_TTL_MS` | `21600000` | Room lifetime / empty-room cleanup horizon (6 hours) |
| `RECONNECT_GRACE_MS` | `60000` | Time allowed to restore a disconnected seat |
| `VITE_SERVER_URL` | `http://<current-host>:3001` | Optional client build-time server origin |
| `KOYEB_PUBLIC_DOMAIN` | Set by Koyeb for GitHub deployments | Used automatically to allow the app's own browser origin |
| `RENDER_EXTERNAL_HOSTNAME` | Set by Render | Used for the deployed app's HTTPS origin; do not set manually |

## Game and state model

The server keeps rooms in memory. A room has a lobby, a playing phase, a results phase, then a finished phase. It stores the roster and scores, current round ID, a server-generated deadline, private answer key, submissions, accepted Category Sprint words, and host ID. Public snapshots omit the Unscramble key during play. A five-character room code is generated server-side, and collisions are checked before reserving it. Room joins and creations are rate-limited by connecting IP; input sizes, nicknames, room size, host actions, and event phase are checked on the server.

Unscramble accepts case-insensitive letters after Unicode decomposition and removal of non-ASCII letters; its target must exactly equal the canonical word. Category Sprint currently validates against a small curated category word list and rejects a word accepted earlier that round. Each player may submit one answer per round. A correct answer scores 3, with +1 for submission in the first 10 seconds. Similar answers score 2, with +1 for an answer in the first 10 seconds. Each round lasts 20 seconds. Incorrect answers score zero. Ties sort by total score and then nickname alphabetically.

Reconnect credentials are random 256-bit client-generated bearer secrets; only a SHA-256 digest is held in server memory. The browser stores its credential and room code in local storage so a refresh can restore the seat. Never share your browser profile with someone you do not trust. Credentials and room data disappear when the process restarts; there is no database, Redis, analytics, or account system in this MVP. A seat is removed after the 60-second grace period. Empty rooms expire after the configured cleanup period. This is a lightweight game, not a service with audited privacy guarantees.

## Checks

Run the game-logic tests with `npm test`, the production client build with `npm run build`, and the two-browser scenario with `npm run test:e2e`. The unit suite covers normalization, score boundaries, duplicate answers, server deadlines, curated Sprint validation, and hidden answer state. The browser test uses two separate contexts and checks shared room state, answer privacy, refresh reconnection, and host transfer.

Validation in this workspace: a direct Node.js game-engine smoke check passed for nickname sanitation, room capacity, hidden Unscramble key, correct scoring and normalization, one submission per player, deadline enforcement, duplicate Sprint words, and host transfer. The full npm test suite, production build, browser test, and live-server checks have **not** run: dependency installation failed because Node's asynchronous `realpath` returns `EPERM` for the project directory in this environment. No test result is inferred from the smoke check.

## Deploy to Render

The included `render.yaml` configures a single Node web service. It builds the Vite client into `dist/`, serves those files from Express, and attaches Socket.IO to the same HTTP server so the browser uses one HTTPS origin. Push this project to a Git repository, connect that repository in Render, then create the service from the Blueprint. Render sets `PORT`; the app binds to `0.0.0.0`. `RENDER_EXTERNAL_HOSTNAME` is used to allow the app's own browser origin. Verify `https://<service>.onrender.com/health`, then test a full match from two independent devices. Keep production secrets in Render's server-side environment. Render's free web services can spin down after inactivity; the current room state is in memory and disappears if the service restarts.

No repository, hosting account, production service, or live URL is configured by this source tree yet.

## Deploy to Koyeb

Create a free Web Service from the public GitHub repository `josco-github/demo`, select the `codex/quickquest-render` branch, and set the work directory to `quickquest`. Use the Node.js buildpack with build command `npm install && npm run build` and run command `npm start`. Expose the service's `PORT` as public HTTP on `/`, and choose the free instance in Washington, D.C. or Frankfurt. Koyeb sets `PORT` and `KOYEB_PUBLIC_DOMAIN`; the server uses the latter for Socket.IO's same-origin checks. The free instance scales to zero after inactivity, and all room state is in memory, so rooms are lost if the service restarts.

## Demo script

1. Open the deployed app on two devices, create a room on device A, and join its code on device B.
2. Mark both players ready and start the match from A.
3. Answer one Unscramble quickly to show the speed bonus, then submit one wrong answer from the other player.
4. Let the Category Sprint round start; show that a valid word gets accepted and an already accepted word is rejected.
5. Refresh a player's browser to demonstrate seat reconnection, then finish the match and compare both leaderboards.

## Current limits

The first release keeps room state in one process, so restarting the server clears rooms and horizontal scaling requires shared storage plus a Socket.IO adapter. Sprint validation is deliberately limited to the curated dictionary. The game alternates modes and currently has seven categories: Animals, Food, Nature, Objects, Places, Travel, and Sports. Multi-instance persistence, a broad dictionary, and hosted deployment are follow-up work.
