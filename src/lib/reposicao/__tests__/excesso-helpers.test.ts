import { describe, expect, it } from "vitest";
import {
  LIMIAR_ESTRUTURAL_DIAS,
  accountsDaEmpresa,
  calcularLinhaExcesso,
  dedupePosicaoMaisRecente,
  ordenarPorCapitalExcedente,
  somarKpisExcesso,
} from "@/lib/reposicao/excesso-helpers";

describe("accountsDaEmpresa", () => {
  it("espelha o CASE canônico da RPC do motor", () => {
    expect(accountsDaEmpresa("OBEN")).toEqual(["vendas", "oben"]);
    expect(accountsDaEmpresa("COLACOR")).toEqual(["colacor_vendas", "colacor"]);
    expect(accountsDaEmpresa("COLACOR_SC")).toEqual(["servicos", "colacor_sc"]);
    expect(accountsDaEmpresa("OUTRA")).toEqual(["outra"]);
  });
});

describe("dedupePosicaoMaisRecente", () => {
  it("fica com a linha mais recente entre accounts", () => {
    const m = dedupePosicaoMaisRecente([
      { omie_codigo_produto: 1, saldo: 10, cmc: 5, synced_at: "2026-07-01T00:00:00Z" },
      { omie_codigo_produto: 1, saldo: 14, cmc: 5, synced_at: "2026-07-20T00:00:00Z" },
    ]);
    expect(m.get(1)?.saldo).toBe(14);
  });
  it("linha com synced_at null perde para linha datada, mas existe sozinha", () => {
    const m = dedupePosicaoMaisRecente([
      { omie_codigo_produto: 1, saldo: 3, cmc: 2, synced_at: null },
      { omie_codigo_produto: 1, saldo: 7, cmc: 2, synced_at: "2026-07-20T00:00:00Z" },
      { omie_codigo_produto: 2, saldo: 4, cmc: 1, synced_at: null },
    ]);
    expect(m.get(1)?.saldo).toBe(7);
    expect(m.get(2)?.saldo).toBe(4);
  });
});

describe("calcularLinhaExcesso", () => {
  it("sem excesso (saldo <= máximo) → null", () => {
    expect(calcularLinhaExcesso({ saldo: 2, estoqueMaximo: 2, demandaMediaDiaria: 1, cmc: 10 })).toBeNull();
    expect(calcularLinhaExcesso({ saldo: 1, estoqueMaximo: 2, demandaMediaDiaria: 1, cmc: 10 })).toBeNull();
  });
  it("dados ausentes não afirmam excesso (saldo/max null → null)", () => {
    expect(calcularLinhaExcesso({ saldo: null, estoqueMaximo: 2, demandaMediaDiaria: 1, cmc: 10 })).toBeNull();
    expect(calcularLinhaExcesso({ saldo: 5, estoqueMaximo: null, demandaMediaDiaria: 1, cmc: 10 })).toBeNull();
  });
  it("excesso digerível: tempo = ceil(excedente/d)", () => {
    const l = calcularLinhaExcesso({ saldo: 14, estoqueMaximo: 2, demandaMediaDiaria: 0.5, cmc: 100 });
    expect(l).toMatchObject({ excedenteUn: 12, capitalExcedente: 1200, tempoDigerirDias: 24, situacao: "digerivel" });
  });
  it("excesso estrutural: acima do limiar", () => {
    const l = calcularLinhaExcesso({ saldo: 14, estoqueMaximo: 2, demandaMediaDiaria: 0.05, cmc: 100 });
    expect(l?.tempoDigerirDias).toBe(240);
    expect(l?.tempoDigerirDias).toBeGreaterThan(LIMIAR_ESTRUTURAL_DIAS);
    expect(l?.situacao).toBe("estrutural");
  });
  it("demanda zero/null = sem giro (nunca fabrica tempo)", () => {
    expect(calcularLinhaExcesso({ saldo: 5, estoqueMaximo: 2, demandaMediaDiaria: 0, cmc: 10 })?.situacao).toBe("sem_giro");
    expect(calcularLinhaExcesso({ saldo: 5, estoqueMaximo: 2, demandaMediaDiaria: null, cmc: 10 })?.tempoDigerirDias).toBeNull();
  });
  it("cmc ausente/zero: capital null, nunca R$0 fabricado", () => {
    expect(calcularLinhaExcesso({ saldo: 5, estoqueMaximo: 2, demandaMediaDiaria: 1, cmc: null })?.capitalExcedente).toBeNull();
    expect(calcularLinhaExcesso({ saldo: 5, estoqueMaximo: 2, demandaMediaDiaria: 1, cmc: 0 })?.capitalExcedente).toBeNull();
  });
});

describe("somarKpisExcesso", () => {
  it("separa estrutural (inclui sem_giro) e conta sem-custo fora do total", () => {
    const k = somarKpisExcesso([
      { capitalExcedente: 100, situacao: "digerivel" },
      { capitalExcedente: 200, situacao: "estrutural" },
      { capitalExcedente: 50, situacao: "sem_giro" },
      { capitalExcedente: null, situacao: "estrutural" },
    ]);
    expect(k).toEqual({ capitalExcedenteRs: 350, capitalEstruturalRs: 250, skusN: 4, estruturaisN: 3, semCustoN: 1 });
  });
});

describe("ordenarPorCapitalExcedente", () => {
  it("desc, sem-custo (null) por último, sem mutar a entrada", () => {
    const entrada = [
      { capitalExcedente: null }, { capitalExcedente: 10 }, { capitalExcedente: 300 },
    ];
    const saida = ordenarPorCapitalExcedente(entrada, (l) => l.capitalExcedente);
    expect(saida.map((s) => s.capitalExcedente)).toEqual([300, 10, null]);
    expect(entrada[0].capitalExcedente).toBeNull();
  });
});
