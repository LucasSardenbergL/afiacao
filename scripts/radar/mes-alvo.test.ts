import { describe, expect, it } from "vitest";
import { candidatosDe, escolherMes, mesBr, type Lote } from "./mes-alvo";

// Relógio CONTROLADO (money-path.md): o dado fica parado e quem anda é o `agora` do teste.
const AGORA = new Date("2026-10-20T06:00:00Z"); // 03:00 em Brasília, dia 20
const todosDisponiveis = () => "disponivel" as const;
const nenhumDisponivel = () => "indisponivel" as const;
const lote = (mes: string, status: Lote["status"], iniciado_em: string | null = "2026-06-12T01:05:18Z"): Lote =>
  ({ mes_referencia: mes, status, iniciado_em });

describe("mesBr / candidatosDe — janela de 3 meses em Brasília", () => {
  it("[M1] janela [M-2, M-1, M] do mais antigo para o mais novo", () => {
    expect(candidatosDe(AGORA)).toEqual(["2026-08", "2026-09", "2026-10"]);
  });
  it("[M2] vira o ano para trás", () => {
    expect(candidatosDe(new Date("2026-01-20T06:00:00Z"))).toEqual(["2025-11", "2025-12", "2026-01"]);
  });
  it("[M3] o mês é o de Brasília, não o UTC (01:00 UTC do dia 1 ainda é o mês anterior em SP)", () => {
    expect(mesBr(new Date("2026-11-01T01:00:00Z"))).toBe("2026-10");
    expect(mesBr(new Date("2026-11-01T04:00:00Z"))).toBe("2026-11");
  });
});

describe("escolherMes — nunca regride, nunca pula em silêncio, nunca atropela carga viva", () => {
  it("[E1] situação de prod: só 2026-05 complete → escolhe o MAIS ANTIGO pendente disponível", () => {
    const d = escolherMes({ candidatos: candidatosDe(AGORA), disponivel: todosDisponiveis, lotes: [lote("2026-05", "complete")], forcar: false, agora: AGORA });
    expect(d.mes).toBe("2026-08");
  });
  it("[E2] mês ainda não publicado é pulado e o seguinte não é escolhido no lugar se for mais novo que o pendente… (ordem crescente)", () => {
    // 2026-08 e 2026-09 complete; 2026-10 ainda não publicado → nada a fazer (não inventa).
    const d = escolherMes({ candidatos: candidatosDe(AGORA), disponivel: (m) => (m === "2026-10" ? "indisponivel" : "disponivel"),
      lotes: [lote("2026-08", "complete"), lote("2026-09", "complete")], forcar: false, agora: AGORA });
    expect(d.mes).toBeNull();
    expect(d.motivos.join("\n")).toContain("2026-10: ainda não publicado");
  });
  it("[E3] publicação atrasada: 2026-09 só saiu depois da rodada → entra na próxima, antes de 2026-10", () => {
    const d = escolherMes({ candidatos: candidatosDe(AGORA), disponivel: todosDisponiveis, lotes: [lote("2026-08", "complete")], forcar: false, agora: AGORA });
    expect(d.mes).toBe("2026-09");
  });
  it("[E4] REGRESSÃO barrada: mês anterior ao último complete nunca é escolhido, nem com --forcar", () => {
    const lotes = [lote("2026-10", "complete")];
    expect(escolherMes({ candidatos: ["2026-09"], disponivel: todosDisponiveis, lotes, forcar: false, agora: AGORA }).mes).toBeNull();
    const forcado = escolherMes({ candidatos: ["2026-09"], disponivel: todosDisponiveis, lotes, forcar: true, agora: AGORA });
    expect(forcado.mes).toBeNull();
    expect(forcado.motivos[0]).toContain("regressão");
  });
  it("[E5] já complete → nada a fazer; --forcar releva SÓ o complete do próprio mês", () => {
    const lotes = [lote("2026-10", "complete")];
    expect(escolherMes({ candidatos: ["2026-10"], disponivel: todosDisponiveis, lotes, forcar: false, agora: AGORA }).mes).toBeNull();
    expect(escolherMes({ candidatos: ["2026-10"], disponivel: todosDisponiveis, lotes, forcar: true, agora: AGORA }).mes).toBe("2026-10");
  });
  it("[E6] lote running iniciado há < 8 h (carga local em andamento) não é atropelado; > 8 h é retomado", () => {
    const vivo = [lote("2026-10", "running", new Date(AGORA.getTime() - 2 * 3_600_000).toISOString())];
    expect(escolherMes({ candidatos: ["2026-10"], disponivel: todosDisponiveis, lotes: vivo, forcar: false, agora: AGORA }).mes).toBeNull();
    const morto = [lote("2026-10", "running", new Date(AGORA.getTime() - 9 * 3_600_000).toISOString())];
    expect(escolherMes({ candidatos: ["2026-10"], disponivel: todosDisponiveis, lotes: morto, forcar: false, agora: AGORA }).mes).toBe("2026-10");
  });
  it("[E7] lote error é retomado (begin_lote preserva iniciado_em; upsert é idempotente)", () => {
    expect(escolherMes({ candidatos: ["2026-10"], disponivel: todosDisponiveis, lotes: [lote("2026-10", "error")], forcar: false, agora: AGORA }).mes).toBe("2026-10");
  });
  it("[E8] nada disponível → null com um motivo por candidato (nunca escolhe no escuro)", () => {
    const d = escolherMes({ candidatos: candidatosDe(AGORA), disponivel: nenhumDisponivel, lotes: [], forcar: false, agora: AGORA });
    expect(d.mes).toBeNull();
    expect(d.motivos).toHaveLength(3);
  });
});
