import { describe, it, expect } from "vitest";
import { classificarCanaria } from "../canaria-preco";

// Canária comportamental do edge de preço (analyze-unified-order {canary:true}).
// O #1089 criou a sonda na edge; este helper classifica a resposta p/ o widget de
// Governança (Opção A da mitigação de reversão do Lovable — detecta edge revertida
// em PROD). Estados exigidos pelo Codex: ok / falha / erro / desconhecido.
// REGRA money-path: erro HTTP (401/403/4xx/5xx) é FALHA de canária, NÃO "sem dados".
//
// Desde 2026-09-30 a canária atesta `ia-nao-precifica-v1`: a fronteira de saída da edge
// (`montarRespostaAnalise`) roda sobre 1 produto + 1 sugestão que TRAZEM preço, e o verde
// exige 0 preços na saída E os 2 itens na saída.

const VERDE = { canary: true, contrato: "ia-nao-precifica-v1", precos_na_saida: 0, itens_na_saida: 2, ok: true };

describe("classificarCanaria", () => {
  it("ok: nenhum preço saiu e os 2 itens saíram, com o contrato da fatia", () => {
    const r = classificarCanaria(VERDE, null);
    expect(r.status).toBe("ok");
  });

  it("falha: a edge voltou a emitir preço (precos_na_saida > 0) — regressão", () => {
    const r = classificarCanaria({ ...VERDE, precos_na_saida: 3, ok: false }, null);
    expect(r.status).toBe("falha");
    expect(r.detalhe).toMatch(/REGRESS/i);
  });

  it("falha: zero preços porque ZERO itens saíram (fronteira que descarta tudo é o sempre-verde)", () => {
    const r = classificarCanaria({ ...VERDE, itens_na_saida: 0 }, null);
    expect(r.status).toBe("falha");
    expect(r.detalhe).toContain("itens_na_saida=0");
  });

  it("falha: ok=false vence mesmo com 0 preços e 2 itens (ok!==true → vermelho)", () => {
    expect(classificarCanaria({ ...VERDE, ok: false }, null).status).toBe("falha");
  });

  it("falha: campos ausentes não viram 0 (ausente ≠ zero) — `ok:true` sozinho não é verde", () => {
    const r = classificarCanaria({ canary: true, contrato: "ia-nao-precifica-v1", ok: true }, null);
    expect(r.status).toBe("falha");
    expect(r.detalhe).toContain("precos_na_saida=ausente");
  });

  it("erro: invoke falhou (403) = canária vermelha, NÃO 'sem dados'", () => {
    const r = classificarCanaria(null, { message: "Forbidden", status: 403 });
    expect(r.status).toBe("erro");
  });

  it("erro VENCE: se há error E data, classifica como erro (não lê o payload)", () => {
    const r = classificarCanaria(VERDE, { message: "rede" });
    expect(r.status).toBe("erro");
  });

  it("desconhecido: sem resposta e sem erro (nunca rodou / payload vazio)", () => {
    expect(classificarCanaria(null, null).status).toBe("desconhecido");
    expect(classificarCanaria(undefined, null).status).toBe("desconhecido");
  });

  it("desconhecido: edge respondeu mas sem o envelope de canária (canary!==true)", () => {
    expect(classificarCanaria({ precos_na_saida: 0, itens_na_saida: 2, ok: true }, null).status).toBe("desconhecido");
  });

  // ── VERSION MARKER (docs/agent/deploy.md §Canárias, ⚠️ #2) ────────────────────────────────────
  // O marcador só fecha o furo se o CONSUMIDOR exigir o valor. Sem estes casos um deploy
  // INTEGRALMENTE VELHO (a canária anterior respondendo `ok:true`) pintaria o card de verde.

  it("contrato da fatia ANTERIOR (`praticado-vence-omie-v1`) = a edge no ar ainda PRECIFICA — vermelho com motivo próprio", () => {
    // É a resposta exata da edge v1.3 (antes desta fatia): o merge "praticado vence Omie" verde.
    const r = classificarCanaria(
      { canary: true, contrato: "praticado-vence-omie-v1", resolved: 123, expected: 123, ok: true } as never,
      null,
    );
    expect(r.status).toBe("falha");
    expect(r.detalhe).toContain("ainda PRECIFICA");
    expect(r.detalhe).toContain("ia-nao-precifica-v1");
  });

  it("contrato de OUTRA fatia = deploy que não é o desta, não verde (a mentira que o marcador existe para pegar)", () => {
    const r = classificarCanaria({ ...VERDE, contrato: "fatia-qualquer-v0" }, null);
    expect(r.status).toBe("falha");
    expect(r.detalhe).toContain("ia-nao-precifica-v1");
    expect(r.detalhe).toContain("fatia-qualquer-v0");
  });

  it("contrato AUSENTE = canária pré-marcador no ar (bundle velho), não verde", () => {
    const r = classificarCanaria({ canary: true, precos_na_saida: 0, itens_na_saida: 2, ok: true }, null);
    expect(r.status).toBe("falha");
    expect(r.detalhe).toContain("sem o marcador");
  });

  it("CALIBRAÇÃO: sob a forma ANTIGA (que aceitava o merge praticado×Omie) a edge velha passaria por verde", () => {
    // A forma antiga do card: contrato praticado-vence-omie-v1 && ok && resolved === 123 && expected === 123.
    // Prova que o caso "edge velha" acima pega saída errada — sem isto ele só provaria que a função responde.
    const antiga = (d: { contrato?: string; resolved?: number; expected?: number; ok?: boolean }) =>
      d.contrato === "praticado-vence-omie-v1" && d.ok === true && d.resolved === 123 && d.expected === 123
        ? "ok"
        : "falha";
    const edgeVelha = { canary: true, contrato: "praticado-vence-omie-v1", resolved: 123, expected: 123, ok: true };
    expect(antiga(edgeVelha)).toBe("ok"); // ← a edge que ainda precifica pintava verde
    expect(classificarCanaria(edgeVelha as never, null).status).toBe("falha");
    // controle positivo: a edge NOVA é verde para o card novo (senão a divergência não provaria nada)…
    expect(classificarCanaria(VERDE, null).status).toBe("ok");
    // …e vermelha para o card antigo — por isso a troca exige o Publish E o deploy (deploy.md §Canárias).
    expect(antiga(VERDE)).toBe("falha");
  });
});
