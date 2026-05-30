# Production Hardening: Wallet/Nonce Persistence, Twilio Security, and Dockerfile

## Summary

- closes #102 — Persist custodial wallets in Postgres (removes in-memory `walletStore`)
- closes #103 — Move auth nonces to Postgres for multi-instance auth
- closes #112 — Enforce Twilio webhook signature validation in all environments
- closes #104 — Add production Dockerfile and deployment runbook

## Changes per issue

### closes #102 — Custodial wallet DB persistence

**Problem:** `src/stellar/wallet.ts` stored encrypted secrets in a module-level `Map`. Restarts wiped all wallets; horizontal scaling was impossible.

**Fix:**
- Added `CustodialWallet` Prisma model (`userId` unique, `publicKey` unique, `encryptedSecret`/`iv`/`authTag` columns)
- New migration: `prisma/migrations/20260529000001_add_custodial_wallets/`
- Rewrote `createCustodialWallet`, `getWalletByUserId`, `getKeypairForUser`, and `listWallets` to read/write `db.custodialWallet`
- 9 unit tests covering create, duplicate prevention, read, keypair decrypt round-trip, and simulated restart persistence

**Key rotation / backup:** rotate `WALLET_ENCRYPTION_KEY` by re-encrypting all `custodial_wallets` rows with the new key before swapping the env var. The database is the authoritative backup — losing the key makes wallets unrecoverable.

---

### closes #103 — Auth nonces in Postgres

**Problem:** `stellar-verification.ts` stored challenge nonces in an in-memory `Map`. Rolling deploys and multiple app instances broke `/api/auth/verify`.

**Fix:**
- Added `AuthNonce` Prisma model (`stellarPubKey` unique, `expiresAt` indexed for cleanup)
- New migration: `prisma/migrations/20260529000002_add_auth_nonces/`
- `StellarVerification` class is now stateless (no nonce map)
- `challenge()` upserts nonces via `db.authNonce`; expired rows are pruned lazily
- `verify()` reads/deletes nonces from DB — expiry check and replay prevention are preserved
- Auth unit tests updated to mock `db.authNonce` instead of the in-memory store; added cross-instance test

---

### closes #112 — Twilio webhook signature validation

**Problem:** `src/routes/whatsapp.ts` skipped `validateRequest` when `NODE_ENV !== 'production'`, allowing spoofed requests on staging/dev.

**Fix:**
- Signature validation now runs whenever `TWILIO_AUTH_TOKEN` is set, regardless of `NODE_ENV`
- Returns `403` immediately if `TWILIO_AUTH_TOKEN` is absent — no silent skip
- Added `TWILIO_AUTH_TOKEN` to the required-vars list in `src/config/env.ts`
- Added fail-fast check in `src/index.ts` `initServices()` so the server refuses to start without the token
- 5 unit tests: no-token 403, invalid-signature staging, invalid in development, valid happy path, env-agnostic enforcement

---

### closes #104 — Production Dockerfile and deployment runbook

**Added:**
- **`Dockerfile`** — multi-stage build: `node:20-alpine` builder (`npm ci` → `prisma generate` → `tsc` → prod-only deps), then slim runtime image running as non-root `app` user; CMD runs `prisma migrate deploy && node dist/index.js`
- **`.dockerignore`** — excludes `node_modules`, `dist`, `.env*`, logs, tests, docs
- **`docs/PRODUCTION_DEPLOYMENT.md`** — new sections covering:
  - Build/push commands
  - Minimum required env vars (`NODE_ENV=production`, `CORS_ORIGINS`, `WALLET_ENCRYPTION_KEY`, `ADMIN_API_TOKEN`, `TWILIO_AUTH_TOKEN`, etc.)
  - `prisma migrate deploy` as pre-start step; Kubernetes initContainer pattern
  - Health/readiness probe table (`GET /health/live` liveness, `GET /health/ready` readiness 200/503) with Kubernetes and ALB examples
  - Key rotation and backup expectations for `WALLET_ENCRYPTION_KEY`, `JWT_SEED`, and auth nonces

## Test plan

- [ ] `npx jest tests/unit/stellar/wallet.test.ts` — 9 tests pass
- [ ] `npx jest src/controllers/__tests__/auth.test.ts` — all auth tests pass
- [ ] `npx jest tests/unit/whatsapp/webhook.test.ts` — 5 tests pass
- [ ] `docker build -t neurowealth-backend .` completes without error
- [ ] `GET /health/live` returns 200 after startup
- [ ] `GET /health/ready` returns 503 before DB connects, 200 after all services ready
- [ ] Starting without `TWILIO_AUTH_TOKEN` set fails fast with a clear error message
- [ ] POST `/api/whatsapp/webhook` with a bad signature returns 403 in all `NODE_ENV` values

🤖 Generated with [Claude Code](https://claude.com/claude-code)
