import { describe, it, expect } from "vitest";
import { devePublicarRun, type RunPublicacaoStatus } from "./publicacao-run";

// Prova a decisão money-path da edge omie-sync-pedidos-compra: QUANDO publicar o run (Codex P1 #1/#2 +
// v3.2 P1#2 — NÃO gatear por summary.erros). A cadência (marcarCompletoOk) NÃO é mais um predicado puro —
// avança pelo SUCESSO da RPC, gateado direto na edge (`if (publicou)`), coberto por edge-money-path-invariants.

describe("devePublicarRun (Codex P1 #1/#2 — só completo com COLETA LIMPA e NÃO-filtrado)", () => {
  const base: RunPublicacaoStatus = { modo: "completo", varreduraCompleta: true, fornecedorCodigo: undefined };

  it("publica no completo limpo, não-filtrado, que viu o fim", () => {
    expect(devePublicarRun(base)).toBe(true);
  });
  it("P1#2: NÃO publica run filtrado por fornecedor (carimbaria um subset)", () => {
    expect(devePublicarRun({ ...base, fornecedorCodigo: 8689681266 })).toBe(false);
  });
  it("NÃO publica no modo incremental (janela curta, não é o snapshot de verdade)", () => {
    expect(devePublicarRun({ ...base, modo: "incremental" })).toBe(false);
  });
  it("P1#1: NÃO publica se a COLETA não viu o fim legítimo (varreduraCompleta=false = abort/truncamento)", () => {
    expect(devePublicarRun({ ...base, varreduraCompleta: false })).toBe(false);
  });
  it("v3.2 P1#2: publica mesmo com upsert torto — o predicado nem conhece summary.erros (só a COLETA importa)", () => {
    // devePublicarRun não recebe `erros`: erro de PERSISTÊNCIA do espelho não corrompe idsVistos, e erro de
    // COLETA já vira varreduraCompleta=false. O tipo RunPublicacaoStatus não tem mais o campo `erros`.
    expect(devePublicarRun(base)).toBe(true);
  });
  it("fornecedorCodigo=0 (falsy) NÃO conta como filtro — publica", () => {
    expect(devePublicarRun({ ...base, fornecedorCodigo: 0 })).toBe(true);
  });
});
