import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Plano v8, C14 — o `error` de `v_sku_parametros_sugeridos` era descartado: os preços e o status
 * de sugestão viravam nulo calados ("sem preço" = "não consegui ler"). E a falha da leitura
 * principal virava "Nenhum SKU encontrado". Os dois agora sobem para a tela.
 */

type Resposta = { data: unknown; error: { message: string } | null; count?: number | null };
let respostas: Record<string, Resposta> = {};

function builder(tabela: string) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "or", "in", "ilike", "order", "range"]) q[m] = () => q;
  q.then = (ok: (r: Resposta) => unknown) =>
    Promise.resolve(respostas[tabela] ?? { data: [], error: null, count: 0 }).then(ok);
  return q;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (t: string) => builder(t), rpc: vi.fn() },
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/hooks/useUrlState", () => ({ useUrlState: () => [{ filtro: "todos" }, vi.fn()] }));
vi.mock("@/hooks/useDebouncedValue", () => ({ useDebouncedValue: (v: unknown) => v }));
vi.mock("@/contexts/ReposicaoEmpresaContext", () => ({ useReposicaoEmpresa: () => ({ empresa: "OBEN" }) }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/reposicao/foraDoMotor/api", () => ({
  buscarForaDoMotor: vi.fn(),
  fecharReativacoesPendentes: vi.fn(),
}));

import { useRevisaoParametros } from "../useRevisaoParametros";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const LINHA_BASE = { id: "p1", empresa: "OBEN", sku_codigo_omie: 101, sku_descricao: "VERNIZ" };
const PRECO = {
  sku_codigo_omie: 101,
  preco_compra_real: 10,
  preco_venda_medio: 20,
  preco_item_eoq: 10,
  fonte_preco: "nfe",
  fornecedor_habilitado: true,
  status_sugestao: "OK",
};

beforeEach(() => {
  respostas = {
    sku_parametros: { data: [LINHA_BASE], error: null, count: 1 },
    v_sku_parametros_sugeridos: { data: [PRECO], error: null },
  };
});

describe("useRevisaoParametros — falha de leitura sobe para a tela", () => {
  it("CONTROLE: tudo lido → preço preenchido, sem aviso", async () => {
    const { result } = renderHook(() => useRevisaoParametros(), { wrapper });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.rows[0].preco_compra_real).toBe(10);
    expect(result.current.precosIndisponiveis).toBe(false);
    expect(result.current.leituraSemLeitura).toBeNull();
  });

  it("erro da view de preços → linhas ficam, e `precosIndisponiveis` acusa", async () => {
    respostas.v_sku_parametros_sugeridos = { data: null, error: { message: "statement timeout" } };
    const { result } = renderHook(() => useRevisaoParametros(), { wrapper });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.precosIndisponiveis).toBe(true);
    expect(result.current.rows[0].preco_compra_real).toBeNull();
  });

  it("erro da leitura principal → estado da falha, não \"nenhum SKU\" calado", async () => {
    respostas.sku_parametros = { data: null, error: { message: "permission denied" }, count: null };
    const { result } = renderHook(() => useRevisaoParametros(), { wrapper });
    await waitFor(() => expect(result.current.leituraSemLeitura).toBe("erro"));
    expect(result.current.rows).toEqual([]);
  });
});
