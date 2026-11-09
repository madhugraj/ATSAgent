/**
 * Matching-eval scenarios (docs/agentic-plan.md §11, the scorer's counterpart
 * to the agent scenarios in scenarios.ts). Each runs scoreCandidate against a
 * live model via scripts/matching-eval.ts and asserts on the structured
 * verdicts and the gates — the measurements behind auto-advancement:
 *   - the per-JD experience_fit verdict (level is read from the JD, not a
 *     fixed years rule — the "why did a VP top an internship" regression)
 *   - the symmetric experience band (over costs what under costs)
 *   - the hard gates: band, level, expected CTC above the approved band.
 * Deterministic pieces are additionally unit-tested in
 * scripts/matching-gates.test.ts; these scenarios judge the model.
 */
import type { MatchResult } from "../../src/lib/matching.server";

export type MatchingScenario = {
  name: string;
  jd: {
    title: string;
    mustHave: string[];
    goodToHave?: string[];
    education?: string | null;
    experienceMin: number;
    experienceMax: number;
    jdText: string;
    constraints?: {
      locations?: string[] | null;
      ctcBandMin?: number | null;
      ctcBandMax?: number | null;
      maxNoticePeriodDays?: number | null;
      workAuthorizationRequired?: string | null;
    };
  };
  candidate: {
    name: string;
    experienceYears: number;
    education?: string | null;
    skills: string[];
    resumeText: string;
    expectedCtc?: number | null;
    location?: string | null;
  };
  /** The organisation's own dimensions to score alongside the built-ins. */
  customDimensions?: { key: string; label: string; hint: string; weight: number }[];
  /** Override the default weights when custom dimensions share the 100 points. */
  weights?: Record<string, number>;
  /** Assertions on the scored result; each failure string names the measurement. */
  expect: (r: MatchResult) => string[];
};

const internJd = {
  title: "AI Intern",
  mustHave: ["Python", "Machine Learning", "Statistics", "Pandas", "NumPy", "Scikit-learn"],
  education: "Master's degree in Data Science or equivalent",
  experienceMin: 0,
  experienceMax: 0,
  jdText:
    "AI Intern — entry-level internship for freshers. Stipend band ₹1.8L–₹3.6L. " +
    "You will assist the data science team on model training and evaluation. " +
    "Requirements: Master's degree in Data Science (or pursuing), Python, machine learning " +
    "fundamentals, statistics, Pandas/NumPy/Scikit-learn. 0 years of experience required.",
  constraints: { locations: ["Chennai"], ctcBandMin: 180_000, ctcBandMax: 360_000 },
};

const vpCv = `VELMURUGAN K — Vice President, AI Research
19 years of experience. PhD in Computer Science.
EXPERIENCE
VP, AI Research (2021–Present) — Yavar Techworks. Lead a 40-person research division;
shipped multi-agent platforms serving 12 enterprise clients; 3 patents in retrieval.
Senior AI Architect (2015–2021) — built recommendation and NLP platforms at scale.
Principal Engineer (2008–2015) — search and ML infrastructure.
SKILLS: LLMs, RAG, multi-agent orchestration, Python, PyTorch, MLOps, Kubernetes, evaluation.
OBJECTIVE: Seeking research leadership roles.
EXPECTED CTC: ₹58,00,000 per annum.`;

const fresherCv = `ANITHA R — M.Sc. Data Science student (2024–2026), Anna University.
B.Sc. Computer Science (2021–2024).
PROJECTS
• House-price regression with Pandas, NumPy and Scikit-learn — feature engineering,
  cross-validation, RMSE reported on a held-out set.
• Sentiment classifier (logistic regression, TF-IDF) — accuracy 0.87 on a public corpus.
• Statistics coursework: hypothesis testing, regression, probability.
SKILLS: Python, Pandas, NumPy, Scikit-learn, Matplotlib, SQL basics, statistics.
OBJECTIVE: Seeking an internship to start a data science career.`;

