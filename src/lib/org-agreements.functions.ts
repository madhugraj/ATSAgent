import { createServerFn } from "@tanstack/react-start";

import { requireOrg, requireOrgOwner } from "@/lib/auth.middleware";
import { AgreementAcceptanceInput } from "@/lib/legal/acceptance";
import type { AgreementKind } from "@/lib/legal/agreements";

export type MyOrgAgreements = {
  /** Current documents this organisation has not accepted yet. */
  outstanding: AgreementKind[];
  isOwner: boolean;
  lastAcceptedAt: string | null;
};

/**
 * Which of the current Terms / Privacy Policy / DPA versions the caller's
 * organisation has still to accept. Any member may ask; only the owner can
 * accept (acceptOrgAgreements).
 */
export const myOrgAgreements = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<MyOrgAgreements> => {
    const { orgAgreementStatus } = await import("../server/org-agreements.server");
    const status = await orgAgreementStatus(context.orgId);
    return {
      outstanding: status.outstanding,
      isOwner: context.isOwner,
      lastAcceptedAt: status.history[0]?.acceptedAt ?? null,
    };
  });

/**
 * The owner accepts the current versions for the organisation — the blocking
 * step shown when a document has a new version or the organisation registered
 * before acceptance was recorded. Audited as `org.agreement.accepted`.
 */
export const acceptOrgAgreements = createServerFn({ method: "POST" })
  .middleware([requireOrgOwner])
  .inputValidator((data: unknown) => AgreementAcceptanceInput.parse(data))
  .handler(async ({ data, context }) => {
    const { getRequest } = await import("@tanstack/react-start/server");
    const { clientIp } = await import("../server/client-ip");
    const agreements = await import("../server/org-agreements.server");
    const request = getRequest();
    const email = (context.claims?.email as string | undefined) ?? context.memberEmail;
    const { recorded } = await agreements.recordAgreementAcceptance({
      orgId: context.orgId,
      userId: context.userId,
      email,
      acceptance: data,
      ipHash: agreements.hashIp(request ? clientIp(request) : null),
    });
    return { ok: true, recorded };
  });
