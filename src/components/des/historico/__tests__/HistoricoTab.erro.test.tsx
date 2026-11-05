import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

// Leitura que falha não pode virar "Nenhum trimestre cadastrado" nem trimestre zerado: o hook
// expõe isError e a aba mostra o erro (fail-closed — nenhum trimestre é julgado).

const { falhar } = vi.hoisted(() => ({ falhar: { tabela: null as string | null } }));

const LINHAS: Record<string, unknown[]> = {
  des_meta_empresa: [{ ano: 2026, trimestre: 3, meta_faturamento: 400840.02, faixa_des_objetivo: null }],
  des_trimestre_snapshot: [],
  v_des_desconto_por_checkin: [],
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (tabela: string) => {
      const erro = falhar.tabela === tabela ? { message: `falha em ${tabela}` } : null;
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        maybeSingle: () => Promise.resolve(erro ? { data: null, error: erro } : { data: null, error: null }),
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
          Promise.resolve(erro ? { data: null, error: erro } : { data: LINHAS[tabela] ?? [], error: null }).then(ok, ko),
      };
      return q;
    },
  },
}));

// recharts (ResponsiveContainer) exige ResizeObserver, ausente no jsdom; o gráfico tem seu próprio
// contrato (cor por julgamento) testado na derivação.
vi.mock("../FaturamentoChart", () => ({ FaturamentoChart: () => null }));

import { HistoricoTab } from "../../HistoricoTab";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  falhar.tabela = null;
});

describe("HistoricoTab — estado de erro", () => {
  it.each(["des_meta_empresa", "des_trimestre_snapshot", "v_des_desconto_por_checkin", "v_des_posicao_trimestre_ao_vivo"])(
    "falha em %s → mensagem de erro, sem empty-state nem julgamento",
    async (tabela) => {
      falhar.tabela = tabela;
      render(<HistoricoTab empresa="OBEN" ano={2026} trimestre={4} />, { wrapper });
      await waitFor(() => expect(screen.getByText(/Não foi possível carregar o histórico do DES/)).toBeTruthy());
      expect(screen.queryByText("Nenhum trimestre cadastrado ainda.")).toBeNull();
      expect(screen.queryByText("Meta não atingida")).toBeNull();
      expect(screen.getByText("Tentar novamente")).toBeTruthy();
    },
  );

  it("CONTROLE: sem falha, o passado com meta e sem snapshot aparece como 'Sem dado'", async () => {
    render(<HistoricoTab empresa="OBEN" ano={2026} trimestre={4} />, { wrapper });
    await waitFor(() => expect(screen.getByText("T3 2026")).toBeTruthy());
    expect(screen.queryByText(/Não foi possível carregar/)).toBeNull();
    expect(screen.getByText("Sem dado")).toBeTruthy();
    expect(screen.queryByText("Meta não atingida")).toBeNull();
  });
});
