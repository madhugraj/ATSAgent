/**
 * Why a run stopped, as the runtime writes it — fixed strings, so the screens
 * that show run errors can recognise them (anything else is provider text and
 * is never shown). No imports: safe for any module.
 */
export const LEG_LIMIT_MESSAGE =
  "The run reached its step or token budget for this stretch of work — raise the agent's run limits in Agent settings, then try again.";
export const CEILING_MESSAGE =
  "The run reached its overall step or token ceiling — it may be going round in circles; check its steps before trying again.";
/** Written by runs stopped before per-leg limits existed. */
export const OLD_LIMIT_MESSAGE = "The run reached its step or token budget.";
