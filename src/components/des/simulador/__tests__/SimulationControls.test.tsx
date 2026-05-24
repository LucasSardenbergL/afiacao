import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SimulationControls } from "../SimulationControls";
import type { PrazoOption } from "../types";

// Radix Slider depende de ResizeObserver, ausente no jsdom.
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const prazos: PrazoOption[] = [
  { id: 1, codigo: "antecipado", nome: "Antecipado", desconto_ou_encargo_perc: -3, padrao: true, ativo: true },
  { id: 2, codigo: "30d", nome: "30 dias", desconto_ou_encargo_perc: 2, padrao: false, ativo: true },
];

function setup(overrides: Partial<React.ComponentProps<typeof SimulationControls>> = {}) {
  const props: React.ComponentProps<typeof SimulationControls> = {
    valorInput: "50000",
    setValorInput: vi.fn(),
    valorExtra: 50000,
    setValorExtra: vi.fn(),
    diasEstoque: 60,
    setDiasEstoque: vi.fn(),
    prazoCodigo: "antecipado",
    setPrazoCodigo: vi.fn(),
    prazos,
    faltamProximaFaixa: null,
    loading: false,
    onSimular: vi.fn(),
    ...overrides,
  };
  render(<SimulationControls {...props} />);
  return props;
}

describe("SimulationControls", () => {
  it("renderiza labels dos controles", () => {
    setup();
    expect(screen.getByText("Valor extra a puxar (R$)")).toBeTruthy();
    expect(screen.getByText("Prazo de pagamento")).toBeTruthy();
    expect(screen.getByText("Dias de estoque extra estimado")).toBeTruthy();
  });

  it("dispara onSimular ao clicar em Simular", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /Simular cenário/ }));
    expect(props.onSimular).toHaveBeenCalledTimes(1);
  });

  it("desabilita o botão quando loading", () => {
    setup({ loading: true });
    expect(screen.getByRole("button", { name: /Simular cenário/ })).toHaveProperty("disabled", true);
  });

  it("no blur com valor válido → setValorExtra", () => {
    const props = setup({ valorInput: "8000" });
    const valorInput = screen.getAllByRole("spinbutton")[0];
    fireEvent.blur(valorInput);
    expect(props.setValorExtra).toHaveBeenCalledWith(8000);
  });

  it("no blur com valor inválido → reseta valorInput", () => {
    const props = setup({ valorInput: "abc", valorExtra: 50000 });
    const valorInput = screen.getAllByRole("spinbutton")[0];
    fireEvent.blur(valorInput);
    expect(props.setValorExtra).not.toHaveBeenCalled();
    expect(props.setValorInput).toHaveBeenCalledWith("50000");
  });

  it("mostra atalho de próxima faixa e aplica ao clicar", () => {
    const props = setup({ faltamProximaFaixa: 12345.6 });
    const btn = screen.getByRole("button", { name: /Faltam para próxima faixa/ });
    fireEvent.click(btn);
    expect(props.setValorExtra).toHaveBeenCalledWith(12346); // Math.round
  });
});
