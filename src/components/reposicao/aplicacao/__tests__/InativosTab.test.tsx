import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InativosTab } from "../InativosTab";
import type { FilaItem } from "../types";

const it1 = {
  id: 1, empresa: "OBEN", sku_codigo_omie: "777", sku_descricao: "Catalisador",
  estoque_minimo_novo: null, ponto_pedido_novo: null, estoque_maximo_novo: null,
  estoque_minimo_omie_atual: null, ponto_pedido_omie_atual: null, estoque_maximo_omie_atual: null,
  status_validacao: "bloqueado_inativo", mensagem_bloqueio: "Produto inativo no Omie",
  delta_max_perc: null, aplicado_em: null, resposta_omie: null, erro_omie: null, criado_em: "2026-05-20T00:00:00Z",
} as FilaItem;

describe("InativosTab", () => {
  it("mostra mensagem vazia quando não há itens", () => {
    render(<InativosTab filteredItens={[]} isLoading={false} onSubstituicao={vi.fn()} onDesativar={vi.fn()} />);
    expect(screen.getByText(/Nenhum SKU bloqueado por inativação/)).toBeTruthy();
  });

  it("renderiza card com SKU e mensagem de bloqueio", () => {
    render(<InativosTab filteredItens={[it1]} isLoading={false} onSubstituicao={vi.fn()} onDesativar={vi.fn()} />);
    expect(screen.getByText("777")).toBeTruthy();
    expect(screen.getByText(/Produto inativo no Omie/)).toBeTruthy();
  });

  it("dispara onSubstituicao e onDesativar", () => {
    const onSubstituicao = vi.fn();
    const onDesativar = vi.fn();
    render(<InativosTab filteredItens={[it1]} isLoading={false} onSubstituicao={onSubstituicao} onDesativar={onDesativar} />);
    fireEvent.click(screen.getByRole("button", { name: /Registrar substituição/ }));
    fireEvent.click(screen.getByRole("button", { name: /Descadastrar do módulo/ }));
    expect(onSubstituicao).toHaveBeenCalledWith(it1);
    expect(onDesativar).toHaveBeenCalledWith("777");
  });
});
