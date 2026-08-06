import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StarsRow } from "../StarsRow";

describe("StarsRow", () => {
  it("renderiza 6 estrelas (default) e preenche count", () => {
    const { container } = render(<StarsRow count={3} />);
    expect(container.querySelectorAll("svg")).toHaveLength(6);
    expect(container.querySelectorAll(".fill-status-warning-bold")).toHaveLength(3);
  });

  it("respeita max custom e sem preenchimento quando count 0", () => {
    const { container } = render(<StarsRow count={0} max={4} />);
    expect(container.querySelectorAll("svg")).toHaveLength(4);
    expect(container.querySelectorAll(".fill-status-warning-bold")).toHaveLength(0);
  });
});
