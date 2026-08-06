import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StarsRow } from "../StarsRow";

describe("StarsRow", () => {
  it("renderiza max estrelas com count preenchidas", () => {
    const { container } = render(<StarsRow count={3} max={6} />);
    expect(container.querySelectorAll("svg").length).toBe(6);
    expect(container.querySelectorAll(".fill-status-warning-bold").length).toBe(3);
  });

  it("usa max=6 por padrão", () => {
    const { container } = render(<StarsRow count={2} />);
    expect(container.querySelectorAll("svg").length).toBe(6);
    expect(container.querySelectorAll(".fill-status-warning-bold").length).toBe(2);
  });
});
