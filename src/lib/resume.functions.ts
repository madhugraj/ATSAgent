/**
 * Authenticated CV delivery from the private resume vault. The bytes travel
 * through ATSIQ so browser privacy tools never need to open the vault host.
 */
import { and, eq } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { candidates } from "@db/schema";
import { requireOrg } from "./auth.middleware";
import { getObject, isStorageConfigured } from "../server/storage";

export const getResumeDownloadUrl = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .validator((data: unknown) => z.object({ candidateId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const [candidate] = await db
      .select({
        id: candidates.id,
        fullName: candidates.fullName,
        resumeFilePath: candidates.resumeFilePath,
      })
      .from(candidates)
      .where(and(eq(candidates.id, data.candidateId), eq(candidates.orgId, context.orgId)))
      .limit(1);
    if (!candidate?.resumeFilePath) {
      return { ok: false as const, error: "No original CV file is stored for this candidate." };
    }
    // Defence in depth: the vault path must live inside this org's folder.
    if (!candidate.resumeFilePath.startsWith(`${context.orgId}/`)) {
      return { ok: false as const, error: "That CV file could not be opened." };
    }
    if (!isStorageConfigured()) {
      return { ok: false as const, error: "The CV vault is not configured on this deployment." };
    }
    let file: { bytes: Uint8Array; contentType: string } | null;
    try {
      file = await getObject(candidate.resumeFilePath);
    } catch {
      return { ok: false as const, error: "That CV file could not be opened." };
    }
    if (!file) {
      return { ok: false as const, error: "That CV file could not be opened." };
    }
    if (file.bytes.byteLength > 20 * 1024 * 1024) {
      return { ok: false as const, error: "That CV is too large to download through ATSIQ." };
    }
    const storedName = candidate.resumeFilePath.split("/").pop() ?? "resume.pdf";
    let filename = storedName;
    try {
      filename = decodeURIComponent(storedName);
    } catch {
      // Keep the stored name when it is not URI encoded.
    }
    return {
      ok: true as const,
      base64: Buffer.from(file.bytes).toString("base64"),
      contentType: file.contentType || "application/octet-stream",
      filename: filename || `${candidate.fullName || "candidate"}-CV.pdf`,
    };
  });
