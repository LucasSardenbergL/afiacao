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
});
