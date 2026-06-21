import { Global, Module } from "@nestjs/common";

import { StorageService } from "./storage.service";

/** Global StorageModule (MinIO/S3 via AWS SDK v3). */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
