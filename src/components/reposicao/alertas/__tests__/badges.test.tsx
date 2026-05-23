import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { sevBadge, statusBadge } from "../badges";

describe("sevBadge", () => {
  it("mapeia severidades conhecidas e passthrough", () => {
    render(<div>{sevBadge("critico")}{sevBadge("atencao")}{sevBadge("info")}{sevBadge("xpto")}</div>);
    expect(screen.getByText("Crítico")).toBeTruthy();
    expect(screen.getByText("Atenção")).toBeTruthy();
    expect(screen.getByText("Info")).toBeTruthy();
    expect(screen.getByText("xpto")).toBeTruthy();
  });
});

describe("statusBadge", () => {
  it("mapeia status conhecidos e passthrough", () => {
    render(<div>{statusBadge("pendente")}{statusBadge("aceito")}{statusBadge("excluido")}{statusBadge("ignorado")}{statusBadge("zzz")}</div>);
    expect(screen.getByText("Pendente")).toBeTruthy();
    expect(screen.getByText("Aceito")).toBeTruthy();
    expect(screen.getByText("Excluído")).toBeTruthy();
    expect(screen.getByText("Ignorado")).toBeTruthy();
    expect(screen.getByText("zzz")).toBeTruthy();
  });
});
