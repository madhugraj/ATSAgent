import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { CAPABILITIES } from "@/lib/capabilities";
import { myCapabilities } from "@/lib/capabilities.server";
import { useOrg } from "./useOrg";
import { usePlatform } from "./usePlatform";

/**
 * The journey context every role-scoped surface (sidebar, dashboards, cross-links)
 * computes from. Single source so the sidebar and feature pages can never disagree
 * about what a role may see. Mirrors — never replaces — server-side enforcement,
 * which for tenant areas also includes the workflow profile's capability set
 * (docs/candidate-identification/track-b-design.md §1.5).
 */
export type NavCtx = {
  inOrg: boolean;
  isOwner: boolean;
  recruiterView: boolean;
  approver: boolean;
  governance: boolean;
  leadership: boolean;
  isSuperUser: boolean;
  claimable: boolean;
  capabilities: string[];
};

const BASELINE: NavCtx = {
  inOrg: true,
  isOwner: false,
  recruiterView: true,
  approver: false,
  governance: false,
  leadership: false,
  isSuperUser: false,
  claimable: false,
  capabilities: [...CAPABILITIES],
};

/**
 * The signed-in member's organisation workflow profile and its capability set.
 * While the read is in flight the capabilities come back as the full set — the
 * server is authoritative, so nothing flash-gates.
 */
export function useCapabilities() {
  const fetchCapabilities = useServerFn(myCapabilities);
  const q = useQuery({
    queryKey: ["my_capabilities"],
    queryFn: () => fetchCapabilities({}),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    // A freshly issued session can lose the first RPC race; never fall through
    // to a gated-off tenant because of a transient 401 or network blip.
    retry: 3,
    retryDelay: (attempt) => Math.min(400 * 2 ** attempt, 2000),
  });
  return {
    profile: q.data ?? null,
    capabilities: q.data?.capabilities ?? [...CAPABILITIES],
    isLoading: q.isLoading,
  };
}

export function useNavCtx(): NavCtx {
  const { org, membership, roles, isOwner, isLoading } = useOrg();
  const { isSuperUser, claimable } = usePlatform();
  const { capabilities } = useCapabilities();

  if (isLoading) return BASELINE; // recruiter journey until roles resolve — nothing flash-gates

  const inOrg = Boolean(org && membership);
  return {
    inOrg,
    isOwner,
    recruiterView:
      inOrg &&
      (roles.length === 0 ||
        isOwner ||
        roles.some((r) => r === "recruiter" || r === "hr_head" || r === "president_cbo")),
    approver:
      inOrg &&
      (isOwner ||
        roles.some(
          (r) =>
            r === "hiring_manager" ||
            r === "department_head" ||
            r === "hr_head" ||
            r === "president_cbo",
        )),
    governance: inOrg && (isOwner || roles.some((r) => r === "hr_head" || r === "president_cbo")),
    // The Talent Brain is a governance view: CHRO, HR head, owner or the product owner.
    leadership:
      isSuperUser || isOwner || roles.some((r) => r === "president_cbo" || r === "hr_head"),
    isSuperUser,
    claimable,
    // While the capability read is in flight, useCapabilities hands back the
    // full set so nothing flash-gates. Non-org visitors keep the full set too:
    // their items are hidden by inOrg anyway.
    capabilities,
  };
}
