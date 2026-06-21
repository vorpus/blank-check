import {
  type DeviceIdentityResponse,
  DeviceIdentityResponseSchema,
} from "@dopamine/contracts";

import { apiBaseUrl } from "./env";

/**
 * Anonymous device identity (charter §4.4, doc 03 §8).
 *
 * On first load we look up a persisted `deviceId` in localStorage; if absent we
 * `POST /v1/identity/device` with `deviceId: null` so the server mints one. The
 * issued bearer token is held in this module's memory (and persisted alongside
 * the deviceId so a reload doesn't re-mint a *device*, only re-issues a token),
 * and the SDK's `getToken` reads it on every request.
 *
 * Forward-compat: this is the SAME bearer plumbing Stage 4 issues real accounts
 * under — only the issuer (the `device` call) changes.
 */

const STORAGE_KEY = "dopamine.identity.v1";

interface PersistedIdentity {
  deviceId: string;
  userId: string;
  accessToken: string;
  /** epoch ms when the token expires (for proactive refresh). */
  expiresAt: number;
}

/** In-memory mirror so `getToken()` is synchronous on the SDK's hot path. */
let current: PersistedIdentity | null = null;
let bootstrapPromise: Promise<PersistedIdentity> | null = null;

function readPersisted(): PersistedIdentity | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedIdentity>;
    if (
      typeof parsed.deviceId === "string" &&
      typeof parsed.userId === "string" &&
      typeof parsed.accessToken === "string" &&
      typeof parsed.expiresAt === "number"
    ) {
      return parsed as PersistedIdentity;
    }
  } catch {
    // Corrupt entry — fall through to a fresh bootstrap.
  }
  return null;
}

function persist(id: PersistedIdentity): void {
  current = id;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(id));
  }
}

/** Read the persisted deviceId without issuing a token (for re-bootstrap). */
function persistedDeviceId(): string | null {
  return (current ?? readPersisted())?.deviceId ?? null;
}

/**
 * Call `POST /v1/identity/device`. We use a bare `fetch` here (not the SDK)
 * because this IS the bootstrap that produces the token the SDK needs — a
 * chicken-and-egg the SDK's `getToken` can't yet satisfy. Response is Zod-parsed.
 */
async function issue(deviceId: string | null): Promise<DeviceIdentityResponse> {
  const res = await fetch(`${apiBaseUrl()}/v1/identity/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  if (!res.ok) {
    throw new Error(`identity bootstrap failed: HTTP ${String(res.status)}`);
  }
  return DeviceIdentityResponseSchema.parse(await res.json());
}

function toPersisted(r: DeviceIdentityResponse): PersistedIdentity {
  return {
    deviceId: r.deviceId,
    userId: r.userId,
    accessToken: r.token.accessToken,
    expiresAt: Date.now() + r.token.expiresInSec * 1000,
  };
}

/**
 * Ensure an identity exists, returning it. Idempotent: concurrent callers share
 * one in-flight bootstrap. Reuses a persisted, non-expired token; otherwise
 * re-issues against the persisted deviceId (or mints a new device on first run).
 */
export function bootstrapIdentity(): Promise<PersistedIdentity> {
  const persisted = current ?? readPersisted();
  if (persisted) current = persisted;

  // Reuse a still-valid token (60s skew guard).
  if (current && current.expiresAt - 60_000 > Date.now()) {
    return Promise.resolve(current);
  }

  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const r = await issue(persistedDeviceId());
    const id = toPersisted(r);
    persist(id);
    return id;
  })().finally(() => {
    bootstrapPromise = null;
  });

  return bootstrapPromise;
}

/** Synchronous bearer accessor for the SDK auth hook. `null` before bootstrap. */
export function getToken(): string | null {
  const id = current ?? readPersisted();
  if (!id) return null;
  current = id;
  return id.accessToken;
}

/** The current deviceId, or `null` before the first bootstrap. */
export function getDeviceId(): string | null {
  return persistedDeviceId();
}

/**
 * Force a token refresh for the SAME device (used on a 401). Clears the cached
 * token's expiry so the next `bootstrapIdentity` re-issues.
 */
export async function refreshToken(): Promise<PersistedIdentity> {
  const r = await issue(persistedDeviceId());
  const id = toPersisted(r);
  persist(id);
  return id;
}

/** Test-only: reset module state between cases. */
export function __resetIdentityForTests(): void {
  current = null;
  bootstrapPromise = null;
  if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
}
