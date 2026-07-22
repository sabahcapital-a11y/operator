import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 text-center bg-sand-50">
      {/* Logo */}
      <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-navy-800 text-2xl font-bold text-white shadow-lg">
        T
      </div>

      <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-700">
        UAE Corporate Tax Compliance
      </span>

      <h1 className="max-w-2xl text-4xl font-bold tracking-tight text-navy-900 sm:text-6xl">
        Your tax deadlines,{" "}
        <span className="text-amber-500">organized</span>
      </h1>

      <p className="max-w-md text-lg text-gray-500">
        Threshold tracks every corporate tax deadline for freelancers and SMEs
        in the UAE — from registration to filing to payment. No advice, just
        organized, timely preparation.
      </p>

      <Link
        to="/onboard"
        className="inline-flex items-center gap-2 rounded-xl bg-navy-800 px-6 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-navy-700 focus:outline-none focus:ring-2 focus:ring-navy-500 focus:ring-offset-2"
      >
        Set up your compliance tracking
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </Link>

      <p className="text-xs text-gray-400">
        Freelancers · Free Zone Companies · Mainland SMEs
      </p>

      <footer className="absolute bottom-6 text-sm text-gray-400">
        Built with{" "}
        <a
          href="https://cto.new"
          className="underline hover:text-gray-600"
        >
          cto.new
        </a>
      </footer>
    </main>
  );
}
