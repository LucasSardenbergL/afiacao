import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DistribuicaoCards } from "../DistribuicaoCards";

describe("DistribuicaoCards", () => {
  it("renderiza os 4 cards de categoria com seus rótulos e contagens", () => {
    render(
      <DistribuicaoCards
        distribuicao={{ prioritario: 2, forte: 5, moderado: 1, fraco: 9 }}
      />,
    );
    expect(screen.getByText("Prioritário")).toBeTruthy();
    expect(screen.getByText("Forte")).toBeTruthy();
    expect(screen.getByText("Moderado")).toBeTruthy();
    expect(screen.getByText("Fraco")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("9")).toBeTruthy();
  });
});
