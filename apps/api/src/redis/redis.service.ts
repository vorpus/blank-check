import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";

import { ENV } from "../config/config.module";
import { type Env } from "../config/env";

/**
 * RedisService — the cache / lock / pub-sub primitive layer (doc 01 §2, charter
 * §3). Owns the shared command connection plus dedicated pub/sub connections
 * (ioredis requires a connection in subscriber mode to be used only for
 * pub/sub). BullMQ gets its own connections via RedisModule's factory.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  /** Shared command connection (GET/SET/INCR/SETNX/EVAL). */
  readonly client: Redis;
  private readonly subscribers: Redis[] = [];

  constructor(@Inject(ENV) private readonly env: Env) {
    this.client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  }

  /** A fresh connection dedicated to SUBSCRIBE (ioredis subscriber-mode rule). */
  createSubscriber(): Redis {
    const sub = new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.subscribers.push(sub);
    return sub;
  }

  /** A fresh general connection (e.g. for publishing from a subscriber context). */
  createConnection(): Redis {
    const conn = new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.subscribers.push(conn);
    return conn;
  }

  onModuleDestroy(): void {
    for (const sub of this.subscribers) sub.disconnect();
    this.client.disconnect();
  }
}
