import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Bot, Hand, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Copilot } from "@/components/Copilot";
import { NotificationBell } from "@/components/NotificationBell";
import { AccountMenu } from "@/components/AccountMenu";
import { CommandPalette } from "@/components/CommandPalette";
import { useNavCtx } from "@/hooks/useNavCtx";
import { useWorkMode } from "@/hooks/useWorkMode";
import { NAV_GROUPS, modeForPath, type NavItem, type WorkMode } from "@/components/nav-config";

/** Where each way of working starts when you switch to it from the other one's page. */
const MODE_HOME: Record<WorkMode, string> = { agent: "/desk", manual: "/requisitions" };
import { BrandFooter, BrandLogo } from "@/components/Brand";

export function AppShell({ children }: { children: React.ReactNode }) {
  const ctx = useNavCtx();
  const [mode, setMode, modeReady] = useWorkMode();
  const visible = (i: NavItem) => i.show(ctx) && (!i.mode || i.mode === mode);
  const nav = NAV_GROUPS.flatMap((g) => g.items).filter(visible);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();

  // The menu follows the page: opening an agent page (e.g. from the bell) while
  // in Manual mode switches to Agent mode, and the other way round.
  const pageMode = modeForPath(pathname);
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

  function renderLink({ to, label, icon: Icon, search }: NavItem) {
    // /interviews and /agents must not stay highlighted on their sub-pages;
    // /agents and its Activity tab differ only by the search.
    const exact = to === "/" || to === "/interviews" || to === "/agents";
    return (
      <Link
        key={`${to}${search ? `?${new URLSearchParams(search)}` : ""}`}
        to={to}
        {...(search ? { search } : {})}
        title={label}
        activeOptions={{ exact, includeSearch: to === "/agents" }}
        className={`flex items-center gap-3 rounded-md py-2 text-sm text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ${
          collapsed ? "justify-center px-2" : "px-3"
        }`}
        activeProps={{
          className: `flex items-center gap-3 rounded-md py-2 text-sm bg-sidebar-accent text-sidebar-accent-foreground font-medium ${
            collapsed ? "justify-center px-2" : "px-3"
          }`,
        }}
      >
        <Icon className="size-4 shrink-0" />
        {collapsed ? null : label}
      </Link>
    );
  }

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
          <nav className="space-y-1">
            {NAV_GROUPS.map((group, gi) => {
              const items = group.items.filter(visible);
              if (!items.length) return null;
              return (
                <div key={group.heading ?? `core-${gi}`} className={group.heading ? "pt-3" : ""}>
                  {group.heading && !collapsed ? (
                    <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/40">
                      {group.heading}
                    </div>
                  ) : null}
                  <div className="space-y-1">{items.map((item) => renderLink(item))}</div>
                </div>
              );
            })}
          </nav>
        </div>
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
              <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">
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
          {nav.map(({ to, label, search }) => (
            <Link
              key={`${to}${search ? `?${new URLSearchParams(search)}` : ""}`}
              to={to}
              {...(search ? { search } : {})}
              activeOptions={{
                exact: to === "/" || to === "/interviews" || to === "/agents",
                includeSearch: to === "/agents",
              }}
              className="whitespace-nowrap rounded-md px-3 py-1.5 text-xs text-muted-foreground"
              activeProps={{
                className:
                  "whitespace-nowrap rounded-md px-3 py-1.5 text-xs bg-secondary font-medium",
              }}
            >
              {label}
            </Link>
          ))}
        </div>
        <main className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6">{children}</main>
        <BrandFooter />
      </div>
      <Copilot />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
