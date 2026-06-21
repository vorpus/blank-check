import { isApiError } from "@/lib/sdk";

/** A centered status message for loading/empty/error states. */
export function StateMessage({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="grid place-items-center py-20 text-center">
      <div className="max-w-sm space-y-2">
        <p className="text-sm font-medium text-neutral-700">{title}</p>
        {detail && <p className="text-xs text-neutral-500">{detail}</p>}
        {children}
      </div>
    </div>
  );
}

/** Human-readable message from an unknown error (ApiError-aware). */
export function errorMessage(err: unknown): string {
  if (isApiError(err)) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
