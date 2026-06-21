import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/**
 * PrismaService — the single Postgres connection (doc 01 §2). Owns connect /
 * disconnect lifecycle. Every module talks to its OWN tables through this client;
 * cross-module access goes through provider interfaces, never another module's
 * tables directly (doc 01 §2.1).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
