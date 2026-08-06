import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { NavigateFunction } from "react-router-dom";
import { FerramentasAtencao } from "../FerramentasAtencao";
import type { UserTool } from "../types";

function makeTool(o: Partial<UserTool> = {}): UserTool {
  return {
    id: "t1",
    tool_category_id: "c1",
    next_sharpening_due: new Date(Date.now() - 5 * 86400000).toISOString(),
    last_sharpened_at: null,
    sharpening_interval_days: 30,
    tool_categories: { name: "Faca de corte", suggested_interval_days: null },
    ...o,
  };
}

describe("FerramentasAtencao", () => {
  it("renderiza ferramenta com rótulo de atraso", () => {
    const navigate = vi.fn();
    render(<FerramentasAtencao urgentTools={[makeTool()]} navigate={navigate as unknown as NavigateFunction} />);
    expect(screen.getByText("Faca de corte")).toBeTruthy();
    expect(screen.getByText(/atrasado/)).toBeTruthy();
  });

  it("dispara navigate no botão Criar pedido", () => {
    const navigate = vi.fn();
    render(<FerramentasAtencao urgentTools={[makeTool()]} navigate={navigate as unknown as NavigateFunction} />);
    fireEvent.click(screen.getByRole("button", { name: /Criar pedido/ }));
    expect(navigate).toHaveBeenCalledWith("/new-order");
  });
});
