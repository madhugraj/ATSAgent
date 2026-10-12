/**
 * Recruiter-side CV intake.
 *
 * Backs the bulk-upload dialog on the Talent pool page and the CV drop-zone on
 * the requisition sourcing panel. The browser only extracts the raw text and
 * base64-encodes the original file; everything after that — AI parse,
 * talent-pool upsert (deduped inside the org), the private CV vault and the
 * optional requisition application — happens here, scoped to the caller's
 * verified organisation.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireOrg } from "./auth.middleware";
import { ingestCandidate, parseCv } from "./intake.server";

const SaveCvInput = z.object({
  fileName: z.string().min(1).max(300),
  resumeText: z.string().min(20).max(60000),
  /** Original CV, base64-encoded, kept in the private vault when present. */
  fileBase64: z.string().max(20_000_000).optional().nullable(),
  /** Attach the candidate to this requisition (org-checked below). */
  requisitionId: z.string().uuid().nullish(),
  fullName: z.string().max(200).nullish(),
  phone: z.string().max(50).nullish(),
  source: z.string().min(1).max(60),
});

export const saveCv = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => SaveCvInput.parse(data))
  .handler(async ({ data, context }) => {
    // Parse here (with the caller's org for AI routing) rather than inside
    // ingestCandidate so a failed parse surfaces as a clear error, exactly as
    // the old browser-side parse did.
    // Both the parse and the intake count towards this candidate's cost.
    const { withAiSubject } = await import("../server/agents/context");
    const res = await withAiSubject(
      { requisitionId: data.requisitionId ?? null, events: [] },
      async () => {
        const parsed = await parseCv(data.resumeText, context.orgId);
        if (!parsed)
          throw new Error(
            "Could not read the CV — export a text-based PDF or paste the resume text.",
          );

        return ingestCandidate({
          resumeText: data.resumeText,
          fileName: data.fileName,
          requisitionId: data.requisitionId ?? null,
          orgId: context.orgId,
          source: data.source,
          fullName: data.fullName ?? null,
          phone: data.phone ?? null,
          parsed,
          resumeFile: data.fileBase64
            ? {
                filename: data.fileName,
                bytes: new Uint8Array(Buffer.from(data.fileBase64, "base64")),
              }
            : null,
        });
      },
    );

    return {
      candidateId: res.candidateId,
      name: res.name,
      merged: res.merged,
      alreadyApplied: res.alreadyApplied,
      emailMissing: Boolean(res.emailMissing),
      resumeStored: res.resumeStored,
      skills: res.skills,
    };
  });
