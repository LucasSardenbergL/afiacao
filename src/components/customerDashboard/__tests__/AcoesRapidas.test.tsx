import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { NavigateFunction } from "react-router-dom";
import { AcoesRapidas } from "../AcoesRapidas";

describe("AcoesRapidas", () => {
  it("renderiza as ações rápidas, incluindo a Central", () => {
    const navigate = vi.fn();
    render(<AcoesRapidas navigate={navigate as unknown as NavigateFunction} />);
    expect(screen.getByText("Central")).toBeTruthy();
    expect(screen.getByText("Novo Pedido")).toBeTruthy();
    expect(screen.getByText("Ferramentas")).toBeTruthy();
    expect(screen.getByText("Gamificação")).toBeTruthy();
    expect(screen.getByText("Suporte")).toBeTruthy();
  });

  it("navega ao clicar em uma ação", () => {
    const navigate = vi.fn();
    render(<AcoesRapidas navigate={navigate as unknown as NavigateFunction} />);
    fireEvent.click(screen.getByText("Novo Pedido"));
    expect(navigate).toHaveBeenCalledWith("/new-order");
  });

  it("a Central leva para /central", () => {
    const navigate = vi.fn();
    render(<AcoesRapidas navigate={navigate as unknown as NavigateFunction} />);
    fireEvent.click(screen.getByText("Central"));
    expect(navigate).toHaveBeenCalledWith("/central");
  });
});
