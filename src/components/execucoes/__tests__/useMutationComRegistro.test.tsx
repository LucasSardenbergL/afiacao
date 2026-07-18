import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const inserts: Array<Record<string, unknown>> = [];
const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
let falharInsert = false;

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (tabela: string) => {
      if (tabela === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { name: "Lucas" }, error: null }),
            }),
          }),
        };
      }
      // acoes_execucoes
      return {
        insert: (linha: Record<string, unknown>) => ({
          select: () => ({
            single: () => {
              if (falharInsert) return Promise.resolve({ data: null, error: { message: "RLS" } });
              inserts.push(linha);
              return Promise.resolve({ data: { id: "reg-1" }, error: null });
            },
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: (_col: string, id: string) => {
            updates.push({ id, patch });
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  },
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "u-master" } }),
}));

import { useMutationComRegistro } from "../useMutationComRegistro";

function criarWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  inserts.length = 0;
  updates.length = 0;
  falharInsert = false;
});

describe("useMutationComRegistro", () => {
  it("sucesso: abre registro, roda a mutation, fecha com sucesso + detalhes", async () => {
    const { result } = renderHook(
      () =>
        useMutationComRegistro({
          acao: "teste.acao",
          mutationFn: async () => ({ importados: 7 }),
          detalhes: (d) => ({ importados: d.importados }),
        }),
      { wrapper: criarWrapper() },
    );

    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ acao: "teste.acao", executado_por: "u-master" });
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("reg-1");
    expect(updates[0].patch).toMatchObject({ status: "sucesso", detalhes: { importados: 7 } });
  });

  it("FAIL-OPEN: insert do registro falha e a ação real roda mesmo assim", async () => {
    falharInsert = true;
    const mutationFn = vi.fn(async () => "ok");
    const { result } = renderHook(
      () => useMutationComRegistro({ acao: "teste.acao", mutationFn }),
      { wrapper: criarWrapper() },
    );

    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mutationFn).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe("ok");
    expect(updates).toHaveLength(0); // sem registro aberto, nada a fechar
  });

  it("erro na mutation: fecha registro com erro e re-lança (onError do caller ainda dispara)", async () => {
    // Tipar o mock: vi.fn() cru é variádico e faria TVariables inferir any (mutate() viraria TS2554).
    const onError = vi.fn((_e: Error) => {});
    const { result } = renderHook(
      () =>
        useMutationComRegistro({
          acao: "teste.acao",
          mutationFn: async () => {
            throw new Error("quebrou");
          },
          onError,
        }),
      { wrapper: criarWrapper() },
    );

    result.current.mutate();
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toMatchObject({ status: "erro" });
    expect(String((updates[0].patch as { detalhes: { erro: string } }).detalhes.erro)).toContain("quebrou");
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
