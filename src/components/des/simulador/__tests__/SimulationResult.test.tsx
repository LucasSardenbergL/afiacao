import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SimulationResult } from "../SimulationResult";
import type { SimResult } from "../types";

const base: SimResult = {
  posicao: { com_extra: 120000, nominal_adicional_na_nf: 50000, fator_inflacao: 1.05, mudou_faixa: true, faixa_nova: { estrelas: 4 } },
  perdas_pedido_atual: { total_rs: 800, perda_antecipado_rs: 300, encargo_prazo_rs: 200, frete_rs: 100, custo_capital_rs: 200 },
  projecao: { proximo_trimestre_projetado: 500000, ganho_futuro_rs: 9000 },
  descontos: { delta_perc: 1.5 },
  saldo_liquido_rs: 8200,
  recomendacao: "compensa",
};

describe("SimulationResult", () => {
  it("mostra posição, ganho futuro e perdas", () => {
    render(<SimulationResult resultado={base} showDetails={false} setShowDetails={vi.fn()} />);
    expect(screen.getByText("Posição após puxar")).toBeTruthy();
    expect(screen.getByText(/120\.000,00/)).toBeTruthy();
    expect(screen.getByText(/9\.000,00/)).toBeTruthy();
    expect(screen.getByText(/800,00/)).toBeTruthy();
  });

  it("mostra a recomendação 'Compensa' no saldo líquido", () => {
    render(<SimulationResult resultado={base} showDetails={false} setShowDetails={vi.fn()} />);
    expect(screen.getByText(/Compensa:/)).toBeTruthy();
  });

  it("mostra badge de NF inflada quando fator > 1", () => {
    render(<SimulationResult resultado={base} showDetails={false} setShowDetails={vi.fn()} />);
    expect(screen.getByText(/NF inflada em 1\.05x pelo prazo/)).toBeTruthy();
  });

  it("NÃO mostra card de saldo quando recomendacao é desconhecida", () => {
    render(<SimulationResult resultado={{ ...base, recomendacao: undefined }} showDetails={false} setShowDetails={vi.fn()} />);
    expect(screen.queryByText("Saldo líquido")).toBeNull();
  });

  it("mostra 'Não compensa' para recomendacao nao_compensa", () => {
    render(<SimulationResult resultado={{ ...base, recomendacao: "nao_compensa" }} showDetails={false} setShowDetails={vi.fn()} />);
    expect(screen.getByText(/Não compensa:/)).toBeTruthy();
  });
});
