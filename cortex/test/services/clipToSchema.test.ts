import { describe, expect, it } from "vitest";
import { SummaryCardSchema } from "@wingman/shared";
import { clipToSchemaIssues } from "../../src/llm/anthropic.js";

describe("clipToSchemaIssues — lens limits are clipped, not fatal", () => {
  it("shortens an over-long line at a word boundary and truncates extra lines", () => {
    const raw = {
      title: "Stripe",
      subtitle: "Payments infrastructure for the internet",
      lines: [
        "Hiring: SWE Intern, New Grad Backend, and Platform Engineers in Seattle", // 71 chars
        "Stack: Ruby, Go, ML infra at scale",
        "Recently: launched usage-based billing APIs",
        "Office: Houston",
        "Booth 42",
        "Sixth line that exceeds the max of five",
      ],
    };
    const first = SummaryCardSchema.safeParse(raw);
    expect(first.success).toBe(false);
    if (first.success) return;
    const { value, clipped } = clipToSchemaIssues(raw, first.error);
    expect(clipped).toBeGreaterThanOrEqual(2);
    const second = SummaryCardSchema.safeParse(value);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.lines).toHaveLength(5);
    expect(second.data.lines[0].length).toBeLessThanOrEqual(40);
    expect(second.data.lines[0].endsWith("…")).toBe(true);
    expect(second.data.lines[0]).not.toMatch(/ …$/);
  });

  it("leaves a valid card untouched", () => {
    const ok = { title: "Stripe", subtitle: "Payments", lines: ["a", "b", "c"] };
    expect(SummaryCardSchema.safeParse(ok).success).toBe(true);
  });
});
