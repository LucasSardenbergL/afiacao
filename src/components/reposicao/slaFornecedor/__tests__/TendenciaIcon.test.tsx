import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TendenciaIcon } from "../TendenciaIcon";

const label = (markup: HTMLElement) => markup.querySelector("svg")?.getAttribute("aria-label");

describe("TendenciaIcon", () => {
  it("piorando", () => {
    const { container } = render(<TendenciaIcon t="piorando" />);
    expect(label(container)).toBe("piorando");
  });
  it("melhorando", () => {
    const { container } = render(<TendenciaIcon t="melhorando" />);
    expect(label(container)).toBe("melhorando");
  });
  it("sem_dados", () => {
    const { container } = render(<TendenciaIcon t="sem_dados" />);
    expect(label(container)).toBe("sem dados de tendência");
  });
  it("estavel (default)", () => {
    const { container } = render(<TendenciaIcon t="estavel" />);
    expect(label(container)).toBe("estável");
  });
});
