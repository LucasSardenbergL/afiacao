import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NegociacaoBanner } from "../NegociacaoBanner";

describe("NegociacaoBanner", () => {
  it("plural → texto e botões disparam callbacks", () => {
    const onVerSugestoes = vi.fn();
    const onFechar = vi.fn();
    render(<NegociacaoBanner count={3} onVerSugestoes={onVerSugestoes} onFechar={onFechar} />);
    expect(screen.getByText(/foram sugeridos/)).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ver sugestões" }));
    expect(onVerSugestoes).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(onFechar).toHaveBeenCalled();
  });

  it("singular → 'foi sugerido'", () => {
    render(<NegociacaoBanner count={1} onVerSugestoes={() => {}} onFechar={() => {}} />);
    expect(screen.getByText(/foi sugerido/)).toBeTruthy();
  });
});
