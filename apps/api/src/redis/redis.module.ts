import { Global, Module } from "@nestjs/common";

import { RedisLockService } from "./redis-lock.service";
import { RedisService } from "./redis.service";

/**
 * Global RedisModule — exposes the raw client, the lock helper, and (via the
 * BullMQ module) the queue connections. Global so search / generation / outbox
 * relay all share one connection pool.
 */
@Global()
@Module({
  providers: [RedisService, RedisLockService],
  exports: [RedisService, RedisLockService],
})
export class RedisModule {}
