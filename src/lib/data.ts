/**
 * UI read layer — thin React Query wrappers over org-scoped server functions.
 * The browser never queries Postgres directly; rows arrive in the same
 * PostgREST wire shapes the routes were written against.
 */
import { queryOptions } from "@tanstack/react-query";

import {
  listAiInterviews,
  listAllScreeningRuns,
  listApplications,
  listCandidateAssessments,
  listCandidates,
  listCandidateNotes,
  listCandidateReferrals,
  listCandidateScreeningKits,
  listCandidateScreeningRuns,
  listCandidateVerifications,
  listDepartments,
  listEvaluations,
  listInterviews,
  listJobDescriptions,
  listOwnershipEvents,
  listMasterItems,
  listMatchScores,
  listOffers,
  listRequisitions,
  listSocialProfiles,
  listTalentRequestSuggestions,
  listTalentRequests,
  listStageEvents,
  listVerifications,
  getRequisition,
  getCandidate,
  globalSearch,
  listLatestJdStatuses,
} from "./queries.functions";
import {
  getScreeningCandidate,
  listScreeningQueue,
  screeningQueueCounts,
} from "./screening-queue.functions";
import type { ScreeningQueueRow } from "./screening-queue.functions";
import type { ScreeningQueueCounts } from "./screening-queue.functions";
import { addMasterItem as addMasterItemFn } from "./master.functions";
import { getLatestBenchmark, type BenchmarkRow } from "./salary-benchmark.functions";
import { listTemplates, type TemplateWire } from "./templates.functions";
import type { Json, Tables } from "@/lib/database.types";

export type Department = Tables<"departments">;
export type Requisition = Tables<"requisitions"> & { job_card_overrides: Json | null };
export type JobDescription = Tables<"job_descriptions"> & { template_name: string | null };
export type Candidate = Tables<"candidates">;
export type Application = Tables<"applications">;
export type MatchScore = Tables<"match_scores">;
export type SocialProfile = Tables<"social_profiles">;
export type Evaluation = Tables<"evaluations">;
export type Interview = Tables<"interviews">;
export type Offer = Tables<"offers"> & {
  letter: Json | null;
  letter_template_id: string | null;
};
export type AiInterview = Tables<"ai_interviews">;
export type MasterItem = Tables<"master_items">;
export type MasterKind =
  | "skill"
  | "location"
  | "education"
  | "employment_type"
  | "industry"
  | "role_title"
  | "billing_type"
  | "engagement_type"
  | "client"
  | "rejection_reason";

export const departmentsQuery = queryOptions({
  queryKey: ["departments"],
  queryFn: async () => (await listDepartments()) as Department[],
});

/** The organisation's reference library: skills, locations, education, employment types, industries. */
export const masterItemsQuery = queryOptions({
  queryKey: ["master_items"],
  queryFn: async () => (await listMasterItems()) as MasterItem[],
});

export function byKind(items: MasterItem[] | undefined, kind: MasterKind) {
  return (items ?? []).filter((i) => i.kind === kind);
}

/** Adds to the library. `existed` is true when the exact entry was already there. */
export async function addMasterItem(kind: MasterKind, name: string, category?: string | null) {
  return (await addMasterItemFn({
    data: { kind, name: name.trim(), category: category ?? null },
  })) as { ok: true; existed: boolean };
}

export const requisitionsQuery = queryOptions({
  queryKey: ["requisitions"],
  queryFn: async () => (await listRequisitions()) as Requisition[],
});

export const requisitionQuery = (id: string) =>
  queryOptions({
    queryKey: ["requisition", id],
    queryFn: async () => (await getRequisition({ data: { id } })) as Requisition | null,
  });

export type { BenchmarkRow } from "./salary-benchmark.functions";
export type { TemplateWire } from "./templates.functions";

export const templatesQuery = queryOptions({
  queryKey: ["templates"],
  queryFn: async () => (await listTemplates()) as TemplateWire[],
});

export const benchmarkQuery = (input: {
  title: string;
  location?: string | null;
  experienceMin: number;
  experienceMax: number;
}) =>
  queryOptions({
    queryKey: ["salary_benchmark", input],
    enabled: input.title.trim().length > 0,
    queryFn: async () =>
      (await getLatestBenchmark({ data: input })) as {
        benchmark: BenchmarkRow;
        stale: boolean;
      } | null,
  });

export const jdQuery = (requisitionId: string) =>
  queryOptions({
    queryKey: ["jd", requisitionId],
    queryFn: async () =>
      (await listJobDescriptions({ data: { requisitionId } })) as JobDescription[],
  });

export const candidatesQuery = queryOptions({
  queryKey: ["candidates"],
  queryFn: async () => (await listCandidates()) as Candidate[],
});

