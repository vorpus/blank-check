import { type INestApplication } from "@nestjs/common";
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from "@nestjs/swagger";
import { cleanupOpenApiDoc } from "nestjs-zod";

/**
 * Build the OpenAPI 3.1 document from the Zod-derived DTOs (doc 01 §7.3, doc 05
 * §3). nestjs-zod v5 `createZodDto` classes expose `_OPENAPI_METADATA_FACTORY`, so
 * `@nestjs/swagger` reads their schemas automatically — the spec is a faithful
 * projection of the SAME Zod contracts that validate at runtime (one source of
 * truth). `cleanupOpenApiDoc(doc, { version: '3.1' })` emits a real OpenAPI 3.1
 * document (proper nullable/JSON-schema handling) as doc 05 §3.2 requires.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle("Dopamine API")
    .setDescription("Stage 1 local skeleton — generation slice (/v1)")
    .setVersion("1.0.0")
    .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT" }, "bearer")
    .build();

  const doc = SwaggerModule.createDocument(app, config);
  // cleanupOpenApiDoc emits 3.1-shaped JSON-schema for the nestjs-zod DTOs but
  // leaves the version string; stamp it to 3.1.0 so openapi-typescript (doc 05
  // §3.2) reads a real 3.1 document.
  const cleaned = cleanupOpenApiDoc(doc, { version: "3.1" });
  return { ...cleaned, openapi: "3.1.0" };
}

/** Mount the Swagger UI at `/v1/docs`. */
export function setupSwaggerUi(app: INestApplication, doc: OpenAPIObject): void {
  SwaggerModule.setup("v1/docs", app, doc);
}
