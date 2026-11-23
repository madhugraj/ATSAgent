import { KeyRound, LogOut, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { changePasswordRequest, signOutApp } from "@/lib/auth-client";
import { PASSWORD_POLICY_HINT, passwordProblem } from "@/lib/password-policy";
import { useMe } from "@/hooks/useMe";
import { useOrg } from "@/hooks/useOrg";
import { usePlatform } from "@/hooks/usePlatform";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PasswordInput } from "@/components/PasswordInput";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  TEXT_SIZE_OPTIONS,
  THEME_OPTIONS,
  applyAppearance,
  readAppearance,
  saveAppearance,
  type TextSize,
  type Theme,
} from "@/lib/appearance";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const ROLE_LABEL: Record<string, string> = {
  recruiter: "Recruiter",
  hiring_manager: "Hiring manager",
  department_head: "Department head",
  hr_head: "HR head",
  president_cbo: "CHRO / President",
};

/**
 * Who is signed in and what they are allowed to do, with sign out in the same
 * place — the top bar beside the notification bell.
 */
export function AccountMenu() {
  const { org, roles, isOwner } = useOrg();
  const { isSuperUser } = usePlatform();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changing, setChanging] = useState(false);

  const [appearance, setAppearance] = useState<{ theme: Theme; textSize: TextSize }>({
    theme: "light",
    textSize: "default",
  });
  useEffect(() => setAppearance(readAppearance()), []);
  useEffect(() => {
    if (appearance.theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyAppearance(appearance);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [appearance]);
  function updateAppearance(patch: Partial<typeof appearance>) {
    const next = { ...appearance, ...patch };
    setAppearance(next);
    saveAppearance(next);
  }

  // One shared identity query — a second queryFn on this key used to win the
  // cache race with useMe() and strip userId for every consumer.
  const { email } = useMe();

  const name = email ?? "You";
  const initials = String(name)
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");

  // Highest privilege first, so the top bar always states the real authority.
  const privileges = [
    ...(isSuperUser ? ["Platform super admin"] : []),
    ...(isOwner ? ["Organisation owner"] : []),
    ...roles.map((r) => ROLE_LABEL[r] ?? r),
  ];
  const headline = privileges[0] ?? "Member";

  useEffect(() => {
    if (!open) setSigningOut(false);
  }, [open]);

  useEffect(() => {
    if (!changeOpen) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setChanging(false);
    }
  }, [changeOpen]);

  async function changePassword() {
    const problem = passwordProblem(newPassword);
    if (problem) {
      toast.error(problem);
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("The two new passwords do not match.");
      return;
    }
    setChanging(true);
    try {
      toast.success(await changePasswordRequest(currentPassword, newPassword));
      setChangeOpen(false);
      setOpen(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setChanging(false);
    }
  }

  async function signOut() {
    setSigningOut(true);
    await signOutApp();
    // The session is the httpOnly cookie — reload so the auth gate re-bootstraps.
    window.location.assign("/");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="h-9 gap-2 px-2"
          aria-label="Account, privileges and sign out"
        >
          <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-[0.6875rem] font-semibold text-primary">
            {initials || <UserRound className="size-3.5" />}
          </span>
          <span className="hidden text-left leading-tight sm:block">
            <span className="block max-w-[140px] truncate text-xs font-semibold">{name}</span>
            <span className="block max-w-[140px] truncate text-[0.625rem] text-muted-foreground">
              {headline}
            </span>
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[280px] p-0">
        <div className="border-b border-border p-3">
          <p className="truncate text-sm font-semibold">{name}</p>
          {email ? <p className="truncate text-xs text-muted-foreground">{email}</p> : null}
          {org ? (
            <p className="mt-1 truncate text-xs text-muted-foreground">{org.name}</p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">No organisation yet</p>
          )}
        </div>
        <div className="border-b border-border p-3">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
            Access level
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {privileges.length ? (
              privileges.map((p) => (
                <Badge key={p} variant={p === headline ? "default" : "secondary"}>
                  {p}
                </Badge>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">
                No roles granted yet — ask your owner for access.
              </span>
            )}
          </div>
          {isSuperUser ? (
            <p className="mt-2 text-[0.6875rem] text-muted-foreground">
              You can see every organisation on the platform console.
            </p>
          ) : (
            <p className="mt-2 text-[0.6875rem] text-muted-foreground">
              You only see data for this organisation.
            </p>
          )}
        </div>
        <div className="space-y-2 border-b border-border p-3">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
            Appearance
          </p>
          <Segmented
            label="Theme"
            options={THEME_OPTIONS}
            value={appearance.theme}
            onChange={(theme) => updateAppearance({ theme })}
          />
          <Segmented
            label="Text size"
            options={TEXT_SIZE_OPTIONS}
            value={appearance.textSize}
            onChange={(textSize) => updateAppearance({ textSize })}
          />
        </div>
        <div className="p-2">
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={() => {
              setOpen(false);
              setChangeOpen(true);
            }}
          >
            <KeyRound className="size-4" /> Change password
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={signOut}
            disabled={signingOut}
          >
            <LogOut className="size-4" /> {signingOut ? "Signing out…" : "Sign out"}
          </Button>
        </div>
      </PopoverContent>
      <Dialog open={changeOpen} onOpenChange={setChangeOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              Updating your password signs out every other device. This device stays signed in.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void changePassword();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="current-password">Current password</Label>
              <PasswordInput
                id="current-password"
                required
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-account-password">New password</Label>
              <PasswordInput
                id="new-account-password"
                required
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{PASSWORD_POLICY_HINT}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-account-password">Repeat new password</Label>
              <PasswordInput
                id="confirm-account-password"
                required
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={changing}>
              {changing ? "Updating…" : "Update password"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </Popover>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-md bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex-1 rounded px-2 py-1 text-xs font-medium text-muted-foreground transition-colors",
            value === o.value && "bg-card text-foreground shadow-sm",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
