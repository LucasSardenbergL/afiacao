import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RuleCard } from "../RuleCard";
import type { AssociationRule } from "@/hooks/useBundleEngine";

const rule = {
  antecedentNames: ["A", "B"],
  consequentNames: ["C"],
  support: 0.3,
  confidence: 0.6,
  lift: 2.1,
  type: "sequential",
} as unknown as AssociationRule;

describe("RuleCard", () => {
  it("renderiza antecedentes, consequentes e métricas", () => {
    render(<RuleCard rule={rule} />);
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("C")).toBeTruthy();
    expect(screen.getByText("30.0%")).toBeTruthy();
    expect(screen.getByText("2.10")).toBeTruthy();
    expect(screen.getByText("⏱ Sequencial")).toBeTruthy();
  });

  it("mostra badge de associação para tipo não-sequencial", () => {
    render(<RuleCard rule={{ ...rule, type: "association" } as unknown as AssociationRule} />);
    expect(screen.getByText("🔗 Associação")).toBeTruthy();
  });
});
