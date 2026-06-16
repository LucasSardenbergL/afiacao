import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HistoricoTab } from "../HistoricoTab";
import type { AlertaRow } from "../types";

function makeAlerta(o: Partial<AlertaRow> = {}): AlertaRow {
  return {
    id: 1,
    empresa: "OBEN",
    fornecedor_nome: "Forn A",
    tipo: "aumento",
    severidade: "info",
    titulo: "Aviso Y",
    mensagem: "msg",
    status: "notificado",
    tentativas: 1,
    criado_em: new Date().toISOString(),
    notificado_em: "2026-03-01T10:00:00Z",
    gmail_message_id: null,
    calendar_evento_id: null,
    erro_notificacao: null,
    metadata: null,
    data_evento: null,
    ...o,
  };
}

describe("HistoricoTab", () => {
  it("mostra empty state sem histórico", () => {
    render(<HistoricoTab loading={false} historico={[]} onSelectAlerta={vi.fn()} />);
    expect(screen.getByText("Sem histórico no período.")).toBeTruthy();
  });

  it("renderiza linha e dispara onSelectAlerta no Ver detalhes", () => {
    const onSelectAlerta = vi.fn();
    render(<HistoricoTab loading={false} historico={[makeAlerta()]} onSelectAlerta={onSelectAlerta} />);
    expect(screen.getByText("Aviso Y")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ver detalhes" }));
    expect(onSelectAlerta).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });
});
