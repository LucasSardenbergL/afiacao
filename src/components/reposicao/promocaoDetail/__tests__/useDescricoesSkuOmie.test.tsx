import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// O hook lê a descrição dos SKUs vinculados aos itens da campanha. A identidade da leitura é
// (conta da campanha, SKUs): vincular um SKU novo tem de disparar OUTRA leitura — reaproveitar o
// mapa anterior mostraria o SKU novo como "fora do catálogo" sem ninguém ter lido.

const { leituras, resposta } = vi.hoisted(() => ({
  leituras: [] as Array<{ conta: unknown; skus: unknown }>,
  resposta: { erro: null as null | { message: string } },
}));

const CATALOGO = [
  { omie_codigo_produto: 8689717792, descricao: "THINNER DR.4403LT", codigo: "PRD00411" },
  { omie_codigo_produto: 8689744102, descricao: "THINNER DR.4403L5", codigo: "PRD00412" },
];

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (tabela: string) => {
      if (tabela !== "omie_products") throw new Error(`tabela inesperada: ${tabela}`);
      const leitura: { conta: unknown; skus: unknown } = { conta: undefined, skus: undefined };
      const q = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => {
          if (coluna === "account") leitura.conta = valor;
          return q;
        },
        in: (coluna: string, valores: number[]) => {
          if (coluna === "omie_codigo_produto") leitura.skus = valores;
          leituras.push(leitura);
          return Promise.resolve(
            resposta.erro
              ? { data: null, error: resposta.erro }
              : { data: CATALOGO.filter((p) => valores.includes(p.omie_codigo_produto)), error: null },
          );
        },
      };
      return q;
    },
  },
}));

import { useDescricoesSkuOmie } from "../useDescricoesSkuOmie";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  leituras.length = 0;
  resposta.erro = null;
});

describe("useDescricoesSkuOmie", () => {
  it("lê na conta da campanha (minúscula) os SKUs distintos e ordenados, e relê quando um vínculo muda", async () => {
    const { result, rerender } = renderHook(
      ({ skus }: { skus: Array<number | null> }) => useDescricoesSkuOmie("OBEN", skus),
      { initialProps: { skus: [8689744102, null, 8689744102] }, wrapper },
    );
    await waitFor(() => expect(result.current(8689744102).estado).toBe("ok"));
    expect(leituras).toStrictEqual([{ conta: "oben", skus: [8689744102] }]);

    rerender({ skus: [8689744102, 8689717792] });
    await waitFor(() =>
      expect(result.current(8689717792)).toStrictEqual({
        estado: "ok",
        descricao: "THINNER DR.4403LT",
        codigo: "PRD00411",
        desatualizada: null,
      }),
    );
    expect(leituras[1]).toStrictEqual({ conta: "oben", skus: [8689717792, 8689744102] });
  });

  it("erro do supabase vira 'indisponível', nunca 'fora do catálogo'", async () => {
    resposta.erro = { message: "permission denied for table omie_products" };
    const { result } = renderHook(() => useDescricoesSkuOmie("OBEN", [8689717792]), { wrapper });
    await waitFor(() => expect(result.current(8689717792)).toStrictEqual({ estado: "indisponivel", motivo: "erro" }));
  });

  it("sem a conta da campanha ou sem SKU vinculado, não lê nada", async () => {
    const semConta = renderHook(() => useDescricoesSkuOmie(undefined, [8689717792]), { wrapper });
    const semSku = renderHook(() => useDescricoesSkuOmie("OBEN", [null]), { wrapper });
    expect(semConta.result.current(8689717792)).toStrictEqual({ estado: "carregando" });
    expect(semSku.result.current(null)).toStrictEqual({ estado: "sem_sku" });
    expect(leituras).toStrictEqual([]);
  });
});
