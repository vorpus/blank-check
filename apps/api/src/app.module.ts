import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_PIPE } from "@nestjs/core";

import { CartModule } from "./cart/cart.module";
import { CatalogModule } from "./catalog/catalog.module";
import { ErrorEnvelopeFilter } from "./common/error-envelope.filter";
import { ZodValidationPipe } from "./common/zod-validation.pipe";
import { ConfigModule } from "./config/config.module";
import { EventsModule } from "./events/events.module";
import { GenerationGatewayModule } from "./generation/generation.module";
import { HealthModule } from "./health/health.module";
import { DeviceAuthGuard } from "./identity/device-auth.guard";
import { IdentityModule } from "./identity/identity.module";
import { OrdersModule } from "./orders/orders.module";
import { PrismaModule } from "./prisma/prisma.module";
import { QueueModule } from "./queue/queue.module";
import { RedisModule } from "./redis/redis.module";
import { SearchModule } from "./search/search.module";
import { StorageModule } from "./storage/storage.module";
import { VerticalRegistryModule } from "./vertical-registry/vertical-registry.module";

/**
 * AppModule (doc 01 §2) — the HTTP api composition root. Infra modules (config,
 * prisma, redis, queue, storage, events, vertical-registry) are global; feature
 * modules (identity, catalog, search, generation) carry the controllers. The
 * generation slice ONLY (Milestone 3a). Cart/Orders/Fulfillment/SSE modules plug
 * in here in 3b with no changes to what's below.
 *
 * Cross-cutting providers, applied globally:
 *   - ZodValidationPipe: parses DTO bodies against their contract schema → 400.
 *   - DeviceAuthGuard: requires a bearer on every route except `@Public()`.
 *   - ErrorEnvelopeFilter: shapes every error as the contract ErrorEnvelope.
 */
@Module({
  imports: [
    // Infra (global)
    ConfigModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    StorageModule,
    EventsModule,
    VerticalRegistryModule,
    // Features (generation slice + order slice)
    IdentityModule,
    CatalogModule,
    SearchModule,
    GenerationGatewayModule,
    CartModule,
    OrdersModule,
    HealthModule,
  ],
  providers: [
    // useValue (not useClass): the pipe has an optional `schema` constructor arg
    // that Nest would otherwise try to DI-resolve. The global instance validates
    // body DTOs by reading their static Zod schema; route-level pipes pass an
    // explicit schema for query params.
    { provide: APP_PIPE, useValue: new ZodValidationPipe() },
    { provide: APP_GUARD, useClass: DeviceAuthGuard },
    { provide: APP_FILTER, useClass: ErrorEnvelopeFilter },
  ],
})
export class AppModule {}
