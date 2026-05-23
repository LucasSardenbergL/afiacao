import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeltaArrow } from "../DeltaArrow";

describe("DeltaArrow", () => {
  it("mostra atual → novo", () => {
    render(<DeltaArrow novo={120} atual={100} />);
    expect(screen.getByText("100")).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
  });

  it("delta entre 10% e 25% → warning", () => {
    render(<DeltaArrow novo={120} atual={100} />);
    const pct = screen.getByText(/\(\+20%\)/);
    expect(pct.className).toContain("text-warning");
  });

  it("delta acima de 25% → destructive", () => {
    render(<DeltaArrow novo={200} atual={100} />);
    const pct = screen.getByText(/\(\+100%\)/);
    expect(pct.className).toContain("text-destructive");
  });

  it("delta até 10% → muted", () => {
    render(<DeltaArrow novo={105} atual={100} />);
    const pct = screen.getByText(/\(\+5%\)/);
    expect(pct.className).toContain("text-muted-foreground");
  });

  it("queda negativa é formatada sem '+'", () => {
    render(<DeltaArrow novo={80} atual={100} />);
    expect(screen.getByText(/\(-20%\)/)).toBeTruthy();
  });

  it("atual zero → não mostra percentual (evita divisão por zero)", () => {
    render(<DeltaArrow novo={50} atual={0} />);
    expect(screen.queryByText(/%\)/)).toBeNull();
  });

  it("novo nulo → travessão e sem percentual", () => {
    render(<DeltaArrow novo={null} atual={100} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText(/%\)/)).toBeNull();
  });
});
