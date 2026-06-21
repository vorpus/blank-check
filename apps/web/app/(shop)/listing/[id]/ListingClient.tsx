"use client";

import { type Listing } from "@dopamine/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { MediaImage } from "@/components/common/MediaImage";
import { Price } from "@/components/common/Price";
import { QtyStepper } from "@/components/common/QtyStepper";
import { StateMessage, errorMessage } from "@/components/common/StateMessage";
import { useCart } from "@/hooks/useCart";
import { useGenerationMedia } from "@/hooks/useGenerationMedia";
import { useListing } from "@/hooks/useListing";

/**
 * Listing detail island (doc 03 §2.3, §6). Fetches the listing, subscribes to its
 * generation stream if mid-generation (text→image swap in place), and offers an
 * Add-to-cart affordance.
 *
 * A listing is ORDERABLE while `media.status === 'generating_media'` — Add-to-cart
 * is enabled; only a truly absent listing (not-found) blocks it. `degraded` is NOT
 * an error: the listing is fully usable, it just shows the kept placeholder image.
 */
export function ListingClient({ id }: { id: string }) {
  const { data: listing, isLoading, isError, error } = useListing(id);

  // Subscribe to the image swap while mid-generation (hook owns lifecycle).
  const generating =
    listing?.media.status === "generating_text" ||
    listing?.media.status === "generating_media";
  useGenerationMedia(
    generating ? listing.media.generation_id : null,
    generating ? id : null,
  );

  if (isLoading) return <ListingSkeleton />;
  if (isError) {
    return (
      <StateMessage title="Couldn’t load this listing" detail={errorMessage(error)}>
        <Link href="/" className="text-sm underline">
          Back to search
        </Link>
      </StateMessage>
    );
  }
  if (!listing) return <ListingSkeleton />;

  return <ListingDetail listing={listing} />;
}

function ListingDetail({ listing }: { listing: Listing }) {
  const router = useRouter();
  const { addItem, isMutating } = useCart();
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);

  // Orderable unless the listing is absent (handled above). All media states —
  // including generating_media and degraded — are orderable.
  const orderable = true;

  return (
    <div className="grid gap-8 md:grid-cols-2">
      <MediaImage
        media={listing.media}
        alt={listing.title}
        className="w-full"
      />

      <div className="space-y-5">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">
            {listing.title}
          </h1>
          <Price
            amount={listing.price}
            className="text-lg font-semibold text-neutral-900"
          />
        </div>

        <p className="text-sm leading-relaxed text-neutral-600">
          {listing.description}
        </p>

        <SpecList attributes={listing.attributes} />

        {listing.media.status === "generating_media" && (
          <p className="text-xs text-neutral-500">
            The final image is still rendering — you can order now; it’ll update
            automatically.
          </p>
        )}

        <div className="flex items-center gap-3 pt-2">
          <QtyStepper qty={qty} onChange={(n) => setQty(Math.max(1, n))} />
          <button
            type="button"
            disabled={!orderable || isMutating}
            onClick={() => {
              addItem(listing, qty);
              setAdded(true);
            }}
            className="rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            Add to cart
          </button>
          {added && (
            <button
              type="button"
              onClick={() => router.push("/cart")}
              className="text-sm underline"
            >
              Go to cart →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Render whatever spec facets the server put in the open `attributes` JSONB. */
function SpecList({ attributes }: { attributes: Record<string, unknown> }) {
  const entries = Object.entries(attributes).filter(
    ([, v]) => typeof v === "string" || typeof v === "number",
  );
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-neutral-500 capitalize">{k.replace(/_/g, " ")}</dt>
          <dd className="text-neutral-800">{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function ListingSkeleton() {
  return (
    <div className="grid gap-8 md:grid-cols-2">
      <div className="aspect-square w-full rounded-lg bg-neutral-100" />
      <div className="space-y-4">
        <div className="h-6 w-2/3 rounded bg-neutral-100" />
        <div className="h-5 w-1/4 rounded bg-neutral-100" />
        <div className="h-20 w-full rounded bg-neutral-100" />
      </div>
    </div>
  );
}