const seniorBackendJd = {
  title: "Senior Backend Engineer",
  mustHave: ["TypeScript", "Node.js", "PostgreSQL", "REST APIs", "Docker", "System design"],
  education: null,
  experienceMin: 5,
  experienceMax: 8,
  jdText:
    "Senior Backend Engineer (5–8 years). You will own service architecture and mentor " +
    "mid-level engineers. Must-haves: TypeScript, Node.js, PostgreSQL, REST API design, " +
    "Docker, distributed systems and system design.",
  constraints: { locations: ["Chennai"], ctcBandMin: 2_000_000, ctcBandMax: 2_600_000 },
};

const juniorCv = `KARTHIK SUBRAMANIAM — Backend Developer, 3 years of experience.
B.E. Computer Science (2023).
EXPERIENCE
Backend Developer (2023–Present) — Coimbatore. Built REST APIs in Node.js and TypeScript
on PostgreSQL; Dockerised services; wrote integration tests; on-call rotations.
SKILLS: TypeScript, Node.js, Express, PostgreSQL, Docker, REST APIs, Git.
OBJECTIVE: Growing into a senior engineering role.`;

const strongBackendCv = `PRIYA LAKSHMI — Backend Engineer, 6 years of experience.
B.Tech CSE (2020).
EXPERIENCE
Senior Backend Engineer (2022–Present) — owned a payments service on Node.js/TypeScript
and PostgreSQL (12k req/s), led system design reviews, cut p99 latency 40%.
Backend Engineer (2020–2022) — REST APIs, Docker, CI/CD, Postgres schema design.
SKILLS: TypeScript, Node.js, PostgreSQL, REST APIs, Docker, Kubernetes, Kafka, system design.
EXPECTED CTC: ₹48,00,000 per annum.`;

