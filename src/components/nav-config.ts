import {
  Activity,
  BarChart3,
  Bot,
  BookMarked,
  BookOpen,
  Brain,
  Briefcase,
  Building2,
  CalendarClock,
  Coins,
  Database,
  FileSignature,
  Gauge,
  Globe2,
  Handshake,
  Inbox,
  LayoutDashboard,
  LayoutTemplate,
  MessagesSquare,
  PhoneCall,
  Plug,
  ShieldCheck,
  Target,
  Users,
} from "lucide-react";

import type { NavCtx } from "@/hooks/useNavCtx";

/**
 * Role-scoped journey. Each item carries its own visibility predicate; groups give the
 * sidebar its sections. Predicates mirror — never replace — the server-side role
 * enforcement on every server function. Shared by the sidebar (AppShell) and the ⌘K
 * command palette (CommandPalette).
 *
 * `mode` splits the menu between the two ways of working (the top-bar switch):
 * "agent" items show in Agent mode, "manual" items in Manual mode, items without a
 * mode (dashboard, administration, help) in both. Both modes work on the same records.
 */
export type WorkMode = "agent" | "manual";

export type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  show: (c: NavCtx) => boolean;
  mode?: WorkMode;
  /** Search params for links into a tab of a page (e.g. Agent activity). */
  search?: Record<string, string>;
};
export type NavGroup = { heading: string | null; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    heading: null,
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard, show: (c) => c.inOrg },
      // Interviewers submit scorecards in either way of working.
      { to: "/interviews/mine", label: "My interviews", icon: CalendarClock, show: (c) => c.inOrg },
    ],
  },
  {
    heading: "Hiring with agents",
    items: [
      {
        to: "/desk",
        label: "Hiring desk",
        icon: MessagesSquare,
        show: (c) => c.inOrg,
        mode: "agent",
      },
      { to: "/agents", label: "Waiting for you", icon: Bot, show: (c) => c.inOrg, mode: "agent" },
      {
        to: "/agents",
        search: { tab: "activity" },
        label: "Agent activity",
        icon: Activity,
        show: (c) => c.inOrg,
        mode: "agent",
      },
    ],
  },
  {
    heading: "Agent administration",
    items: [
      {
        to: "/agents/settings",
        label: "Agent settings",
        icon: Bot,
        show: (c) => c.governance,
        mode: "agent",
      },
      {
        to: "/agents/observability",
        label: "Agent observability",
        icon: Activity,
        show: (c) => c.governance,
        mode: "agent",
      },
      {
        to: "/agents/register",
        label: "Agent register",
        icon: ShieldCheck,
        show: (c) => c.governance,
        mode: "agent",
      },
    ],
  },
  {
    heading: "Pipeline",
    items: [
      {
        to: "/requisitions",
        label: "Requisitions & JD",
        icon: Briefcase,
        show: (c) => c.inOrg,
        mode: "manual",
      },
      {
        to: "/candidates",
        label: "Talent pool",
        icon: Users,
        show: (c) => c.recruiterView,
        mode: "manual",
      },
      // Matching is a hiring-team tool: recruiters run it, hiring managers and
      // department heads review the results for their own requisitions.
      {
        to: "/matching",
        label: "JD ↔ CV matching",
        icon: Target,
        show: (c) => c.recruiterView || c.approver,
        mode: "manual",
      },
      {
        to: "/screening",
        label: "Screening calls",
        icon: PhoneCall,
        show: (c) => c.recruiterView,
        mode: "manual",
      },
      {
        to: "/interviews",
        label: "Interviews",
        icon: CalendarClock,
        show: (c) => c.recruiterView,
        mode: "manual",
      },
      {
        to: "/offers",
        label: "Offers",
        icon: FileSignature,
        show: (c) => c.recruiterView,
        mode: "manual",
      },
      {
        to: "/collaboration",
        label: "Team & sharing",
        icon: Handshake,
        show: (c) => c.inOrg,
        mode: "manual",
      },
    ],
  },
  {
    heading: "Sourcing",
    items: [
      {
        to: "/inbox",
        label: "Careers inbox",
        icon: Inbox,
        show: (c) => c.recruiterView,
        mode: "manual",
      },
      {
        to: "/ijp",
        label: "Internal postings",
        icon: Building2,
        show: (c) => c.recruiterView,
        mode: "manual",
      },
    ],
  },
  {
    heading: "Intelligence",
    items: [
      {
        to: "/reports",
        label: "Reports",
        icon: BarChart3,
        show: (c) => c.approver,
        mode: "manual",
      },
      {
        to: "/hiring-cost",
        label: "Hiring cost",
        icon: Coins,
        show: (c) => c.governance,
      },
      {
        to: "/roi",
        label: "Return on Individual",
        icon: Gauge,
        show: (c) => c.leadership,
        mode: "manual",
      },
      {
        to: "/brain",
        label: "Talent Brain",
        icon: Brain,
        show: (c) => c.leadership,
        mode: "manual",
      },
    ],
  },
  {
    heading: "Administration",
    items: [
      { to: "/team", label: "Users & roles", icon: ShieldCheck, show: (c) => c.governance },
      { to: "/organisation", label: "Organisation", icon: Building2, show: (c) => c.isOwner },
      { to: "/integrations", label: "Integrations", icon: Plug, show: (c) => c.governance },
      { to: "/masters", label: "Master data", icon: Database, show: (c) => c.governance },
      {
        to: "/templates",
        label: "Content templates",
        icon: LayoutTemplate,
        show: (c) => c.governance,
      },
      {
        to: "/platform",
        label: "Platform console",
        icon: Globe2,
        show: (c) => c.isSuperUser || c.claimable,
      },
      {
        to: "/platform-ai-usage",
        label: "AI usage",
        icon: Coins,
        show: (c) => c.isSuperUser,
      },
      {
        to: "/platform-agents",
        label: "Platform agents",
        icon: Bot,
        show: (c) => c.isSuperUser,
      },
      {
        to: "/catalogue",
        label: "Product catalogue",
        icon: BookMarked,
        show: (c) => c.isSuperUser,
      },
    ],
  },
  {
    heading: null,
    items: [{ to: "/help", label: "User manual", icon: BookOpen, show: () => true }],
  },
];

/** The way of working a page belongs to (null for shared pages), by longest matching path. */
export function modeForPath(pathname: string): WorkMode | null {
  let best: { len: number; mode: WorkMode | null } = { len: -1, mode: null };
  for (const item of NAV_GROUPS.flatMap((g) => g.items)) {
    const to = item.to;
    const hit = to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`);
    if (hit && to.length > best.len) best = { len: to.length, mode: item.mode ?? null };
  }
  return best.mode;
}
