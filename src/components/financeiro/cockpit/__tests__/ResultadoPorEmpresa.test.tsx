import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResultadoPorEmpresa } from "../ResultadoPorEmpresa";
import type { FinDRE } from "@/services/financeiroService";

const dre = {
  company: "oben",
  mes: 3,
  receita_liquida: 100000,
  lucro_bruto: 40000,
  resultado_operacional: 20000,
  resultado_liquido: 15000,
  detalhamento: {
    impostos: { ded_icms: 1800 },
    regime_tributario: "presumido",
  },
} as unknown as FinDRE;

describe("ResultadoPorEmpresa", () => {
  it("mostra placeholder sem DRE", () => {
    render(<ResultadoPorEmpresa dreConsolidado={[]} confiabilidade={[]} />);
    expect(screen.getByText("Sem DRE calculado. Recalcule na aba DRE.")).toBeTruthy();
  });

  it("renderiza linha de DRE com MB, mês, receita e dedução", () => {
    render(<ResultadoPorEmpresa dreConsolidado={[dre]} confiabilidade={[]} />);
    expect(screen.getByText("40.0%")).toBeTruthy(); // margem bruta
    expect(screen.getByText("Mar")).toBeTruthy();
    expect(screen.getByText("R$ 100.0k")).toBeTruthy(); // receita
    expect(screen.getByText("ICMS")).toBeTruthy(); // dedução
  });

  it("teórico do presumido mostra o TOTAL uma vez e rotula o Δ como IRPJ+CSLL", () => {
    const d = { ...dre, detalhamento: { ...(dre as unknown as { detalhamento: object }).detalhamento,
      imposto_teorico: { irpj: 400, csll: 360, pis: 650, cofins: 3000, total: 4410 }, delta_imposto_pct: 0.1 } } as unknown as FinDRE;
    render(<ResultadoPorEmpresa dreConsolidado={[d]} confiabilidade={[]} />);
    const linha = screen.getByText(/Imposto teórico esperado/);
    expect(linha.textContent).toMatch(/4\.410,00/);
    expect(linha.textContent).not.toMatch(/8\.820/);
    expect(linha.textContent).toMatch(/Δ IRPJ\+CSLL 10% vs realizado/);
  });

  it("teórico do simples com DAS desconhecido → indisponível, nunca R$ 0", () => {
    const d = { ...dre, detalhamento: { impostos: {}, regime_tributario: "simples", imposto_teorico: { das: null } } } as unknown as FinDRE;
    render(<ResultadoPorEmpresa dreConsolidado={[d]} confiabilidade={[]} />);
    expect(screen.getByText(/Imposto teórico esperado/).textContent).toMatch(/indisponível/);
  });
});
