import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

// Integração HistoricoTab + useHistoricoData com QueryClient REAL e Supabase mockado.
// Leitura que não aconteceu (erro — inclusive depois de um sucesso — ou offline) não pode virar
// "Nenhum trimestre cadastrado" nem trimestre julgado: a aba mostra <AvisoLeituraFalhou>.
// Os dados espelham a prod em 2026-11-05 (OBEN): metas T1..T4/26, um snapshot PARCIAL do T2
// (18/04) e a posição ao vivo do T4 sem faturado GoodData (só trânsito).

const { estado } = vi.hoisted(() => ({
  estado: { falhar: null as string | null, metaT3: 400840.02, semMetas: false, fatBrutoT4: null as number | null },
}));

const meta = (trimestre: number, valor: number) => ({ ano: 2026, trimestre, meta_faturamento: valor, faixa_des_objetivo: null });

function linhas(tabela: string): unknown {
  switch (tabela) {
    case "des_meta_empresa":
      if (estado.semMetas) return [];
      return [meta(4, 400840.02), meta(3, estado.metaT3), meta(2, 400840.02), meta(1, 400840.02)];
    case "des_trimestre_snapshot":
      return [{ ano: 2026, trimestre: 2, data_referencia: "2026-04-18", fat_bruto_valor: 103068.74, pedidos_abertos_valor: 49539.78, objetivo_valor: 400840.02 }];
    case "v_des_desconto_por_checkin":
      return [];
    case "v_des_posicao_trimestre_ao_vivo":
      return {
        ano: 2026,
        trimestre: 4,
        posicao_ao_vivo_conservadora: 264175.21,
        fat_bruto_confirmado: estado.fatBrutoT4,
        gooddata_data_referencia: null,
        faixa_conservadora: { estrelas: 3 },
        // a view lê meta_pessoal de des_meta_empresa: sem metas lá, sem meta aqui.
        meta_pessoal: estado.semMetas ? null : 400840.02,
        inicio_trimestre: "2026-10-01",
        fim_trimestre: "2026-12-31",
      };
    default:
      throw new Error(`tabela inesperada: ${tabela}`);
  }
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (tabela: string) => {
      const resposta = () =>
        Promise.resolve(
          estado.falhar === tabela
            ? { data: null, error: { message: `falha em ${tabela}` } }
            : { data: linhas(tabela), error: null },
        );
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        maybeSingle: resposta,
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => resposta().then(ok, ko),
      };
      return q;
    },
  },
}));

// recharts (ResponsiveContainer) exige ResizeObserver, ausente no jsdom; a cor por julgamento
// do gráfico é testada na derivação (montarChartData).
vi.mock("../FaturamentoChart", () => ({ FaturamentoChart: () => null }));

import { HistoricoTab } from "../../HistoricoTab";

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}
const renderTab = () => render(<HistoricoTab empresa="OBEN" ano={2026} trimestre={4} />, { wrapper });

beforeEach(() => {
  estado.falhar = null;
  estado.metaT3 = 400840.02;
  estado.semMetas = false;
  estado.fatBrutoT4 = null;
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  onlineManager.setOnline(true);
});

describe("HistoricoTab — leitura que não aconteceu", () => {
  it.each(["des_meta_empresa", "des_trimestre_snapshot", "v_des_desconto_por_checkin", "v_des_posicao_trimestre_ao_vivo"])(
    "falha em %s → aviso de erro, sem empty-state nem julgamento",
    async (tabela) => {
      estado.falhar = tabela;
      renderTab();
      const aviso = await screen.findByTestId("aviso-leitura-falhou");
      expect(aviso.getAttribute("data-estado")).toBe("erro");
      expect(screen.queryByText("Nenhum trimestre cadastrado ainda.")).toBeNull();
      expect(screen.queryByText("T3 2026")).toBeNull();
    },
  );

  it("offline na 1ª leitura (pending+paused, que não é isLoading) → aviso 'sem-rede', não vazio", async () => {
    onlineManager.setOnline(false);
    renderTab();
    const aviso = await screen.findByTestId("aviso-leitura-falhou");
    expect(aviso.getAttribute("data-estado")).toBe("sem-rede");
    expect(screen.queryByText("Nenhum trimestre cadastrado ainda.")).toBeNull();
  });

  it("erro DEPOIS de um sucesso (cache na mão) → aviso, não os cards velhos", async () => {
    renderTab();
    await screen.findByText("T3 2026");
    estado.falhar = "des_trimestre_snapshot";
    await act(() => qc.refetchQueries());
    const aviso = await screen.findByTestId("aviso-leitura-falhou");
    expect(aviso.getAttribute("data-estado")).toBe("erro");
    expect(screen.queryByText("T3 2026")).toBeNull();
  });
});

describe("HistoricoTab — dados de prod (2026-11-05)", () => {
  it("CONTROLE: 4 cards; T1/T3 'Sem dado', T2 parcial 'Sem fechamento', nenhum 'Meta não atingida'", async () => {
    renderTab();
    await screen.findByText("T3 2026");
    expect(screen.queryByTestId("aviso-leitura-falhou")).toBeNull();
    for (const t of ["T1 2026", "T2 2026", "T3 2026", "T4 2026"]) expect(screen.getByText(t)).toBeTruthy();
    expect(screen.getAllByText("Sem dado")).toHaveLength(2);
    expect(screen.getAllByText("Sem fechamento")).toHaveLength(1);
    expect(screen.getByText("Faturado até 18/04/2026")).toBeTruthy();
    expect(screen.queryByText("Meta não atingida")).toBeNull();
    expect(screen.queryByText("Faturado final")).toBeNull();
    // T4: posição ao vivo é só trânsito (sem faturado GoodData) → não aparece como faturado.
    expect(screen.queryByText(/264\.175,21/)).toBeNull();
  });

  it("sem nenhuma meta mas com posição ao vivo faturada → mostra o atual, não 'Nenhum trimestre cadastrado'", async () => {
    estado.semMetas = true;
    estado.fatBrutoT4 = 150000;
    renderTab();
    await screen.findByText("T4 2026");
    expect(screen.queryByText("Nenhum trimestre cadastrado ainda.")).toBeNull();
    expect(screen.getByText("Posição ao vivo (faturado + pedidos)")).toBeTruthy();
  });

  it("modal mostra o card VIGENTE: refetch com meta nova atualiza o modal aberto", async () => {
    renderTab();
    await screen.findByText("T3 2026");
    const t3 = screen.getByText("T3 2026").closest(".rounded-lg, [class*='card']") as HTMLElement | null;
    const botoes = screen.getAllByText("Ver detalhes");
    // ordem desc: T4, T3, T2, T1
    fireEvent.click(t3 ? within(t3).getByText("Ver detalhes") : botoes[1]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/400\.840,02/)).toBeTruthy();
    estado.metaT3 = 555000;
    await act(() => qc.refetchQueries());
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByText(/555\.000,00/)).toBeTruthy());
  });
});
