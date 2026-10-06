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
  PhoneCall,
  Plug,
  ShieldCheck,
  Target,
  Users,
} from "lucide-react";

import type { NavCtx } from "@/hooks/useNavCtx";

/**
 * Role-scoped journey. Each item carries its own visibility predicate; groups give the
 * sidebar its sections (Sourcing / Pipeline / Intelligence / Governance). Predicates
 * mirror — never replace — the server-side role enforcement on every server function.
 * Shared by the sidebar (AppShell) and the ⌘K command palette (CommandPalette).
 */
export type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  show: (c: NavCtx) => boolean;
};
export type NavGroup = { heading: string | null; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    heading: null,
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard, show: (c) => c.inOrg },
      { to: "/collaboration", label: "Team & sharing", icon: Handshake, show: (c) => c.inOrg },
    ],
  },
  {
    heading: "Pipeline",
    items: [
      { to: "/requisitions", label: "Requisitions & JD", icon: Briefcase, show: (c) => c.inOrg },
      { to: "/candidates", label: "Talent pool", icon: Users, show: (c) => c.recruiterView },
      // Matching is a hiring-team tool: recruiters run it, hiring managers and
      // department heads review the results for their own requisitions.
      {
        to: "/matching",
        label: "JD ↔ CV matching",
        icon: Target,
        show: (c) => c.recruiterView || c.approver,
      },
      { to: "/screening", label: "Screening calls", icon: PhoneCall, show: (c) => c.recruiterView },
      { to: "/interviews", label: "Interviews", icon: CalendarClock, show: (c) => c.recruiterView },
      { to: "/interviews/mine", label: "My interviews", icon: CalendarClock, show: (c) => c.inOrg },
      { to: "/offers", label: "Offers", icon: FileSignature, show: (c) => c.recruiterView },
      { to: "/agents", label: "Agent decisions", icon: Bot, show: (c) => c.inOrg },
    ],
  },
  {
    heading: "Sourcing",
    items: [
      { to: "/inbox", label: "Careers inbox", icon: Inbox, show: (c) => c.recruiterView },
      { to: "/ijp", label: "Internal postings", icon: Building2, show: (c) => c.recruiterView },
    ],
  },
  {
    heading: "Intelligence",
    items: [
      { to: "/reports", label: "Reports", icon: BarChart3, show: (c) => c.approver },
      { to: "/roi", label: "Return on Individual", icon: Gauge, show: (c) => c.leadership },
      { to: "/brain", label: "Talent Brain", icon: Brain, show: (c) => c.leadership },
    ],
  },
  {
    heading: "Governance",
    items: [
      { to: "/team", label: "Users & roles", icon: ShieldCheck, show: (c) => c.governance },
      { to: "/organisation", label: "Organisation", icon: Building2, show: (c) => c.isOwner },
      { to: "/integrations", label: "Integrations", icon: Plug, show: (c) => c.governance },
      { to: "/agents/settings", label: "Agent settings", icon: Bot, show: (c) => c.governance },
      {
        to: "/agents/register",
        label: "Agent register",
        icon: ShieldCheck,
        show: (c) => c.governance,
      },
      {
        to: "/agents/observability",
        label: "Agent observability",
        icon: Activity,
        show: (c) => c.governance,
      },
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
