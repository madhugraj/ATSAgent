import { FileText } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AgreementDraft } from "@/lib/legal/acceptance";
import { AGREEMENT_KINDS, AGREEMENTS, type AgreementKind } from "@/lib/legal/agreements";

/**
 * Links to each document (opened in a new tab so a half-filled form is kept),
 * the signatory's name and title, and the required acceptance checkbox.
 */
export function AgreementFields({
  value,
  onChange,
  kinds = AGREEMENT_KINDS,
  orgName,
  email,
}: {
  value: AgreementDraft;
  onChange: (next: AgreementDraft) => void;
  kinds?: readonly AgreementKind[];
  orgName?: string;
  email?: string | null;
}) {
  const docs = kinds.map((k) => AGREEMENTS[k]);
  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {docs.map((d) => (
          <li
            key={d.kind}
            className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm"
          >
            <span className="flex items-center gap-2">
              <FileText className="size-4 text-muted-foreground" />
              <a
                href={d.path}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline-offset-4 hover:underline"
              >
                {d.title}
              </a>
            </span>
            <span className="num text-xs text-muted-foreground">
              Version {d.version}
              {d.draft ? " · draft" : ""}
            </span>
          </li>
        ))}
      </ul>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">
            Signatory full name<span className="text-destructive"> *</span>
          </Label>
          <Input
            value={value.signatoryName}
            onChange={(e) => onChange({ ...value, signatoryName: e.target.value })}
            placeholder="e.g. Priya Raman"
            autoComplete="name"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">
            Signatory job title<span className="text-destructive"> *</span>
          </Label>
          <Input
            value={value.signatoryTitle}
            onChange={(e) => onChange({ ...value, signatoryTitle: e.target.value })}
            placeholder="e.g. Chief Human Resources Officer"
            autoComplete="organization-title"
          />
        </div>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={value.accepted}
          onChange={(e) => onChange({ ...value, accepted: e.target.checked })}
        />
        <span>
          I am authorised to accept, and on behalf of {orgName?.trim() || "my organisation"} I
          accept, the{" "}
          {docs
            .map((d) => d.title)
            .join(", ")
            .replace(/, ([^,]*)$/, " and $1")}
          {email ? (
            <>
              {" "}
              — recorded with my name, title and <span className="num">{email}</span>
            </>
          ) : null}
          .
        </span>
      </label>
    </div>
  );
}
