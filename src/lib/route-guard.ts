import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";

import { capabilitiesAdmitRoute, routeCapabilityOf } from "@/lib/capabilities";
import { myCapabilities } from "@/lib/capabilities.server";

/**
 * TanStack Router `beforeLoad` guard for capability-gated tenant routes
 * (docs/candidate-identification/track-b-design.md §1.5).
 *
 * The mirror, not the boundary: every gated route's server functions carry
 * their own enforcement, so if the capability read fails here the navigation
 * proceeds and the page's own queries answer for the tenant. `routeCapabilityOf`
 * treats NAV_EXEMPT_PREFIXES as not gated, so the guard is safe to add broadly.
 */
export async function requireRouteCapability({
  context,
  location,
}: {
  context: unknown;
  location: { pathname: string };
}): Promise<void> {
  let capabilities: string[];
  try {
    capabilities = await fetchCapabilities(context);
  } catch {
    // Server functions are authoritative — never block a page on a failed mirror read.
    return;
  }
  // Classify the pathname only: TanStack's location.href also carries the
  // search string and hash, which must never dodge a rule (routeCapabilityOf
  // strips them defensively too, but the pathname is the right input).
  const rule = routeCapabilityOf(location.pathname);
  if (rule && !capabilitiesAdmitRoute(capabilities, rule)) throw redirect({ to: "/" });
}

async function fetchCapabilities(context: unknown): Promise<string[]> {
  const queryClient = (context as { queryClient?: QueryClient } | undefined)?.queryClient;
  if (!queryClient) return (await myCapabilities({})).capabilities;
  const profile = await queryClient.ensureQueryData({
    queryKey: ["my_capabilities"],
    queryFn: () => myCapabilities({}),
    staleTime: 30_000,
  });
  return profile.capabilities;
}
