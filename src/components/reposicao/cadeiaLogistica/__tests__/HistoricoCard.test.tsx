import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HistoricoCard } from "../HistoricoCard";
import type { HistoricoItem } from "../types";

describe("HistoricoCard", () => {
  it("mostra mensagem vazia quando não há histórico", () => {
    render(<HistoricoCard historico={[]} />);
    expect(screen.getByText("Sem mudanças registradas.")).toBeTruthy();
  });

  it("lista os itens com fornecedor e descrição da mudança", () => {
    const historico: HistoricoItem[] = [
      {
        id: 1,
        empresa: "OBEN",
        fornecedor_nome: "ACME",
        etapa_codigo: "E1",
        acao: "edicao",
        descricao_mudanca: "Etapa Frete editada",
        criado_em: "2026-05-20T10:00:00Z",
      },
    ];
    render(<HistoricoCard historico={historico} />);
    expect(screen.getByText("ACME")).toBeTruthy();
    expect(screen.getByText(/Etapa Frete editada/)).toBeTruthy();
  });

  it("trata historico undefined sem quebrar", () => {
    render(<HistoricoCard historico={undefined} />);
    expect(screen.getByText("Sem mudanças registradas.")).toBeTruthy();
  });
});
