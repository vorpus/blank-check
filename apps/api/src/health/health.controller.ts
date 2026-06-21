import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { Public } from "../identity/device-auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";

/**
 * Health controller. `GET /v1/health` is the compose healthcheck target (see
 * docker-compose.yml api healthcheck). Public + dependency-aware: it pings
 * Postgres + Redis so "healthy" means the api can actually serve, not just that
 * the process is up.
 */
@ApiTags("health")
@Controller({ path: "health", version: "1" })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  @Public()
  @ApiOperation({ summary: "Liveness/readiness probe (pings Postgres + Redis)" })
  async health(): Promise<{ status: string; deps: Record<string, string> }> {
    const [db, redis] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(() => "ok").catch(() => "down"),
      this.redis.client
        .ping()
        .then(() => "ok")
        .catch(() => "down"),
    ]);
    const status = db === "ok" && redis === "ok" ? "ok" : "degraded";
    return { status, deps: { db, redis } };
  }
}
