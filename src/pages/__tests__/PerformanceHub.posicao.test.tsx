import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Os cards "Posição ao Vivo" e "Meta Pessoal" do Hub leem a v_des_posicao_trimestre_ao_vivo da empresa
// do SELETOR. Sem faturado confirmado do GoodData a posição é desconhecida (nem o trânsito da view
// antiga, nem R$ 0 da view nova ou de uma leitura que falhou); meta não cadastrada também: "—".

const { estado } = vi.hoisted(() => ({
  estado: {
    /** A linha da view; só a empresa `empresaDaLinha` a tem (as outras: nenhuma linha). */
    posicao: null as Record<string, unknown> | null,
    empresaDaLinha: "OBEN",
    falha: false,
    erro: false,
    empresasPedidas: [] as unknown[],
  },
}));

// Devolve SÓ as colunas pedidas e SÓ a linha da empresa filtrada (como no PostgREST): um select que
// esquece uma coluna, ou um filtro de empresa fixo, não são escondidos pelo mock.
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
      let empresa: unknown = undefined;
      const q = {
        select: (c?: string) => {
          colunas = c ?? "*";
          return q;
        },
        eq: (coluna: string, valor: unknown) => {
          if (coluna === "empresa") {
            empresa = valor;
            estado.empresasPedidas.push(valor);
          }
          return q;
        },
        limit: () => q,
        gte: () => Promise.resolve({ count: 3, error: null }),
        maybeSingle: () => {
          if (tabela !== "v_des_posicao_trimestre_ao_vivo") throw new Error(`tabela inesperada: ${tabela}`);
          if (estado.falha) return Promise.reject(new Error("rede"));
          // erro do PostgREST com a linha antiga ainda "presente" — só o `error` diz que não leu
          if (estado.erro)
            return Promise.resolve({
              data: { fat_bruto_confirmado: 1, posicao_ao_vivo_otimista: 297966.59, meta_pessoal: 400840.02 },
              error: { message: "x" },
            });
          const linha = empresa === estado.empresaDaLinha ? estado.posicao : null;
          return Promise.resolve({ data: projetar(linha, colunas), error: null });
        },
      };
      return q;
    },
  },
}));

import { KpiCards } from "../PerformanceHub";

function renderizar(empresa = "OBEN") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <KpiCards empresa={empresa} />
    </QueryClientProvider>,
  );
}

const valorDoCard = async (rotulo: string) => {
  await screen.findByText("3"); // ligações: a query do Hub assentou
  const card = screen.getByText(rotulo).parentElement;
  return (card?.textContent ?? "").replace(rotulo, "").replace(/\s+/g, " ").trim();
};

const COM_FATURADO = { fat_bruto_confirmado: 50000, posicao_ao_vivo_otimista: 347966.59, meta_pessoal: 400840.02 };

beforeEach(() => {
  estado.posicao = null;
  estado.empresaDaLinha = "OBEN";
  estado.falha = false;
  estado.erro = false;
  estado.empresasPedidas = [];
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

  it("leitura que devolveu erro (sem lançar): '—', nunca R$ 0", async () => {
    estado.erro = true;
    renderizar();
    expect(await valorDoCard("Posição ao Vivo")).toBe("—");
  });

  it("leitura que falhou: '—', nunca R$ 0", async () => {
    estado.falha = true;
    renderizar();
    expect(await valorDoCard("Posição ao Vivo")).toBe("—");
  });

  it("faturado presente mas posição NULL (forma inesperada): '—', nunca R$ 0", async () => {
    estado.posicao = { fat_bruto_confirmado: 50000, posicao_ao_vivo_otimista: null, meta_pessoal: 400840.02 };
    renderizar();
    expect(await valorDoCard("Posição ao Vivo")).toBe("—");
  });

  it("controle: com faturado confirmado mostra a posição", async () => {
    estado.posicao = COM_FATURADO;
    renderizar();
    expect(await valorDoCard("Posição ao Vivo")).toBe("R$ 347.967");
  });
});

describe("PerformanceHub — card Meta Pessoal", () => {
  it("meta não cadastrada: '—', nunca R$ 0", async () => {
    estado.posicao = { ...COM_FATURADO, meta_pessoal: null };
    renderizar();
    expect(await valorDoCard("Meta Pessoal")).toBe("—");
  });

  it("leitura que devolveu erro: '—', nunca a meta da linha nem R$ 0", async () => {
    estado.erro = true;
    renderizar();
    expect(await valorDoCard("Meta Pessoal")).toBe("—");
  });

  it("leitura que falhou: '—', nunca R$ 0", async () => {
    estado.falha = true;
    renderizar();
    expect(await valorDoCard("Meta Pessoal")).toBe("—");
  });

  it("controle: meta cadastrada aparece", async () => {
    estado.posicao = COM_FATURADO;
    renderizar();
    expect(await valorDoCard("Meta Pessoal")).toBe("R$ 400.840");
  });
});

describe("PerformanceHub — empresa do seletor", () => {
  it("COLACOR selecionada: lê a COLACOR (não a OBEN) e, sem linha dela, mostra '—' nos dois cards", async () => {
    estado.posicao = COM_FATURADO; // só a OBEN tem linha
    renderizar("COLACOR");
    expect(await valorDoCard("Posição ao Vivo")).toBe("—");
    expect(await valorDoCard("Meta Pessoal")).toBe("—");
    expect(estado.empresasPedidas).toContain("COLACOR");
    expect(estado.empresasPedidas).not.toContain("OBEN");
  });

  it("controle: COLACOR com linha própria mostra os valores dela", async () => {
    estado.posicao = { fat_bruto_confirmado: 10000, posicao_ao_vivo_otimista: 123456, meta_pessoal: 200000 };
    estado.empresaDaLinha = "COLACOR";
    renderizar("COLACOR");
    expect(await valorDoCard("Posição ao Vivo")).toBe("R$ 123.456");
    expect(await valorDoCard("Meta Pessoal")).toBe("R$ 200.000");
  });
});

describe("PerformanceHub — card Score SPIN Médio", () => {
  it("sem fonte de score ainda: '—', nunca 0 inventado", async () => {
    estado.posicao = COM_FATURADO;
    renderizar();
    expect(await valorDoCard("Score SPIN Médio")).toBe("—");
  });
});
