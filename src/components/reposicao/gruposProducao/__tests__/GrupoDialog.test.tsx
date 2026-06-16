import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GrupoDialog } from "../GrupoDialog";
import { emptyGrupo, type Grupo } from "../types";

function noop() { /* */ }

describe("GrupoDialog", () => {
  it("fechado (editing=null) → não renderiza", () => {
    render(<GrupoDialog editing={null} setEditing={noop} isNew={false} onSalvar={noop} salvarPending={false} />);
    expect(screen.queryByText("Novo grupo")).toBeNull();
    expect(screen.queryByText("Editar grupo")).toBeNull();
  });

  it("novo (isNew) → título Novo grupo e campos", () => {
    render(<GrupoDialog editing={emptyGrupo()} setEditing={noop} isNew onSalvar={noop} salvarPending={false} />);
    expect(screen.getByText("Novo grupo")).toBeTruthy();
    expect(screen.getByText("Fornecedor *")).toBeTruthy();
    expect(screen.getByText("Código do grupo *")).toBeTruthy();
  });

  it("editar → título Editar grupo; Salvar dispara onSalvar com o grupo", () => {
    const onSalvar = vi.fn();
    const g: Partial<Grupo> = { ...emptyGrupo(), id: 9, fornecedor_nome: "ACME", grupo_codigo: "g1" };
    render(<GrupoDialog editing={g} setEditing={noop} isNew={false} onSalvar={onSalvar} salvarPending={false} />);
    expect(screen.getByText("Editar grupo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Salvar/ }));
    expect(onSalvar).toHaveBeenCalledWith(g);
  });
});
