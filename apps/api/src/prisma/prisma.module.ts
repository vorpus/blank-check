import { Global, Module } from "@nestjs/common";

import { PrismaService } from "./prisma.service";

/** Global PrismaModule so every feature module can inject PrismaService. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
