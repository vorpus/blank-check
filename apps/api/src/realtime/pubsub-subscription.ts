import { type Redis } from "ioredis";

import { StructuredLogger } from "../common/logger";
import { type RedisService } from "../redis/redis.service";

const logger = new StructuredLogger("pubsub-subscription");

/**
 * The ONE pub/sub subscription helper (doc 01 §8, charter §4.3). Opens a
 * dedicated ioredis subscriber connection (ioredis requires a connection in
 * subscriber mode to be used only for SUBSCRIBE), parses each message as JSON,
 * and pumps it to `onMessage`. Returns an async `unsubscribe` that the SSE
 * responder calls on disconnect — so every stream tears its subscriber down
 * cleanly and no Redis connection leaks per dropped client.
 *
 * DRY: order streams and the generation stream both subscribe through this; the
 * connection lifecycle + JSON parse live here once.
 */
export interface PubSubSubscription {
  unsubscribe: () => Promise<void>;
}

export async function subscribeChannel(
  redis: RedisService,
  channel: string,
  onMessage: (payload: unknown) => void,
): Promise<PubSubSubscription> {
  const sub: Redis = redis.createSubscriber();

  sub.on("message", (ch: string, message: string) => {
    if (ch !== channel) return;
    try {
      onMessage(JSON.parse(message));
    } catch (err) {
      logger.warn(`dropping unparseable message on ${channel}: ${(err as Error).message}`);
    }
  });

  await sub.subscribe(channel);

  return {
    unsubscribe: async (): Promise<void> => {
      try {
        await sub.unsubscribe(channel);
      } catch {
        // best-effort
      }
      sub.disconnect();
    },
  };
}
