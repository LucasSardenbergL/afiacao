import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// O check-in tira a faixa (e os percentuais de cada critério) da posição ao vivo. Sem faturado
// confirmado do GoodData a faixa é desconhecida: nem a da view antiga (tirada só do trânsito) nem
// "0,00%" por critério — o badge mostra "—" e o desconto projetado também some.

const { estado, leiturasPercentual } = vi.hoisted(() => ({
  estado: { posicao: null as Record<string, unknown> | null },
  leiturasPercentual: [] as unknown[],
}));

const CRITERIOS = [
  { id: 1, codigo: "Q1", nome: "Treinamento", descricao: null, ordem: 1, tipo: "qualitativo" },
  { id: 2, codigo: "B1", nome: "Lançamento", descricao: null, ordem: 2, tipo: "bonus" },
];
const PERCENTUAIS = [
  { criterio_id: 1, faixa_id: 13, percentual: 0.5 },
  { criterio_id: 2, faixa_id: 13, percentual: 0.25 },
];
const DESCONTO = {
  empresa: "OBEN",
  ano: 2026,
  trimestre: 4,
  checkin_id: 7,
  data_avaliacao: "2026-11-01",
  tipo: "projecao",
  faixa_id: 13,
  desconto_padrao: 1.5,
  qualitativos_atingidos_perc: 0.5,
  bonus_atingido_perc: 0,
  desconto_total_projetado: 2,
  desconto_total_maximo: 2.25,
};

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u-1" } }) }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (tabela: string) => {
      const muitos = (): unknown[] => {
        switch (tabela) {
          case "des_criterio_qualitativo":
            return CRITERIOS;
          case "des_criterio_percentual":
            leiturasPercentual.push(tabela);
            return PERCENTUAIS;
          case "v_des_desconto_por_checkin":
            return [DESCONTO];
          default:
            return [];
        }
      };
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: () => {
          if (tabela === "v_des_posicao_trimestre_ao_vivo") return Promise.resolve({ data: estado.posicao, error: null });
          if (tabela === "v_des_desconto_por_checkin") return Promise.resolve({ data: DESCONTO, error: null });
          throw new Error(`maybeSingle inesperado: ${tabela}`);
        },
        then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
          Promise.resolve({ data: muitos(), error: null }).then(ok, falha),
      };
      return q;
    },
  },
}));

import { useCheckinQualitativo } from "../useCheckinQualitativo";
import { CriterioCard } from "../CriterioCard";

const FAIXA_3 = { faixa_id: 13, faixa_numero: 3, estrelas: 3, desconto_padrao_perc: 1.5, volume_min: 250000, volume_max: 349999.99 };
const VIEW_ANTIGA = { fat_bruto_confirmado: null, posicao_ao_vivo_conservadora: 297966.59, faixa_conservadora: FAIXA_3, faixa_otimista: FAIXA_3 };
const VIEW_NOVA = { fat_bruto_confirmado: null, posicao_ao_vivo_conservadora: null, faixa_conservadora: null, faixa_otimista: null };
const COM_FATURADO = { fat_bruto_confirmado: 50000, posicao_ao_vivo_conservadora: 347966.59, faixa_conservadora: FAIXA_3, faixa_otimista: FAIXA_3 };

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const usar = () => renderHook(() => useCheckinQualitativo({ empresa: "OBEN", ano: 2026, trimestre: 4 }), { wrapper });

beforeEach(() => {
  estado.posicao = null;
  leiturasPercentual.length = 0;
});

describe.each([
  ["view ANTIGA (faixa tirada só do trânsito)", VIEW_ANTIGA],
  ["view NOVA (faixa NULL)", VIEW_NOVA],
])("useCheckinQualitativo sem faturado confirmado — %s", (_nome, linha) => {
  it("não lê percentual de faixa nenhuma e não mostra desconto projetado", async () => {
    estado.posicao = linha;
    const { result } = usar();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await waitFor(() => expect(result.current.historicoLoading).toBe(false));
    // dá tempo às queries dependentes (posição → percentuais; desconto) assentarem
    await new Promise((r) => setTimeout(r, 30));
    expect(leiturasPercentual).toEqual([]);
    expect(result.current.percentualPorCriterio).toEqual({});
    expect(result.current.desconto).toBeNull();
    expect(result.current.max).toBeNull();
    expect(result.current.total).toBeNull();
  });
});

describe("useCheckinQualitativo com faturado confirmado (controle)", () => {
  it("lê os percentuais da faixa e mostra o desconto projetado", async () => {
    estado.posicao = COM_FATURADO;
    const { result } = usar();
    await waitFor(() => expect(result.current.percentualPorCriterio).toEqual({ 1: 0.5, 2: 0.25 }));
    await waitFor(() => expect(result.current.total).toBe(2));
    expect(result.current.max).toBe(2.25);
    expect(result.current.desconto?.checkin_id).toBe(7);
  });
});

describe("CriterioCard — percentual desconhecido", () => {
  it("mostra 'Vale —', nunca 'Vale 0,00%'", () => {
    render(
      <CriterioCard
        criterio={CRITERIOS[0] as never}
        resposta={{ atingido: false, observacao: "" }}
        percentual={null}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Vale —")).toBeTruthy();
    expect(screen.queryByText(/0,00%/)).toBeNull();
  });

  it("controle: percentual conhecido aparece", () => {
    render(
      <CriterioCard
        criterio={CRITERIOS[0] as never}
        resposta={{ atingido: false, observacao: "" }}
        percentual={0.5}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Vale 0,50%")).toBeTruthy();
  });
});
