import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TrendingUp } from "lucide-react";
import { MetricCard } from "../MetricCard";
import { WaterfallBar } from "../WaterfallBar";

describe("posicaoAgora cards", () => {
  it("MetricCard renderiza título, valor compacto e subtítulo", () => {
    render(<MetricCard title="Capital de Giro" value={2_500_000} subtitle="CR - CP abertos" positive icon={TrendingUp} />);
    expect(screen.getByText("Capital de Giro")).toBeTruthy();
    expect(screen.getByText("R$ 2.5M")).toBeTruthy();
    expect(screen.getByText("CR - CP abertos")).toBeTruthy();
  });

  it("WaterfallBar renderiza label e valor", () => {
    render(<WaterfallBar label="Entradas" value={100_000} max={200_000} color="bg-status-success" />);
    expect(screen.getByText("Entradas")).toBeTruthy();
    expect(screen.getByText("R$ 100.0k")).toBeTruthy();
  });
});
