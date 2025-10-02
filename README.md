# Omegle Lite

Minimal anonymous 1-to-1 chat (Omegle-like) built with Node.js, Express, and Socket.IO.

## Features
- Anonymous, instant pairing of two users
- Next (skip) to find a new stranger
- Typing indicator
- Lightweight, no database required
- Single command to run locally or deploy

## Quick Start (Local)
```bash
npm install
npm start
# open http://localhost:3000
```

Open the site in two different browser windows to test chat.

## Deploy (Render/Railway/Heroku/Vercel)
- **Render/Railway**: Create a new Web Service from this repo. Build command: `npm install`. Start command: `npm start`.
- **Heroku**: Use the included `Procfile` and push.
- **Vercel**: Use a Node server. Set Build Command: `npm install`, Output: (leave blank), and Run Command: `npm start`.

## Project Structure
```text
/public          # Static frontend (HTML/CSS/JS)
server.js        # Express + Socket.IO backend and matchmaking
package.json     # Dependencies and scripts
```

## Environment
- Requires Node.js 18+
- Listens on `PORT` env var (falls back to 3000)

## Notes
- This demo stores no logs or messages server-side.
- For production, consider rate limiting, abuse filters, reporting, and TOS.
