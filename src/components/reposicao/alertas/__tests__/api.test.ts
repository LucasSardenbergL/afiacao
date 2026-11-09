import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock encadeável e THENABLE do supabase (mesmo molde de foraDoMotor/__tests__/api.test.ts): qualquer
// ponto da cadeia pode ser aguardado e devolve o que `resposta` mandar; `chamadas` guarda a cadeia.
const resposta = vi.fn();
const rpc = vi.fn();
const chamadas: Array<[string, unknown[]]> = [];
vi.mock("@/integrations/supabase/client", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "insert"]) {
    chain[m] = (...a: unknown[]) => {
      chamadas.push([m, a]);
      return chain;
    };
  }
  chain.then = (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
    Promise.resolve(resposta()).then(ok, erro);
  return {
    supabase: {
      from: (t: string) => {
        chamadas.push(["from", [t]]);
        return chain;
      },
      rpc: (...a: unknown[]) => rpc(...a),
    },
  };
});

import { atribuirGrupoAosSkus, buscarStats } from "../api";

const grupo = { grupo_codigo: "G1", descricao: "Bases PU" };
const ev = (id: number, empresa = "OBEN") => ({ id, sku_codigo_omie: String(1000 + id), empresa });

beforeEach(() => {
  vi.clearAllMocks();
  chamadas.length = 0;
});

describe("atribuirGrupoAosSkus", () => {
  it("grava vínculo e fecha alerta de cada SKU, e recalcula UMA vez no fim", async () => {
    resposta.mockResolvedValue({ error: null });
    rpc.mockResolvedValue({ error: null });
    const r = await atribuirGrupoAosSkus({ empresa: "OBEN", eventos: [ev(1), ev(2)], grupo, usuarioEmail: "x@y" });
    expect(r).toEqual({ atribuidos: 2, falha: null, recalculoFalhou: false });
    const inserts = chamadas.filter(([m]) => m === "insert").map(([, a]) => a[0]);
    expect(inserts).toEqual([
      { empresa: "OBEN", sku_codigo_omie: "1001", grupo_codigo: "G1" },
      { empresa: "OBEN", sku_codigo_omie: "1002", grupo_codigo: "G1" },
    ]);
    const nomes = rpc.mock.calls.map((c) => c[0]);
    expect(nomes).toEqual(["resolver_outlier", "resolver_outlier", "atualizar_parametros_numericos_skus"]);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_evento_id: 1, p_decisao: "aceitar" });
  });

  it("insert falhou → para ali, não conta o SKU, e recalcula só se algum anterior valeu", async () => {
    resposta.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: "duplicate key" } });
    rpc.mockResolvedValue({ error: null });
    const r = await atribuirGrupoAosSkus({ empresa: "OBEN", eventos: [ev(1), ev(2), ev(3)], grupo });
    expect(r.atribuidos).toBe(1);
    expect(r.falha).toEqual({ sku: "1002", mensagem: "duplicate key" });
    expect(chamadas.filter(([m]) => m === "insert")).toHaveLength(2);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["resolver_outlier", "atualizar_parametros_numericos_skus"]);
  });

  it("primeiro insert falhou → nada atribuído e NÃO recalcula", async () => {
    resposta.mockResolvedValueOnce({ error: { message: "RLS" } });
    const r = await atribuirGrupoAosSkus({ empresa: "OBEN", eventos: [ev(1)], grupo });
    expect(r).toEqual({ atribuidos: 0, falha: { sku: "1001", mensagem: "RLS" }, recalculoFalhou: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("resolver falhou depois do vínculo gravado → conta o SKU (já classificado) e reporta a falha", async () => {
    resposta.mockResolvedValue({ error: null });
    rpc.mockResolvedValueOnce({ error: { message: "42501" } }).mockResolvedValue({ error: null });
    const r = await atribuirGrupoAosSkus({ empresa: "OBEN", eventos: [ev(1), ev(2)], grupo });
    expect(r.atribuidos).toBe(1);
    expect(r.falha).toEqual({ sku: "1001", mensagem: "42501" });
    expect(chamadas.filter(([m]) => m === "insert")).toHaveLength(1);
  });

  it("recálculo devolveu erro → recalculoFalhou (rpc não lança; antes o toast dizia 'recalculados')", async () => {
    resposta.mockResolvedValue({ error: null });
    rpc
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: "statement timeout" } });
    const r = await atribuirGrupoAosSkus({ empresa: "OBEN", eventos: [ev(1)], grupo });
    expect(r).toEqual({ atribuidos: 1, falha: null, recalculoFalhou: true });
  });

  it("eventos de outra empresa no lote → recusa antes de escrever", async () => {
    await expect(
      atribuirGrupoAosSkus({ empresa: "OBEN", eventos: [ev(1), ev(2, "COLACOR")], grupo }),
    ).rejects.toThrow("Eventos de empresas diferentes no mesmo lote");
    expect(chamadas).toHaveLength(0);
  });
});

describe("buscarStats", () => {
  it("conta por HEAD (sem baixar linhas) e soma decisões humanas de hoje", async () => {
    let n = 0;
    resposta.mockImplementation(() => ({ count: ++n, error: null }));
    const s = await buscarStats(new Date(2026, 9, 31, 15, 0));
    expect(s).toEqual({
      semGrupo: 1, ltAtipico: 2, ltCriticos: 3, vendaAtipica: 4, inativadoOmie: 5, reativadoOmie: 6, decididosHoje: 7,
    });
    const selects = chamadas.filter(([m]) => m === "select").map(([, a]) => a[1]);
    expect(selects.every((o) => (o as { head?: boolean }).head === true)).toBe(true);
    const gte = chamadas.find(([m]) => m === "gte");
    expect(gte?.[1][0]).toBe("decidido_em");
    expect(new Date(gte?.[1][1] as string).getHours()).toBe(0);
  });

  it("count null → erro (ausente ≠ zero: card mostraria 0 inventado)", async () => {
    resposta.mockResolvedValue({ count: null, error: null });
    await expect(buscarStats()).rejects.toThrow("Contagem de alertas indisponível");
  });

  it("erro do PostgREST propaga", async () => {
    resposta.mockResolvedValue({ count: null, error: { message: "boom" } });
    await expect(buscarStats()).rejects.toMatchObject({ message: "boom" });
  });
});
