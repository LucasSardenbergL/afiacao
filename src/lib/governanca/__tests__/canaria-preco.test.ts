import { describe, it, expect } from "vitest";
import { classificarCanaria } from "../canaria-preco";

// Canária comportamental do edge de preço (analyze-unified-order {canary:true}).
// O #1089 criou a sonda na edge; este helper classifica a resposta p/ o widget de
// Governança (Opção A da mitigação de reversão do Lovable — detecta edge revertida
// em PROD). Estados exigidos pelo Codex: ok / falha / erro / desconhecido.
// REGRA money-path: erro HTTP (401/403/4xx/5xx) é FALHA de canária, NÃO "sem dados".

describe("classificarCanaria", () => {
  it("ok: preço praticado (123) venceu o Omie (999) — fallback correto", () => {
    const r = classificarCanaria({ canary: true, contrato: "praticado-vence-omie-v1", resolved: 123, expected: 123, ok: true }, null);
    expect(r.status).toBe("ok");
  });

  it("falha: override do Omie (resolved=999) — regressão", () => {
    const r = classificarCanaria({ canary: true, contrato: "praticado-vence-omie-v1", resolved: 999, expected: 123, ok: false }, null);
    expect(r.status).toBe("falha");
    expect(r.detalhe).toMatch(/REGRESS/i);
  });

  it("falha: ok=false vence mesmo com resolved=123 (Codex: ok!==true → vermelho)", () => {
    expect(classificarCanaria({ canary: true, contrato: "praticado-vence-omie-v1", resolved: 123, expected: 123, ok: false }, null).status).toBe("falha");
  });

  it("falha: expected!==123 (canária adulterada) → vermelho", () => {
    expect(classificarCanaria({ canary: true, contrato: "praticado-vence-omie-v1", resolved: 123, expected: 999, ok: true }, null).status).toBe("falha");
  });

  it("erro: invoke falhou (403) = canária vermelha, NÃO 'sem dados'", () => {
    const r = classificarCanaria(null, { message: "Forbidden", status: 403 });
    expect(r.status).toBe("erro");
  });

  it("erro VENCE: se há error E data, classifica como erro (não lê o payload)", () => {
    const r = classificarCanaria({ canary: true, contrato: "praticado-vence-omie-v1", resolved: 123, expected: 123, ok: true }, { message: "rede" });
    expect(r.status).toBe("erro");
  });

  it("desconhecido: sem resposta e sem erro (nunca rodou / payload vazio)", () => {
    expect(classificarCanaria(null, null).status).toBe("desconhecido");
    expect(classificarCanaria(undefined, null).status).toBe("desconhecido");
  });

  it("desconhecido: edge respondeu mas sem o envelope de canária (canary!==true)", () => {
    expect(classificarCanaria({ resolved: 123, expected: 123, ok: true }, null).status).toBe("desconhecido");
  });

  // ── VERSION MARKER (docs/agent/deploy.md §Canárias, ⚠️ #2) ────────────────────────────────────
  // O marcador só fecha o furo se o CONSUMIDOR exigir o valor. Sem estes casos o edge emite
  // `contrato` e o card segue aceitando `ok` sozinho — um deploy INTEGRALMENTE VELHO carrega o
  // `expected` velho junto, compara velho×velho e o card pinta verde.

  it("verde exige o contrato da fatia, não só ok/resolved/expected", () => {
    const r = classificarCanaria(
      { canary: true, contrato: "praticado-vence-omie-v1", resolved: 123, expected: 123, ok: true },
      null,
    );
    expect(r.status).toBe("ok");
  });

  it("contrato de OUTRA fatia = deploy velho, não verde (a mentira que o marcador existe para pegar)", () => {
    const r = classificarCanaria(
      { canary: true, contrato: "fatia-anterior-v0", resolved: 123, expected: 123, ok: true },
      null,
    );
    expect(r.status).toBe("falha");
    expect(r.detalhe).toContain("praticado-vence-omie-v1");
    expect(r.detalhe).toContain("fatia-anterior-v0");
  });

  it("contrato AUSENTE = canária pré-marcador no ar (bundle velho), não verde", () => {
    // É exatamente a resposta que a edge dava ANTES desta fatia: {canary,resolved,expected,ok}.
    const r = classificarCanaria({ canary: true, resolved: 123, expected: 123, ok: true }, null);
    expect(r.status).toBe("falha");
    expect(r.detalhe).toContain("sem o marcador");
  });

  it("CALIBRAÇÃO: sob a forma ANTIGA (sem exigir contrato) os dois casos acima passariam por verdes", () => {
    // A forma antiga: ok && resolved === 123 && expected === 123. Prova que os asserts acima pegam
    // saída errada — sem isto eles só provariam que a função responde.
    const antiga = (d: { resolved?: number; expected?: number; ok?: boolean }) =>
      d.ok === true && d.resolved === 123 && d.expected === 123 ? "ok" : "falha";
    expect(antiga({ resolved: 123, expected: 123, ok: true })).toBe("ok"); // ← contrato ausente
    expect(classificarCanaria({ canary: true, resolved: 123, expected: 123, ok: true }, null).status).toBe("falha");
    // controle positivo: no caso legítimo as duas concordam (senão a divergência não provaria nada)
    expect(antiga({ resolved: 123, expected: 123, ok: true })).toBe("ok");
    expect(
      classificarCanaria(
        { canary: true, contrato: "praticado-vence-omie-v1", resolved: 123, expected: 123, ok: true },
        null,
      ).status,
    ).toBe("ok");
    // e na regressão de preço as duas concordam em VERMELHO
    expect(antiga({ resolved: 999, expected: 123, ok: false })).toBe("falha");
    expect(
      classificarCanaria(
        { canary: true, contrato: "praticado-vence-omie-v1", resolved: 999, expected: 123, ok: false },
        null,
      ).status,
    ).toBe("falha");
  });
});
