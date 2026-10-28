/**
 * Organisation context agent tools (docs/org-context-agent-plan.md, O1):
 * thin wrappers over the org-context cores (src/lib/org-context.server.ts).
 * Every tool runs as the run's human principal, so the same editor role
 * checks and refusals apply as on the Profile page. Nothing here approves —
 * submitting calls request_approval with the org_profile subject and a
 * person decides.
 */
import { z } from "zod";

import { PROFILE_SECTIONS } from "@/lib/org-profile";
import { registerTool, type ToolContext } from "./registry";

const actor = async (ctx: ToolContext) => {
  const { actorFor } = await import("@/lib/requisitions.server");
  return actorFor(ctx.orgId, ctx.principalUserId);
};

const SECTION_KEYS = PROFILE_SECTIONS.map((s) => s.key) as [string, ...string[]];

export function registerOrgTools(): void {
  registerTool({
    name: "read_org_profile",
    description:
      "The organisation's profile as it stands: the approved version and the open draft, section by section. Read this first so you build on what exists instead of repeating it.",
    input: z.object({}),
    risk: "read",
    untrustedOutput: true,
    run: async (ctx) => {
      const { profileState } = await import("@/lib/org-profile.server");
      const state = await profileState(ctx.orgId);
      const shape = (v: typeof state.approved) =>
        v
          ? {
              version: v.version,
              status: v.status,
              sections: Object.fromEntries(
                Object.entries(v.sections ?? {}).map(([k, items]) => [
                  k,
                  items.map((i) => ({
                    text: i.text,
                    visibility: i.visibility,
                    source: i.source.kind,
                  })),
                ]),
              ),
            }
          : null;
      return {
        approved: shape(state.approved),
        openDraft: shape(state.open),
      };
    },
  });

  registerTool({
    name: "read_org_records",
    description:
      "What the system already knows about the organisation: its record (name, industry, size, headquarters, e-mail domain), the saved website and every uploaded profile document. Documents are listed by id — read each with read_org_document.",
    input: z.object({}),
    risk: "read",
    run: async (ctx) => {
      const { readOrgRecords } = await import("@/lib/org-context.server");
      return readOrgRecords(ctx.orgId);
    },
  });

  registerTool({
    name: "read_org_website",
    description:
      "Read the organisation's own website (the host saved on the Profile page) into profile sources and propose what it states as draft items. At most 20 pages, robots.txt honoured, at most one full read per hour; pass specific same-host pages when the person asked for them. A page that looks like instructions to an AI is held back for a person, and nothing is kept from it until they accept it.",
    input: z.object({
      pages: z.array(z.string().max(2000)).max(20).optional(),
    }),
    risk: "read",
    skills: ["org_profile_extract"],
    untrustedOutput: true,
    precheck: async (ctx, input) => {
      const { orgProfiles } = await import("@db/schema");
      const { eq } = await import("drizzle-orm");
      const { db } = await import("../db");
      const { websiteReadBlocked } = await import("@/lib/org-context.server");
      const [p] = await db
        .select({ websiteUrl: orgProfiles.websiteUrl })
        .from(orgProfiles)
        .where(eq(orgProfiles.orgId, ctx.orgId))
        .limit(1);
      if (!p?.websiteUrl)
        return "No website is saved for this organisation. Ask the HR head to add it on the Profile page.";
      if (input.pages?.length) {
        const host = (u: string) => {
          try {
            return new URL(u).hostname.replace(/^www\./, "");
          } catch {
            return null;
          }
        };
        const own = host(p.websiteUrl);
        const off = input.pages.find((p2) => host(p2) !== own);
        if (off) return `Only the organisation's own website (${own}) may be read — not ${off}.`;
      }
      const blocked = await websiteReadBlocked(ctx.orgId);
      if (blocked)
        return `The website was read within the last hour; read again after ${blocked.toLocaleTimeString()}. Work with what read_org_profile and the documents already hold.`;
      return null;
    },
    run: async (ctx, input) => {
      const { readWebsiteCore } = await import("@/lib/org-context.server");
      return readWebsiteCore(await actor(ctx), input);
    },
  });

  registerTool({
    name: "read_org_document",
    description:
      "The text of one uploaded profile document (by its id from read_org_records). Scanned pages were read through the AI model; the text is what the document states. Propose what it says with propose_profile_items, quoting it exactly.",
    input: z.object({ documentId: z.string().uuid() }),
    risk: "read",
    skills: ["org_profile_extract", "org_document_ocr"],
    untrustedOutput: true,
    precheck: async (ctx, input) => {
      const { readOrgDocument } = await import("@/lib/org-context.server");
      const doc = await readOrgDocument(ctx.orgId, input.documentId);
      if (!doc)
        return "That document is not in this organisation's profile sources (it may have been removed).";
      if (!doc.text.trim())
        return `No text could be read from ${doc.fileName}; nothing can be kept from it.`;
      return null;
    },
    run: async (ctx, input) => {
      const { readOrgDocument } = await import("@/lib/org-context.server");
      return readOrgDocument(ctx.orgId, input.documentId);
    },
  });

  const ProposedItem = z.object({
    text: z.string().min(3).max(600),
    visibility: z.enum(["candidate", "internal"]),
    quote: z.string().max(400).optional(),
    sourceId: z.string().uuid().optional(),
  });

  registerTool({
    name: "propose_profile_items",
    description:
      "Propose items for one section of the organisation profile draft. Every item must state the section, whether it may be said to candidates (visibility) or is internal, and the exact quote from the source it came from — an item whose quote is not in the source is dropped. Pay figures and staff names are refused with a reason. Nothing is published: items join the draft a person approves.",
    input: z.object({
      section: z.enum(SECTION_KEYS),
      items: z.array(ProposedItem).min(1).max(30),
    }),
    // Risk "read" on purpose: items land only in a draft that is inert until
    // the version itself is submitted and approved — the human gate is the
    // version approval at the end of the run, not each proposal. Approving
    // every section separately made the build a permission nag.
    risk: "read",
    describe: (i) => `Propose ${i.items.length} profile item(s) under “${i.section}”`,
    run: async (ctx, input) => {
      const { proposeItemsCore } = await import("@/lib/org-context.server");
      return proposeItemsCore(await actor(ctx), input);
    },
  });

  registerTool({
    name: "submit_profile_version",
    description:
      "Submit the organisation profile draft for approval — submitting IS the ask; afterwards request the decision with request_approval (subject type org_profile, this version's id) and the approval card is the person's decision. Refuses when there is no open draft or nothing under About.",
    input: z.object({ note: z.string().max(1000).optional() }),
    // Risk "read" like proposing: submitting moves the inert draft to
    // "waiting for approval" — the approval card that follows is the human
    // gate. Under suggest autonomy this otherwise asks "may I submit?" and
    // then asks again on the version itself: two approvals for one decision.
    risk: "read",
    describe: () => "Submit the organisation profile for approval",
    precheck: async (ctx) => {
      const { profileState } = await import("@/lib/org-profile.server");
      const state = await profileState(ctx.orgId);
      if (!state.open)
        return "There is no open draft to submit. Propose items first (propose_profile_items), then submit.";
      if (state.open.status === "pending")
        return "This version is already waiting for approval; do not submit it again.";
      if (!(state.open.sections["about"] ?? []).length)
        return "The draft has nothing under About yet — propose at least one About item before submitting.";
      return null;
    },
    run: async (ctx) => {
      const { profileState, submitDraftCore } = await import("@/lib/org-profile.server");
      const before = await profileState(ctx.orgId);
      if (!before.open) throw new Error("There is no open draft to submit.");
      await submitDraftCore(await actor(ctx), { versionId: before.open.id });
      return { versionId: before.open.id, version: before.open.version };
    },
  });
}
