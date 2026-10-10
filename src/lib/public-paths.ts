// Routes that must render for signed-out visitors. The password-reset link,
// legal pages and candidate-facing apply/assess/schedule links arrive with no session —
// gating them behind the sign-in screen made them unreachable. Consumed by
// every gate in __root.tsx (AuthGate, OrgGate), not just the first one.
const PUBLIC_PATHS = new Set(["/auth/reset", "/privacy", "/cookies"]);

export function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith("/apply/") ||
    pathname.startsWith("/assess/") ||
    pathname.startsWith("/schedule/") ||
    pathname.startsWith("/offer/")
  );
}
