export default function Loading() {
  return (
    <div
      className="flex min-h-[60vh] items-center justify-center"
      role="status"
      aria-label="Loading"
    >
      <div className="size-6 animate-spin rounded-full border-2 border-hairline border-t-ink" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
