import { OrderClient } from "./OrderClient";

/**
 * Order / live tracking (doc 03 §2.6). Primarily a client island: it's auth-scoped
 * and realtime-driven, so SSR buys little — the shell renders, the island fetches
 * + subscribes.
 */
export default async function OrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <OrderClient id={id} />;
}
