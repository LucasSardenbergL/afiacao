import { describe, expect, it } from "vitest";
import {
  avaliarFilaNoCaixa,
  companyDoFinanceiro,
  custoCapitalMensal,
  pisoProjecao,
  somarFilaCompras,
} from "@/lib/reposicao/caixa-compra-helpers";

describe("companyDoFinanceiro", () => {
  it("reposição OBEN vira oben do financeiro", () => {
    expect(companyDoFinanceiro("OBEN")).toBe("oben");
    expect(companyDoFinanceiro("COLACOR_SC")).toBe("colacor_sc");
  });
});

describe("pisoProjecao", () => {
  it("acha o MIN e a semana dele", () => {
    const r = pisoProjecao([
      { saldo_projetado: 100, semana_label: "S1" },
      { saldo_projetado: -40, semana_label: "S2" },
      { saldo_projetado: 60, semana_label: "S3" },
    ]);
    expect(r).toEqual({ pisoRs: -40, semanaLabel: "S2" });
  });
  it("projeção vazia ou toda-null → null (indisponível ≠ piso zero)", () => {
    expect(pisoProjecao([])).toBeNull();
    expect(pisoProjecao([{ saldo_projetado: null, semana_label: "S1" }])).toBeNull();
  });
  it("linha null no meio é ignorada, o resto vale", () => {
    const r = pisoProjecao([
      { saldo_projetado: 50, semana_label: "S1" },
      { saldo_projetado: null, semana_label: "S2" },
    ]);
    expect(r?.pisoRs).toBe(50);
  });
});

describe("somarFilaCompras", () => {
  it("soma pendentes + aprovados; ignora split pai, cancelado, valor nulo/zero", () => {
    const r = somarFilaCompras([
      { status: "pendente_aprovacao", valor_total: 1000 },
      { status: "aprovado_aguardando_disparo", valor_total: 500 },
      { status: "split_em_filhos", valor_total: 1500 },
      { status: "cancelado", valor_total: 200 },
      { status: "disparado", valor_total: 300 },
      { status: "pendente_aprovacao", valor_total: null },
      { status: "pendente_aprovacao", valor_total: 0 },
    ]);
    expect(r).toEqual({ pendentesRs: 1000, aprovadosRs: 500, totalRs: 1500 });
  });
});

describe("avaliarFilaNoCaixa", () => {
  it("piso menos fila; fura quando cruza R$0", () => {
    expect(avaliarFilaNoCaixa({ pisoRs: 5000, filaRs: 1500 })).toEqual({ pisoDepoisRs: 3500, furaCaixa: false });
    expect(avaliarFilaNoCaixa({ pisoRs: 1000, filaRs: 1500 })).toEqual({ pisoDepoisRs: -500, furaCaixa: true });
  });
  it("piso já negativo continua negativo (fila só piora)", () => {
    expect(avaliarFilaNoCaixa({ pisoRs: -100, filaRs: 50 }).furaCaixa).toBe(true);
  });
});

describe("custoCapitalMensal", () => {
  it("valor × cm/12", () => {
    expect(custoCapitalMensal(12000, 25.75)).toBeCloseTo(12000 * 0.2575 / 12, 6);
  });
  it("config ausente/inválida → null (nunca fabrica)", () => {
    expect(custoCapitalMensal(12000, null)).toBeNull();
    expect(custoCapitalMensal(12000, 0)).toBeNull();
    expect(custoCapitalMensal(12000, Number.NaN)).toBeNull();
  });
  it("fila vazia custa 0 (com config válida)", () => {
    expect(custoCapitalMensal(0, 25.75)).toBe(0);
  });
});
