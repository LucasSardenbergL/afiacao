import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ItemRow } from "../types";

// O vínculo manual promoção → SKU Omie. `descricao_produto_fornecedor` é a ENTRADA do fornecedor
// (o texto da campanha): confirmar o SKU não pode trocá-la pela descrição do SKU escolhido, nem no
// item original nem nos irmãos (um por embalagem extra) — senão ninguém audita "o que o fornecedor
// ofertou × qual SKU recebeu o desconto" (prod 2026-10-01: 13 de 13 confirmados sobrescritos).

const { insertSpy, produtosOmie } = vi.hoisted(() => ({
  insertSpy: vi.fn(),
  produtosOmie: [
    { omie_codigo_produto: 8689717792, descricao: "THINNER DR.4403LT", codigo: "PRD00411" },
    { omie_codigo_produto: 8689744102, descricao: "THINNER DR.4403L5", codigo: "PRD00412" },
  ],
}));

vi.mock("@/integrations/supabase/client", () => {
  // A busca do popover: from('omie_products').select().eq().eq().or().limit(20).
  const busca = () => {
    const q = {
      select: () => q,
      eq: () => q,
      or: () => q,
      limit: () => Promise.resolve({ data: produtosOmie, error: null }),
    };
    return q;
  };
  return {
    supabase: {
      from: (tabela: string) => {
        if (tabela === "omie_products") return busca();
        if (tabela === "promocao_item") {
          return {
            insert: (payload: unknown) => {
              insertSpy(payload);
              return Promise.resolve({ error: null });
            },
          };
        }
        throw new Error(`tabela inesperada no teste: ${tabela}`);
      },
    },
  };
});

import { MapeamentoStatusCell } from "../MapeamentoStatusCell";

// Radix Popover/Checkbox usam APIs ausentes no jsdom.
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    observe() { /* */ }
    unobserve() { /* */ }
    disconnect() { /* */ }
  });
});

beforeEach(() => {
  insertSpy.mockClear();
});

const TEXTO_FORNECEDOR = "THINNER P/ PU - OFERTA 5L E 18L";

const itemNaoEncontrado = (over: Partial<ItemRow> = {}): ItemRow => ({
  id: 151,
  campanha_id: 24,
  sku_codigo_fornecedor: "DR.4403",
  descricao_produto_fornecedor: TEXTO_FORNECEDOR,
  sku_codigo_omie: null,
  mapeamento_qualidade: "nao_encontrado",
  mapeamento_candidatos: null,
  desconto_perc: 20,
  volume_minimo: 10,
  confirmado: false,
  ativo: true,
  desconto_extra_perc: null,
  desconto_extra_observacoes: null,
  desconto_extra_negociado_por: null,
  desconto_extra_negociado_em: null,
  desconto_extra_email_referencia: null,
  ...over,
});

/** Abre a busca, marca as embalagens NESTA ordem e confirma. */
async function vincular(item: ItemRow, descricoesNaOrdem: string[]) {
  const onUpdate = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MapeamentoStatusCell item={item} onUpdate={onUpdate} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Não encontrado"));
  for (const d of descricoesNaOrdem) {
    fireEvent.click(await screen.findByRole("checkbox", { name: new RegExp(d.replace(/\./g, "\\.")) }));
  }
  fireEvent.click(screen.getByRole("button", { name: /Confirmar/ }));
  await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
  return onUpdate;
}

describe("MapeamentoStatusCell — vínculo manual preserva a entrada do fornecedor", () => {
  it("o item original recebe o SKU e a confirmação, sem tocar a descrição do fornecedor", async () => {
    const onUpdate = await vincular(itemNaoEncontrado(), ["THINNER DR.4403LT"]);

    expect(onUpdate.mock.calls[0][0]).toStrictEqual({
      sku_codigo_omie: 8689717792,
      mapeamento_qualidade: "manual_confirmado",
      confirmado: true,
    });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("o irmão de uma embalagem extra nasce com o texto ORIGINAL do fornecedor, não com a descrição do SKU dele", async () => {
    const onUpdate = await vincular(itemNaoEncontrado(), ["THINNER DR.4403LT", "THINNER DR.4403L5"]);

    expect(onUpdate.mock.calls[0][0]).toStrictEqual({
      sku_codigo_omie: 8689717792,
      mapeamento_qualidade: "manual_confirmado",
      confirmado: true,
    });
    await waitFor(() => expect(insertSpy).toHaveBeenCalledTimes(1));
    expect(insertSpy.mock.calls[0][0]).toStrictEqual([
      {
        campanha_id: 24,
        sku_codigo_fornecedor: "DR.4403#omie8689744102",
        descricao_produto_fornecedor: TEXTO_FORNECEDOR,
        sku_codigo_omie: 8689744102,
        mapeamento_qualidade: "manual_confirmado",
        desconto_perc: 20,
        volume_minimo: 10,
        confirmado: true,
        ativo: true,
        observacoes: "Expandido manualmente a partir de DR.4403",
      },
    ]);
  });

  it("fornecedor sem texto: o irmão nasce SEM descrição (null), nunca com a do SKU", async () => {
    await vincular(itemNaoEncontrado({ descricao_produto_fornecedor: null }), [
      "THINNER DR.4403LT",
      "THINNER DR.4403L5",
    ]);

    await waitFor(() => expect(insertSpy).toHaveBeenCalledTimes(1));
    const [irmao] = insertSpy.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(irmao.sku_codigo_omie).toBe(8689744102);
    expect(irmao.descricao_produto_fornecedor).toBeNull();
  });
});
