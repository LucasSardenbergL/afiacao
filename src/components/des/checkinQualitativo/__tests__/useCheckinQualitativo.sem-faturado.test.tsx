import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// O check-in tira a faixa (e os percentuais de cada critério) da posição ao vivo. Sem faturado
// confirmado do GoodData a faixa é desconhecida: nem a da view antiga (tirada só do trânsito) nem
// "0,00%" por critério — o badge mostra "—", o desconto projetado some, e os check-ins anteriores
// continuam listados (a existência vem de des_checkin_qualitativo) com os percentuais em "—".

const { estado, leiturasPercentual } = vi.hoisted(() => ({
  estado: {
    posicao: null as Record<string, unknown> | null,
    /** Linhas da v_des_desconto_por_checkin: a view antiga traz a do check-in; a nova, nenhuma. */
    descontos: [] as Record<string, unknown>[],
    falhaCheckins: false,
  },
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
const CHECKINS = [{ id: 7, data_avaliacao: "2026-11-01", tipo: "projecao", avaliado_por: "Lucas" }];
const DESCONTO = {
  empresa: "OBEN",
  ano: 2026,
  trimestre: 4,
  checkin_id: 7,
  data_avaliacao: "2026-11-01",
  tipo: "projecao",
  faixa_numero: 3,
  desconto_padrao: 1.5,
  qualitativos_atingidos_perc: 0.5,
  bonus_atingido_perc: 0,
  desconto_total_projetado: 2,
  desconto_total_maximo: 2.25,
};

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u-1" } }) }));

// Devolve SÓ as colunas pedidas: um select que esquece fat_bruto_confirmado não recebe o campo
// (como no PostgREST) — o mock não esconde a falta.
const projetar = (linha: Record<string, unknown> | null, colunas: string) => {
  if (!linha || colunas.trim() === "*") return linha;
  return Object.fromEntries(
    colunas.split(",").map((c) => c.trim()).filter((c) => c in linha).map((c) => [c, linha[c]]),
  );
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (tabela: string) => {
      let colunas = "*";
      const muitos = (): { data: unknown; error: unknown } => {
        switch (tabela) {
          case "des_criterio_qualitativo":
            return { data: CRITERIOS, error: null };
          case "des_criterio_percentual":
            leiturasPercentual.push(tabela);
            return { data: PERCENTUAIS, error: null };
          case "des_checkin_qualitativo":
            return estado.falhaCheckins
              ? { data: null, error: { message: "falhou" } }
              : { data: CHECKINS.map((c) => projetar(c, colunas)), error: null };
          case "v_des_desconto_por_checkin":
            return { data: estado.descontos, error: null };
          default:
            return { data: [], error: null };
        }
      };
      const q = {
        select: (c?: string) => {
          colunas = c ?? "*";
          return q;
        },
        eq: () => q,
        in: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: () => {
          if (tabela === "v_des_posicao_trimestre_ao_vivo")
            return Promise.resolve({ data: projetar(estado.posicao, colunas), error: null });
          if (tabela === "v_des_desconto_por_checkin")
            return Promise.resolve({ data: estado.descontos[0] ?? null, error: null });
          throw new Error(`maybeSingle inesperado: ${tabela}`);
        },
        then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
          Promise.resolve(muitos()).then(ok, falha),
      };
      return q;
    },
  },
}));

import { useCheckinQualitativo } from "../useCheckinQualitativo";
import { CriterioCard } from "../CriterioCard";
import { CheckinQualitativoTab } from "../../CheckinQualitativoTab";

const FAIXA_3 = { faixa_id: 13, faixa_numero: 3, estrelas: 3, desconto_padrao_perc: 1.5, volume_min: 250000, volume_max: 349999.99 };
const VIEW_ANTIGA = { fat_bruto_confirmado: null, posicao_ao_vivo_conservadora: 297966.59, faixa_conservadora: FAIXA_3, faixa_otimista: FAIXA_3 };
const VIEW_NOVA = { fat_bruto_confirmado: null, posicao_ao_vivo_conservadora: null, faixa_conservadora: null, faixa_otimista: null };
const COM_FATURADO = { fat_bruto_confirmado: 50000, posicao_ao_vivo_conservadora: 347966.59, faixa_conservadora: FAIXA_3, faixa_otimista: FAIXA_3 };

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const usar = () => renderHook(() => useCheckinQualitativo({ empresa: "OBEN", ano: 2026, trimestre: 4 }), { wrapper });
const renderizarAba = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CheckinQualitativoTab empresa="OBEN" ano={2026} trimestre={4} />
    </QueryClientProvider>,
  );
};
const tabelaAnteriores = () => screen.findByTestId("historico-checkins");

