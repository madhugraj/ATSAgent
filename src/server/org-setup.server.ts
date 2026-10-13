/**
 * Organisation set-up shared by self-service registration
 * (src/lib/org.functions.ts) and the local bootstrap script
 * (scripts/bootstrap-org.ts), so every organisation starts the same way.
 */
import { ilike } from "drizzle-orm";

import { db } from "./db";
import { organizations } from "@db/schema";

/** The tenant's own careers address slug: yavar.ai -> yavar@careers.atsiq.yavar.ai, unique. */
export async function uniqueInboxSlug(companyDomain: string, name: string): Promise<string> {
  let inboxSlug =
    companyDomain.split(".")[0]?.replace(/[^a-z0-9-]+/g, "-") ||
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 28) ||
    "org";
  for (let attempt = 2; attempt < 30; attempt++) {
    const [taken] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(ilike(organizations.inboxSlug, inboxSlug))
      .limit(1);
    if (!taken) break;
    inboxSlug = `${inboxSlug.replace(/-\d+$/, "")}-${attempt}`;
  }
  return inboxSlug;
}
