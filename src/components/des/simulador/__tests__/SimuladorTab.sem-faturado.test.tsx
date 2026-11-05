import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Sem faturado confirmado do GoodData a posição do trimestre é desconhecida. A RPC
// simular_puxar_volume_trimestre a trataria como 0 (e a view antiga, como só trânsito): faixa, ganho
// e recomendação sobre uma base inventada. A aba não simula nem mostra "faltam p/ próxima faixa".

const { estado, rpc } = vi.hoisted(() => ({
  estado: { posicao: null as Record<string, unknown> | null, posicaoErro: false },
  rpc: vi.fn(),
}));

// O Slider (Radix) dos controles mede o trilho; o jsdom não tem ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const PRAZOS = [
  { id: 1, codigo: "antecipado", nome: "Antecipado", desconto_ou_encargo_perc: -2, padrao: true, ativo: true },
  { id: 2, codigo: "30d", nome: "30 dias", desconto_ou_encargo_perc: 0, padrao: false, ativo: true },
];
const FAIXAS = [
  { faixa_numero: 1, estrelas: 1, volume_min: 50000, volume_max: 99999.99 },
  { faixa_numero: 2, estrelas: 2, volume_min: 100000, volume_max: 249999.99 },
  { faixa_numero: 3, estrelas: 3, volume_min: 250000, volume_max: 349999.99 },
  { faixa_numero: 4, estrelas: 4, volume_min: 350000, volume_max: null },
];

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => {
      rpc(...args);
      return Promise.resolve({ data: {}, error: null });
    },
    from: (tabela: string) => {
      let ordens = 0;
      const q = {
        select: () => q,
        eq: () => q,
        order: () => {
          ordens += 1;
          if (tabela === "des_faixa_quantitativa") return Promise.resolve({ data: FAIXAS, error: null });
          if (tabela === "fornecedor_prazo_pagamento_config" && ordens === 2)
            return Promise.resolve({ data: PRAZOS, error: null });
          return q;
        },
        maybeSingle: () => {
          if (tabela !== "v_des_posicao_trimestre_ao_vivo") throw new Error(`tabela inesperada: ${tabela}`);
          return Promise.resolve(
            estado.posicaoErro
              ? { data: null, error: { message: "falhou" } }
              : { data: estado.posicao, error: null },
          );
        },
      };
      return q;
    },
  },
}));

import { SimuladorTab } from "../../SimuladorTab";

const FAIXA_3 = { faixa_id: 13, faixa_numero: 3, estrelas: 3, desconto_padrao_perc: 1.5, volume_min: 250000, volume_max: 349999.99 };
const VIEW_ANTIGA = { fat_bruto_confirmado: null, posicao_ao_vivo_conservadora: 297966.59, faixa_conservadora: FAIXA_3 };
const VIEW_NOVA = { fat_bruto_confirmado: null, posicao_ao_vivo_conservadora: null, faixa_conservadora: null };
const COM_FATURADO = { fat_bruto_confirmado: 50000, posicao_ao_vivo_conservadora: 297966.59, faixa_conservadora: FAIXA_3 };

function renderizar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SimuladorTab empresa="OBEN" ano={2026} trimestre={4} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  estado.posicao = null;
  estado.posicaoErro = false;
  rpc.mockClear();
});

describe.each([
  ["view ANTIGA (posição = só trânsito)", VIEW_ANTIGA],
  ["view NOVA (posição NULL)", VIEW_NOVA],
  ["sem linha na view", null],
])("SimuladorTab sem faturado confirmado — %s", (_nome, linha) => {
  it("bloqueia a simulação: nenhum painel, nenhum 'faltam', nenhuma chamada da RPC", async () => {
    estado.posicao = linha;
    renderizar();
    const aviso = await screen.findByTestId("simulador-sem-posicao");
    expect(aviso.textContent).toContain("Sem faturado confirmado do GoodData em T4/2026");
    expect(screen.queryByText("Simular cenário")).toBeNull();
    expect(document.body.textContent).not.toContain("Faltam para próxima faixa");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("SimuladorTab — leitura da posição falhou", () => {
  it("diz que não leu (≠ 'sem faturado') e não simula", async () => {
    estado.posicaoErro = true;
    renderizar();
    const aviso = await screen.findByTestId("simulador-sem-posicao");
    expect(aviso.textContent).toContain("Não foi possível ler a posição do trimestre.");
    expect(screen.queryByText("Simular cenário")).toBeNull();
  });
});

describe("SimuladorTab com faturado confirmado (controle)", () => {
  it("mostra o painel, o 'faltam p/ próxima faixa' e simula pela RPC", async () => {
    estado.posicao = COM_FATURADO;
    renderizar();
    const botao = await screen.findByText("Simular cenário");
    // faixa 3 → próxima é a 4 (volume_min 350.000): faltam 350.000 − 297.966,59 = 52.033,41
    expect((document.body.textContent ?? "").replace(/\s+/g, " ")).toContain(
      "Faltam para próxima faixa: R$ 52.033,41",
    );
    expect(screen.queryByTestId("simulador-sem-posicao")).toBeNull();
    fireEvent.click(botao);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(rpc.mock.calls[0][0]).toBe("simular_puxar_volume_trimestre");
  });
});
