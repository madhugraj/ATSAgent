import { Link } from "@tanstack/react-router";

import logoUrl from "@/assets/yavar-logo.png";

/**
 * The Yavar wordmark. The source artwork is dark, so on dark surfaces pass
 * tone="onDark" to render it light-on-dark instead of disappearing.
 */
export function BrandLogo({
  className = "h-7",
  tone = "onLight",
}: {
  className?: string;
  tone?: "onLight" | "onDark";
}) {
  return (
    <img
      src={logoUrl}
      alt="Yavar"
      className={`${className} w-auto ${tone === "onDark" ? "brightness-0 invert" : ""}`}
    />
  );
}

const LINKEDIN = "https://www.linkedin.com/company/yavar-techworks/";

/** Legal footer shown across the application. */
export function BrandFooter() {
  return (
    <footer className="mt-8 border-t border-border px-4 py-5 text-xs text-muted-foreground sm:px-6">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3">
        <span>© Copyright {new Date().getFullYear()} Yavar AI. All rights reserved.</span>
        <nav className="flex flex-wrap items-center gap-4">
          <Link to="/privacy" className="hover:text-foreground hover:underline">
            Privacy Policy
          </Link>
          <Link to="/terms" className="hover:text-foreground hover:underline">
            Terms
          </Link>
          <Link to="/dpa" className="hover:text-foreground hover:underline">
            Data Processing Agreement
          </Link>
          <Link to="/cookies" className="hover:text-foreground hover:underline">
            Cookies Policy
          </Link>
          <a
            href="https://yavar.ai"
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground hover:underline"
          >
            yavar.ai
          </a>
          <a
            href={LINKEDIN}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground hover:underline"
          >
            LinkedIn
          </a>
        </nav>
      </div>
    </footer>
  );
}
