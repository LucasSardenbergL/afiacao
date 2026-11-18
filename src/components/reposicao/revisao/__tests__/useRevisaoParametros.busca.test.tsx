import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Busca só com dígitos ("6468") tratava o termo como código Omie EXATO e nunca olhava a
 * descrição — "F ACAB FL20.6468.00QT" sumia da tela. Agora: código OU trecho da descrição.
 */

const chamadas: Array<[string, unknown[]]> = [];

function builder() {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "or", "in", "ilike", "order", "range"]) {
    q[m] = (...args: unknown[]) => {
      chamadas.push([m, args]);
      return q;
    };
  }
  q.then = (ok: (r: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(ok);
  return q;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => builder(), rpc: vi.fn() },
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

beforeEach(() => {
  chamadas.length = 0;
});

async function buscar(termo: string) {
  const { result } = renderHook(() => useRevisaoParametros(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  chamadas.length = 0;
  act(() => result.current.onSearchChange(termo));
  await waitFor(() => expect(chamadas.some(([m]) => m === "range")).toBe(true));
}

describe("useRevisaoParametros — busca numérica", () => {
  it("só dígitos → código Omie OU trecho da descrição", async () => {
    await buscar("6468");
    const ors = chamadas.filter(([m]) => m === "or").map(([, a]) => a[0]);
    expect(ors).toContain("sku_codigo_omie.eq.6468,sku_descricao.ilike.%6468%");
    expect(chamadas.some(([m, a]) => m === "eq" && a[0] === "sku_codigo_omie")).toBe(false);
  });

  it("texto → ilike na descrição, sem cláusula de código", async () => {
    await buscar("verniz");
    expect(chamadas).toContainEqual(["ilike", ["sku_descricao", "%verniz%"]]);
    const ors = chamadas.filter(([m]) => m === "or").map(([, a]) => String(a[0]));
    expect(ors.some((o) => o.includes("sku_codigo_omie"))).toBe(false);
  });
});
