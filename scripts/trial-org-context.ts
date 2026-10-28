/**
 * Live trial of the Organisation context agent's website read (O1):
 * confirm the organisation's website, fetch www.yavar.ai (or ORG_WEBSITE)
 * through the real reader, extract profile items with the organisation's own
 * AI key, and print what happened per page — bytes, hash, changed?, items
 * proposed, items refused and why, injection holds, and the ledger slugs
 * used. Never wired into CI.
 *
 *   DATABASE_URL=… SESSION_SECRET=… ORG_SLUG=… bun scripts/trial-org-context.ts
 *   … add --dry-run to fetch and strip HTML without any AI call.
 */
import { and, eq } from "drizzle-orm";

process.env["SESSION_SECRET"] ??= "trial-only-session-secret-0123456789abcdef";

const { db } = await import("../src/server/db");
const { orgMembers, orgProfiles, organizations, userRoles, users } =
  await import("../drizzle/schema");

const dryRun = process.argv.includes("--dry-run");
const slug = process.env["ORG_SLUG"];
if (!slug) {
  console.error("Set ORG_SLUG to the organisation to trial with (its owner runs the read).");
  process.exit(1);
}

const [org] = await db
  .select({ id: organizations.id, name: organizations.name })
  .from(organizations)
  .where(eq(organizations.slug, slug))
  .limit(1);
if (!org) {
  console.error(`No organisation with slug "${slug}".`);
  process.exit(1);
}
const [owner] = await db
  .select({ userId: orgMembers.userId })
  .from(orgMembers)
  .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.isOwner, true)))
  .limit(1);
if (!owner) {
  console.error("The organisation has no owner member to run the read as.");
  process.exit(1);
}
const roles = await db
  .select({ role: userRoles.role })
  .from(userRoles)
  .where(and(eq(userRoles.userId, owner.userId), eq(userRoles.orgId, org.id)));
const isEditor = roles.some((r) => r.role === "hr_head" || r.role === "president_cbo");
if (!isEditor) {
  console.error(
    "The owner needs the HR head or CBO role too (the profile's editor check) — grant one, or run as the HR head with ORG_USER set.",
  );
  process.exit(1);
}

const website = process.env["ORG_WEBSITE"] ?? "https://www.yavar.ai";
const actor = { orgId: org.id, userId: owner.userId };

if (!dryRun) {
  const { resolveAiConfig } = await import("../src/lib/ai-gateway.server");
  const cfg = await resolveAiConfig(org.id);
  if (!cfg.apiKey) {
    console.error(
      "The organisation has no AI key saved — save one on Integrations first, or use --dry-run.",
    );
    process.exit(1);
  }
}

console.log(`Trial: ${org.name} — ${website}${dryRun ? " (dry run: no AI calls)" : ""}\n`);

if (dryRun) {
  const { safeFetchText } = await import("../src/server/safe-fetch");
  const { htmlToText, pageLinks } = await import("../src/lib/org-context.server");
  const t0 = Date.now();
  const res = await safeFetchText(website, { maxBytes: 200_000, hops: 2 });
  const text = htmlToText(res.text);
  console.log(`home: ${res.finalUrl}`);
  console.log(`  bytes ${res.text.length}, text ${text.length} chars, ${Date.now() - t0} ms`);
  const links = pageLinks(res.text, res.finalUrl);
  console.log(`  same-host links found: ${links.length}`);
  for (const l of links.slice(0, 20)) console.log(`   - ${l}`);
  process.exit(0);
}

const { setWebsiteCore, readWebsiteCore } = await import("../src/lib/org-context.server");

const saved = await setWebsiteCore(actor, { url: website, confirm: true });
if (!saved.ok) {
  console.error("The website could not be saved.");
  process.exit(1);
}
console.log(`website saved: ${saved.url}\n`);

const t0 = Date.now();
const res = await readWebsiteCore(actor, {});
console.log(
  `read finished in ${((Date.now() - t0) / 1000).toFixed(1)} s — status: ${res.status}\n`,
);
console.log(
  `pages fetched: ${res.pagesFetched} (changed ${res.pagesChanged}, unchanged ${res.pagesUnchanged})`,
);
for (const s of res.skipped) console.log(`  skipped ${s.url} — ${s.why}`);
for (const f of res.flagged) console.log(`  HELD BACK (looks like instructions): ${f.url}`);
console.log(`items proposed into the draft: ${res.itemsKept}`);
if (res.itemsRefused.length) {
  console.log(`items refused: ${res.itemsRefused.length}`);
  for (const r of res.itemsRefused) console.log(`  [${r.section}] ${r.reason}`);
}
console.log(
  `\nLedger: every AI call is in ai_usage_events under org ${org.id} (features org_profile_extract / org_document_ocr).`,
);
console.log(`Next: review the draft on /org-profile, then submit and approve it.`);
process.exit(0);
