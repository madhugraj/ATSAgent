import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Linkedin, Loader2, Sparkles, Upload } from "lucide-react";

import {
  applicationsQuery,
  candidatesQuery,
  departmentsQuery,
  jdQuery,
  latestScores,
  matchScoresQuery,
  requisitionQuery,
  templatesQuery,
} from "@/lib/data";
import {
  addApplicationsToRequisition,
  advanceRequisition,
  approveJobDescription,
  requestJdChanges,
  saveJobDescription,
  saveRequisitionWeights,
  setRequisitionIjp,
  setRequisitionIjpNotes,
  saveJobCardOverrides,
  syncRequisitionFromJd,
  updateRequisitionCompensation,
} from "@/lib/requisitions.functions";
import {
  draftLinkedinPost,
  generateJd,
  importJd,
  parseResume,
  suggestWeights,
  type SocialJobPost,
  type WeightAdvice,
} from "@/lib/matching.functions";
import { balanceWeights, extractResumeText } from "@/lib/cv-extract";
import { intakeCvs, type IntakeStatus } from "@/lib/cv-intake";
import { rankPool } from "@/lib/shortlist";
import { publishToLinkedIn } from "@/lib/linkedin.functions";
import { getTemplateBackground, getTemplateLogo, validateJobCard } from "@/lib/templates.functions";

import { useRoles } from "@/hooks/useRoles";
import { useOrg } from "@/hooks/useOrg";

import {
  EmptyState,
  PageHeader,
  ScoreChip,
  SkillPills,
  StageBadge,
  StatusBadge,
  inr,
} from "@/components/ats";
import { MarketBenchmark } from "@/components/salary-benchmark";
import { JobCard, ZoneOverlay, type JobCardZone } from "@/components/job-card";
import { JobBoardsSection } from "@/components/requisition-job-boards";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";

export const Route = createFileRoute("/requisitions/$id")({
  head: () => ({
    meta: [
      { title: "Requisition detail & AI job description — ATS" },
      {
        name: "description",
        content:
          "Approve the requisition, draft the job description with AI, tune match weights and review the applicant pipeline.",
      },
      { property: "og:title", content: "Requisition detail & AI job description" },
      {
        property: "og:description",
        content:
          "Approval trail, AI-generated JD versions, weight configuration and applicant match scores.",
      },
    ],
  }),
  component: RequisitionDetail,
});

type TrailEntry = { from?: string; to?: string; at?: string; comment?: string | null };

const APPROVALS: Record<string, { next: string; label: string }> = {
  draft: { next: "pending_dh", label: "Send to Department Head" },
  pending_dh: { next: "pending_hr", label: "Approve as Department Head" },
  pending_hr: { next: "pending_cbo", label: "Approve as HR Head" },
  pending_cbo: { next: "approved", label: "Approve as President / CBO" },
};

