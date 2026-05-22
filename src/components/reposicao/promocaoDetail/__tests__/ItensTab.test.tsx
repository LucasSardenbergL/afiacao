import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Tabs } from "@/components/ui/tabs";
import type { ItemRow } from "../types";

// Isola ItensTab dos leaf-components reais; os stubs também provam que a
// fiação onSave/onUpdate → onUpdateItem({itemId, changes}) está correta.
vi.mock("../DescontoExtraCell", () => ({
  DescontoExtraCell: ({ onSave }: { onSave: (c: Partial<ItemRow>) => void }) => (
    <button
      data-testid="desconto-extra"
      onClick={() => onSave({ desconto_extra_perc: 5 })}
    >
      extra
    </button>
  ),
}));
vi.mock("../MapeamentoStatusCell", () => ({
  MapeamentoStatusCell: ({
    onUpdate,
  }: {
    onUpdate: (c: Partial<ItemRow>) => void;
  }) => (
    <button
      data-testid="map-status"
      onClick={() => onUpdate({ sku_codigo_omie: 123 })}
    >
      map
    </button>
  ),
}));

import { ItensTab } from "../ItensTab";

const makeItem = (over: Partial<ItemRow> = {}): ItemRow => ({
  id: 1,
  campanha_id: 10,
  sku_codigo_fornecedor: "DR.4403",
  descricao_produto_fornecedor: "Lixa grão 220",
  sku_codigo_omie: null,
  mapeamento_qualidade: null,
  mapeamento_candidatos: null,
  desconto_perc: 20,
  volume_minimo: null,
  confirmado: false,
  ativo: true,
  desconto_extra_perc: null,
  desconto_extra_observacoes: null,
  desconto_extra_negociado_por: null,
  desconto_extra_negociado_em: null,
  desconto_extra_email_referencia: null,
  ...over,
});

const baseProps = {
  itens: [makeItem()],
  loadingItens: false,
  efetivoMap: {} as Record<number, number>,
  userEmail: "test@x",
  addingItem: false,
  setAddingItem: vi.fn(),
  novoCodFornecedor: "",
  setNovoCodFornecedor: vi.fn(),
  novoDesconto: "",
  setNovoDesconto: vi.fn(),
  novoVolume: "",
  setNovoVolume: vi.fn(),
  savingNovoItem: false,
  onAddItem: vi.fn(),
  onUpdateItem: vi.fn(),
  onDeleteItem: vi.fn(),
  onCancelAdd: vi.fn(),
};

function renderTab(props: Partial<typeof baseProps> = {}) {
  const merged = { ...baseProps, ...props };
  return render(
    <Tabs defaultValue="itens">
      <ItensTab {...merged} />
    </Tabs>,
  );
}

describe("ItensTab", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loading: mostra Carregando", () => {
    renderTab({ loadingItens: true });
    expect(screen.getByText(/Carregando/)).toBeTruthy();
  });

  it("vazio: mostra mensagem de nenhum item", () => {
    renderTab({ itens: [] });
    expect(screen.getByText(/Nenhum item nesta campanha/)).toBeTruthy();
  });

  it("renderiza a descrição do item", () => {
    renderTab();
    expect(screen.getByText("Lixa grão 220")).toBeTruthy();
  });

  it("editar Desc.% (blur com valor alterado) chama onUpdateItem com {itemId, changes}", () => {
    const onUpdateItem = vi.fn();
    renderTab({ onUpdateItem });
    const desconto = screen.getAllByRole("spinbutton")[0];
    fireEvent.change(desconto, { target: { value: "33" } });
    fireEvent.blur(desconto);
    expect(onUpdateItem).toHaveBeenCalledWith({
      itemId: 1,
      changes: { desconto_perc: 33 },
    });
  });

  it("blur sem alterar valor não chama onUpdateItem", () => {
    const onUpdateItem = vi.fn();
    renderTab({ onUpdateItem });
    const desconto = screen.getAllByRole("spinbutton")[0];
    fireEvent.blur(desconto);
    expect(onUpdateItem).not.toHaveBeenCalled();
  });

  it("DescontoExtraCell.onSave é envolvido em {itemId, changes}", () => {
    const onUpdateItem = vi.fn();
    renderTab({ onUpdateItem });
    fireEvent.click(screen.getByTestId("desconto-extra"));
    expect(onUpdateItem).toHaveBeenCalledWith({
      itemId: 1,
      changes: { desconto_extra_perc: 5 },
    });
  });

  it("MapeamentoStatusCell.onUpdate é envolvido em {itemId, changes}", () => {
    const onUpdateItem = vi.fn();
    renderTab({ onUpdateItem });
    fireEvent.click(screen.getByTestId("map-status"));
    expect(onUpdateItem).toHaveBeenCalledWith({
      itemId: 1,
      changes: { sku_codigo_omie: 123 },
    });
  });

  it("remover item com confirm=true chama onDeleteItem(id)", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onDeleteItem = vi.fn();
    renderTab({ onDeleteItem });
    // A lixeira é o último button da linha (ícone sem texto acessível).
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[buttons.length - 1]);
    expect(onDeleteItem).toHaveBeenCalledWith(1);
  });

  it("Adicionar item chama setAddingItem(true)", () => {
    const setAddingItem = vi.fn();
    renderTab({ setAddingItem });
    fireEvent.click(screen.getByRole("button", { name: /Adicionar item/i }));
    expect(setAddingItem).toHaveBeenCalledWith(true);
  });

  it("linha de adição: Salvar→onAddItem, Cancelar→onCancelAdd", () => {
    const onAddItem = vi.fn();
    const onCancelAdd = vi.fn();
    renderTab({ addingItem: true, onAddItem, onCancelAdd });
    fireEvent.click(screen.getByRole("button", { name: /^Salvar$/i }));
    expect(onAddItem).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /^Cancelar$/i }));
    expect(onCancelAdd).toHaveBeenCalledTimes(1);
  });
});
