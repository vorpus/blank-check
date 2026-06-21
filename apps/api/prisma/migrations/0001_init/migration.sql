-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'anonymous',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verticals" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "stateMachineKey" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "generationOn" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "verticals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefronts" (
    "id" TEXT NOT NULL,
    "verticalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "theme" JSONB NOT NULL DEFAULT '{}',
    "config" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "storefronts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "storefrontId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listings" (
    "id" TEXT NOT NULL,
    "storefrontId" TEXT NOT NULL,
    "verticalId" TEXT NOT NULL,
    "categoryId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "media" JSONB NOT NULL DEFAULT '{}',
    "imageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "canonicalQuery" TEXT,
    "generationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storefrontId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verticalId" TEXT NOT NULL,
    "storefrontId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "stateMachineKey" TEXT NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "idempotencyKey" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "seq" INTEGER NOT NULL DEFAULT 0,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "titleSnapshot" TEXT NOT NULL,
    "unitPriceSnapshot" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillment_plans" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "verticalId" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "nextTickAt" TIMESTAMP(3),

    CONSTRAINT "fulfillment_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_events" (
    "orderId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'state_change',
    "state" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_events_pkey" PRIMARY KEY ("orderId","seq")
);

-- CreateTable
CREATE TABLE "generation_jobs" (
    "id" TEXT NOT NULL,
    "storefrontId" TEXT NOT NULL,
    "verticalId" TEXT NOT NULL,
    "canonicalQuery" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "regime" TEXT NOT NULL,
    "batchSize" INTEGER NOT NULL DEFAULT 1,
    "generationId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_events" (
    "id" TEXT NOT NULL,
    "consumer" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_events_pkey" PRIMARY KEY ("id","consumer")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_deviceId_key" ON "users"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "categories_storefrontId_slug_key" ON "categories"("storefrontId", "slug");

-- CreateIndex
CREATE INDEX "listings_storefrontId_status_idx" ON "listings"("storefrontId", "status");

-- CreateIndex
CREATE INDEX "listings_generationId_idx" ON "listings"("generationId");

-- CreateIndex
CREATE UNIQUE INDEX "listings_storefrontId_canonicalQuery_key" ON "listings"("storefrontId", "canonicalQuery");

-- CreateIndex
CREATE UNIQUE INDEX "cart_items_cartId_listingId_key" ON "cart_items"("cartId", "listingId");

-- CreateIndex
CREATE INDEX "orders_userId_placedAt_idx" ON "orders"("userId", "placedAt");

-- CreateIndex
CREATE UNIQUE INDEX "orders_userId_idempotencyKey_key" ON "orders"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "fulfillment_plans_orderId_key" ON "fulfillment_plans"("orderId");

-- CreateIndex
CREATE INDEX "fulfillment_plans_nextTickAt_idx" ON "fulfillment_plans"("nextTickAt");

-- CreateIndex
CREATE UNIQUE INDEX "generation_jobs_requestId_key" ON "generation_jobs"("requestId");

-- CreateIndex
CREATE INDEX "generation_jobs_generationId_idx" ON "generation_jobs"("generationId");

-- CreateIndex
CREATE UNIQUE INDEX "generation_jobs_storefrontId_canonicalQuery_key" ON "generation_jobs"("storefrontId", "canonicalQuery");

-- CreateIndex
CREATE INDEX "outbox_events_status_createdAt_idx" ON "outbox_events"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "storefronts" ADD CONSTRAINT "storefronts_verticalId_fkey" FOREIGN KEY ("verticalId") REFERENCES "verticals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_storefrontId_fkey" FOREIGN KEY ("storefrontId") REFERENCES "storefronts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_storefrontId_fkey" FOREIGN KEY ("storefrontId") REFERENCES "storefronts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_plans" ADD CONSTRAINT "fulfillment_plans_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

