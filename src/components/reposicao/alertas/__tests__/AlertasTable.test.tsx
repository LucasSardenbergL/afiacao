import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AlertasTable } from "../AlertasTable";
import type { EventoOutlier } from "../types";

const evt: EventoOutlier = {
  id: 1, empresa: "oben", sku_codigo_omie: "12345", sku_descricao: "Produto X",
  tipo: "venda_atipica", severidade: "atencao", data_evento: "2026-01-15T00:00:00",
  valor_observado: 100, valor_esperado: 50, desvios_padrao: 3.2,
  detalhes: { mensagem: "pico de venda" }, status: "pendente",
  decidido_em: null, decidido_por: null, justificativa_decisao: null, detectado_em: "2026-01-16T08:00:00",
};

function noop() { /* */ }

function baseProps(over: Partial<React.ComponentProps<typeof AlertasTable>> = {}): React.ComponentProps<typeof AlertasTable> {
  return {
    lista: { rows: [evt], total: 1 },
    isLoading: false,
    selecionados: new Set<number>(),
    todosMarcados: false,
    selecionavelCount: 1,
    toggleAll: noop,
    toggleOne: noop,
    onDrill: noop,
    page: 1,
    totalPages: 1,
    setPage: noop,
    ...over,
  };
}

describe("AlertasTable", () => {
  it("lista vazia → mensagem 'Nenhum alerta encontrado'", () => {
    render(<AlertasTable {...baseProps({ lista: { rows: [], total: 0 } })} />);
    expect(screen.getByText("Nenhum alerta encontrado")).toBeTruthy();
  });

  it("com alerta → SKU, descrição, tipo, severidade e status", () => {
    render(<AlertasTable {...baseProps()} />);
    expect(screen.getByText("12345")).toBeTruthy();
    expect(screen.getByText("Produto X")).toBeTruthy();
    expect(screen.getByText("Venda atípica")).toBeTruthy();
    expect(screen.getByText("Atenção")).toBeTruthy();
    expect(screen.getByText("Pendente")).toBeTruthy();
    expect(screen.getByText("1 alerta(s)")).toBeTruthy();
  });

  it("clicar Detalhes chama onDrill com o evento", () => {
    const onDrill = vi.fn();
    render(<AlertasTable {...baseProps({ onDrill })} />);
    fireEvent.click(screen.getByRole("button", { name: "Detalhes" }));
    expect(onDrill).toHaveBeenCalledWith(evt);
  });

  it("checkbox da linha chama toggleOne; paginação avança quando há próxima página", () => {
    const toggleOne = vi.fn();
    const setPage = vi.fn();
    render(<AlertasTable {...baseProps({ toggleOne, setPage, page: 1, totalPages: 2 })} />);
    // checkbox[0] = header, [1] = linha
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(toggleOne).toHaveBeenCalledWith(1);
    // botão "próxima" (segundo botão de paginação) habilitado
    const navButtons = screen.getAllByRole("button").filter(b => b.querySelector("svg"));
    fireEvent.click(navButtons[navButtons.length - 1]);
    expect(setPage).toHaveBeenCalled();
  });
});
