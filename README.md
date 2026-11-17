# toro-hub-api

Hono sobre Cloudflare Workers. Plan: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

```sh
pnpm install
cp .dev.vars.example .dev.vars   # secrets locales
pnpm dev                         # http://localhost:8787  (/health, /openapi.json)
pnpm test                        # vitest dentro del runtime de Workers
pnpm typecheck
pnpm run deploy                  # secrets en prod: wrangler secret put TMDB_API_KEY …
```
