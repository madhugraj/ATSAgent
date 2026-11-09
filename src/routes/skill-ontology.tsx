/**
 * Skill ontology merged into the Talent Brain (one page for the organisation's
 * skill and role ontology); old links land there.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/skill-ontology")({
  beforeLoad: () => {
    throw redirect({ to: "/brain", replace: true });
  },
});