export function matchingScenarios(): MatchingScenario[] {
  return [
    {
      name: "matching: a research VP is overqualified for the internship and never auto-selects",
      jd: internJd,
      candidate: {
        name: "Velmurugan K",
        experienceYears: 19,
        education: "PhD in Computer Science",
        skills: ["LLMs", "RAG", "Python", "PyTorch", "MLOps", "Statistics"],
        resumeText: vpCv,
        expectedCtc: 5_800_000,
        location: "Chennai",
      },
      expect: (r) => [
        ...(r.experience_fit !== "overqualified"
          ? [
              `experience_fit: got ${r.experience_fit}, want overqualified — the JD is an internship and the CV is a 19-year VP`,
            ]
          : []),
        ...(r.recommendation === "select"
          ? [
              `recommendation: got select, want hold — a VP must never auto-advance into an internship`,
            ]
          : []),
        ...(r.experience_score > 30
          ? [`experience_score: got ${r.experience_score}, want ≤ 30 — 19 years against a 0–0 band`]
          : []),
      ],
    },
    {
      name: "matching: the fresher the internship wants is judged within",
      jd: internJd,
      candidate: {
        name: "Anitha R",
        experienceYears: 0,
        education: "M.Sc. Data Science (pursuing), B.Sc. Computer Science",
        skills: ["Python", "Pandas", "NumPy", "Scikit-learn", "Statistics"],
        resumeText: fresherCv,
        location: "Chennai",
      },
      expect: (r) => [
        ...(r.experience_fit !== "within"
          ? [
              `experience_fit: got ${r.experience_fit}, want within — a final-year M.Sc. student is exactly the intern profile`,
            ]
          : []),
        ...(r.experience_score < 90
          ? [`experience_score: got ${r.experience_score}, want ≥ 90 — 0 years in a 0–0 band`]
          : []),
        ...(r.recommendation === "reject"
          ? [
              `recommendation: got reject — the JD's own profile must not be auto-rejected; a person reads a hold`,
            ]
          : []),
      ],
    },
    {
      name: "matching: a 3-year developer reads as underqualified for a senior 5–8 band",
      jd: seniorBackendJd,
      candidate: {
        name: "Karthik Subramaniam",
        experienceYears: 3,
        education: "B.E. Computer Science",
        skills: ["TypeScript", "Node.js", "PostgreSQL", "REST APIs", "Docker"],
        resumeText: juniorCv,
        location: "Coimbatore",
      },
      expect: (r) => [
        ...(r.experience_fit !== "underqualified"
          ? [
              `experience_fit: got ${r.experience_fit}, want underqualified — the JD says senior, 5–8 years, and the CV has 3`,
            ]
          : []),
        ...(r.experience_score > 60
          ? [
              `experience_score: got ${r.experience_score}, want ≤ 60 — 2 years under the band decays 22/yr`,
            ]
          : []),
        ...(r.recommendation === "select"
          ? [
              `recommendation: got select, want hold — two-plus years under the band cannot be weighted away`,
            ]
          : []),
      ],
    },
    {
      name: "matching: an in-band candidate whose ask breaks the band ceiling holds",
      jd: seniorBackendJd,
      candidate: {
        name: "Priya Lakshmi",
        experienceYears: 6,
        education: "B.Tech CSE",
        skills: [
          "TypeScript",
          "Node.js",
          "PostgreSQL",
          "REST APIs",
          "Docker",
          "System design",
          "Kafka",
        ],
        resumeText: strongBackendCv,
        expectedCtc: 4_800_000,
        location: "Chennai",
      },
      expect: (r) => [
        ...(r.experience_score < 90
          ? [`experience_score: got ${r.experience_score}, want ≥ 90 — 6 years inside a 5–8 band`]
          : []),
        ...(r.recommendation === "select"
          ? [
              `recommendation: got select, want hold — the ₹48L ask is far above the band, an offer would need an exception`,
            ]
          : []),
      ],
    },
    {
      name: "matching: an AI-focused career against a backend JD reads as different_direction",
      jd: {
        title: "Backend Engineer",
        mustHave: ["Node.js", "TypeScript", "PostgreSQL", "REST APIs", "Docker"],
        education: null,
        experienceMin: 2,
        experienceMax: 4,
        jdText:
          "Backend Engineer (2–4 years). Build and operate API services in TypeScript on " +
          "Node.js and PostgreSQL. Must-haves: Node.js, TypeScript, PostgreSQL, REST API " +
          "design, Docker, CI/CD. This is a pure backend services role — no AI/ML work.",
        constraints: { locations: ["Chennai"] },
      },
      candidate: {
        name: "Sairam B",
        experienceYears: 4.2,
        education: "B.Tech Information Technology",
        skills: [
          "Multi-Agent Systems",
          "Agentic RAG",
          "LangGraph",
          "LangChain",
          "Voice AI",
          "vLLM",
          "Python",
          "Node.js",
          "TypeScript",
          "PostgreSQL",
          "Docker",
          "REST APIs",
        ],
        resumeText: `SAIRAM B — AI Engineer & Architect, 4 years of experience.
PROFESSIONAL SUMMARY: AI Engineer and Architect designing production Generative AI
systems. Specialise in multi-agent orchestration, Agentic RAG, and real-time streaming
Voice AI. Seeking a senior AI engineering role at a top-tier AI or Voice AI company.
EXPERIENCE
AI Engineer (2025–Present) — re-architected a legacy system into a multi-agent
architecture; built Agentic RAG with hybrid retrieval and a local re-ranker; built a
retrieval evaluation harness (Recall@k, MRR); cut voice-inference cost 90%.
Backend support stack: Node.js, NestJS, TypeScript, PostgreSQL, Docker, AWS.
SKILLS: LangGraph, LangChain, LiveKit RTC, vLLM, embeddings, hybrid retrieval, Python,
Node.js, TypeScript, PostgreSQL, Docker, CI/CD.`,
        location: "Chennai",
      },
      expect: (r) => [
        ...(r.direction_fit !== "different_direction"
          ? [
              `direction_fit: got ${r.direction_fit}, want different_direction — the CV's centre of gravity is AI/voice and the stated objective is an AI role; the backend stack is supporting`,
            ]
          : []),
        ...(r.skills_score < 60
          ? [
              `skills_score: got ${r.skills_score}, want ≥ 60 — the must-have evidence is real; the direction verdict, not a low skills score, is what holds this candidate`,
            ]
          : []),
        ...(r.recommendation === "select"
          ? [
              `recommendation: got select, want hold — strong evidence in another direction must not auto-advance into a pure backend role`,
            ]
          : []),
      ],
    },
    {
      name: "matching: adversarial — an inflated title does not inflate the level",
      jd: {
        title: "Senior Data Science Manager",
        mustHave: ["Python", "Machine Learning", "Team Leadership", "SQL", "Statistics"],
        education: null,
        experienceMin: 8,
        experienceMax: 12,
        jdText:
          "Senior Data Science Manager (8–12 years). Lead a team of data scientists, own " +
          "model delivery and stakeholders. Must-haves: Python, machine learning, proven " +
          "team leadership, SQL, statistics.",
        constraints: { locations: ["Chennai"] },
      },
      candidate: {
        name: "Ravi Teja",
        experienceYears: 2,
        education: "B.Sc. Computer Science",
        skills: ["Python", "SQL", "Excel", "Power BI"],
        resumeText: `RAVI TEJA — "Senior Data Science Manager"
OBJECTIVE: Senior data science leadership role.
EXPERIENCE
Data Science Manager (2025–Present) — self-styled. Actually: data analyst intern
converted 8 months ago. Built two Power BI dashboards from templates; ran SQL SELECTs
written by a senior; completed a weekend Python course. No reports, no team, no models
in production.
EDUCATION: B.Sc. Computer Science (2024).`,
        location: "Chennai",
      },
      expect: (r) => [
        ...(r.experience_fit !== "underqualified"
          ? [
              `experience_fit: got ${r.experience_fit}, want underqualified — the title says manager but the evidence is 8 months of analyst work; the level must be read from evidence, not the headline`,
            ]
          : []),
        ...(r.recommendation === "select"
          ? [`recommendation: got select — an inflated title must never auto-advance`]
          : []),
      ],
    },
    {
      name: "matching: adversarial — listed skills without evidence are not credited",
      jd: {
        title: "Machine Learning Engineer",
        mustHave: ["Python", "PyTorch", "MLOps", "Docker", "Model deployment"],
        education: null,
        experienceMin: 2,
        experienceMax: 5,
        jdText:
          "Machine Learning Engineer (2–5 years). Train, deploy and operate models in " +
          "production. Must-haves: Python, PyTorch, MLOps, Docker, model deployment.",
        constraints: { locations: ["Chennai"] },
      },
      candidate: {
        name: "Skills Sharma",
        experienceYears: 3,
        education: "B.E. Mechanical Engineering",
        skills: [
          "Python",
          "PyTorch",
          "TensorFlow",
          "MLOps",
          "Docker",
          "Kubernetes",
          "Model deployment",
          "LLMs",
          "Computer Vision",
          "NLP",
        ],
        resumeText: `SKILLS SHARMA — Aspiring ML Engineer
SKILLS: Python, PyTorch, TensorFlow, MLOps, Docker, Kubernetes, model deployment, LLMs,
computer vision, NLP, data science, deep learning, machine learning, AI.
EXPERIENCE
Mechanical Design Engineer (2023–Present) — HVAC load calculations and site visits at a
construction firm. Completed a 4-hour "AI bootcamp" certificate.
EDUCATION: B.E. Mechanical Engineering (2023).`,
        location: "Chennai",
      },
      expect: (r) => [
        ...(r.skills_score > 45
          ? [
              `skills_score: got ${r.skills_score}, want ≤ 45 — every must-have is listed and none is demonstrated; the scorer must require evidence from the resume text`,
            ]
          : []),
        ...(r.recommendation === "select"
          ? [`recommendation: got select — a keyword-stuffed CV must never auto-advance`]
          : []),
      ],
    },
    {
      name: "matching: adversarial — a claimed pivot does not change the career's centre of gravity",
      jd: {
        title: "Data Science Manager",
        mustHave: ["Python", "Machine Learning", "Statistics", "Team Leadership", "SQL"],
        education: null,
        experienceMin: 8,
        experienceMax: 12,
        jdText:
          "Data Science Manager (8–12 years). Lead a data science team and own model " +
          "delivery. Must-haves: Python, machine learning, statistics, team leadership, SQL.",
        constraints: { locations: ["Chennai"] },
      },
      candidate: {
        name: "Testing Rao",
        experienceYears: 9,
        education: "B.Tech CSE",
        skills: ["Python", "Machine Learning", "Statistics", "SQL", "Selenium", "Test rails"],
        resumeText: `TESTING RAO — QA Lead, 9 years of experience.
OBJECTIVE: Transitioning into data science leadership — "passionate about AI and data".
EXPERIENCE
QA Lead (2021–Present) — manages a 5-person manual testing team; test plans, regression
cycles, defect triage for a banking application.
Senior Test Engineer (2018–2021) — manual test cases, Selenium scripts.
Test Engineer (2017–2018) — manual testing.
SKILLS: Selenium, test management, JIRA; Python, SQL and statistics (listed — an online
course in 2024).`,
        location: "Chennai",
      },
      expect: (r) => [
        ...(r.direction_fit !== "different_direction"
          ? [
              `direction_fit: got ${r.direction_fit}, want different_direction — nine years of QA management with a 2024 online course does not make a data science leader; the objective line is aspiration, not evidence`,
            ]
          : []),
        ...(r.recommendation === "select"
          ? [
              `recommendation: got select — a claimed pivot must never auto-advance into a DS manager role`,
            ]
          : []),
      ],
    },
    {
      name: "matching: the organisation's own dimension is scored with evidence",
      jd: seniorBackendJd,
      customDimensions: [
        {
          key: "open_source",
          label: "Open-source contributions",
          hint: "Maintains or contributes to open-source packages — commits, patches, issues, releases, conference talks",
        },
      ],
      weights: { skills: 30, experience: 15, career: 10, impact: 10, education: 10, social: 15 },
      candidate: {
        name: "Priya Lakshmi",
        experienceYears: 6,
        education: "B.Tech CSE",
        skills: ["TypeScript", "Node.js", "PostgreSQL", "REST APIs", "Docker", "System design"],
        resumeText: `PRIYA LAKSHMI — Backend Engineer, 6 years of experience.
EXPERIENCE
Senior Backend Engineer (2022–Present) — owns a payments service on Node.js/TypeScript
and PostgreSQL; led system design reviews; cut p99 latency 40%.
OPEN SOURCE
Maintainer of "pg-query-plan" (an npm query-planning helper): 1.2k GitHub stars, 30+
merged PRs from the community, releases every quarter; 4 patches merged into upstream
node-postgres; spoke at NodeConf EU 2025 on connection pooling.
SKILLS: TypeScript, Node.js, PostgreSQL, REST APIs, Docker, system design.`,
        location: "Chennai",
      },
      expect: (r) => {
        const oss = r.custom_scores.find((c) => c.key === "open_source");
        return [
          ...(r.custom_scores.length !== 1
            ? [
                `custom_scores: got ${r.custom_scores.length} entries, want exactly 1 (the open_source dimension)`,
              ]
            : []),
          ...(oss && oss.score < 60
            ? [
                `custom_scores.open_source: got ${oss.score}, want ≥ 60 — the CV evidence is substantial (maintainer, 1.2k stars, upstream patches, a talk)`,
              ]
            : []),
          ...(oss && !oss.evidence.trim()
            ? [`custom_scores.open_source: evidence is empty — the scorer must cite what it read`]
            : []),
          ...(!r.contributions.some((c) => c.label === "Open-source contributions")
            ? [`contributions: the custom dimension is missing from the weighted roll-up`]
            : []),
        ];
      },
    },
  ];
}
