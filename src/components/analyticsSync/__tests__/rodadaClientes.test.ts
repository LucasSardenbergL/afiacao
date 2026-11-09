import { describe, it, expect } from "vitest";
import { haRodadaAberta, rodadasRelevantes, statusRodada, type RodadaClientesRow } from "../rodadaClientes";

const AGORA = Date.parse("2026-11-01T21:00:00Z");
const base = (over: Partial<RodadaClientesRow> = {}): RodadaClientesRow => ({
  id: "r1", origem: "manual", criado_em: "2026-11-01T20:55:00Z", conta_slug: "oben", start_page: 40, total_paginas: 260,
  concluida_em: null, falhou_em: null, motivo_falha: null, ultimo_erro: null, running_since: null,
  heartbeat_at: "2026-11-01T20:59:00Z", importados: 1200, pulados: 3000, erros: 0, telefones_repostos: 5,
  falhas: [], contas_sem_credencial: [], invocacoes: 12, ...over,
});

describe("statusRodada", () => {
  it("rodando: mostra a conta na ordem da varredura, a página e os totais", () => {
    const s = statusRodada(base({ running_since: "2026-11-01T20:59:30Z" }), AGORA);
    expect(s.estado).toBe("executando");
    expect(s.descricao).toBe("Importando — conta 2/3 (Oben), página 40/260. 1.200 novos · 3.000 já existiam · 0 erros");
  });

  it("entre lotes é 'na fila'; sem sinal por mais de 10 min é 'atrasada' (o cron pode ter parado)", () => {
    expect(statusRodada(base(), AGORA).estado).toBe("aguardando");
    const atrasada = statusRodada(base({ heartbeat_at: "2026-11-01T20:40:00Z" }), AGORA);
    expect(atrasada.estado).toBe("atrasada");
    expect(atrasada.descricao).toBe("Sem sinal do servidor há mais de 10 min (conta 2/3, página 40). Avise a equipe.");
    // Worker morto com lease ocupado e sem cron para roubá-lo: também é atrasada, não "executando" eterno.
    expect(statusRodada(base({ running_since: "2026-11-01T20:30:00Z", heartbeat_at: "2026-11-01T20:30:00Z" }), AGORA).estado).toBe("atrasada");
  });

  it("concluída com conta interrompida, sem credencial ou erros NÃO é 'concluida' — é parcial", () => {
    const fim = { concluida_em: "2026-11-01T20:58:00Z", conta_slug: null };
    expect(statusRodada(base(fim), AGORA).estado).toBe("concluida");
    expect(statusRodada(base({ ...fim, falhas: [{ conta: "Oben" }] }), AGORA).estado).toBe("parcial");
    expect(statusRodada(base({ ...fim, contas_sem_credencial: [{ account: "colacor" }] }), AGORA).estado).toBe("parcial");
    expect(statusRodada(base({ ...fim, erros: 3 }), AGORA).estado).toBe("parcial");
  });

  it("falhou: diz o motivo e oferece retomar só sem lease", () => {
    const f = statusRodada(base({ falhou_em: "2026-11-01T20:50:00Z", motivo_falha: "erro_persistente", ultimo_erro: "Omie fora do ar" }), AGORA);
    expect(f.estado).toBe("falhou");
    expect(f.podeRearmar).toBe(true);
    expect(f.descricao).toBe("Falhou (erro repetido) em Oben, página 40 — Omie fora do ar. 1.200 novos · 3.000 já existiam · 0 erros");
    expect(statusRodada(base({ falhou_em: "x", running_since: "y" }), AGORA).podeRearmar).toBe(false);
  });
});

describe("rodadasRelevantes / haRodadaAberta", () => {
  it("aberta + falhada mais recente + concluída mais recente, nessa ordem", () => {
    const rows = [
      base({ id: "c-velha", criado_em: "2026-10-01T00:00:00Z", concluida_em: "2026-10-01T01:00:00Z" }),
      base({ id: "f", criado_em: "2026-10-20T00:00:00Z", falhou_em: "2026-10-20T01:00:00Z" }),
      base({ id: "c", criado_em: "2026-10-25T00:00:00Z", concluida_em: "2026-10-25T01:00:00Z" }),
      base({ id: "a", criado_em: "2026-11-01T20:55:00Z" }),
    ];
    expect(rodadasRelevantes(rows).map((r) => r.id)).toEqual(["a", "f", "c"]);
    expect(haRodadaAberta(rows)).toBe(true);
    expect(haRodadaAberta(rows.filter((r) => r.id !== "a"))).toBe(false);
  });
});
