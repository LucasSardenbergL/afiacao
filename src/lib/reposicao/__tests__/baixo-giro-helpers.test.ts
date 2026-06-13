import { describe, it, expect } from "vitest";
import {
  somarCapitalParado,
  classificarSituacao,
  diasSemVender,
  previewManterLote,
} from "../baixo-giro-helpers";

describe("somarCapitalParado", () => {
  it("soma saldo×cmc só onde saldo>0 e cmc>0; conta os sem custo", () => {
    const r = somarCapitalParado([
      { saldo: 10, cmc: 5 },     // 50
      { saldo: 2, cmc: null },   // sem custo
      { saldo: 0, cmc: 9 },      // sem estoque → ignora
      { saldo: 3, cmc: 0 },      // cmc 0 = sem custo
    ]);
    expect(r.totalRs).toBe(50);
    expect(r.semCustoN).toBe(2);
    expect(r.comEstoqueN).toBe(3);
  });
  it("lida com lista vazia", () => {
    expect(somarCapitalParado([])).toEqual({ totalRs: 0, semCustoN: 0, comEstoqueN: 0 });
  });
});

describe("classificarSituacao", () => {
  it("mapeia bloqueios para resolver_bloqueio", () => {
    expect(classificarSituacao("SEM_PRECO", 1).cta).toBe("resolver_bloqueio");
    expect(classificarSituacao("SEM_LEADTIME_DEFINIDO", 1).tipo).toBe("sem_leadtime");
    expect(classificarSituacao("AGUARDANDO_HABILITACAO_FORNECEDOR", 1).tipo).toBe("sem_fornecedor");
    expect(classificarSituacao("AGUARDANDO_CLASSIFICACAO_GRUPO", 1).tipo).toBe("sem_grupo");
  });
  it("2ª ordem vira cold_start", () => {
    const r = classificarSituacao("AGUARDANDO_SEGUNDA_ORDEM", null);
    expect(r.tipo).toBe("aguardando_2a_ordem");
    expect(r.cta).toBe("cold_start");
  });
  it("OK fica em dia", () => {
    expect(classificarSituacao("OK", 1).cta).toBe("em_dia");
  });
  it("sem status + sem parâmetro = sem_parametro / manter_ou_descontinuar", () => {
    const r = classificarSituacao(null, null);
    expect(r.tipo).toBe("sem_parametro");
    expect(r.cta).toBe("manter_ou_descontinuar");
  });
});

describe("diasSemVender", () => {
  it("conta dias entre última venda e hoje", () => {
    expect(diasSemVender("2026-06-01", "2026-06-06")).toBe(5);
  });
  it("null sem venda", () => {
    expect(diasSemVender(null, "2026-06-06")).toBeNull();
  });
});

describe("previewManterLote", () => {
  it("soma qtde e R$ que o ciclo compraria com pp/max novos; só itens em posição<=pp", () => {
    const r = previewManterLote(
      [
        { ppAtual: null, maxAtual: null, posicao: 0, custo: 10 }, // pos 0 <= 1 → compra 2 → R$20
        { ppAtual: null, maxAtual: null, posicao: 1, custo: 5 },  // pos 1 <= 1 → compra 1 → R$5
        { ppAtual: null, maxAtual: null, posicao: 5, custo: 4 },  // pos 5 > 1 → 0
        { ppAtual: null, maxAtual: null, posicao: 0, custo: null },// compra 2, sem custo
      ],
      1, 2,
    );
    expect(r.qtdeTotal).toBe(5);         // 2+1+0+2
    expect(r.valorTotalRs).toBe(25);     // 20+5+0
    expect(r.semCustoN).toBe(1);         // o item com custo null que compraria
  });
});
