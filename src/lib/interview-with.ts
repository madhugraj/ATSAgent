/**
 * Who an interview is with, as a candidate is told it — never a name: the
 * hiring manager and the panel are confidential (docs/voice-agents-charter.md).
 * One wording for the invite e-mail, its calendar file, the time-choice page
 * and the voice agents (pure; unit-tested).
 */
export function interviewWith(panelSize: number): string {
  return panelSize > 1 ? `a panel of ${panelSize} from the hiring team` : "the hiring team";
}
