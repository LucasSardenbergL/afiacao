import { describe, expect, it } from "vitest";
import {
  avaliarFilaNoCaixa,
  companyDoFinanceiro,
  custoCapitalMensal,
  pisoProjecao,
  ROTULO_PISO_HOJE,
  somarFilaCompras,
} from "@/lib/reposicao/caixa-compra-helpers";

describe("companyDoFinanceiro", () => {
  it("reposição OBEN vira oben do financeiro", () => {
    expect(companyDoFinanceiro("OBEN")).toBe("oben");
    expect(companyDoFinanceiro("COLACOR_SC")).toBe("colacor_sc");
  });
});

describe("pisoProjecao", () => {
  it("acha o MIN entre hoje e os fechamentos, e a semana dele", () => {
    // hoje = 100 − 10 = 90; o fechamento de S2 (−40) é o piso.
    const r = pisoProjecao([
      { saldo_projetado: 100, fluxo_liquido: 10, semana_label: "S1" },
      { saldo_projetado: -40, fluxo_liquido: -140, semana_label: "S2" },
      { saldo_projetado: 60, fluxo_liquido: 100, semana_label: "S3" },
    ]);
    expect(r).toEqual({ pisoRs: -40, semanaLabel: "S2" });
  });
  it("#3401: o saldo de HOJE entra como ponto — recebimento na sexta não esconde a compra de hoje", () => {
    // Saldo R$100 hoje, recebimento de R$1.000 na semana: fecha em R$1.100. A compra à vista de
    // R$500 sai hoje → o caixa vai a −R$400, embora todos os fechamentos fiquem ≥ R$600.
    const semanas = [
      { saldo_projetado: 1_100, fluxo_liquido: 1_000, semana_label: "26/10-01/11" },
      { saldo_projetado: 1_100, fluxo_liquido: 0, semana_label: "02/11-08/11" },
    ];
    const piso = pisoProjecao(semanas);
    expect(piso).toEqual({ pisoRs: 100, semanaLabel: ROTULO_PISO_HOJE });
    expect(avaliarFilaNoCaixa({ pisoRs: piso!.pisoRs, filaRs: 500 })).toEqual({ pisoDepoisRs: -400, furaCaixa: true });
  });
  it("centavos: caixa que ZERA não fura (1100,10 − 1000 − 100,10), e R$0,01 a mais fura", () => {
    const piso = pisoProjecao([{ saldo_projetado: 1_100.1, fluxo_liquido: 1_000, semana_label: "S1" }]);
    expect(piso).toEqual({ pisoRs: 100.1, semanaLabel: ROTULO_PISO_HOJE });
    expect(avaliarFilaNoCaixa({ pisoRs: piso!.pisoRs, filaRs: 100.1 })).toEqual({ pisoDepoisRs: 0, furaCaixa: false });
    expect(avaliarFilaNoCaixa({ pisoRs: piso!.pisoRs, filaRs: 100.11 })).toEqual({ pisoDepoisRs: -0.01, furaCaixa: true });
    expect(avaliarFilaNoCaixa({ pisoRs: piso!.pisoRs, filaRs: 100.09 })).toEqual({ pisoDepoisRs: 0.01, furaCaixa: false });
  });
  it("projeção vazia ou toda-null → null (indisponível ≠ piso zero)", () => {
    expect(pisoProjecao([])).toBeNull();
    expect(pisoProjecao([{ saldo_projetado: null, fluxo_liquido: 5, semana_label: "S1" }])).toBeNull();
  });
  it("semana 0 sem fluxo numérico → null: sem o ponto hoje não há piso de caixa", () => {
    expect(pisoProjecao([
      { saldo_projetado: 100, fluxo_liquido: null, semana_label: "S1" },
      { saldo_projetado: 50, fluxo_liquido: -50, semana_label: "S2" },
    ])).toBeNull();
    expect(pisoProjecao([{ saldo_projetado: 100, fluxo_liquido: Number.NaN, semana_label: "S1" }])).toBeNull();
  });
  it("linha null depois da semana 0 é ignorada, o resto vale", () => {
    const r = pisoProjecao([
      { saldo_projetado: 50, fluxo_liquido: 0, semana_label: "S1" },
      { saldo_projetado: null, fluxo_liquido: 0, semana_label: "S2" },
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
