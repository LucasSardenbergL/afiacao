import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TopInadimplentes } from "../TopInadimplentes";
import type { InadimplenteRow } from "../types";

describe("TopInadimplentes", () => {
  it("renderiza nome, qtd de títulos e valor", () => {
    const rows: InadimplenteRow[] = [
      { nome: "Cliente A", cnpj: "123", total_vencido: 5000, qtd_titulos: 3 },
    ];
    render(<TopInadimplentes inadimplentes={rows} />);
    expect(screen.getByText("Cliente A")).toBeTruthy();
    expect(screen.getByText("3 título(s)")).toBeTruthy();
    expect(screen.getByText(/5\.000,00/)).toBeTruthy();
  });

  it("usa fallback de CNPJ e 'não identificado'", () => {
    const rows: InadimplenteRow[] = [
      { nome: "", cnpj: "999", total_vencido: 100, qtd_titulos: 1 },
      { nome: "", cnpj: "", total_vencido: 50, qtd_titulos: 1 },
    ];
    render(<TopInadimplentes inadimplentes={rows} />);
    expect(screen.getByText("CNPJ: 999")).toBeTruthy();
    expect(screen.getByText("Cliente não identificado")).toBeTruthy();
  });
});
