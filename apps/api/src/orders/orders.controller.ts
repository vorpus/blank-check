import { type Order, type TrackingSnapshot } from "@dopamine/contracts";
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { type FastifyReply, type FastifyRequest } from "fastify";

import { CatalogService } from "../catalog/catalog.service";
import { ValidationError } from "../common/errors";
import { CurrentUser } from "../identity/current-user.decorator";
import { Public } from "../identity/device-auth.guard";
import { IdentityService, type AuthPrincipal } from "../identity/identity.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";

import {
  OrderListResponseDto,
  OrderResponseDto,
  PlaceOrderDto,
  TrackingSnapshotResponseDto,
} from "./orders.dto";
import { OrdersService } from "./orders.service";
import { TrackingService } from "./tracking.service";

/**
 * Orders controller (doc 01 §7). REST place/get/list/cancel + the snapshot and SSE
 * stream endpoints. Place requires the `Idempotency-Key` header (idempotent on
 * retry). The SSE/stream routes are `@Public()` because EventSource can't set an
 * Authorization header — they authenticate via a bearer in the `Authorization`
 * header OR a `token` query param, then authorize the order against the principal.
 */
@ApiTags("orders")
@Controller({ version: "1" })
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly tracking: TrackingService,
    private readonly catalog: CatalogService,
    private readonly realtime: RealtimeGateway,
    private readonly identity: IdentityService,
  ) {}

  @Post("orders")
  @ApiOperation({ summary: "Place an order from the active cart (idempotent on Idempotency-Key)" })
  @ApiOkResponse({ type: OrderResponseDto })
  async place(
    @Body() body: PlaceOrderDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<Order> {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new ValidationError("missing required Idempotency-Key header");
    }
    const storefront = await this.catalog.resolveStorefront(body.storefrontId ?? null);
    return this.orders.place(user.userId, storefront.id, idempotencyKey.trim());
  }

  @Get("orders")
  @ApiOperation({ summary: "List the device user's orders (most recent first)" })
  @ApiOkResponse({ type: OrderListResponseDto })
  list(@CurrentUser() user: AuthPrincipal): Promise<Order[]> {
    return this.orders.list(user.userId);
  }

  @Get("orders/:id")
  @ApiOperation({ summary: "Order detail — vertical-agnostic display payload (polling fallback)" })
  @ApiOkResponse({ type: OrderResponseDto })
  get(@Param("id") id: string, @CurrentUser() user: AuthPrincipal): Promise<Order> {
    return this.orders.get(user.userId, id);
  }

  @Post("orders/:id/cancel")
  @ApiOperation({ summary: "Cancel an order if the machine allows it from the current state (else 409)" })
  @ApiOkResponse({ type: OrderResponseDto })
  cancel(@Param("id") id: string, @CurrentUser() user: AuthPrincipal): Promise<Order> {
    return this.orders.cancel(user.userId, id);
  }

  @Get("orders/:id/tracking")
  @ApiOperation({ summary: "Authoritative tracking snapshot + ordered event log + latestSeq" })
  @ApiOkResponse({ type: TrackingSnapshotResponseDto })
  snapshot(@Param("id") id: string, @CurrentUser() user: AuthPrincipal): Promise<TrackingSnapshot> {
    return this.tracking.snapshot(user.userId, id);
  }

  @Get("orders/:id/stream")
  @Public()
  @ApiOperation({ summary: "SSE: live tracking_event frames; Last-Event-ID replay" })
  async stream(
    @Param("id") id: string,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @Query("token") token: string | undefined,
    @Query("lastEventId") lastEventIdQuery: string | undefined,
    @Headers("authorization") authHeader: string | undefined,
    @Headers("last-event-id") lastEventIdHeader: string | undefined,
  ): Promise<void> {
    const principal = this.authStream(authHeader, token);
    // Authorize: the order must belong to the principal (404 otherwise).
    await this.orders.get(principal.userId, id);
    const lastEventId = parseLastEventId(req, lastEventIdHeader, lastEventIdQuery);
    await this.realtime.streamOrder(res, id, lastEventId);
  }

  @Get("generation/:generationId/stream")
  @Public()
  @ApiOperation({ summary: "SSE: relay images.ready/images.degraded for a generation batch" })
  async generationStream(
    @Param("generationId") generationId: string,
    @Res() res: FastifyReply,
    @Query("token") token: string | undefined,
    @Headers("authorization") authHeader: string | undefined,
  ): Promise<void> {
    // Auth only (no per-order ownership — generation streams are not user-scoped
    // rows; any authenticated device can subscribe to swap events for its search).
    this.authStream(authHeader, token);
    await this.realtime.streamGeneration(res, generationId);
  }

  /** Verify a bearer from the Authorization header OR a `token` query (for EventSource). */
  private authStream(authHeader: string | undefined, token: string | undefined): AuthPrincipal {
    const bearer = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : token;
    if (!bearer) throw new ValidationError("missing bearer (Authorization header or ?token=)");
    return this.identity.verify(bearer);
  }
}

/**
 * Resolve the SSE resume cursor from EITHER the `last-event-id` header (browser
 * EventSource sets this on RECONNECT only) OR the `lastEventId` query param (the
 * SDK's TrackingClient carries it on the INITIAL connect, since an EventSource
 * constructor can't set request headers). Closing this gap makes tracking
 * gap-free across the snapshot→subscribe seam (charter §4.3): the api replays
 * `tracking_events WHERE seq > cursor` before live streaming regardless of which
 * channel the client used. The header wins if both are present (reconnect is the
 * authoritative resume point); the client de-dupes by seq either way.
 */
function parseLastEventId(
  req: FastifyRequest,
  headerValue: string | undefined,
  queryValue: string | undefined,
): number | null {
  const raw =
    headerValue ??
    (req.headers["last-event-id"] as string | undefined) ??
    queryValue;
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