export const candidateQuery = (id: string) =>
  queryOptions({
    queryKey: ["candidate", id],
    queryFn: async () => (await getCandidate({ data: { id } })) as Candidate | null,
  });

export const applicationsQuery = queryOptions({
  queryKey: ["applications"],
  queryFn: async () => (await listApplications()) as Application[],
});

export const matchScoresQuery = queryOptions({
  queryKey: ["match_scores"],
  queryFn: async () => (await listMatchScores()) as MatchScore[],
});

export const socialProfilesQuery = queryOptions({
  queryKey: ["social_profiles"],
  queryFn: async () => (await listSocialProfiles()) as SocialProfile[],
});

export const evaluationsQuery = queryOptions({
  queryKey: ["evaluations"],
  queryFn: async () => (await listEvaluations()) as Evaluation[],
});

export const interviewsQuery = queryOptions({
  queryKey: ["interviews"],
  queryFn: async () => (await listInterviews()) as Interview[],
});

export const offersQuery = queryOptions({
  queryKey: ["offers"],
  queryFn: async () => (await listOffers()) as Offer[],
});

export const aiInterviewsQuery = queryOptions({
  queryKey: ["ai_interviews"],
  queryFn: async () => (await listAiInterviews()) as AiInterview[],
});

export type StageEvent = Tables<"stage_events">;
export type CandidateVerification = Tables<"candidate_verifications">;

export const stageEventsQuery = (applicationIds: string[]) =>
  queryOptions({
    queryKey: ["stage_events", [...applicationIds].sort().join(",")],
    enabled: applicationIds.length > 0,
    queryFn: async () => (await listStageEvents({ data: { applicationIds } })) as StageEvent[],
  });

/** Every verification run; newest first, so the head of each candidate group is current. */
export const verificationsQuery = queryOptions({
  queryKey: ["candidate_verifications"],
  queryFn: async () => (await listVerifications()) as CandidateVerification[],
});

export const candidateVerificationsQuery = (candidateId: string) =>
  queryOptions({
    queryKey: ["candidate_verifications", candidateId],
    queryFn: async () =>
      (await listCandidateVerifications({ data: { candidateId } })) as CandidateVerification[],
  });

export type CandidateAssessment = Tables<"candidate_assessments">;

export const candidateAssessmentsQuery = (candidateId: string) =>
  queryOptions({
    queryKey: ["candidate_assessments", candidateId],
    queryFn: async () =>
      (await listCandidateAssessments({ data: { candidateId } })) as CandidateAssessment[],
  });

/** Latest verification per candidate. */
export function latestVerifications(rows: CandidateVerification[]) {
  const map = new Map<string, CandidateVerification>();
  for (const v of rows) if (!map.has(v.candidate_id)) map.set(v.candidate_id, v);
  return map;
}

/** Latest score per application. */
export function latestScores(scores: MatchScore[]) {
  const map = new Map<string, MatchScore>();
  for (const s of scores) if (!map.has(s.application_id)) map.set(s.application_id, s);
  return map;
}

export type ScreeningKit = Tables<"screening_kits">;
export type ScreeningRun = Tables<"screening_runs">;

/** Screening question kits prepared for one candidate, newest first. */
export const screeningKitsQuery = (candidateId: string) =>
  queryOptions({
    queryKey: ["screening_kits", candidateId],
    queryFn: async () =>
      (await listCandidateScreeningKits({ data: { candidateId } })) as ScreeningKit[],
  });

/** Graded screening calls for one candidate, newest first. */
export const screeningRunsQuery = (candidateId: string) =>
  queryOptions({
    queryKey: ["screening_runs", candidateId],
    queryFn: async () =>
      (await listCandidateScreeningRuns({ data: { candidateId } })) as ScreeningRun[],
  });

/** Every graded screening call in the organisation, newest first. */
export const allScreeningRunsQuery = queryOptions({
  queryKey: ["screening_runs", "all"],
  queryFn: async () => (await listAllScreeningRuns()) as ScreeningRun[],
});

/* ------------------------------------------- screening triage queue (slim) */

export type ScreeningBucket = "to_call" | "ready" | "graded" | "all";

export type { ScreeningQueueRow };

export type ScreeningQueuePage = {
  rows: ScreeningQueueRow[];
  counts: { to_call: number; ready: number; graded: number; all: number };
  total: number;
};

/** One page of the triage queue; counts ride along so tab badges never lie. */
export const screeningQueueQuery = (input: {
  requisitionId?: string | null;
  bucket: ScreeningBucket;
  term?: string;
  offset: number;
  limit?: number;
}) =>
  queryOptions({
    queryKey: ["screening_queue", input],
    queryFn: async () =>
      (await listScreeningQueue({
        data: { ...input, limit: input.limit ?? 50 },
      })) as ScreeningQueuePage,
  });

