import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CostEngineCard, AssociationRulesCard } from "../EngineCards";
import type { RecConfigs } from "../useAnalyticsSync";

const recConfigs = [
  { id: "1", key: "divergence_threshold", value: 0.25, description: "limiar" },
  { id: "2", key: "l_min", value: 1.5, description: "lift mínimo" },
  { id: "3", key: "s_min", value: 0.02, description: "support mínimo" },
] as unknown as RecConfigs;

describe("CostEngineCard", () => {
  it("calcula a divergência a partir do recConfigs e mostra as 4 fontes", () => {
    render(<CostEngineCard isRunning={false} pending={false} recConfigs={recConfigs} onRecalcular={() => {}} />);
    expect(screen.getByText(/Divergência > 25%/)).toBeTruthy();
    expect(screen.getByText("PRODUCT COST")).toBeTruthy();
    expect(screen.getByText("DEFAULT PROXY")).toBeTruthy();
  });

  it("usa 20% como fallback quando não há config", () => {
    render(<CostEngineCard isRunning={false} pending={false} recConfigs={undefined} onRecalcular={() => {}} />);
    expect(screen.getByText(/Divergência > 20%/)).toBeTruthy();
  });

  it("dispara onRecalcular", () => {
    const onRecalcular = vi.fn();
    render(<CostEngineCard isRunning={false} pending={false} recConfigs={recConfigs} onRecalcular={onRecalcular} />);
    fireEvent.click(screen.getByRole("button", { name: /Recalcular Custos/ }));
    expect(onRecalcular).toHaveBeenCalledTimes(1);
  });
});

describe("AssociationRulesCard", () => {
  it("mostra lift e support do recConfigs", () => {
    render(<AssociationRulesCard isRunning={false} pending={false} recConfigs={recConfigs} onRecalcular={() => {}} />);
    expect(screen.getByText(/lift ≥ 1\.5/)).toBeTruthy();
    expect(screen.getByText(/support ≥ 0\.02/)).toBeTruthy();
  });

  it("usa fallbacks (1.2 / 0.01) quando não há config", () => {
    render(<AssociationRulesCard isRunning={false} pending={false} recConfigs={undefined} onRecalcular={() => {}} />);
    expect(screen.getByText(/lift ≥ 1\.2/)).toBeTruthy();
    expect(screen.getByText(/support ≥ 0\.01/)).toBeTruthy();
  });
});
