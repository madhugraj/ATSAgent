import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireOrg } from "./auth.middleware";
import { benchmarkMarket, type MarketBenchmark } from "./market.server";

export type { MarketBenchmark, MarketLevel, MarketSource } from "./market.server";

const BenchmarkInput = z.object({
  role: z.string().min(2),
  location: z.string().default(""),
  currency: z.string().default("INR"),
  experienceMin: z.number().default(0),
  experienceMax: z.number().default(0),
  skills: z.array(z.string()).default([]),
  department: z.string().optional().nullable(),
});

/** Live market pay research for one role, broken down by career level. */
export const benchmarkCompensation = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => BenchmarkInput.parse(data))
  .handler(async ({ data, context }): Promise<MarketBenchmark> =>
    benchmarkMarket({ ...data, orgId: context.orgId }),
  );
