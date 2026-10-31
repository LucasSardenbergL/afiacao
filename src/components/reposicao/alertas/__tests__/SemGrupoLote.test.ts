import { describe, it, expect } from "vitest";
import { agruparPorFornecedor } from "../SemGrupoLote";
import type { EventoOutlier } from "../types";

const ev = (id: number, fornecedor: string | undefined, empresa = "OBEN"): EventoOutlier => ({
  id, empresa, sku_codigo_omie: String(id), sku_descricao: null, tipo: "sku_sem_grupo", severidade: "atencao",
  data_evento: "2026-05-14", valor_observado: null, valor_esperado: null, desvios_padrao: null,
  detalhes: fornecedor === undefined ? null : { fornecedor }, status: "pendente",
  decidido_em: null, decidido_por: null, justificativa_decisao: null, detectado_em: "2026-05-14",
});

describe("agruparPorFornecedor", () => {
  it("agrupa por empresa+fornecedor, maior lote primeiro", () => {
    const lotes = agruparPorFornecedor([ev(1, "SAINT"), ev(2, "SAYERLACK"), ev(3, "SAYERLACK")]);
    expect(lotes.map((l) => [l.fornecedor, l.eventos.map((e) => e.id)])).toEqual([
      ["SAYERLACK", [2, 3]],
      ["SAINT", [1]],
    ]);
  });

  it("mesmo fornecedor em empresas diferentes NÃO se mistura (o lote recalcula uma empresa)", () => {
    const lotes = agruparPorFornecedor([ev(1, "SAYERLACK"), ev(2, "SAYERLACK", "COLACOR")]);
    expect(lotes).toHaveLength(2);
    expect(lotes.every((l) => l.eventos.every((e) => e.empresa === l.empresa))).toBe(true);
  });

  it("sem fornecedor no detalhe → lote próprio com nome vazio, não some", () => {
    const lotes = agruparPorFornecedor([ev(1, undefined)]);
    expect(lotes).toEqual([expect.objectContaining({ fornecedor: "", eventos: [expect.objectContaining({ id: 1 })] })]);
  });
});
