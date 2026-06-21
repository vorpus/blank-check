import { Module } from "@nestjs/common";

import { CartModule } from "../cart/cart.module";
import { CatalogModule } from "../catalog/catalog.module";
import { IdentityModule } from "../identity/identity.module";
import { RealtimeGateway } from "../realtime/realtime.gateway";

import { OrderTransitionService } from "./order-transition.service";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import { TrackingService } from "./tracking.service";

/**
 * OrdersModule (doc 01 §2, §9, §10) — owns `orders` / `order_items` and the
 * tracking snapshot + SSE realtime gateway. Depends on Cart (checkout snapshot),
 * Catalog (storefront resolution), Identity (SSE token verification on the
 * EventSource path), and the global VerticalRegistry + Queue + Events modules.
 *
 * `OrderTransitionService` is exported so the worker's fulfillment ticker reuses
 * the EXACT same generic transition logic (one state machine usage, one atomic
 * event+state write) — no duplicated advance logic across api and worker.
 * `TrackingService` is exported so the worker has no need of it, but it stays a
 * single owner of the tracking-event projection.
 */
@Module({
  imports: [CartModule, CatalogModule, IdentityModule],
  providers: [OrdersService, OrderTransitionService, TrackingService, RealtimeGateway],
  controllers: [OrdersController],
  exports: [OrdersService, OrderTransitionService, TrackingService],
})
export class OrdersModule {}
