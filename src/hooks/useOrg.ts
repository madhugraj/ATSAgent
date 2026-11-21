import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { myOrg } from "@/lib/org.functions";

/** The signed-in user's organisation, membership and granted roles. */
export function useOrg() {
  const fetchOrg = useServerFn(myOrg);
  const q = useQuery({
    queryKey: ["my_org"],
    queryFn: () => fetchOrg({}),
    staleTime: 30_000,
    // A tenant awaiting platform approval must flip into the workspace on its own the
    // moment a super admin decides — signing out and back in was never required.
    refetchInterval: (query) => {
      const status = query.state.data?.org?.status;
      return status === "pending" || status === "rejected" ? 10_000 : false;
    },
    refetchOnWindowFocus: true,
    // A freshly issued session can lose the first RPC race; never fall through
    // to "you have no organisation" because of a transient 401 or network blip.
    retry: 3,
    retryDelay: (attempt) => Math.min(400 * 2 ** attempt, 2000),
  });
  return {
    org: q.data?.org ?? null,
    membership: q.data?.membership ?? null,
    roles: q.data?.roles ?? [],
    isOwner: Boolean(q.data?.membership?.isOwner),
    /** Interviewer role only: the app shows the panel view and nothing else. */
    panelOnly: Boolean(q.data?.panelOnly),
    isLoading: q.isLoading,
    isError: q.isError,
    error: q.error as Error | null,
    refetch: q.refetch,
  };
}
