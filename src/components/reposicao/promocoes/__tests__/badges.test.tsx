import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { confiancaBadge } from "../badges";

describe("confiancaBadge", () => {
  it("null/undefined → não renderiza", () => {
    expect(confiancaBadge(null)).toBeNull();
    expect(confiancaBadge(undefined as unknown as number)).toBeNull();
  });

  it("renderiza percentual arredondado", () => {
    render(<div>{confiancaBadge(0.876)}</div>);
    expect(screen.getByText("88%")).toBeTruthy();
  });

  it("faixas de confiança mudam a classe", () => {
    const { container: low } = render(<div>{confiancaBadge(0.3)}</div>);
    expect(low.querySelector(".text-destructive")).toBeTruthy();
    const { container: mid } = render(<div>{confiancaBadge(0.7)}</div>);
    expect(mid.querySelector(".text-status-warning")).toBeTruthy();
    const { container: high } = render(<div>{confiancaBadge(0.95)}</div>);
    expect(high.querySelector(".text-status-success")).toBeTruthy();
  });
});
