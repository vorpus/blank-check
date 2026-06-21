import { type Metadata } from "next";

import { ListingClient } from "./ListingClient";

/**
 * Listing detail (doc 03 §2.3). This route is the shareable / SEO-addressable
 * surface — it's a Server Component shell that emits stable metadata and a
 * semantic <article>, then hydrates into the `ListingClient` island for the
 * cart action + live media subscription.
 *
 * NOTE (Stage-1 auth reconciliation): `GET /v1/listings/{id}` is behind the
 * global DeviceAuthGuard, and the anonymous device token lives in the browser's
 * localStorage (charter §4.4) — there is no token at SSR time. So the listing
 * BODY is fetched in the client island rather than server-side. The route stays
 * server-rendered + crawlable (URL, title, heading); the dynamic, authed payload
 * hydrates. A real SEO pass (Stage 3+) would issue a server-readable token or a
 * public read alias; flagged for the team.
 */

export function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  // We can't read the (authed) title server-side; keep metadata stable + generic.
  return params.then(() => ({
    title: "Listing · dopamine",
  }));
}

export default async function ListingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <article className="space-y-6">
      <ListingClient id={id} />
    </article>
  );
}
