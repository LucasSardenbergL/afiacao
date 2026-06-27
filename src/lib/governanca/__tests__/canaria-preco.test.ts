import { describe, it, expect } from "vitest";
import { classificarCanaria } from "../canaria-preco";

// Canária comportamental do edge de preço (analyze-unified-order {canary:true}).
// O #1089 criou a sonda na edge; este helper classifica a resposta p/ o widget de
// Governança (Opção A da mitigação de reversão do Lovable — detecta edge revertida
// em PROD). Estados exigidos pelo Codex: ok / falha / erro / desconhecido.
// REGRA money-path: erro HTTP (401/403/4xx/5xx) é FALHA de canária, NÃO "sem dados".

describe("classificarCanaria", () => {
  it("ok: preço praticado (123) venceu o Omie (999) — fallback correto", () => {
    const r = classificarCanaria({ canary: true, resolved: 123, expected: 123, ok: true }, null);
    expect(r.status).toBe("ok");
  });

  it("falha: override do Omie (resolved=999) — regressão", () => {
    const r = classificarCanaria({ canary: true, resolved: 999, expected: 123, ok: false }, null);
    expect(r.status).toBe("falha");
    expect(r.detalhe).toMatch(/REGRESS/i);
  });

  it("falha: ok=false vence mesmo com resolved=123 (Codex: ok!==true → vermelho)", () => {
    expect(classificarCanaria({ canary: true, resolved: 123, expected: 123, ok: false }, null).status).toBe("falha");
  });

  it("falha: expected!==123 (canária adulterada) → vermelho", () => {
    expect(classificarCanaria({ canary: true, resolved: 123, expected: 999, ok: true }, null).status).toBe("falha");
  });

  it("erro: invoke falhou (403) = canária vermelha, NÃO 'sem dados'", () => {
    const r = classificarCanaria(null, { message: "Forbidden", status: 403 });
    expect(r.status).toBe("erro");
  });

  it("erro VENCE: se há error E data, classifica como erro (não lê o payload)", () => {
    const r = classificarCanaria({ canary: true, resolved: 123, expected: 123, ok: true }, { message: "rede" });
    expect(r.status).toBe("erro");
  });

  it("desconhecido: sem resposta e sem erro (nunca rodou / payload vazio)", () => {
    expect(classificarCanaria(null, null).status).toBe("desconhecido");
    expect(classificarCanaria(undefined, null).status).toBe("desconhecido");
  });

  it("desconhecido: edge respondeu mas sem o envelope de canária (canary!==true)", () => {
    expect(classificarCanaria({ resolved: 123, expected: 123, ok: true }, null).status).toBe("desconhecido");
  });
});
