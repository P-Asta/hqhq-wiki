import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="font-mono text-sm text-faint">404</p>
      <h1 className="text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-5xl">
        Page <span className="grad-text-b">not found</span>
      </h1>
      <p className="max-w-md text-sm text-mute">
        The page you are looking for does not exist, or its title has changed.
      </p>
      <Link
        href="/"
        className="focus-ring mt-2 inline-flex items-center rounded-[var(--radius-sm)] bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
      >
        Back to the wiki
      </Link>
    </main>
  );
}
