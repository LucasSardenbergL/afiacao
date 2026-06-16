import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatsTab } from "../StatsTab";

beforeAll(() => {
  // Recharts ResponsiveContainer usa ResizeObserver, ausente no jsdom.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe("StatsTab", () => {
  it("renderiza KPIs quando não está carregando", () => {
    render(<StatsTab loading={false} total7d={42} taxaSucesso={87} esgotados={3} chartData={[]} />);
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("87%")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("Total últimos 7 dias")).toBeTruthy();
    expect(screen.getByText("Distribuição diária (30 dias)")).toBeTruthy();
  });

  it("mostra 3 skeletons em loading", () => {
    const { container } = render(
      <StatsTab loading total7d={0} taxaSucesso={0} esgotados={0} chartData={[]} />,
    );
    expect(container.querySelectorAll(".animate-shimmer")).toHaveLength(3);
  });
});
