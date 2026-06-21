import { Module } from "@nestjs/common";

import { CatalogModule } from "../catalog/catalog.module";
import { ConfigModule } from "../config/config.module";
import { EventsModule } from "../events/events.module";
import { GenerationGatewayModule } from "../generation/generation.module";
import { OrdersModule } from "../orders/orders.module";
import { PrismaModule } from "../prisma/prisma.module";
import { QueueModule } from "../queue/queue.module";
import { RedisModule } from "../redis/redis.module";
import { StorageModule } from "../storage/storage.module";
import { VerticalRegistryModule } from "../vertical-registry/vertical-registry.module";

import { FulfillmentService } from "./fulfillment.service";
import { FulfillmentWorker } from "./fulfillment.worker";
import { GenerationWorker } from "./generation.worker";

/**
 * WorkerModule (doc 01 §11) — the SAME DI providers as the api, minus the HTTP
 * controllers. Bootstraps as a Nest application context (no HTTP listener) so the
 * BullMQ processors + OutboxRelay run with the identical Prisma / EventBus /
 * Storage / VerticalRegistry wiring the api uses. One codebase, two entrypoints.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    StorageModule,
    EventsModule,
    VerticalRegistryModule,
    CatalogModule,
    GenerationGatewayModule,
    OrdersModule,
  ],
  providers: [GenerationWorker, FulfillmentWorker, FulfillmentService],
  exports: [GenerationWorker, FulfillmentWorker, FulfillmentService],
})
export class WorkerModule {}
