import { describe, expect, it } from "vitest";

import { RedisLockService } from "./redis-lock.service";
import { type RedisService } from "./redis.service";

/**
 * The generation lock collapses a thundering herd (doc 01 §4.2, charter §4.2): two
 * concurrent identical misses must yield exactly ONE generation. This models the
 * Redis SET NX semantics with an in-memory store and asserts only the first
 * acquire wins until release.
 */
function fakeRedis(): { service: RedisService; store: Map<string, string> } {
  const store = new Map<string, string>();
  const client = {
    set: (key: string, value: string, _px: string, _ttl: number, _nx: string): Promise<"OK" | null> => {
      if (store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve("OK");
    },
    eval: (_lua: string, _n: number, key: string, token: string): Promise<number> => {
      if (store.get(key) === token) {
        store.delete(key);
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    },
  };
  return { service: { client } as unknown as RedisService, store };
}

describe("RedisLockService", () => {
  it("only the first of two concurrent identical acquires wins → one generation", async () => {
    const { service } = fakeRedis();
    const lock = new RedisLockService(service);

    const [a, b] = await Promise.all([
      lock.acquire("gen:lock:sto_1:ladder", 30000),
      lock.acquire("gen:lock:sto_1:ladder", 30000),
    ]);

    const winners = [a, b].filter((h) => h !== null);
    expect(winners).toHaveLength(1);
  });

  it("releases by token so a re-acquire succeeds afterwards", async () => {
    const { service } = fakeRedis();
    const lock = new RedisLockService(service);

    const first = await lock.acquire("k", 30000);
    expect(first).not.toBeNull();
    await lock.release(first!);

    const second = await lock.acquire("k", 30000);
    expect(second).not.toBeNull();
  });

  it("release with a stale token does not delete a re-acquired lock", async () => {
    const { service, store } = fakeRedis();
    const lock = new RedisLockService(service);

    const stale = { key: "k", token: "old" };
    store.set("k", "current"); // someone else holds it now
    await lock.release(stale);

    expect(store.get("k")).toBe("current"); // untouched
  });
});
