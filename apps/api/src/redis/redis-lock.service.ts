import { Injectable } from "@nestjs/common";

import { RedisService } from "./redis.service";

/** A held lock handle; `token` proves ownership for a safe release. */
export interface LockHandle {
  key: string;
  token: string;
}

// Lua: release only if we still own the lock (compare-and-delete) — avoids a
// stale owner deleting a lock another worker has since re-acquired.
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/**
 * RedisLockService — the SET NX PX generation lock (doc 01 §4.2, charter §4.2).
 * Reusable helper so the generation gateway (and any future critical section)
 * collapses a thundering herd: only the first caller acquires; losers attach to
 * the in-flight job. Ownership is token-guarded so release is safe.
 */
@Injectable()
export class RedisLockService {
  constructor(private readonly redis: RedisService) {}

  /** Try to acquire `key` for `ttlMs`. Returns a handle on success, null on contention. */
  async acquire(key: string, ttlMs: number): Promise<LockHandle | null> {
    const token = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
    const ok = await this.redis.client.set(key, token, "PX", ttlMs, "NX");
    return ok === "OK" ? { key, token } : null;
  }

  /** Release a held lock (compare-and-delete by token). Safe to call after expiry. */
  async release(handle: LockHandle): Promise<void> {
    await this.redis.client.eval(RELEASE_LUA, 1, handle.key, handle.token);
  }
}
