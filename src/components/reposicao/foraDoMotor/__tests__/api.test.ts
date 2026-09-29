import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock encadeável e THENABLE do supabase: qualquer ponto da cadeia pode ser aguardado (o PostgREST
// real é thenable) e devolve o que `resposta` mandar. `chamadas` guarda a cadeia p/ conferir o filtro.
const resposta = vi.fn();
const rpc = vi.fn();
const chamadas: Array<[string, unknown[]]> = [];
vi.mock("@/integrations/supabase/client", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "range", "in"]) {
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

import {
  contarForaDoMotor,
  buscarForaDoMotor,
  fecharReativacoesPendentes,
  LIMITE_FORA_DO_MOTOR,
  VIEW_FORA_DO_MOTOR,
} from "../api";

beforeEach(() => {
  vi.clearAllMocks();
  chamadas.length = 0;
});

describe("contarForaDoMotor", () => {
  it("lê a contagem da view, filtrada pela empresa", async () => {
    resposta.mockReturnValue({ count: 4, error: null });
    await expect(contarForaDoMotor("OBEN")).resolves.toBe(4);
    expect(chamadas[0]).toEqual(["from", [VIEW_FORA_DO_MOTOR]]);
    expect(chamadas).toContainEqual(["eq", ["empresa", "OBEN"]]);
  });

  it("contagem AUSENTE não vira zero: lança (ausente ≠ zero)", async () => {
    resposta.mockReturnValue({ count: null, error: null });
    await expect(contarForaDoMotor("OBEN")).rejects.toThrow("contagem ausente");
  });

  it("erro do PostgREST propaga", async () => {
    resposta.mockReturnValue({ count: null, error: new Error("permission denied for view") });
    await expect(contarForaDoMotor("OBEN")).rejects.toThrow("permission denied for view");
  });
});

describe("buscarForaDoMotor", () => {
  it("devolve SKU → reativado_omie_pendente", async () => {
    resposta.mockReturnValue({
      data: [
        { sku_codigo_omie: 11978607801, reativado_omie_pendente: true },
        { sku_codigo_omie: 8689734282, reativado_omie_pendente: false },
      ],
      error: null,
    });
    const mapa = await buscarForaDoMotor("OBEN");
    expect([...mapa.entries()]).toEqual([
      [11978607801, true],
      [8689734282, false],
    ]);
    expect(chamadas).toContainEqual(["eq", ["empresa", "OBEN"]]);
  });

  it("resultado no teto do PostgREST lança em vez de truncar calado", async () => {
    resposta.mockReturnValue({
      data: Array.from({ length: LIMITE_FORA_DO_MOTOR }, (_, i) => ({ sku_codigo_omie: i + 1, reativado_omie_pendente: false })),
      error: null,
    });
    await expect(buscarForaDoMotor("OBEN")).rejects.toThrow("teto");
  });

  it("erro do PostgREST propaga", async () => {
    resposta.mockReturnValue({ data: null, error: new Error("boom") });
    await expect(buscarForaDoMotor("OBEN")).rejects.toThrow("boom");
  });
});

describe("fecharReativacoesPendentes", () => {
  it("resolve cada evento sku_reativado_omie pendente do SKU pelo RPC da tela de Alertas", async () => {
    resposta.mockReturnValue({ data: [{ id: 7 }, { id: 9 }], error: null });
    rpc.mockResolvedValue({ data: {}, error: null });
    await expect(fecharReativacoesPendentes("OBEN", 12034226322, "lucas@x.com", "religado")).resolves.toBe(2);
    expect(chamadas).toContainEqual(["from", ["eventos_outlier"]]);
    expect(chamadas).toContainEqual(["eq", ["sku_codigo_omie", "12034226322"]]);
    expect(chamadas).toContainEqual(["eq", ["tipo", "sku_reativado_omie"]]);
    expect(chamadas).toContainEqual(["eq", ["status", "pendente"]]);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("resolver_outlier", {
      p_evento_id: 7,
      p_decisao: "aceitar",
      p_justificativa: "religado",
      p_usuario_email: "lucas@x.com",
    });
  });

  it("sem evento pendente não chama o RPC", async () => {
    resposta.mockReturnValue({ data: [], error: null });
    await expect(fecharReativacoesPendentes("OBEN", 1, "lucas@x.com", "x")).resolves.toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("falha do RPC propaga (quem chama decide se é best-effort)", async () => {
    resposta.mockReturnValue({ data: [{ id: 7 }], error: null });
    rpc.mockResolvedValue({ data: null, error: new Error("Evento já resolvido") });
    await expect(fecharReativacoesPendentes("OBEN", 1, "lucas@x.com", "x")).rejects.toThrow("Evento já resolvido");
  });
});
