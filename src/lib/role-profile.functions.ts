import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireOrg } from "./auth.middleware";
import { draftRoleProfile, type RoleProfile } from "./role-profile.server";

export type { RoleProfile } from "./role-profile.server";

const Input = z.object({
  role: z.string().min(2),
  department: z.string().optional().nullable(),
  location: z.string().default(""),
  experienceMin: z.number().default(0),
  experienceMax: z.number().default(0),
  industry: z.string().optional().nullable(),
});

/** Draft skills, qualifications and responsibilities for a role title. */
export const suggestRoleProfile = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }): Promise<RoleProfile> =>
    draftRoleProfile({ ...data, orgId: context.orgId }),
  );
