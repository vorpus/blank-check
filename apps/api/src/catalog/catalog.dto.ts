import { ListingSchema } from "@dopamine/contracts";
import { createZodDto } from "nestjs-zod";

/** Listing response DTO (drives OpenAPI + response shape; doc 01 §7.3). */
export class ListingResponseDto extends createZodDto(ListingSchema) {}
