import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bell, CheckCheck } from "lucide-react";
import { useState } from "react";

import { myNotifications } from "@/lib/notifications.functions";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";

/** Live action inbox: approvals, interviews, offers, invitations, pending tenants. */
export function NotificationBell() {
  const fetchAll = useServerFn(myNotifications);
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["notifications"],
    queryFn: () => fetchAll({}),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 2,
  });
  const items = q.data ?? [];
  const urgent = items.filter((n) => n.severity === "urgent").length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
          <Bell className="size-4" />
          {items.length ? (
            <span
              className={`absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] font-semibold ${
                urgent
                  ? "bg-destructive text-destructive-foreground"
                  : "bg-primary text-primary-foreground"
              }`}
            >
              {items.length > 9 ? "9+" : items.length}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">Notifications</span>
          <Button variant="ghost" size="sm" onClick={() => q.refetch()}>
            Refresh
          </Button>
        </div>
        {q.isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <CheckCheck className="size-4" /> Nothing needs your attention.
          </p>
        ) : (
          <ul className="max-h-[420px] divide-y divide-border overflow-y-auto">
            {items.map((n) => (
              <li key={n.id}>
                <Link
                  to={n.to}
                  onClick={() => setOpen(false)}
                  className="block px-3 py-2.5 transition-colors hover:bg-muted/50"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium leading-snug">{n.title}</span>
                    {n.severity === "urgent" ? (
                      <Badge variant="destructive" className="shrink-0 text-[0.625rem]">
                        Action
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{n.body}</p>
                  {n.at ? (
                    <p className="num mt-0.5 text-[0.6875rem] text-muted-foreground">
                      {new Date(n.at).toLocaleString()}
                    </p>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
