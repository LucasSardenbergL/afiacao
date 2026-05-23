import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GruposTable } from "../GruposTable";
import type { Grupo } from "../types";

const grupo: Grupo = {
  id: 1, empresa: "OBEN", fornecedor_nome: "ACME", grupo_codigo: "g_rapido",
  descricao: "Rápido", lt_producao_dias: 5, lt_producao_unidade: "uteis",
  horario_corte: "14:00:00", observacoes: null,
};

function noop() { /* */ }

describe("GruposTable", () => {
  it("loading → Carregando…", () => {
    render(<GruposTable grupos={[]} loading contagensSku={{}} onEdit={noop} />);
    expect(screen.getByText("Carregando…")).toBeTruthy();
  });

  it("vazio → mensagem", () => {
    render(<GruposTable grupos={[]} loading={false} contagensSku={{}} onEdit={noop} />);
    expect(screen.getByText("Nenhum grupo cadastrado.")).toBeTruthy();
  });

  it("com grupo → dados, contagem de SKUs e edição dispara onEdit", () => {
    const onEdit = vi.fn();
    render(<GruposTable grupos={[grupo]} loading={false} contagensSku={{ g_rapido: 7 }} onEdit={onEdit} />);
    expect(screen.getByText("ACME")).toBeTruthy();
    expect(screen.getByText("g_rapido")).toBeTruthy();
    expect(screen.getByText("Rápido")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("14:00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(onEdit).toHaveBeenCalledWith(grupo);
  });
});
