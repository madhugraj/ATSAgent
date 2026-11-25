/**
 * Hiring desk routing evals: what a recruiter types → which command the desk
 * must choose. Run against a live model by scripts/desk-eval.ts.
 *
 * Every phrasing here is one a recruiter actually used or a close variant.
 * A desk that answers these from counts ("29 in the pipeline") or sends the
 * person to another page fails.
 */
export type DeskScenario = {
  name: string;
  /** Earlier turns, oldest first. */
  history?: { role: "user" | "desk"; body: string }[];
  message: string;
  expect: { type: string; stage?: string; all?: boolean; names?: string[] };
};

const poolResult = {
  role: "desk" as const,
  body: '2 more people in the talent pool match and aren\'t in this pipeline yet:\n1. Priya Raman — 6 yrs, Chennai: LLM, Python in skills\n2. Arun Kumar — 4 yrs, Bengaluru: RAG in CV text\nSay "add them" (or name the ones you want) to add them to the pipeline and score them.',
};

export const deskScenarios: DeskScenario[] = [
  // Listing the pipeline
  {
    name: "list: show me the list",
    message: "Show me the list of the candidates",
    expect: { type: "show_candidates" },
  },
  {
    name: "list: who are the candidates",
    message: "who all are in the pipeline?",
    expect: { type: "show_candidates" },
  },
  {
    name: "list: shortlisted (typo)",
    message: "Who is shorlisted?",
    expect: { type: "show_candidates", stage: "shortlisted" },
  },
  {
    name: "list: names of shortlisted",
    message: "give me the names of the shortlisted candidates",
    expect: { type: "show_candidates", stage: "shortlisted" },
  },
  {
    name: "list: in L1",
    message: "who is in L1 right now?",
    expect: { type: "show_candidates", stage: "l1" },
  },
  // Searching the talent pool
  {
    name: "pool: apart from X, any other matching CV",
    message: "Apart from Vishal, do we have any other matching CV for this req in the pool?",
    expect: { type: "search_pool" },
  },
  {
    name: "pool: rescan the pool",
    message: "Can u rescan the pool and check",
    expect: { type: "search_pool" },
  },
  {
    name: "pool: find more like",
    message: "find more candidates like Vishal from our database",
    expect: { type: "search_pool" },
  },
  {
    name: "pool: any more profiles",
    message: "any more profiles for this role?",
    expect: { type: "search_pool" },
  },
  // Adding from a pool search
  {
    name: "pool add: add them",
    history: [poolResult],
    message: "add them",
    expect: { type: "add_from_pool" },
  },
  {
    name: "pool add: add all",
    history: [poolResult],
    message: "yes add all of them",
    expect: { type: "add_from_pool" },
  },
  {
    name: "pool add: by name",
    history: [poolResult],
    message: "add Priya only",
    expect: { type: "add_from_pool", names: ["priya"] },
  },
  // Existing commands must keep working
  {
    name: "regression: re-score",
    message: "re-score the candidates, the JD changed",
    expect: { type: "go_back" },
  },
  { name: "regression: show JD", message: "show me the JD", expect: { type: "show_jd" } },
  { name: "regression: screen top 3", message: "talk to the first 3", expect: { type: "screen" } },
  { name: "regression: close role", message: "close this role", expect: { type: "close_role" } },
];
