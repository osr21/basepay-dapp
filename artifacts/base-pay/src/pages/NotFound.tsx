import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <p className="text-7xl font-bold text-primary/20 mb-4">404</p>
      <h1 className="text-xl font-bold mb-2">Page not found</h1>
      <p className="text-muted-foreground text-sm mb-6">This page doesn't exist.</p>
      <Link href="/">
        <a className="px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all">
          Back to Dashboard
        </a>
      </Link>
    </div>
  );
}
