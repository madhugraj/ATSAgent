/** What a panellist sees for one round (client-safe type; built in panel-brief.server.ts). */
export type PanelBrief = {
  candidateName: string;
  jobTitle: string;
  level: number;
  roundName: string | null;
  roundFocus: string | null;
  competencies: string[];
  scheduledAt: string | null;
  durationMins: number;
  mode: string;
  meetingLink: string | null;
  agenda: string | null;
  profile: {
    employer: string | null;
    years: number | null;
    location: string | null;
    education: string | null;
    skills: string[];
  };
  /** The CV as parsed text; null when none is on file. */
  cv: string | null;
  /** Internal only (signed-in members): latest match and screening outcome. */
  match: string | null;
  screening: string | null;
};
