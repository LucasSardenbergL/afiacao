import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// A aba Posição Atual não pode mostrar posição, faixa nem "meta atingida" tirados só do trânsito
// quando o trimestre não tem faturado confirmado do GoodData — nem com a view antiga (que somava
// COALESCE(fat, 0) + trânsito), nem com a nova (que devolve NULL e o front lia como 0).

const { estado } = vi.hoisted(() => ({ estado: { posicao: null as Record<string, unknown> | null } }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (tabela: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        gt: () => q,
        order: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => {
          if (tabela !== "v_des_posicao_trimestre_ao_vivo") throw new Error(`tabela inesperada: ${tabela}`);
          return Promise.resolve({ data: estado.posicao, error: null });
        },
      };
      return q;
    },
  },
}));

import { PosicaoAtualTab } from "../PosicaoAtualTab";

const FAIXA_3 = { faixa_id: 13, faixa_numero: 3, estrelas: 3, desconto_padrao_perc: 1.5, volume_min: 250000, volume_max: 349999.99 };
const BASE = {
  empresa: "OBEN",
  ano: 2026,
  trimestre: 4,
  gooddata_data_referencia: null,
  gooddata_objetivo: null,
  gooddata_pedidos_abertos: null,
  meta_pessoal: 400840.02,
  faixa_des_alvo: null,
  valor_em_transito_seguro: 297966.59,
  valor_em_transito_risco: 0,
  valor_fora_trimestre: 0,
  qtd_pedidos_no_trimestre: 12,
  qtd_pedidos_fora_trimestre: 0,
  calculado_em: "2026-11-05",
  inicio_trimestre: "2026-10-01",
  fim_trimestre: "2026-12-31",
  dias_restantes: 56,
};
const VIEW_ANTIGA = {
  ...BASE,
  fat_bruto_confirmado: null,
  posicao_ao_vivo_conservadora: 297966.59,
  posicao_ao_vivo_otimista: 297966.59,
  faixa_conservadora: FAIXA_3,
  faixa_otimista: FAIXA_3,
  gap_para_meta_pessoal: 102873.43,
};
const VIEW_NOVA = {
  ...BASE,
  fat_bruto_confirmado: null,
  posicao_ao_vivo_conservadora: null,
  posicao_ao_vivo_otimista: null,
  faixa_conservadora: null,
  faixa_otimista: null,
  gap_para_meta_pessoal: null,
};
const COM_FATURADO = {
  ...BASE,
  gooddata_data_referencia: "2026-11-01",
  fat_bruto_confirmado: 50000,
  posicao_ao_vivo_conservadora: 347966.59,
  posicao_ao_vivo_otimista: 347966.59,
  faixa_conservadora: FAIXA_3,
  faixa_otimista: FAIXA_3,
  gap_para_meta_pessoal: 52873.43,
};

function renderizar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PosicaoAtualTab empresa="OBEN" ano={2026} trimestre={4} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const semEspacoDuro = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ");

beforeEach(() => {
  estado.posicao = null;
});

describe.each([
  ["view ANTIGA (posição = só trânsito)", VIEW_ANTIGA],
  ["view NOVA (posição NULL)", VIEW_NOVA],
])("PosicaoAtualTab sem faturado confirmado — %s", (_nome, linha) => {
  it("não mostra posição, faixa, barra nem 'meta atingida'; diz que o trânsito não é posição", async () => {
    estado.posicao = linha;
    renderizar();
    const aviso = await screen.findByTestId("posicao-sem-faturado");
    expect(semEspacoDuro(aviso.textContent)).toContain("Sem faturado confirmado do GoodData");
    const texto = semEspacoDuro(document.body.textContent);
    expect(texto).not.toContain("Meta atingida");
    expect(texto).not.toContain("Faltam R$");
    expect(texto).not.toContain("estrelas");
    const cardPosicao = semEspacoDuro(screen.getByTestId("card-posicao").textContent);
    const cardMeta = semEspacoDuro(screen.getByTestId("card-meta").textContent);
    const cardFaixa = semEspacoDuro(screen.getByTestId("card-faixa").textContent);
    expect(cardPosicao).toContain("—");
    expect(cardPosicao).not.toContain("R$ 0,00");
    expect(cardPosicao).not.toContain("otimista");
    expect(cardMeta).not.toContain("Meta atingida");
    expect(cardFaixa).toContain("—");
    expect(cardFaixa).not.toMatch(/\d estrelas|\d★/);
    expect(texto).toContain("Sem posição confirmada");
    expect(texto).toContain("a faixa não é calculada");
    expect(screen.queryByTestId("barra-meta")).toBeNull();
    // O trânsito aparece só no aviso, como trânsito — não no lugar da posição.
    expect(texto.match(/297\.966,59/g)?.length).toBe(1);
  });
});

describe("PosicaoAtualTab com faturado confirmado (controle)", () => {
  it("mostra posição, faixa, barra e o quanto falta", async () => {
    estado.posicao = COM_FATURADO;
    renderizar();
    expect(await screen.findByTestId("barra-meta")).toBeTruthy();
    const texto = semEspacoDuro(document.body.textContent);
    expect(texto).toContain("347.966,59");
    expect(texto).toContain("Faltam R$ 52.873,43");
    expect(texto).toContain("estrelas");
    expect(screen.queryByTestId("posicao-sem-faturado")).toBeNull();
  });

  it("meta NULL: não diz 'meta atingida'", async () => {
    estado.posicao = { ...COM_FATURADO, meta_pessoal: null, gap_para_meta_pessoal: 0 };
    renderizar();
    await screen.findByText("Meta pessoal não cadastrada.");
    expect(semEspacoDuro(document.body.textContent)).not.toContain("Meta atingida");
    expect(screen.queryByTestId("barra-meta")).toBeNull();
  });
});
