import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Plano v8, C14 — os KPIs de /admin/notificacoes viravam zero em erro (`stats30 ?? []`):
 * "não consegui ler" chegava como "0 alertas em 7 dias, 0% de sucesso, 0 esgotados".
 */

type Resposta = { data: unknown; error: { message: string } | null };
let resposta: Resposta = { data: [], error: null };

function builder() {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "gte", "order", "limit"]) q[m] = () => q;
  q.then = (ok: (r: Resposta) => unknown) => Promise.resolve(resposta).then(ok);
  return q;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => builder(), functions: { invoke: vi.fn() } },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useNotificacoes } from "../useNotificacoes";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  resposta = { data: [], error: null };
});

describe("useNotificacoes — KPIs de 30 dias", () => {
  it("CONTROLE: leitura boa e vazia → 0 alertas, sem taxa (null), sem aviso", async () => {
    const { result } = renderHook(() => useNotificacoes(), { wrapper });
    await waitFor(() => expect(result.current.loadingStats).toBe(false));
    expect(result.current.total7d).toBe(0);
    expect(result.current.esgotados).toBe(0);
    expect(result.current.taxaSucesso).toBeNull();
    expect(result.current.statsSemLeitura).toBeNull();
  });

  it("CONTROLE: com notificações concluídas → taxa medida", async () => {
    const agora = new Date().toISOString();
    resposta = {
      data: [
        { id: "1", status: "notificado", criado_em: agora, tentativas: 1 },
        { id: "2", status: "falha_notificacao", criado_em: agora, tentativas: 3 },
      ],
      error: null,
    };
    const { result } = renderHook(() => useNotificacoes(), { wrapper });
    await waitFor(() => expect(result.current.total7d).toBe(2));
    expect(result.current.taxaSucesso).toBe(50);
    expect(result.current.esgotados).toBe(1);
  });

  it("erro na leitura → KPIs null e o estado da falha, não zeros", async () => {
    resposta = { data: null, error: { message: "permission denied" } };
    const { result } = renderHook(() => useNotificacoes(), { wrapper });
    await waitFor(() => expect(result.current.statsSemLeitura).toBe("erro"));
    expect(result.current.total7d).toBeNull();
    expect(result.current.taxaSucesso).toBeNull();
    expect(result.current.esgotados).toBeNull();
    expect(result.current.chartData).toEqual([]);
  });
});