export type ScreeningCandidateDetail = {
  candidate: Omit<Candidate, "resume_text">;
  application: {
    id: string;
    stage: string;
    applied_at: string;
    requisition_id: string;
    requisition_title: string;
    requisition_code: string | null;
  };
  match: {
    overall_score: number | null;
    rationale: string | null;
    matched_skills: string[];
    missing_skills: string[];
    risk_flags: string[];
    recommendation: string | null;
    computed_at: string | null;
  } | null;
  roles: { application_id: string; requisition_id: string; title: string; stage: string }[];
};

/** The selected candidate's pane data (full profile minus resume text). */
export const screeningCandidateQuery = (candidateId: string, applicationId: string) =>
  queryOptions({
    queryKey: ["screening_candidate", candidateId, applicationId],
    queryFn: async () =>
      (await getScreeningCandidate({
        data: { candidateId, applicationId },
      })) as ScreeningCandidateDetail,
  });

/* ------------------------------------------------- dashboard & ⌘K palette */

/** Bucket counts only — feeds the dashboard strip. The ["screening_queue", …]
 * key prefix means the queue page's invalidations refresh this for free. */
export const screeningQueueCountsQuery = queryOptions({
  queryKey: ["screening_queue", "counts"],
  queryFn: async () => (await screeningQueueCounts()) as ScreeningQueueCounts,
  staleTime: 30_000,
});

export type JdWireStatus = "draft" | "pending_dh" | "approved" | "changes_requested";
export type JdStatusWire = { requisition_id: string; status: JdWireStatus; version: number };

/** Latest JD version per requisition. Writers must invalidate ["jd_statuses"]. */
export const jdStatusesQuery = queryOptions({
  queryKey: ["jd_statuses"],
  queryFn: async () => (await listLatestJdStatuses()) as JdStatusWire[],
  staleTime: 15_000,
});

/** requisition_id → latest JD status (missing entry = no JD version yet). */
export function latestJdStatusMap(rows: JdStatusWire[] | undefined) {
  const m = new Map<string, JdWireStatus>();
  for (const r of rows ?? []) m.set(r.requisition_id, r.status);
  return m;
}

export type SearchCandidateWire = {
  id: string;
  full_name: string;
  email: string | null;
  location: string | null;
  experience_years: number | string | null;
  via_partner_pool: boolean;
};
export type GlobalSearchWire = {
  candidates: SearchCandidateWire[];
  requisitions: { id: string; code: string; title: string; status: string }[];
};

/** ⌘K palette search — slim, redaction-aware, gated to ≥2 chars. */
export const globalSearchQuery = (term: string) =>
  queryOptions({
    queryKey: ["global_search", term.trim().toLowerCase()],
    enabled: term.trim().length >= 2,
    queryFn: async () => (await globalSearch({ data: { term } })) as GlobalSearchWire,
    staleTime: 15_000,
    placeholderData: (prev: GlobalSearchWire | undefined) => prev,
    gcTime: 60_000,
  });

/* ----------------------------- team & sharing queries (ported to drizzle) */

export type CandidateNote = Tables<"candidate_notes">;
export type CandidateReferral = Tables<"candidate_referrals">;
export type TalentRequest = Tables<"talent_requests">;
export type TalentRequestSuggestion = Tables<"talent_request_suggestions">;
export type OwnershipEvent = Tables<"candidate_ownership_events">;

/** Team notes and mentions on one candidate, newest first. */
export const candidateNotesQuery = (candidateId: string) =>
  queryOptions({
    queryKey: ["candidate_notes", candidateId],
    queryFn: async () => (await listCandidateNotes({ data: { candidateId } })) as CandidateNote[],
  });

/** Ownership hand-over audit trail for one candidate, newest first. */
export const ownershipEventsQuery = (candidateId: string) =>
  queryOptions({
    queryKey: ["ownership_events", candidateId],
    queryFn: async () => (await listOwnershipEvents({ data: { candidateId } })) as OwnershipEvent[],
  });

/** Referrals sent between colleagues. */
export const referralsQuery = queryOptions({
  queryKey: ["candidate_referrals"],
  queryFn: async () => (await listCandidateReferrals()) as CandidateReferral[],
});

/** Open + closed "who has people for this?" requests from the team. */
export const talentRequestsQuery = queryOptions({
  queryKey: ["talent_requests"],
  queryFn: async () => (await listTalentRequests()) as TalentRequest[],
});

/** Candidates suggested against those requests. */
export const talentSuggestionsQuery = queryOptions({
  queryKey: ["talent_request_suggestions"],
  queryFn: async () => (await listTalentRequestSuggestions()) as TalentRequestSuggestion[],
});
