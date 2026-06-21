# Stage 04 — Accounts & Auth

> **Status:** Planned. **Depends on:** Stage 01 (anonymous identity + bearer scheme).
> Independent of Stages 02/03 — can slot earlier if a multi-user/shareable demo
> is needed sooner.
> **Goal:** upgrade anonymous/device identity to real accounts **without
> disrupting the anonymous-first low-friction flow.**

Realizes architecture **01 §3.2** (auth) and **01 §8.3** (identity-scoped limits).

## Design principle

Anonymous-first stays. A device user can do everything in Stage 1 with no
account. An account is an *upgrade* that **claims** the existing anonymous user's
carts/orders/history — the `user` row persists, the auth method attached to it
changes. Because Stage 1 issued bearer tokens under the same scheme accounts will
use, this is "swap the token issuer," not a re-plumb.

## Scope

- **Account model:** add `auth_provider`, credential/identity tables to the
  Stage 1 `users` table; email or OAuth identity.
- **JWT access + refresh tokens**, rotation, revocation; same bearer scheme for
  web (and later mobile).
- **OAuth providers** (Apple / Google at least — needed for mobile) + optional
  email/passwordless.
- **Account upgrade flow:** anonymous `deviceId` user → claims account; carts and
  orders migrate transparently (no data loss, idempotent).
- **Authorization:** order/cart ownership checks scoped to the authenticated
  user; admin role for the internal regenerate/seed/quarantine endpoints.
- **Identity-scoped rate limits** (replaces/augments device + IP buckets from
  Stage 1's generation guards).
- **Account UI:** sign-up / sign-in / sign-out, "continue as guest," profile,
  order history tied to the account.

## Exit criteria

A guest can use the full loop; can later sign up and keep their cart + order
history; can sign in on a second device and see the same history; refresh-token
rotation and revocation work; protected endpoints reject unauthorized access;
the anonymous fast path is unchanged for users who never sign up.
