# LeadGuard — Phase 1: Deterministic Core

Silent funnel-failure monitoring for marketing agencies.

This repo contains the **Phase 1 deterministic core**: the Playwright test runner, cron scheduler, and Postgres schema. No frontend, no LLM agents — just the reliable loop that proves a test journey can run and record results.

## Architecture

```
leadguard/
├── packages/
│   ├── db/          — Drizzle ORM schema, migrations, connection helper
│   ├── runner/      — Playwright test executor (browser automation)
│   └── scheduler/   — Cron-based job scheduler
├── samples/
│   ├── contact-form-journey.ts  — sample test script
│   └── seed.ts                  — seeds demo agency/site/journey
└── package.json     — workspaces root
```

### Data model

- **agencies** — agency accounts (name, email, stripe_customer_id, plan)
- **sites** — monitored sites (url, name, agency_id, plan, status)
- **journeys** — test journeys per site (name, type, playwright_script, schedule)
- **runs** — individual test executions (status, timing, screenshot, errors, diagnosis)
- **alerts** — alert records sent to agencies (severity, channel)

## Setup

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- A PostgreSQL database (set `DATABASE_URL`)
- Playwright browsers installed (`npx playwright install chromium`)

### Install

```bash
cd /home/team/shared/leadguard
bun install
npx playwright install chromium
```

### Database

```bash
# Generate migrations from schema
export DATABASE_URL="postgres://..."
bun run db:generate

# Run migrations
bun run db:migrate

# Or push schema directly (dev only)
bun run db:push
```

### Seed sample data

```bash
DATABASE_URL="postgres://..." bun run samples/seed.ts
```

This creates a demo agency, site, and journey that tests `https://example.com`.

## Running

### Run a single journey

```bash
DATABASE_URL="postgres://..." bun run packages/runner/src/index.ts --journey-id <uuid>
```

Exit codes:
- `0` — test passed
- `1` — test failed
- `2` — runner error / ambiguous

### Run the scheduler

```bash
DATABASE_URL="postgres://..." bun run scheduler
```

Env vars:
- `POLL_INTERVAL_SECONDS` — how often to check for due journeys (default: 30)
- `MAX_CONCURRENCY` — max concurrent runner processes (default: 5)

The scheduler:
1. Polls `journeys` for records where `next_run_at <= now` and `enabled = 1`
2. Spawns the runner as a child process for each due journey
3. Respects the concurrency limit
4. Logs all scheduling activity

## Writing test journeys

A journey script is the **body of an async function** that receives a `ctx` object:

```typescript
// ctx.page — Playwright Page (already navigated, browser is set up)
// ctx.consoleErrors — string[] (runner captures console errors automatically)
// ctx.networkLog — array (runner captures network responses automatically)

await ctx.page.goto('https://example.com/contact', { waitUntil: 'networkidle' });
await ctx.page.fill('#name', 'Test User');
await ctx.page.fill('#email', 'test@leadguard-test.dev');
await ctx.page.click('button[type="submit"]');
await ctx.page.waitForSelector('.success-message', { timeout: 5000 });
```

The runner handles:
- Browser launch and teardown
- Cookie consent banner dismissal
- Screenshot capture (full-page)
- Console error + network log collection
- Result recording in the database

**Do not** include the function wrapper, `import` statements, or browser setup — just the body.

## Design decisions

- **Dual driver**: Uses `postgres-js` for production (PostgreSQL) via `DATABASE_URL`. Drizzle ORM for type-safe queries and migrations.
- **Memory-conscious**: Runner is a CLI script, not a long-lived server. Each instance uses ~150MB. Concurrency cap of 5 keeps total under 1GB.
- **Cookie consent**: Auto-dismisses common banners (OneTrust, Cookiebot, generic patterns).
- **Test identities**: The `leadguard-test.dev` domain is reserved for test submissions. In production, test data should use clearly marked patterns to avoid polluting client CRMs.
- **Journey scripts are stored in the database** — not in the filesystem. This makes them dynamic (created by the onboarding agent in Phase 2) and versionable.
