import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CriterioCard } from "../CriterioCard";
import type { Criterio, Resposta } from "../types";

const criterio: Criterio = {
  id: 1, codigo: "Q1", nome: "Atende metas de mix", descricao: "Comprou todas as linhas", ordem: 1, tipo: "qualitativo",
};

function setup(overrides: Partial<React.ComponentProps<typeof CriterioCard>> = {}) {
  const props: React.ComponentProps<typeof CriterioCard> = {
    criterio,
    resposta: { atingido: false, observacao: "" } as Resposta,
    percentual: 2.5,
    onChange: vi.fn(),
    ...overrides,
  };
  render(<CriterioCard {...props} />);
  return props;
}

describe("CriterioCard", () => {
  it("renderiza nome, descrição e percentual", () => {
    setup();
    expect(screen.getByText("Atende metas de mix")).toBeTruthy();
    expect(screen.getByText("Comprou todas as linhas")).toBeTruthy();
    expect(screen.getByText("Vale 2,50%")).toBeTruthy();
    expect(screen.getByText("Não atingido")).toBeTruthy();
  });

  it("alterna o switch chamando onChange com atingido=true", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("switch"));
    expect(props.onChange).toHaveBeenCalledWith({ atingido: true, observacao: "" });
  });

  it("mostra observação só quando atingido e dispara onChange ao digitar", () => {
    const props = setup({ resposta: { atingido: true, observacao: "" } });
    expect(screen.getByText("Atingido")).toBeTruthy();
    const textarea = screen.getByPlaceholderText(/Observação/);
    fireEvent.change(textarea, { target: { value: "ok" } });
    expect(props.onChange).toHaveBeenCalledWith({ atingido: true, observacao: "ok" });
  });

  it("não renderiza textarea quando não atingido", () => {
    setup({ resposta: { atingido: false, observacao: "" } });
    expect(screen.queryByPlaceholderText(/Observação/)).toBeNull();
  });
});
