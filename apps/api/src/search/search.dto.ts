import { SearchResultSchema } from "@dopamine/contracts";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** Query params for GET /v1/search. `storefrontId` optional → default storefront. */
export const SearchQuerySchema = z.object({
  q: z.string().min(1, "q is required"),
  storefrontId: z.string().optional(),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export class SearchResultDto extends createZodDto(SearchResultSchema) {}
