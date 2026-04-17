# Public Deployment

This app is ready to run behind a real HTTPS domain. The recommended setup is:

- reverse proxy with TLS (`Nginx`, `Caddy`, `Cloudflare Tunnel`, `Render`, `Railway`, `VPS`)
- Node process running `server.js`
- a strict `ALLOWED_ORIGINS` value matching your real frontend domain

## 1. Environment

Copy `.env.example` to `.env` and set the production values:

```env
PORT=3000
HOST=0.0.0.0
VAL_REGION=ap
ALLOWED_ORIGINS=https://your-domain.com,https://www.your-domain.com
TRUST_PROXY=true
```

Notes:

- `ALLOWED_ORIGINS` should be your real public site origin only
- `TRUST_PROXY=true` is recommended when you are behind `Nginx`, `Caddy`, or a platform proxy
- do not enable `VAL_USER` / `VAL_PASS` unless you intentionally need server-side fallback auth

## 2. Install and run

```powershell
npm install
npm run start
```

The app will listen on `HOST:PORT`.

## 3. Reverse proxy

Put the Node app behind HTTPS. The domain should proxy to:

- `http://127.0.0.1:3000`

Make sure your proxy forwards:

- `Host`
- `X-Forwarded-Proto`
- `X-Forwarded-For`

## 4. Recommended domain model

Use one domain for both frontend and backend, for example:

- `https://your-domain.com`

That is the simplest and safest configuration because:

- static files and API come from the same origin
- `ALLOWED_ORIGINS` can stay tight
- browser login flow is easier to reason about

## 5. What to avoid

- do not expose `.env`
- do not share pasted Riot redirect URLs between users
- do not leave `ALLOWED_ORIGINS` empty in public production unless you truly want open browser access
- do not deploy over plain HTTP for internet-facing use

## 6. Quick checklist

- domain is on HTTPS
- `ALLOWED_ORIGINS` matches that domain
- `TRUST_PROXY=true` if behind a proxy
- app starts with `npm run start`
- footer legal pages are reachable:
  - `/privacy.html`
  - `/terms.html`
  - `/copyright.html`
