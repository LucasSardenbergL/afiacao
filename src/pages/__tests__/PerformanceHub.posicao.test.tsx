import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// O card "Posição ao Vivo" do Hub lê a v_des_posicao_trimestre_ao_vivo. Sem faturado confirmado do
// GoodData a posição é desconhecida: nem o trânsito da view antiga, nem R$ 0 da view nova (NULL) ou
// de uma leitura que falhou — o card mostra "—".

const { estado } = vi.hoisted(() => ({
  estado: { posicao: null as Record<string, unknown> | null, falha: false },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (tabela: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        limit: () => q,
        gte: () => Promise.resolve({ count: 3, error: null }),
        maybeSingle: () => {
          if (tabela !== "v_des_posicao_trimestre_ao_vivo") throw new Error(`tabela inesperada: ${tabela}`);
          if (estado.falha) return Promise.reject(new Error("rede"));
          return Promise.resolve({ data: estado.posicao, error: null });
        },
      };
      return q;
    },
  },
}));

import { KpiCards } from "../PerformanceHub";

function renderizar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <KpiCards empresa="OBEN" />
    </QueryClientProvider>,
  );
}

const valorDoCard = async (rotulo: string) => {
  await screen.findByText("3"); // ligações: a query do Hub assentou
  const card = screen.getByText(rotulo).parentElement;
  return (card?.textContent ?? "").replace(rotulo, "").replace(/\s+/g, " ").trim();
};

beforeEach(() => {
  estado.posicao = null;
  estado.falha = false;
});

describe("PerformanceHub — card Posição ao Vivo", () => {
  it.each([
    ["view ANTIGA (posição = só trânsito)", { fat_bruto_confirmado: null, posicao_ao_vivo_otimista: 297966.59, meta_pessoal: 400840.02 }],
    ["view NOVA (posição NULL)", { fat_bruto_confirmado: null, posicao_ao_vivo_otimista: null, meta_pessoal: 400840.02 }],
    ["sem linha na view", null],
  ])("sem faturado confirmado — %s: mostra '—'", async (_nome, linha) => {
    estado.posicao = linha;
    renderizar();
    expect(await valorDoCard("Posição ao Vivo")).toBe("—");
  });

  it("leitura que falhou: '—', nunca R$ 0", async () => {
    estado.falha = true;
    renderizar();
    expect(await valorDoCard("Posição ao Vivo")).toBe("—");
  });

  it("controle: com faturado confirmado mostra a posição", async () => {
    estado.posicao = { fat_bruto_confirmado: 50000, posicao_ao_vivo_otimista: 347966.59, meta_pessoal: 400840.02 };
    renderizar();
    expect(await valorDoCard("Posição ao Vivo")).toBe("R$ 347.967");
  });
});
