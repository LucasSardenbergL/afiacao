import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PendentesTab } from "../PendentesTab";
import type { AlertaRow } from "../types";

function makeAlerta(o: Partial<AlertaRow> = {}): AlertaRow {
  return {
    id: 1,
    empresa: "OBEN",
    fornecedor_nome: "Forn A",
    tipo: "aumento",
    severidade: "urgente",
    titulo: "Reajuste X",
    mensagem: "msg",
    status: "pendente_notificacao",
    tentativas: 1,
    criado_em: new Date().toISOString(),
    notificado_em: null,
    gmail_message_id: null,
    calendar_evento_id: null,
    erro_notificacao: null,
    metadata: null,
    data_evento: null,
    ...o,
  };
}

function setup(overrides: Partial<React.ComponentProps<typeof PendentesTab>> = {}) {
  const props: React.ComponentProps<typeof PendentesTab> = {
    loading: false,
    pendentesFiltrados: [makeAlerta()],
    filtroSev: "__all__",
    onFiltroSevChange: vi.fn(),
    filtroEmpresa: "__all__",
    onFiltroEmpresaChange: vi.fn(),
    filtroTipo: "__all__",
    onFiltroTipoChange: vi.fn(),
    empresasOpts: ["OBEN"],
    tiposOpts: ["aumento"],
    onSelectAlerta: vi.fn(),
    ...overrides,
  };
  render(<PendentesTab {...props} />);
  return props;
}

describe("PendentesTab", () => {
  it("mostra skeleton em loading", () => {
    const { container } = render(
      <PendentesTab
        loading
        pendentesFiltrados={[]}
        filtroSev="__all__"
        onFiltroSevChange={vi.fn()}
        filtroEmpresa="__all__"
        onFiltroEmpresaChange={vi.fn()}
        filtroTipo="__all__"
        onFiltroTipoChange={vi.fn()}
        empresasOpts={[]}
        tiposOpts={[]}
        onSelectAlerta={vi.fn()}
      />,
    );
    expect(container.querySelectorAll(".animate-shimmer").length).toBeGreaterThan(0);
  });

  it("empty state sem pendentes", () => {
    setup({ pendentesFiltrados: [] });
    expect(screen.getByText("Nenhum alerta pendente.")).toBeTruthy();
  });

  it("renderiza linha e dispara onSelectAlerta", () => {
    const props = setup();
    expect(screen.getByText("Reajuste X")).toBeTruthy();
    fireEvent.click(screen.getByText("Reajuste X"));
    expect(props.onSelectAlerta).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });
});
