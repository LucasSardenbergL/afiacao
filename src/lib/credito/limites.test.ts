import { describe, expect, it } from "vitest";
import {
  agruparPorFaixa, emBlocos, lerResultadoLote, motivoFalha, tamanhoDe, valorCitado, type PropostaFila,
} from "./limites";

const base: PropostaFila = {
  id: "p1", grupo_user_id: "g1", nome: "Cliente", documento: null, status: "pendente",
  limite_sugerido_brl: 3000, prazo_max_dias: 21, risco: "baixo", confianca: 0.8,
  ficha: {}, saida_ia: null, travas: null, ficha_calculada_em: "2026-11-25T12:00:00Z",
  created_at: "2026-11-25T12:00:00Z", limite_vigente_brl: null,
};

describe("faixas risco × tamanho", () => {
  it("classifica o tamanho pelo limite pós-trava", () => {
    expect([tamanhoDe(0), tamanhoDe(5000), tamanhoDe(5001), tamanhoDe(20001)])
      .toEqual(["zero", "ate_5k", "ate_20k", "acima_20k"]);
  });
  it("agrupa e ordena baixo→sem evidência, zero→maior, somando o total", () => {
    const f = agruparPorFaixa([
      { ...base, id: "a", risco: "alto", limite_sugerido_brl: 0 },
      { ...base, id: "b", risco: "baixo", limite_sugerido_brl: 30000 },
      { ...base, id: "c", risco: "baixo", limite_sugerido_brl: 3000 },
      { ...base, id: "d", risco: "baixo", limite_sugerido_brl: 2000 },
    ]);
    expect(f.map((x) => x.chave)).toEqual(["baixo:ate_5k", "baixo:acima_20k", "alto:zero"]);
    expect(f[0].total_brl).toBe(5000);
  });
});

describe("valor real do campo citado pela IA", () => {
  const ficha = { em_aberto_brl: 600, atraso_p80_dias: 2, pct_valor_atrasado: 0.1429, compra_media_mensal_brl: null,
    evidencia_suficiente: true, piso_estado: "livre" };
  it("formata cada tipo e mostra 'desconhecido' para null (ausente ≠ zero)", () => {
    expect(valorCitado(ficha, "atraso_p80_dias")).toBe("2 d");
    expect(valorCitado(ficha, "pct_valor_atrasado")).toBe("14,3%");
    expect(valorCitado(ficha, "compra_media_mensal_brl")).toBe("desconhecido");
    expect(valorCitado(ficha, "evidencia_suficiente")).toBe("sim");
    expect(valorCitado(ficha, "piso_estado")).toBe("livre");
    expect(valorCitado(ficha, "em_aberto_brl")).toMatch(/^R\$\s?600$/);
  });
  it("campo que a ficha não tem é dito, não inventado", () => {
    expect(valorCitado(ficha, "nome_cliente")).toBe("campo inexistente na ficha");
  });
});

describe("lote", () => {
  it("blocos de até 50 quando pedido, deduplicados", () => {
    const ids = Array.from({ length: 120 }, (_, i) => `id${i % 101}`);
    const b = emBlocos(ids, 50);
    expect(b.map((x) => x.length)).toEqual([50, 50, 1]);
  });
  it("padrão: blocos de 3 (cabe no statement_timeout — blocos de 13+ estouravam em prod)", () => {
    const ids = Array.from({ length: 7 }, (_, i) => `id${i}`);
    expect(emBlocos(ids).map((x) => x.length)).toEqual([3, 3, 1]);
  });
  it("lê a resposta por id e recusa forma estranha", () => {
    const r = lerResultadoLote({ aprovadas: 1, resultados: [
      { id: "a", ok: true, versao: 1 },
      { id: "b", ok: false, sqlstate: "P0001", erro: "credito_aprovar_proposta: ficha_vencida (x)" },
    ] });
    expect(r.map((x) => x.ok)).toEqual([true, false]);
    expect(motivoFalha(r[1])).toBe("ficha com mais de 14 dias — aguarde a reavaliação");
    expect(() => lerResultadoLote({ aprovadas: 1 })).toThrow("resposta do lote sem resultados");
    expect(() => lerResultadoLote({ resultados: [{ ok: true }] })).toThrow("resultado do lote malformado");
  });
});
