import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ArgLine } from "../ArgLine";

describe("ArgLine", () => {
  it("renderiza ícone, label e texto", () => {
    render(<ArgLine icon="🔍" label="Diagnóstico" text="texto teste" />);
    expect(screen.getByText("🔍")).toBeTruthy();
    expect(screen.getByText("Diagnóstico")).toBeTruthy();
    expect(screen.getByText("texto teste")).toBeTruthy();
  });
});
