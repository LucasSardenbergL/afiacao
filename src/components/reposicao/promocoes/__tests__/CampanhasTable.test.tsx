import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CampanhasTable } from "../CampanhasTable";
import type { GrupoMensal } from "@/lib/agruparPorMes";
import type { CampanhaComContagem } from "../types";

const campanha: CampanhaComContagem = {
  id: 7, nome: "Promo Verão", fornecedor_nome: "ACME", tipo_origem: "fornecedor_impoe",
  data_inicio: "2026-01-05", data_fim: "2026-01-20", estado: "rascunho",
  extracao_confianca: 0.9, criado_em: "2026-01-01", num_itens: 3,
};

const grupos: GrupoMensal<CampanhaComContagem>[] = [
  { chave: "2026-01", label: "Janeiro 2026", itens: [campanha], vazio: false },
  { chave: "2026-02", label: "Fevereiro 2026", itens: [], vazio: true },
];

function noop() { /* */ }

describe("CampanhasTable", () => {
  it("loading → Carregando…", () => {
    render(<CampanhasTable isLoading grupos={[]} isCollapsed={() => false} toggleMes={noop} onOpenUpload={noop} onNavigate={noop} />);
    expect(screen.getByText("Carregando…")).toBeTruthy();
  });

  it("sem grupos → mensagem de vazio", () => {
    render(<CampanhasTable isLoading={false} grupos={[]} isCollapsed={() => false} toggleMes={noop} onOpenUpload={noop} onNavigate={noop} />);
    expect(screen.getByText("Nenhuma campanha cadastrada ainda.")).toBeTruthy();
  });

  it("grupos expandidos → campanha, estado, itens, confiança; clique navega", () => {
    const onNavigate = vi.fn();
    render(<CampanhasTable isLoading={false} grupos={grupos} isCollapsed={() => false} toggleMes={noop} onOpenUpload={noop} onNavigate={onNavigate} />);
    expect(screen.getByText("Janeiro 2026")).toBeTruthy();
    expect(screen.getByText("Promo Verão")).toBeTruthy();
    expect(screen.getByText("ACME")).toBeTruthy();
    expect(screen.getByText("Rascunho")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("90%")).toBeTruthy();
    // mês vazio expandido
    expect(screen.getByText("Nenhuma campanha cadastrada neste mês.")).toBeTruthy();
    fireEvent.click(screen.getByText("Promo Verão"));
    expect(onNavigate).toHaveBeenCalledWith(7);
  });

  it("clicar cabeçalho do mês chama toggleMes; upload no mês vazio chama onOpenUpload", () => {
    const toggleMes = vi.fn();
    const onOpenUpload = vi.fn();
    render(<CampanhasTable isLoading={false} grupos={grupos} isCollapsed={() => false} toggleMes={toggleMes} onOpenUpload={onOpenUpload} onNavigate={noop} />);
    fireEvent.click(screen.getByText("Janeiro 2026"));
    expect(toggleMes).toHaveBeenCalledWith("2026-01");
    fireEvent.click(screen.getByRole("button", { name: /Upload PDF/ }));
    expect(onOpenUpload).toHaveBeenCalled();
  });
});
