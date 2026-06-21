import { type ArgumentMetadata, Injectable, type PipeTransform } from "@nestjs/common";
import { type ZodType } from "zod";

import { ValidationError } from "./errors";

/**
 * ZodValidationPipe (doc 01 §3, doc 05 §7) — parses a request body/query against
 * a `@dopamine/contracts` Zod schema and throws a 400 ErrorEnvelope on failure.
 *
 * Two usages:
 *   - Construct with an explicit schema: `new ZodValidationPipe(SearchQuerySchema)`
 *     for query params (where there's no DTO class to attach metadata to).
 *   - Attach to a `createZodDto`-derived class: the class carries its schema on a
 *     static `schema`/`isZodDto`, which this pipe reads — so body DTOs validate
 *     automatically AND feed the OpenAPI generator from the same schema.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema?: ZodType) {}

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = this.schema ?? extractDtoSchema(metadata.metatype);
    if (!schema) return value;

    const result = schema.safeParse(value);
    if (!result.success) {
      throw new ValidationError("request failed validation", {
        issues: result.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    return result.data;
  }
}

interface ZodDtoLike {
  isZodDto?: boolean;
  schema?: ZodType;
}

/** Read the Zod schema off a `createZodDto`-produced class, if present. */
function extractDtoSchema(metatype: unknown): ZodType | undefined {
  if (typeof metatype !== "function") return undefined;
  const dto = metatype as unknown as ZodDtoLike;
  return dto.isZodDto ? dto.schema : undefined;
}
