import { ListingSchema } from "@dopamine/contracts";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** Listing response DTO (drives OpenAPI + response shape; doc 01 §7.3). */
export class ListingResponseDto extends createZodDto(ListingSchema) {}

/**
 * Category tree response (GET /v1/storefronts/{id}/categories). This is an
 * api-internal read shape (not a wire contract in @dopamine/contracts), so the
 * schema lives here. A Zod DTO gives the endpoint the same typed OpenAPI response
 * schema the other endpoints have, instead of an untyped `200`.
 */
export const CategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  parentId: z.string().nullable(),
});
export type Category = z.infer<typeof CategorySchema>;

export const CategoryListSchema = z.array(CategorySchema);

/** Array-of-categories response DTO. */
export class CategoryListResponseDto extends createZodDto(CategoryListSchema) {}
