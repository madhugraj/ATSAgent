/**
 * Pay terms, Phase 4 — offers, the offer letter, the negotiation call's spoken
 * figures, job postings and money formatting in each role's currency
 * (docs/pay-terms-plan.md). Pure: no database.
 *
 * Run: bun test scripts/pay-offers.test.ts
 */
import { describe, expect, test } from "bun:test";

import { money } from "../src/lib/money";
import { contractEndOf } from "../src/lib/pay-context.server";
import { offerCompensationWords } from "../src/lib/offers.functions";
import { EMPLOYMENT_TYPE } from "../src/server/distribution/content";
import { employmentWords } from "../src/server/agents/tools";
import { amountsIn } from "../src/server/voice/negotiation-graders";
import {
  namesOtherFigure,
  offerSentence,
  spokenRupees,
} from "../src/server/voice/negotiation-call-tools";

describe("offers in their own currency", () => {
  test("the letter states the amount with its code and basis; INR annual keeps the old fields", () => {
    const inr = offerCompensationWords({
      amount: 2_000_000,
      currency: "INR",
      payBasis: "annual",
      kindOfWork: "permanent",
      contractEnd: null,
    });
    expect(inr.formatted).toBe("INR 20,00,000 per annum");
    expect(inr.annualCtcFormatted).toBe("20,00,000");
    const eur = offerCompensationWords({
      amount: 52_000,
      currency: "EUR",
      payBasis: "annual",
      kindOfWork: "fixed_term",
      contractEnd: "2027-12-31",
    });
    expect(eur).toMatchObject({
      formatted: "EUR 52,000 per annum",
      annualCtcInr: null,
      kind: "fixed-term contract",
      contractEnd: "2027-12-31",
    });
    expect(
      offerCompensationWords({
        amount: 65.5,
        currency: "USD",
        payBasis: "hourly",
        kindOfWork: "contract_hourly",
        contractEnd: null,
      }).formatted,
    ).toBe("USD 65.50 per hour");
  });

  test("a contract ends the day before the same date its length later", () => {
    expect(contractEndOf("2027-01-01", 12)).toBe("2027-12-31");
    expect(contractEndOf("2027-01-31", 1)).toBe("2027-02-27"); // Feb has no 31st
    expect(contractEndOf("2027-03-15", 6)).toBe("2027-09-14");
    expect(contractEndOf(null, 6)).toBeNull();
    expect(contractEndOf("2027-03-15", null)).toBeNull();
  });

  test("money in server text: rupees the Indian way, others by their own symbol", () => {
    expect(money(1_850_000)).toBe("₹18,50,000");
    expect(money(52_000, "EUR")).toBe("€52,000");
    expect(money(65.5, "USD", "hourly")).toBe("US$65.50 an hour");
    expect(money(90_000, "GBP", "annual")).toBe("£90,000 a year");
    expect(money(null, "EUR")).toBe("—");
  });
});

describe("the negotiation call speaks the offer's currency", () => {
  const figures = (currency?: string) => ({
    proposalCtc: currency && currency !== "INR" ? 52_000 : 1_850_000,
    stepCtc: null,
    levers: { joiningBonus: currency && currency !== "INR" ? 3_000 : 100_000 },
    ...(currency ? { currency } : {}),
  });

  test("rupees unchanged; euros in thousands, as gross annual pay", () => {
    expect(spokenRupees(1_850_000)).toBe("18 lakh 50 thousand rupees");
    expect(spokenRupees(52_000, "EUR")).toBe("52 thousand euros");
    expect(offerSentence("proposal", figures() as never)).toContain(
      "18 lakh 50 thousand rupees a year as the annual cost to company",
    );
    const eur = offerSentence("proposal", figures("EUR") as never);
    expect(eur).toContain("52 thousand euros a year as your gross annual pay");
    expect(eur).toContain("a one-time joining bonus of 3 thousand euros");
  });

  test("the amount guard reads thousands, millions and symbols; a yes naming another figure is not a yes", () => {
    expect(amountsIn("52 thousand euros")).toEqual([52_000]);
    expect(amountsIn("€1.2 million")).toEqual([1_200_000]);
    expect(amountsIn("18 lakh 50 thousand rupees")).toEqual([1_850_000]);
    expect(namesOtherFigure("yes, 52 thousand is fine", 52_000, "EUR")).toBe(false);
    expect(namesOtherFigure("yes if it's 60 thousand", 52_000, "EUR")).toBe(true);
  });
});

describe("job postings state the kind of work, never pay", () => {
  test("schema.org employment types and the JD's words", () => {
    expect(EMPLOYMENT_TYPE["permanent"]).toEqual(["FULL_TIME"]);
    expect(EMPLOYMENT_TYPE["contract_hourly"]).toEqual(["CONTRACTOR"]);
    expect(EMPLOYMENT_TYPE["fixed_term"]).toEqual(["FULL_TIME", "TEMPORARY"]);
    expect(employmentWords("permanent", null, null)).toBe("Permanent, full-time");
    expect(employmentWords("fixed_term", 12, true)).toBe(
      "Fixed-term contract, 12 months, can be extended",
    );
    expect(employmentWords("contract_hourly", 6, false)).toBe("Contract, 6 months");
  });
});
