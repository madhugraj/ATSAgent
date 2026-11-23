import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Bot, Hand, PanelLeftClose, PanelLeftOpen, Pin, PinOff, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Copilot } from "@/components/Copilot";
import { NotificationBell } from "@/components/NotificationBell";
import { AgentPopup } from "@/components/AgentPopup";
import { AccountMenu } from "@/components/AccountMenu";
import { CommandPalette } from "@/components/CommandPalette";
import { useNavCtx } from "@/hooks/useNavCtx";
import { useOrg } from "@/hooks/useOrg";
import { useWorkMode } from "@/hooks/useWorkMode";
import { usePins } from "@/hooks/usePins";
import {
  NAV_GROUPS,
  hubForPath,
  tabLabel,
  modeForPath,
  type NavGroup,
  type NavItem,
  type WorkMode,
} from "@/components/nav-config";

/** Where each way of working starts when you switch to it from the other one's page. */
const MODE_HOME: Record<WorkMode, string> = { agent: "/desk", manual: "/requisitions" };
import { BrandFooter, BrandLogo } from "@/components/Brand";

/** Where a panel-only member (interviewer role) lives: their rounds and scorecards. */
const PANEL_HOME = "/interviews/mine";

export function AppShell({ children }: { children: React.ReactNode }) {
  const ctx = useNavCtx();
  const { panelOnly } = useOrg();
  const [mode, setMode, modeReady] = useWorkMode();
  const visible = (i: NavItem) => i.show(ctx) && (!i.mode || i.mode === mode);
  // Each hub with the pages this person may open in this mode; its first page is where it opens.
  const hubs = NAV_GROUPS.flatMap((g) => {
    const items = g.items.filter(visible);
    const first = items[0];
    return first ? [{ ...g, items, first }] : [];
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const searchTab = useRouterState({
    select: (s) => String((s.location.search as Record<string, unknown>)["tab"] ?? ""),
  });
  const [pins, togglePin] = usePins();
  const navigate = useNavigate();

  // The menu follows the page: opening an agent page (e.g. from the bell) while
  // in Manual mode switches to Agent mode, and the other way round.
  const pageMode = modeForPath(pathname);
  const currentHub = hubForPath(pathname);
  const tabHub = hubs.find((h) => h.heading === currentHub?.heading);
  const tabs = tabHub?.items ?? [];
  // The page on screen among its hub's tabs (longest path; /agents tabs differ by ?tab=).
  const currentItem = tabs
    .filter((i) =>
      i.to === "/" ? pathname === "/" : pathname === i.to || pathname.startsWith(`${i.to}/`),
    )
    .filter((i) => !i.search || i.search["tab"] === searchTab)
    .sort((a, b) => b.to.length - a.to.length || Number(!!b.search) - Number(!!a.search))[0];
  useEffect(() => {
    if (modeReady && pageMode && pageMode !== mode) setMode(pageMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow the page (once the saved mode is known)
  }, [pageMode, modeReady]);

  function switchMode(next: WorkMode) {
    if (next === mode) return;
    setMode(next);
    // Leaving a page of the other way of working: go to this one's start page.
    if (pageMode && pageMode !== next) void navigate({ to: MODE_HOME[next] });
  }

  // Collapsed state is remembered per browser so the choice survives reloads.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(localStorage.getItem("atsiq.sidebar") === "collapsed");
  }, []);
  function toggle() {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem("atsiq.sidebar", next ? "collapsed" : "expanded");
      return next;
    });
  }

  // A panel-only member sees one page; every other path sends them there
  // (cosmetic — the server refuses them everywhere else regardless).
  useEffect(() => {
    if (panelOnly && pathname !== PANEL_HOME) void navigate({ to: PANEL_HOME, replace: true });
  }, [panelOnly, pathname, navigate]);
  if (panelOnly)
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <header className="flex h-14 items-center justify-between border-b border-border px-5">
          <Link to={PANEL_HOME} aria-label="My interviews">
            <BrandLogo className="h-6" />
          </Link>
          <AccountMenu />
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 p-6">
          {pathname === PANEL_HOME ? children : null}
        </main>
      </div>
    );

  const itemKey = ({ to, search }: NavItem) =>
    `${to}${search ? `?${new URLSearchParams(search)}` : ""}`;

  // Pinned pages this person can still open in this mode, in the order they were pinned.
  const visibleItems = hubs.flatMap((h) => h.items);
  const pinned = pins.flatMap((k) => visibleItems.filter((i) => itemKey(i) === k).slice(0, 1));
  const currentPinned = currentItem ? pins.includes(itemKey(currentItem)) : false;

  function renderPinned(item: NavItem) {
    const { to, search, label, icon: Icon } = item;
    return (
      <Link
        key={itemKey(item)}
        to={to}
        {...(search ? { search } : {})}
        title={label}
        activeOptions={activeOptions(to)}
        className={`flex items-center gap-3 rounded-md py-1.5 text-sm text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[status=active]:text-sidebar-accent-foreground ${
          collapsed ? "justify-center px-2" : "px-3"
        }`}
      >
        <Icon className="size-4 shrink-0" />
        {collapsed ? null : <span className="truncate">{label}</span>}
      </Link>
    );
  }

  /** One sidebar entry per hub; it opens the hub's first page and stays lit on all of them. */
  function renderHub({ heading, icon: Icon, first }: NavGroup & { first: NavItem }) {
    const active = currentHub?.heading === heading;
    return (
      <Link
        key={heading}
        to={first.to}
        {...(first.search ? { search: first.search } : {})}
        title={heading}
        aria-current={active ? "page" : undefined}
        className={`flex items-center gap-3 rounded-md py-2 text-sm transition-colors ${
          collapsed ? "justify-center px-2" : "px-3"
        } ${
          active
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            : "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        }`}
      >
        <Icon className="size-4 shrink-0" />
        {collapsed ? null : heading}
      </Link>
    );
  }

  // /interviews and /agents must not stay lit on their sub-pages;
  // /agents and its Activity tab differ only by the search.
  const activeOptions = (to: string) => ({
    exact: to === "/" || to === "/interviews" || to === "/agents",
    includeSearch: to === "/agents",
  });

  return (
    <div className="flex min-h-screen">
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 flex-col overflow-y-auto bg-sidebar text-sidebar-foreground transition-[width] duration-200 lg:flex ${
          collapsed ? "w-[68px] p-3" : "w-64 p-5"
        }`}
      >
        <div>
          <div
            className={`mb-6 flex items-center gap-2 ${collapsed ? "justify-center" : "justify-between px-1"}`}
          >
            {collapsed ? null : (
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-[0.2em] text-sidebar-primary">
                  People Excellence
                </div>
                <div className="mt-1 text-lg font-semibold">Talent Acquisition</div>
              </div>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              aria-label={collapsed ? "Expand menu" : "Collapse menu"}
              title={collapsed ? "Expand menu" : "Collapse menu"}
              className="shrink-0 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              {collapsed ? (
                <PanelLeftOpen className="size-4" />
              ) : (
                <PanelLeftClose className="size-4" />
              )}
            </Button>
          </div>
          {pinned.length ? (
            <nav
              aria-label="Pinned"
              className="mb-3 space-y-0.5 border-b border-sidebar-border pb-3"
            >
              {collapsed ? null : (
                <div className="px-3 pb-1 text-[0.625rem] font-semibold uppercase tracking-widest text-sidebar-foreground/40">
                  Pinned
                </div>
              )}
              {pinned.map(renderPinned)}
            </nav>
          ) : null}
          <nav className="space-y-1">{hubs.filter((h) => !h.bottom).map(renderHub)}</nav>
        </div>
        <nav className="mt-auto space-y-1 border-t border-sidebar-border pt-3">
          {hubs.filter((h) => h.bottom).map(renderHub)}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
          <Link to="/" className="flex items-center gap-3">
            <BrandLogo className="h-6" />
            <span className="hidden text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground sm:inline">
              ATSIQ
            </span>
          </Link>
          <div
            role="radiogroup"
            aria-label="Way of working"
            className="flex rounded-lg border border-border bg-muted/60 p-0.5 text-xs"
          >
            {(
              [
                { value: "agent", label: "Agent mode", Icon: Bot, hint: "Hire through the agents" },
                {
                  value: "manual",
                  label: "Manual mode",
                  Icon: Hand,
                  hint: "Do each step yourself",
                },
              ] as const
            ).map(({ value, label, Icon, hint }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                title={hint}
                onClick={() => switchMode(value)}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors ${
                  mode === value
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="size-3.5" aria-hidden />
                <span className="sm:hidden">{label.split(" ")[0]}</span>
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="hidden h-8 gap-2 text-muted-foreground sm:flex"
              onClick={() => setPaletteOpen(true)}
              aria-label="Search (Command K)"
            >
              <Search className="size-4" />
              Search
              <kbd className="rounded border border-border bg-muted px-1 font-mono text-[0.625rem]">
                ⌘K
              </kbd>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 text-muted-foreground sm:hidden"
              onClick={() => setPaletteOpen(true)}
              aria-label="Search (Command K)"
            >
              <Search className="size-4" />
            </Button>
            <NotificationBell />
            <AccountMenu />
          </div>
        </div>
        <div className="flex gap-1 overflow-x-auto border-b border-border bg-card px-4 py-2 lg:hidden">
          {hubs.map(({ heading, first }) => (
            <Link
              key={heading}
              to={first.to}
              {...(first.search ? { search: first.search } : {})}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs ${
                currentHub?.heading === heading
                  ? "bg-secondary font-medium"
                  : "text-muted-foreground"
              }`}
            >
              {heading}
            </Link>
          ))}
        </div>
        {tabs.length > 1 ? (
          <nav
            aria-label={currentHub?.heading}
            className="flex gap-1 overflow-x-auto border-b border-border bg-card px-4 sm:px-6"
          >
            {tabs.map((item) => (
              <Link
                key={itemKey(item)}
                to={item.to}
                {...(item.search ? { search: item.search } : {})}
                activeOptions={activeOptions(item.to)}
                className="-mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground data-[status=active]:border-primary data-[status=active]:font-medium data-[status=active]:text-foreground"
              >
                {tabHub ? tabLabel(tabHub, item) : item.label}
              </Link>
            ))}
            {currentItem ? (
              <button
                type="button"
                onClick={() => togglePin(itemKey(currentItem))}
                aria-pressed={currentPinned}
                title={
                  currentPinned
                    ? `Unpin ${currentItem.label}`
                    : `Pin ${currentItem.label} to the menu`
                }
                aria-label={
                  currentPinned ? `Unpin ${currentItem.label}` : `Pin ${currentItem.label}`
                }
                className="ml-auto flex shrink-0 items-center self-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {currentPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
              </button>
            ) : null}
          </nav>
        ) : null}
        <main className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6">{children}</main>
        <BrandFooter />
      </div>
      <AgentPopup />
      <Copilot />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
