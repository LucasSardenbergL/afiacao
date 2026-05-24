import { describe, it, expect } from "vitest";
import { inferConfianca } from "../confianca";
import type { PedidoItem } from "@/types/reposicao";

function row(status: string | null): PedidoItem {
  return { status } as unknown as PedidoItem;
}

describe("inferConfianca", () => {
  it("pendente_aprovacao → alta", () => {
    expect(inferConfianca(row("pendente_aprovacao")).level).toBe("alta");
  });
  it("disparado → alta", () => {
    expect(inferConfianca(row("disparado")).level).toBe("alta");
  });
  it("aprovado → alta", () => {
    expect(inferConfianca(row("aprovado_aguardando_disparo")).level).toBe("alta");
  });
  it("cancelado → baixa", () => {
    expect(inferConfianca(row("cancelado")).level).toBe("baixa");
  });
  it("bloqueado → baixa", () => {
    expect(inferConfianca(row("bloqueado_guardrail")).level).toBe("baixa");
  });
  it("status desconhecido → media", () => {
    expect(inferConfianca(row("qualquer_coisa")).level).toBe("media");
  });
  it("status nulo → media", () => {
    expect(inferConfianca(row(null)).level).toBe("media");
  });
});
