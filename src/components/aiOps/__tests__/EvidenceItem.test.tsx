import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EvidenceItem } from "../EvidenceItem";

describe("EvidenceItem", () => {
  it("renderiza label e value", () => {
    render(<EvidenceItem evidence={{ label: "Atraso", value: "15 dias", type: "critical" }} />);
    expect(screen.getByText("Atraso:")).toBeTruthy();
    expect(screen.getByText("15 dias")).toBeTruthy();
  });
});