function RequisitionDetail() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const req = useQuery(requisitionQuery(id));
  const jds = useQuery(jdQuery(id));
  const depts = useQuery(departmentsQuery);
  const apps = useQuery(applicationsQuery);
  const cands = useQuery(candidatesQuery);
  const scores = useQuery(matchScoresQuery);
  const draftJd = useServerFn(generateJd);
  const runImportJd = useServerFn(importJd);
  const { roles, canApprove, requiredRoleFor, isAdmin } = useRoles();

  const [busy, setBusy] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeStatus, setRevokeStatus] = useState<"rejected" | "closed">("rejected");
  const [revokeReason, setRevokeReason] = useState("");
  const [jdText, setJdText] = useState<string | null>(null);
  const [jdPaste, setJdPaste] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [comment, setComment] = useState("");

  const runSuggestWeights = useServerFn(suggestWeights);
  const runParseResume = useServerFn(parseResume);
  const runDraftPost = useServerFn(draftLinkedinPost);
  const runPublishPost = useServerFn(publishToLinkedIn);

  const [advising, setAdvising] = useState(false);
  const [advice, setAdvice] = useState<WeightAdvice | null>(null);

  const [poolSearch, setPoolSearch] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadLog, setUploadLog] = useState<IntakeStatus[]>([]);

  const [postTone, setPostTone] = useState<"professional" | "warm" | "bold">("professional");
  const [jdTemplateId, setJdTemplateId] = useState("");
  const [postTemplateId, setPostTemplateId] = useState("");
  const [cardTemplateId, setCardTemplateId] = useState("");
  const [cardEditing, setCardEditing] = useState(false);
  const [cardZones, setCardZones] = useState<JobCardZone[] | null>(null);
  const [cardValues, setCardValues] = useState<{
    role: string;
    location: string;
    skills: string[];
    contact: string;
  } | null>(null);

  const { org } = useOrg();
  const orgName = org?.name ?? "Yavar";
  const allTemplates = useQuery(templatesQuery).data ?? [];
  const jobCardTemplates = allTemplates.filter((t) => t.kind === "job_card");
  const cardTemplate =
    jobCardTemplates.find((t) => t.id === cardTemplateId) ??
    jobCardTemplates.find((t) => t.is_default) ??
    null;
  const logoQ = useQuery({
    queryKey: ["template_logo", cardTemplate?.id ?? "none"],
    enabled: Boolean(cardTemplate?.has_logo),
    queryFn: async () => getTemplateLogo({ data: { templateId: cardTemplate!.id } }),
  });
  const cardLogo = logoQ.data?.ok
    ? { base64: logoQ.data.base64, contentType: logoQ.data.contentType }
    : null;
  const bgQ = useQuery({
    queryKey: ["template_background", cardTemplate?.id ?? "none"],
    enabled: Boolean(cardTemplate?.has_background),
    queryFn: async () => getTemplateBackground({ data: { templateId: cardTemplate!.id } }),
  });
  const cardBackground = bgQ.data?.ok
    ? { base64: bgQ.data.base64, contentType: bgQ.data.contentType }
    : null;
  const [cardIssues, setCardIssues] = useState<string[]>([]);
  const [validatingCard, setValidatingCard] = useState(false);
  const [savingCard, setSavingCard] = useState(false);
  const [selectedCardZone, setSelectedCardZone] = useState<number | null>(null);
  const [cardTheme, setCardTheme] = useState<{
    overlayOpacity?: number;
    textColor?: string;
    backgroundBrightness?: number;
    accentColor?: string;
  } | null>(null);
  const [post, setPost] = useState<SocialJobPost | null>(null);
  const [postText, setPostText] = useState("");
  const [postBusy, setPostBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const r = req.data;
  if (req.isLoading) return <p className="text-sm text-muted-foreground">Loading requisition…</p>;
  if (!r) return <EmptyState title="Requisition not found" />;

  const dept = (depts.data ?? []).find((d) => d.id === r.department_id);
  const latestJd = (jds.data ?? [])[0];
  const scoreMap = latestScores(scores.data ?? []);
  const pipeline = (apps.data ?? []).filter((a) => a.requisition_id === r.id);

  const savedOverrides = (r?.job_card_overrides ?? {}) as {
    zones?: JobCardZone[];
    theme?: {
      overlayOpacity?: number;
      textColor?: string;
      backgroundBrightness?: number;
      accentColor?: string;
    };
    values?: { role?: string; location?: string; skills?: string[]; contact?: string };
  };
  const templateZones = (cardTemplate?.config as { zones?: JobCardZone[] } | null)?.zones ?? [];
  const cardZoneList = cardZones ?? savedOverrides.zones ?? templateZones;

  const templateTheme =
    (cardTemplate?.config as {
      overlayOpacity?: number;
      textColor?: string;
      backgroundBrightness?: number;
      accentColor?: string;
    } | null) ?? {};
  const cardThemeFinal = {
    ...templateTheme,
    ...savedOverrides.theme,
    ...cardTheme,
  };
  function updateCardTheme(patch: Partial<typeof cardThemeFinal>) {
    setCardTheme((t) => ({ ...(t ?? {}), ...patch }));
  }

  const cardValuesFinal = {
    role: cardValues?.role ?? savedOverrides.values?.role ?? r.title,
    location: cardValues?.location ?? savedOverrides.values?.location ?? r.location ?? "",
    skills:
      cardValues?.skills ??
      savedOverrides.values?.skills ??
      (latestJd?.must_have?.length ? latestJd.must_have : r.must_have_skills).slice(0, 6),
    contact: cardValues?.contact ?? savedOverrides.values?.contact ?? org?.careers_email ?? "",
  };

  /** Talent-pool candidates not yet applied here, pre-ranked against this JD. */
  const inPipeline = new Set(pipeline.map((a) => a.candidate_id));
  const poolRanked = rankPool(
    (cands.data ?? []).filter((c) => {
      if (inPipeline.has(c.id)) return false;
      const q = poolSearch.trim().toLowerCase();
      if (!q) return true;
      return [c.full_name, c.location ?? "", (c.skills ?? []).join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(q);
    }),
    r,
  ).slice(0, 60);

  const weights = {
    skills: r.weight_skills,
    experience: r.weight_experience,
    career: r.weight_career,
    impact: r.weight_impact,
    education: r.weight_education,
    social: r.weight_social,
  };
  const weightTotal = Object.values(weights).reduce((a, b) => a + b, 0);
  const step = APPROVALS[r.status];
  const allowed = step ? canApprove(r.status) : false;
  // Revocation: a wrong requisition in the approval chain can be rejected by
  // the same hierarchy that approves it; an approved one can be closed by the
  // HR head / president. Server-side advanceRequisition validates both.
  const canReject =
    ["pending_dh", "pending_hr", "pending_cbo"].includes(r.status) && canApprove(r.status);
  const canClose =
    ["approved", "on_hold"].includes(r.status) && (isAdmin || roles.includes("hr_head"));

  async function revoke(next: "rejected" | "closed") {
    if (!revokeReason.trim()) {
      toast.error("A reason is required — it goes on the approval trail");
      return;
    }
    setBusy(true);
    try {
      await advanceRequisition({
        data: { id: r!.id, status: next, comment: revokeReason.trim() },
      });
      toast.success(
        next === "rejected"
          ? "Requisition rejected — the reason is on the approval trail"
          : "Requisition closed",
      );
      setRevokeOpen(false);
      setRevokeReason("");
      qc.invalidateQueries({ queryKey: ["requisition", id] });
      qc.invalidateQueries({ queryKey: ["requisitions"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the requisition");
    } finally {
      setBusy(false);
    }
  }

  async function advance() {
    if (!step) return;
    if (!allowed) {
      toast.error(`Only the ${requiredRoleFor(r!.status)} can action this step`);
      return;
    }
    setBusy(true);
    const trail = [
      ...(Array.isArray(r!.approval_trail) ? (r!.approval_trail as unknown[]) : []),
      {
        from: r!.status,
        to: step.next,
        comment: comment || null,
        at: new Date().toISOString(),
        by_role: roles[0] ?? null,
      },
    ];
    try {
      await advanceRequisition({
        data: { id: r!.id, status: step.next, approvalTrail: trail },
      });
    } catch (e) {
      setBusy(false);
      toast.error(e instanceof Error ? e.message : "Could not advance the requisition");
      return;
    }
    setBusy(false);
    setComment("");
    toast.success(`Requisition moved to ${step.next.replace("_", " ")}`);
    qc.invalidateQueries({ queryKey: ["requisition", id] });
    qc.invalidateQueries({ queryKey: ["requisitions"] });
  }

  async function toggleIjp(enabled: boolean) {
    try {
      await setRequisitionIjp({ data: { id: r!.id, enabled } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the internal posting");
      return;
    }
    toast.success(
      enabled ? "Published to the internal job board" : "Removed from the internal job board",
    );
    qc.invalidateQueries({ queryKey: ["requisition", id] });
    qc.invalidateQueries({ queryKey: ["requisitions"] });
  }

  async function saveIjpNotes(notes: string) {
    try {
      await setRequisitionIjpNotes({ data: { id: r!.id, notes: notes || null } });
    } catch {
      /* the legacy client never surfaced note-save failures */
    }
    qc.invalidateQueries({ queryKey: ["requisition", id] });
  }

  async function draft() {
    setBusy(true);
    try {
      // Explicit pick, else the org default — the generator uses the same resolution.
      const jdTemplate =
        allTemplates.find((t) => t.id === jdTemplateId) ??
        allTemplates.find((t) => t.kind === "jd" && t.is_default) ??
        null;
      const jd = await draftJd({
        data: {
          title: r!.title,
          department: dept?.name ?? null,
          location: r!.location,
          experienceMin: r!.experience_min,
          experienceMax: r!.experience_max,
          mustHave: r!.must_have_skills,
          goodToHave: r!.good_to_have_skills,
          responsibilities: r!.responsibilities,
          education: r!.education_requirement,
          reportingTo: r!.hiring_manager,
          templateId: jdTemplateId || null,
        },
      });
      await saveJobDescription({
        data: {
          requisitionId: r!.id,
          jd,
          templateId: jdTemplate?.id ?? null,
          templateName: jdTemplate?.name ?? null,
        },
      });
      toast.success("JD drafted and sent for Department Head review");
      qc.invalidateQueries({ queryKey: ["jd", id] });
      qc.invalidateQueries({ queryKey: ["jd_statuses"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "JD generation failed");
    } finally {
      setBusy(false);
    }
  }

  /** Take a recruiter's own JD (pasted text or PDF/DOCX/TXT file) and file it as a JD version. */
  async function importExistingJd(raw: string) {
    const text = raw.trim();
    if (text.length < 30) {
      toast.error("Paste or upload the full JD text first");
      return;
    }
    setBusy(true);
    try {
      const jd = await runImportJd({ data: { jdText: text, title: r!.title } });
      await saveJobDescription({ data: { requisitionId: r!.id, jd } });

      // Keep the requisition's scoring baseline in sync with the uploaded JD.
      if (jd.must_have?.length && !r!.must_have_skills.length) {
        await syncRequisitionFromJd({ data: { id: r!.id, mustHaveSkills: jd.must_have } });
      }
      if (jd.good_to_have?.length && !r!.good_to_have_skills.length) {
        await syncRequisitionFromJd({ data: { id: r!.id, goodToHaveSkills: jd.good_to_have } });
      }
      if ((jd.experience_min || jd.experience_max) && !r!.experience_min && !r!.experience_max) {
        await syncRequisitionFromJd({
          data: {
            id: r!.id,
            experienceMin: jd.experience_min,
            experienceMax: Math.max(jd.experience_max, jd.experience_min),
          },
        });
      }

      setJdPaste("");
      setShowImport(false);
      toast.success("Your JD was imported, structured and sent for Department Head review");
      qc.invalidateQueries({ queryKey: ["jd", id] });
      qc.invalidateQueries({ queryKey: ["jd_statuses"] });
      qc.invalidateQueries({ queryKey: ["requisition", id] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "JD import failed");
    } finally {
      setBusy(false);
    }
  }

  async function onJdFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const text = await extractResumeText(file);
      setJdPaste(text);
      await importExistingJd(text);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not read that file");
      setBusy(false);
    }
  }

  async function approveJd() {
    if (!latestJd) return;
    try {
      await approveJobDescription({
        data: { id: latestJd.id, fullText: jdText ?? latestJd.full_text },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not approve the JD");
      return;
    }
    toast.success("JD approved — sourcing can begin");
    qc.invalidateQueries({ queryKey: ["jd", id] });
    qc.invalidateQueries({ queryKey: ["jd_statuses"] });
  }

  async function requestChanges() {
    if (!latestJd) return;
    const comment = window.prompt("What should change in this JD?")?.trim();
    if (!comment) return;
    try {
      await requestJdChanges({ data: { id: latestJd.id, comment } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the JD back");
      return;
    }
    toast.success("Sent back with your comments");
    qc.invalidateQueries({ queryKey: ["jd", id] });
    qc.invalidateQueries({ queryKey: ["jd_statuses"] });
  }

  async function saveWeights(next: typeof weights) {
    try {
      await saveRequisitionWeights({ data: { id: r!.id, weights: next } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the weights");
      return;
    }
    qc.invalidateQueries({ queryKey: ["requisition", id] });
  }

  /* ------------------------------------------------ JD-aware weight advice */

  async function adviseWeights() {
    setAdvising(true);
    try {
      const a = await runSuggestWeights({
        data: {
          title: r!.title,
          mustHave: r!.must_have_skills,
          goodToHave: r!.good_to_have_skills,
          education: r!.education_requirement,
          experienceMin: r!.experience_min,
          experienceMax: r!.experience_max,
          jdText: latestJd?.full_text ?? null,
        },
      });
      setAdvice(a);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not analyse the JD");
    } finally {
      setAdvising(false);
    }
  }

  /* ------------------------------------------------- job card TA corrections */

  function toggleCardEdit() {
    if (!cardEditing) {
      const overrides = (r?.job_card_overrides ?? {}) as {
        zones?: JobCardZone[];
        values?: { role?: string; location?: string; skills?: string[]; contact?: string };
      };
      const tcfg = (cardTemplate?.config ?? {}) as { zones?: JobCardZone[] };
      setCardZones(overrides.zones ?? tcfg.zones ?? []);
      setCardValues({
        role: cardValuesFinal.role,
        location: cardValuesFinal.location,
        skills: cardValuesFinal.skills,
        contact: cardValuesFinal.contact,
      });
      setCardIssues([]);
      setCardTheme(savedOverrides.theme ?? null);
    }
    setSelectedCardZone(null);
    setCardEditing(!cardEditing);
  }

  function updateCardZone(i: number, patch: Partial<JobCardZone>) {
    setCardZones((zs) =>
      (zs ?? templateZones).map((z, idx) => (idx === i ? { ...z, ...patch } : z)),
    );
  }

  function duplicateCardZone(i: number) {
    const source = cardZoneList[i];
    if (!source) return;
    const copy: JobCardZone = {
      ...source,
      x: Math.min(80, source.x + 2),
      y: Math.min(85, source.y + 4),
    };
    setCardZones([...cardZoneList, copy]);
    setSelectedCardZone(cardZoneList.length);
  }

  function removeCardZone(i: number) {
    setCardZones(cardZoneList.filter((_, idx) => idx !== i));
    setSelectedCardZone(null);
  }

  function addCardZone(slot: JobCardZone["slot"]) {
    const fresh: JobCardZone = {
      slot,
      x: 10,
      y: 12 + cardZoneList.length * 11,
      w: 40,
      h: 9,
      fontSize: 32,
      align: "left",
      color: cardThemeFinal.textColor || "#ffffff",
      mask: true,
      fontFamily: "system",
    };
    setCardZones([...cardZoneList, fresh]);
    setSelectedCardZone(cardZoneList.length);
  }

  async function validateCard() {
    const canvas = document.getElementById("job-card-canvas") as HTMLCanvasElement | null;
    if (!canvas || !cardTemplate) return;
    setValidatingCard(true);
    try {
      const out = await validateJobCard({
        data: {
          templateId: cardTemplate.id,
          renderedBase64: canvas.toDataURL("image/png").split(",")[1] ?? "",
          zones: cardZoneList,
        },
      });
      setCardIssues(out.issues ?? []);
      if (out.zones) setCardZones(out.zones as JobCardZone[]);
      toast.success(
        out.issues?.length
          ? `${out.issues.length} gap(s) found — zones corrected on the canvas`
          : "No gaps — the card matches the template",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Validation failed");
    } finally {
      setValidatingCard(false);
    }
  }

  async function saveCard() {
    if (!r) return;
    setSavingCard(true);
    try {
      await saveJobCardOverrides({
        data: {
          id: r.id,
          zones: cardZoneList,
          values: cardValuesFinal,
          theme: {
            ...(cardThemeFinal.overlayOpacity !== undefined
              ? { overlayOpacity: cardThemeFinal.overlayOpacity }
              : {}),
            ...(cardThemeFinal.textColor ? { textColor: cardThemeFinal.textColor } : {}),
            ...(cardThemeFinal.backgroundBrightness !== undefined
              ? { backgroundBrightness: cardThemeFinal.backgroundBrightness }
              : {}),
            ...(cardThemeFinal.accentColor ? { accentColor: cardThemeFinal.accentColor } : {}),
          },
        },
      });
      toast.success("Card corrections saved for this requisition");
      setCardEditing(false);
      qc.invalidateQueries({ queryKey: ["requisition", id] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the corrections");
    } finally {
      setSavingCard(false);
    }
  }

  /* ------------------------------------------------------ market benchmark */

  async function applyBenchmark(v: {
    budgetCtc: string;
    ctcBandMin: string;
    ctcBandMax: string;
    careerLevel: string;
  }) {
    try {
      await updateRequisitionCompensation({
        data: {
          id: r!.id,
          budgetCtc: v.budgetCtc,
          ctcBandMin: v.ctcBandMin,
          ctcBandMax: v.ctcBandMax,
          careerLevel: v.careerLevel,
        },
      });
      toast.success("Budget CTC updated from the market benchmark");
      qc.invalidateQueries({ queryKey: ["requisition", id] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the budget CTC");
    }
  }

  /* ------------------------------------------------------ candidate sourcing */

  /** Attach talent-pool candidates to this requisition as applications. */
  async function addFromPool(ids: string[]) {
    if (ids.length === 0) return;
    const already = new Set(pipeline.map((a) => a.candidate_id));
    const fresh = ids.filter((cid) => !already.has(cid));
    if (fresh.length === 0) {
      toast.info("Those candidates are already in this pipeline");
      return;
    }
    try {
      await addApplicationsToRequisition({
        data: { requisitionId: r!.id, candidateIds: fresh, source: "talent_pool" },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add the candidates");
      return;
    }
    setPicked([]);
    toast.success(`${fresh.length} candidate(s) added — run the Matching engine to score them`);
    qc.invalidateQueries({ queryKey: ["applications"] });
  }

  /** Upload brand-new CVs straight onto this requisition. */
  async function uploadCvs(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    setUploadBusy(true);
    setUploadLog(list.map((f) => ({ file: f.name, state: "pending" as const, message: "Queued" })));
    try {
      const summary = await intakeCvs({
        files: list,
        parse: runParseResume,
        source: "direct",
        requisitionId: r!.id,
        onUpdate: (i, patch) =>
          setUploadLog((l) => l.map((row, idx) => (idx === i ? { ...row, ...patch } : row))),
      });
      await qc.invalidateQueries({ queryKey: ["candidates"] });
      await qc.invalidateQueries({ queryKey: ["applications"] });
      if (summary.failed === 0) toast.success(`${summary.ok} CV(s) added to this requisition`);
      else toast.warning(`${summary.ok} parsed · ${summary.failed} failed`);
    } finally {
      setUploadBusy(false);
    }
  }

  /* ----------------------------------------------------- LinkedIn job post */

  async function makePost() {
    setPostBusy(true);
    try {
      const p = await runDraftPost({
        data: {
          title: r!.title,
          company: orgName,
          location: r!.location,
          openings: r!.openings,
          experienceMin: r!.experience_min,
          experienceMax: r!.experience_max,
          mustHave: r!.must_have_skills,
          goodToHave: r!.good_to_have_skills,
          jdText: latestJd?.full_text ?? null,
          tone: postTone,
          applyUrl:
            typeof window === "undefined" ? null : `${window.location.origin}/apply/${r!.id}`,
          templateId: postTemplateId || null,
        },
      });
      setPost(p);
      setPostText(
        `${p.headline}\n\n${p.body}\n\n${p.call_to_action}\n\n${p.hashtags.map((h) => `#${h}`).join(" ")}`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not draft the post");
    } finally {
      setPostBusy(false);
    }
  }

  async function publishPost() {
    if (!postText.trim()) return;
    setPublishing(true);
    try {
      await runPublishPost({ data: { requisitionId: r!.id, text: postText } });
      toast.success("Posted to LinkedIn — it is live on the company feed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not publish to LinkedIn");
    } finally {
      setPublishing(false);
    }
  }

  return (
    <>
      <Link
        to="/requisitions"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> All requisitions
      </Link>

      <PageHeader
        eyebrow={r.code}
        title={r.title}
        description={`${dept?.name ?? "Unassigned"} · ${r.location} · ${r.openings} opening(s) · ${r.experience_min}–${r.experience_max} yrs · ${inr(Number(r.budget_ctc))}`}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={r.status} />
            {step && (
              <div className="text-right">
                <div className="flex items-center gap-2">
                  {canReject && (
                    <Button
                      variant="outline"
                      className="border-destructive/40 text-destructive hover:bg-destructive/10"
                      onClick={() => {
                        setRevokeStatus("rejected");
                        setRevokeReason("");
                        setRevokeOpen(true);
                      }}
                      disabled={busy}
                    >
                      Reject
                    </Button>
                  )}
                  <Button onClick={advance} disabled={busy || !allowed}>
                    {step.label}
                  </Button>
                </div>
                {!allowed && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Requires the {requiredRoleFor(r.status)} role
                  </p>
                )}
              </div>
            )}
            {canClose && (
              <Button
                variant="outline"
                onClick={() => {
                  setRevokeStatus("closed");
                  setRevokeReason("");
                  setRevokeOpen(true);
                }}
                disabled={busy}
              >
                Close requisition
              </Button>
            )}
          </div>
        }
      />

      <Dialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {revokeStatus === "rejected" ? "Reject this requisition" : "Close this requisition"}
            </DialogTitle>
            <DialogDescription>
              {revokeStatus === "rejected"
                ? "The requisition stops moving through approvals. The reason is recorded on the approval trail and cannot be removed."
                : "The role is closed for everyone. The reason is recorded on the approval trail."}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={3}
            placeholder="Why is this requisition being withdrawn? (required — kept on the audit trail)"
            value={revokeReason}
            onChange={(e) => setRevokeReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => revoke(revokeStatus)}
              disabled={busy || !revokeReason.trim()}
            >
              {busy
                ? "Saving…"
                : revokeStatus === "rejected"
                  ? "Reject requisition"
                  : "Close requisition"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="panel p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-semibold">Job description</h2>
                <p className="text-xs text-muted-foreground">
                  {latestJd
                    ? `Version ${latestJd.version} · ${latestJd.status}${
                        latestJd.template_name ? ` · Format: ${latestJd.template_name}` : ""
                      }`
                    : "No JD drafted yet"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                  value={jdTemplateId}
                  onChange={(e) => setJdTemplateId(e.target.value)}
                  title="JD template — organisation default when empty"
                >
                  <option value="">Default JD format</option>
                  {allTemplates
                    .filter((t) => t.kind === "jd")
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.is_default ? " ★" : ""}
                      </option>
                    ))}
                </select>
                <Button variant="outline" onClick={() => setShowImport((v) => !v)} disabled={busy}>
                  <Upload className="size-4" /> I already have a JD
                </Button>
                <Button variant="outline" onClick={draft} disabled={busy}>
                  <Sparkles className="size-4" /> {latestJd ? "Redraft with AI" : "Draft with AI"}
                </Button>
              </div>
            </div>

            {showImport && (
              <div className="mt-4 space-y-3 rounded-lg border border-dashed border-border p-4">
                <div>
                  <Label className="text-sm">Upload your existing JD</Label>
                  <p className="text-xs text-muted-foreground">
                    PDF, DOCX or TXT. We extract the text, structure it into must-have /
                    good-to-have skills and the experience band, then file it as the next JD version
                    for approval — nothing is rewritten.
                  </p>
                </div>
                <Input
                  type="file"
                  accept=".pdf,.doc,.docx,.txt,.md"
                  disabled={busy}
                  onChange={(e) => onJdFile(e.target.files?.[0])}
                />
                <Textarea
                  rows={8}
                  placeholder="…or paste the JD text here"
                  value={jdPaste}
                  onChange={(e) => setJdPaste(e.target.value)}
                  className="text-xs"
                />
                <div className="flex gap-2">
                  <Button onClick={() => importExistingJd(jdPaste)} disabled={busy}>
                    {busy ? "Importing…" : "Import this JD"}
                  </Button>
                  <Button variant="ghost" onClick={() => setShowImport(false)} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {latestJd ? (
              <div className="mt-4 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label className="text-xs text-muted-foreground">Must have</Label>
                    <div className="mt-1.5">
                      <SkillPills skills={latestJd.must_have} tone="match" />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Good to have</Label>
                    <div className="mt-1.5">
                      <SkillPills skills={latestJd.good_to_have} />
                    </div>
                  </div>
                </div>
                <Textarea
                  rows={16}
                  className="num text-xs leading-relaxed"
                  value={jdText ?? latestJd.full_text ?? ""}
                  onChange={(e) => setJdText(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button onClick={approveJd} disabled={latestJd.status === "approved"}>
                    {latestJd.status === "approved" ? "JD approved" : "Approve JD"}
                  </Button>
                  {latestJd.status === "pending_dh" ? (
                    <Button variant="outline" onClick={requestChanges}>
                      Request changes
                    </Button>
                  ) : null}
                  <Button asChild variant="outline">
                    <Link to="/matching" search={{ req: r.id }}>
                      Score candidates against this JD
                    </Link>
                  </Button>
                </div>
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">
                Generate a JD from the requisition inputs — must-have skills, experience band and
                responsibilities become the scoring baseline for JD↔CV matching.
              </p>
            )}
          </section>

          {/* ---------------------------------------- Source candidates */}
          <section className="panel p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">Source candidates for this JD</h2>
                <p className="text-xs text-muted-foreground">
                  Pull people already in the talent pool — pre-ranked on must-have overlap and
                  experience band — or drop in fresh CVs. Added candidates become applications, then
                  the Matching engine does the full AI + social scoring.
                </p>
              </div>
              <Button asChild variant="outline">
                <Link to="/matching" search={{ req: r.id }}>
                  Open matching engine
                </Link>
              </Button>
            </div>

            <div className="mt-4 grid gap-5 lg:grid-cols-2">
              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">
                  From the talent pool
                </Label>
                <Input
                  placeholder="Search name, skill or location…"
                  value={poolSearch}
                  onChange={(e) => setPoolSearch(e.target.value)}
                />
                <ul className="mt-3 max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                  {poolRanked.length === 0 && (
                    <li className="p-4 text-xs text-muted-foreground">
                      No unattached candidates match. Add CVs to the talent pool first.
                    </li>
                  )}
                  {poolRanked.map((p) => (
                    <li key={p.candidate.id} className="flex items-center gap-3 p-3">
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--primary)]"
                        checked={picked.includes(p.candidate.id)}
                        onChange={(e) =>
                          setPicked((prev) =>
                            e.target.checked
                              ? [...prev, p.candidate.id]
                              : prev.filter((x) => x !== p.candidate.id),
                          )
                        }
                      />
                      <ScoreChip score={p.fit} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{p.candidate.full_name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {p.candidate.experience_years} yrs · {p.candidate.location ?? "—"} ·{" "}
                          {p.mustHits.length}/{r.must_have_skills.length || 0} must-haves
                          {p.experienceOk ? "" : " · outside band"}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button onClick={() => addFromPool(picked)} disabled={picked.length === 0}>
                    Add {picked.length || ""} to pipeline
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setPicked(poolRanked.slice(0, 10).map((p) => p.candidate.id))}
                    disabled={poolRanked.length === 0}
                  >
                    Auto-shortlist top 10
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Pre-rank is a free keyword/experience overlap — it decides who to score, never who
                  to hire.
                </p>
              </div>

              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">
                  Upload new CVs onto this requisition
                </Label>
                <Input
                  type="file"
                  multiple
                  disabled={uploadBusy}
                  accept=".pdf,.docx,.txt,.md"
                  onChange={(e) => {
                    uploadCvs(e.target.files);
                    e.target.value = "";
                  }}
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Each CV is read in the browser, AI-parsed into structured fields, saved to the
                  talent pool (existing emails are updated, not duplicated) and applied to this
                  requisition.
                </p>
                {uploadLog.length > 0 && (
                  <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto text-xs">
                    {uploadLog.map((l, i) => (
                      <li
                        key={i}
                        className={
                          l.state === "error"
                            ? "text-destructive"
                            : l.state === "ok"
                              ? "text-muted-foreground"
                              : "text-foreground"
                        }
                      >
                        <span className="font-medium">{l.file}</span> — {l.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>

          {/* ---------------------------------------- LinkedIn post designer */}
          <section className="panel p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">LinkedIn job post</h2>
                <p className="text-xs text-muted-foreground">
                  {r.status === "approved"
                    ? "Design the post from the approved JD, preview it exactly as it will appear, then publish."
                    : "Available once the requisition is approved — approve it above to design the post."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                  value={postTemplateId}
                  onChange={(e) => setPostTemplateId(e.target.value)}
                  title="Post template — organisation default when empty"
                >
                  <option value="">Default post format</option>
                  {allTemplates
                    .filter((t) => t.kind === "linkedin_post")
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.is_default ? " ★" : ""}
                      </option>
                    ))}
                </select>
                <select
                  className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                  value={postTone}
                  onChange={(e) => setPostTone(e.target.value as typeof postTone)}
                >
                  <option value="professional">Professional</option>
                  <option value="warm">Warm</option>
                  <option value="bold">Bold</option>
                </select>
                <Button onClick={makePost} disabled={postBusy || r.status !== "approved"}>
                  <Sparkles className="size-4" />{" "}
                  {postBusy ? "Designing…" : post ? "Redesign" : "Design post"}
                </Button>
              </div>
            </div>

            {post && (
              <div className="mt-4 grid gap-5 lg:grid-cols-2">
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center gap-3">
                    <div className="grid size-11 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                      {orgName.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="text-sm font-semibold">{orgName}</div>
                      <div className="text-xs text-muted-foreground">Company · Just now</div>
                    </div>
                  </div>
                  <p className="mt-3 text-sm font-medium">{post.headline}</p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{post.body}</p>
                  <p className="mt-2 text-sm text-primary">
                    {post.hashtags.map((h) => `#${h}`).join(" ")}
                  </p>
                  <p className="mt-3 text-sm font-medium">{post.call_to_action}</p>
                </div>

                <div className="space-y-3">
                  <Textarea
                    rows={14}
                    className="text-xs leading-relaxed"
                    value={postText}
                    onChange={(e) => setPostText(e.target.value)}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={publishPost} disabled={publishing || !postText.trim()}>
                      {publishing ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Linkedin className="size-4" />
                      )}
                      {publishing ? "Publishing…" : "Publish to LinkedIn"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={async () => {
                        await navigator.clipboard.writeText(postText);
                        toast.success("Post copied — paste it into LinkedIn");
                      }}
                    >
                      Copy post
                    </Button>
                    <Button asChild variant="ghost">
                      <Link to="/integrations">LinkedIn connection</Link>
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Publishing as your company's LinkedIn account — nothing to set up here. The post
                    carries your ATSIQ apply link, so every CV people send from LinkedIn lands in
                    the talent pool and in this pipeline automatically, already read and scored.
                    Copy-paste still works if you prefer.
                  </p>
                </div>
              </div>
            )}

            {r.status === "approved" && (
              <div className="mt-6 border-t border-border pt-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h3 className="font-semibold">Job card image</h3>
                    <p className="text-xs text-muted-foreground">
                      Branded advert image for WhatsApp and feed sharing — post the text above as
                      the caption. Theme it up on Content templates.
                    </p>
                  </div>
                  {jobCardTemplates.length > 0 && (
                    <select
                      className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                      value={cardTemplateId}
                      onChange={(e) => setCardTemplateId(e.target.value)}
                    >
                      <option value="">Default theme</option>
                      {jobCardTemplates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                          {t.is_default ? " ★" : ""}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="mt-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant={cardEditing ? "secondary" : "outline"}
                      onClick={toggleCardEdit}
                    >
                      {cardEditing ? "Done editing" : "Correct layout & text"}
                    </Button>
                    {cardEditing && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={validateCard}
                          disabled={validatingCard || !cardTemplate?.has_background}
                          title={
                            cardTemplate?.has_background
                              ? "AI compare against the template artwork"
                              : "Available for templates with background artwork"
                          }
                        >
                          {validatingCard ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Sparkles className="size-4" />
                          )}
                          {validatingCard ? "Validating…" : "Check vs template"}
                        </Button>
                        <Button size="sm" onClick={saveCard} disabled={savingCard}>
                          {savingCard ? "Saving…" : "Save corrections"}
                        </Button>
                      </>
                    )}
                  </div>
                  {cardEditing && (
                    <div className="mb-3 grid gap-2 sm:grid-cols-2">
                      <Input
                        value={cardValuesFinal.role}
                        onChange={(e) =>
                          setCardValues((v) => ({
                            role: e.target.value,
                            location: v?.location ?? "",
                            skills: v?.skills ?? [],
                            contact: v?.contact ?? "",
                          }))
                        }
                        placeholder="Role text"
                      />
                      <Input
                        value={cardValuesFinal.location}
                        onChange={(e) =>
                          setCardValues((v) => ({
                            role: v?.role ?? "",
                            location: e.target.value,
                            skills: v?.skills ?? [],
                            contact: v?.contact ?? "",
                          }))
                        }
                        placeholder="Location"
                      />
                      <Input
                        value={cardValuesFinal.skills.join(", ")}
                        onChange={(e) =>
                          setCardValues((v) => ({
                            role: v?.role ?? "",
                            location: v?.location ?? "",
                            skills: e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                            contact: v?.contact ?? "",
                          }))
                        }
                        placeholder="Skills, comma-separated"
                      />
                      <Input
                        value={cardValuesFinal.contact}
                        onChange={(e) =>
                          setCardValues((v) => ({
                            role: v?.role ?? "",
                            location: v?.location ?? "",
                            skills: v?.skills ?? [],
                            contact: e.target.value,
                          }))
                        }
                        placeholder="Contact (careers email)"
                      />
                    </div>
                  )}
                  {cardEditing && (
                    <div className="mb-3 rounded-md border border-dashed border-border p-3">
                      <Label className="mb-1 block text-xs text-muted-foreground">
                        Background touch-up
                      </Label>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div>
                          <Label className="text-[10px] uppercase text-muted-foreground">
                            Dark overlay ({cardThemeFinal.overlayOpacity ?? 0}%)
                          </Label>
                          <input
                            type="range"
                            min={0}
                            max={75}
                            value={cardThemeFinal.overlayOpacity ?? 0}
                            onChange={(e) =>
                              updateCardTheme({ overlayOpacity: Number(e.target.value) })
                            }
                            className="w-full"
                          />
                        </div>
                        <div>
                          <Label className="text-[10px] uppercase text-muted-foreground">
                            Artwork brightness ({cardThemeFinal.backgroundBrightness ?? 100}%)
                          </Label>
                          <input
                            type="range"
                            min={50}
                            max={130}
                            value={cardThemeFinal.backgroundBrightness ?? 100}
                            onChange={(e) =>
                              updateCardTheme({ backgroundBrightness: Number(e.target.value) })
                            }
                            className="w-full"
                          />
                        </div>
                      </div>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        Saved with the corrections for this requisition.
                      </p>
                    </div>
                  )}
                  {cardEditing &&
                    selectedCardZone !== null &&
                    cardZoneList[selectedCardZone] &&
                    (() => {
                      const zone = cardZoneList[selectedCardZone]!;
                      const stepper = (
                        field: "x" | "y" | "w" | "h" | "fontSize",
                        step: number,
                        min = 0,
                      ) => (
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 px-2"
                            onClick={() =>
                              updateCardZone(selectedCardZone, {
                                [field]: Math.max(min, (zone[field] ?? 0) - step),
                              } as Partial<JobCardZone>)
                            }
                          >
                            −
                          </Button>
                          <span className="num min-w-9 text-center text-xs">
                            {Math.round(zone[field] ?? 0)}
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 px-2"
                            onClick={() =>
                              updateCardZone(selectedCardZone, {
                                [field]: (zone[field] ?? 0) + step,
                              } as Partial<JobCardZone>)
                            }
                          >
                            +
                          </Button>
                        </div>
                      );
                      return (
                        <div className="mb-3 rounded-md border border-border p-3">
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              Zone: {zone.slot}
                            </span>
                            <div className="flex gap-1.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => duplicateCardZone(selectedCardZone)}
                              >
                                Duplicate
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive"
                                onClick={() => removeCardZone(selectedCardZone)}
                              >
                                Remove
                              </Button>
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                            {(
                              [
                                ["x", 1, 0],
                                ["y", 1, 0],
                                ["w", 1, 1],
                                ["h", 1, 1],
                                ["fontSize", 2, 8],
                              ] as const
                            ).map(([field, step, min]) => (
                              <div key={field}>
                                <Label className="text-[10px] uppercase text-muted-foreground">
                                  {field}
                                </Label>
                                {stepper(field, step, min)}
                              </div>
                            ))}
                            <div>
                              <Label className="text-[10px] uppercase text-muted-foreground">
                                align
                              </Label>
                              <select
                                className="h-7 w-full rounded-md border bg-background px-1 text-xs"
                                value={zone.align}
                                onChange={(e) =>
                                  updateCardZone(selectedCardZone, {
                                    align: e.target.value as JobCardZone["align"],
                                  })
                                }
                              >
                                <option value="left">left</option>
                                <option value="center">center</option>
                                <option value="right">right</option>
                              </select>
                            </div>
                            <div>
                              <Label className="text-[10px] uppercase text-muted-foreground">
                                font
                              </Label>
                              <select
                                className="h-7 w-full rounded-md border bg-background px-1 text-xs"
                                value={zone.fontFamily ?? "system"}
                                onChange={(e) =>
                                  updateCardZone(selectedCardZone, {
                                    fontFamily: e.target.value as "system" | "serif" | "mono",
                                  })
                                }
                              >
                                <option value="system">System</option>
                                <option value="serif">Serif</option>
                                <option value="mono">Mono</option>
                              </select>
                            </div>
                            <div>
                              <Label className="text-[10px] uppercase text-muted-foreground">
                                colour
                              </Label>
                              <input
                                type="color"
                                value={zone.color ?? cardThemeFinal.textColor ?? "#ffffff"}
                                onChange={(e) =>
                                  updateCardZone(selectedCardZone, { color: e.target.value })
                                }
                                className="h-7 w-full cursor-pointer rounded-md border bg-background p-0.5"
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  {cardEditing && cardIssues.length > 0 && (
                    <ul className="mb-3 list-disc space-y-1 rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                      {cardIssues.map((issue, i) => (
                        <li key={i}>{issue}</li>
                      ))}
                    </ul>
                  )}
                  <JobCard
                    orgName={orgName}
                    logo={cardLogo}
                    theme={{
                      accentColor: cardThemeFinal.accentColor ?? "#4f46e5",
                      layout:
                        (cardTemplate?.config as { layout?: "banner" | "side" | "artwork" } | null)
                          ?.layout ?? "banner",
                      overlayOpacity: cardThemeFinal.overlayOpacity ?? 0,
                      backgroundBrightness: cardThemeFinal.backgroundBrightness ?? 100,
                      ...(cardThemeFinal.textColor ? { textColor: cardThemeFinal.textColor } : {}),
                      zones: cardZoneList,
                    }}
                    background={cardBackground}
                    overlay={
                      cardEditing ? (
                        <ZoneOverlay
                          zones={cardZoneList}
                          selected={selectedCardZone}
                          onSelect={setSelectedCardZone}
                          onChange={(i, patch) =>
                            setCardZones((zs) =>
                              (zs ?? templateZones).map((z, idx) =>
                                idx === i ? { ...z, ...patch } : z,
                              ),
                            )
                          }
                        />
                      ) : undefined
                    }
                    canvasId="job-card-canvas"
                    title={cardValuesFinal.role}
                    location={cardValuesFinal.location}
                    experienceMin={r.experience_min}
                    experienceMax={r.experience_max}
                    openings={r.openings}
                    skills={cardValuesFinal.skills}
                    contactValue={cardValuesFinal.contact}
                    applyUrl={
                      typeof window === "undefined" ? "" : `${window.location.origin}/apply/${r.id}`
                    }
                    fileName={`job-card-${r.code}`}
                  />
                </div>
              </div>
            )}
          </section>

          <JobBoardsSection requisitionId={r.id} approved={r.status === "approved"} />

          <section className="panel">
            <div className="border-b border-border p-5">
              <h2 className="font-semibold">Applicant pipeline</h2>
              <p className="text-xs text-muted-foreground">{pipeline.length} applicant(s)</p>
            </div>
            {pipeline.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">
                No applications against this requisition yet.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {pipeline.map((a) => {
                  const c = (cands.data ?? []).find((x) => x.id === a.candidate_id);
                  const s = scoreMap.get(a.id);
                  return (
                    <li key={a.id} className="flex items-center gap-4 p-4">
                      {s ? (
                        <ScoreChip score={s.overall_score} />
                      ) : (
                        <span className="num w-12 text-center text-xs text-muted-foreground">
                          —
                        </span>
                      )}
                      <Link
                        to="/candidates/$id"
                        params={{ id: a.candidate_id }}
                        className="min-w-0 flex-1 hover:underline"
                      >
                        <div className="truncate font-medium">{c?.full_name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {c?.experience_years} yrs · {c?.location} · via {a.source}
                        </div>
                      </Link>
                      <StageBadge stage={a.stage} />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <div className="space-y-6">
          <section className="panel p-5">
            <h2 className="font-semibold">Match weight configuration</h2>
            <p className="text-xs text-muted-foreground">
              Applied to every JD↔CV score for this requisition. Total must be 100.
            </p>
            <div className="mt-4 space-y-4">
              {(
                [
                  ["skills", "Skills fit"],
                  ["experience", "Experience"],
                  ["career", "Career history"],
                  ["impact", "Impact & innovation"],
                  ["education", "Education"],
                  ["social", "Social profiling"],
                ] as const
              ).map(([key, label]) => (
                <div key={key}>
                  <div className="mb-1.5 flex items-center justify-between text-sm">
                    <span>{label}</span>
                    <span className="num font-semibold">{weights[key]}</span>
                  </div>
                  <Slider
                    value={[weights[key]]}
                    min={0}
                    max={70}
                    step={5}
                    onValueChange={([v]) => saveWeights({ ...weights, [key]: v })}
                  />
                </div>
              ))}
              <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                <p
                  className={
                    weightTotal === 100
                      ? "num text-xs text-muted-foreground"
                      : "num text-xs text-destructive"
                  }
                >
                  Total {weightTotal} / 100
                  {weightTotal !== 100 ? " — rebalance before scoring" : ""}
                </p>
                {weightTotal !== 100 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => saveWeights(balanceWeights(weights))}
                  >
                    Balance to 100
                  </Button>
                )}
              </div>

              <div className="border-t border-border pt-3">
                <Button size="sm" variant="outline" onClick={adviseWeights} disabled={advising}>
                  <Sparkles className="size-4" />{" "}
                  {advising ? "Reading the JD…" : "Suggest weights from this JD"}
                </Button>
                {advice && (
                  <div className="mt-3 space-y-2 rounded-lg border border-dashed border-border p-3 text-xs">
                    <p className="num font-semibold">
                      Skills {advice.skills} · Experience {advice.experience} · Career{" "}
                      {advice.career} · Impact {advice.impact} · Education {advice.education} ·
                      Social {advice.social}
                    </p>
                    <p className="text-muted-foreground">{advice.rationale}</p>
                    {advice.notes.length > 0 && (
                      <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                        {advice.notes.map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                    )}
                    <div className="flex gap-2 pt-1">
                      <Button
                        size="sm"
                        onClick={() =>
                          saveWeights({
                            skills: advice.skills,
                            experience: advice.experience,
                            career: advice.career,
                            impact: advice.impact,
                            education: advice.education,
                            social: advice.social,
                          })
                        }
                      >
                        Apply these weights
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setAdvice(null)}>
                        Dismiss
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          <MarketBenchmark
            title={r.title}
            location={r.location}
            experienceMin={r.experience_min}
            experienceMax={r.experience_max}
            requisitionId={r.id}
            panel
            preload
            onApply={applyBenchmark}
          />

          <section className="panel p-5">
            <h2 className="font-semibold">Internal job posting (IJP)</h2>
            <p className="text-xs text-muted-foreground">
              Publish an approved requisition to employees first. Internal applicants are scored
              against the same JD.
            </p>
            <div className="mt-4 flex items-center justify-between gap-3">
              <div className="text-sm">
                {r.status === "approved"
                  ? r.ijp_enabled
                    ? "Live on the internal job board"
                    : "Not published internally"
                  : "Available once the requisition is approved"}
              </div>
              <Switch
                checked={r.ijp_enabled}
                disabled={r.status !== "approved"}
                onCheckedChange={toggleIjp}
              />
            </div>
            {r.ijp_enabled && (
              <div className="mt-4">
                <Label className="mb-1.5 block text-xs text-muted-foreground">
                  Note for employees
                </Label>
                <Textarea
                  rows={3}
                  defaultValue={r.ijp_notes ?? ""}
                  onBlur={(e) => saveIjpNotes(e.target.value)}
                  placeholder="Eligibility, minimum tenure, manager endorsement…"
                />
                <Button asChild size="sm" variant="outline" className="mt-3">
                  <Link to="/ijp">Open internal job board</Link>
                </Button>
              </div>
            )}
          </section>

          <section className="panel p-5">
            <h2 className="font-semibold">Approval trail</h2>
            <ol className="mt-3 space-y-3 text-sm">
              {(Array.isArray(r.approval_trail)
                ? (r.approval_trail as unknown as TrailEntry[])
                : []
              ).map((t, i) => (
                <li key={i} className="border-l-2 border-border pl-3">
                  <div className="font-medium">
                    {String(t.from ?? "").replace("_", " ")} →{" "}
                    {String(t.to ?? "").replace("_", " ")}
                  </div>
                  <div className="num text-xs text-muted-foreground">
                    {t.at ? new Date(t.at).toLocaleString() : ""}
                  </div>
                  {t.comment ? <p className="mt-1 text-xs">{t.comment}</p> : null}
                </li>
              ))}
              {(!Array.isArray(r.approval_trail) || r.approval_trail.length === 0) && (
                <li className="text-xs text-muted-foreground">No approval actions recorded yet.</li>
              )}
            </ol>
            {step && (
              <div className="mt-4">
                <Label className="mb-1.5 block text-xs text-muted-foreground">
                  Approver comment
                </Label>
                <Input
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Optional note"
                />
              </div>
            )}
          </section>

          <section className="panel p-5">
            <h2 className="font-semibold">Requisition inputs</h2>
            <div className="mt-3 space-y-3 text-sm">
              <div>
                <Label className="text-xs text-muted-foreground">Must have</Label>
                <div className="mt-1.5">
                  <SkillPills skills={r.must_have_skills} tone="match" />
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Good to have</Label>
                <div className="mt-1.5">
                  <SkillPills skills={r.good_to_have_skills} />
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Education</Label>
                <p>{r.education_requirement ?? "—"}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Hiring manager</Label>
                <p>{r.hiring_manager ?? "—"}</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