beforeEach(() => {
  estado.posicao = null;
  estado.descontos = [];
  estado.falhaCheckins = false;
  leiturasPercentual.length = 0;
});

describe.each([
  ["view ANTIGA (faixa tirada só do trânsito)", VIEW_ANTIGA, [DESCONTO]],
  ["view NOVA (faixa NULL, a linha some da view de desconto)", VIEW_NOVA, []],
])("useCheckinQualitativo sem faturado confirmado — %s", (_nome, linha, descontos) => {
  it("não lê percentual de faixa, não mostra desconto projetado e lista o check-in com percentuais null", async () => {
    estado.posicao = linha;
    estado.descontos = descontos;
    const { result } = usar();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await waitFor(() => expect(result.current.historico).toHaveLength(1));
    // dá tempo às queries dependentes (posição → percentuais; desconto) assentarem
    await new Promise((r) => setTimeout(r, 30));
    expect(leiturasPercentual).toEqual([]);
    expect(result.current.percentualPorCriterio).toEqual({});
    expect(result.current.desconto).toBeNull();
    expect(result.current.max).toBeNull();
    expect(result.current.total).toBeNull();
    expect(result.current.historico).toEqual([
      {
        checkin_id: 7,
        data_avaliacao: "2026-11-01",
        tipo: "projecao",
        avaliado_por: "Lucas",
        qualitativos_atingidos_perc: null,
        desconto_total_projetado: null,
      },
    ]);
  });
});

describe("useCheckinQualitativo com faturado confirmado (controle)", () => {
  it("lê os percentuais da faixa, mostra o desconto projetado e o do check-in anterior", async () => {
    estado.posicao = COM_FATURADO;
    estado.descontos = [DESCONTO];
    const { result } = usar();
    await waitFor(() => expect(result.current.percentualPorCriterio).toEqual({ 1: 0.5, 2: 0.25 }));
    await waitFor(() => expect(result.current.total).toBe(2));
    expect(result.current.max).toBe(2.25);
    expect(result.current.desconto?.checkin_id).toBe(7);
    await waitFor(() => expect(result.current.historico?.[0]?.desconto_total_projetado).toBe(2));
    expect(result.current.historico?.[0]?.qualitativos_atingidos_perc).toBe(0.5);
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

describe.each([
  ["view ANTIGA", VIEW_ANTIGA, [DESCONTO]],
  ["view NOVA", VIEW_NOVA, []],
])("CheckinQualitativoTab sem faturado confirmado — %s", (_nome, linha, descontos) => {
  it("critérios em 'Vale —'; o check-in anterior aparece, com percentuais '—'", async () => {
    estado.posicao = linha;
    estado.descontos = descontos;
    renderizarAba();
    await screen.findByText("Treinamento");
    expect(screen.getAllByText("Vale —")).toHaveLength(2);
    const card = await tabelaAnteriores();
    await within(card).findByText("01/11/2026");
    const texto = (card.textContent ?? "").replace(/\s+/g, " ");
    expect(texto).not.toContain("Nenhum checkin registrado");
    expect(texto).not.toMatch(/\d,\d\d%/);
    expect(document.body.textContent).not.toMatch(/Vale 0,00%/);
  });
});

describe("CheckinQualitativoTab — check-ins anteriores", () => {
  it("controle: com faturado, o check-in anterior mostra o desconto projetado", async () => {
    estado.posicao = COM_FATURADO;
    estado.descontos = [DESCONTO];
    renderizarAba();
    const card = await tabelaAnteriores();
    await within(card).findByText("2,00%");
    expect(within(card).getByText("0,50%")).toBeTruthy();
  });

  it("leitura que falhou: diz que não leu, não 'nenhum checkin'", async () => {
    estado.posicao = COM_FATURADO;
    estado.falhaCheckins = true;
    renderizarAba();
    await screen.findByText("Não foi possível ler os check-ins deste trimestre.");
    expect(document.body.textContent).not.toContain("Nenhum checkin registrado");
  });
});
