import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@/components/ats";
import { OrgProfilePanel } from "@/components/OrgProfilePanel";

export const Route = createFileRoute("/org-profile")({
  head: () => ({
    meta: [
      { title: "Organisation profile — Talent Acquisition" },
      {
        name: "description",
        content:
          "What your organisation does, its domain, locations, culture, hiring norms and policies — approved by the HR head or owner, and the context every hiring agent works from.",
      },
    ],
  }),
  component: OrgProfilePage,
});

function OrgProfilePage() {
  return (
    <>
      <PageHeader
        eyebrow="Organisation"
        title="Organisation profile"
        description="The context every hiring agent works from — written by the Organisation context agent from your website, your documents and what you tell it, and approved by the HR head or an owner. Also lives under Organisation → Profile."
      />
      <OrgProfilePanel />
    </>
  );
}
