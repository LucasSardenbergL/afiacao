import { describe, expect, it } from "vitest";
import {
  aplicarResultado,
  armazemMemoria,
  backoffMs,
  type Comando,
  enfileirar,
  enviarRodada,
  leiturasDaAtribuicao,
  proximosEnvios,
  type ResultadoEnvio,
} from "../fila";

function cmd(id: string, tarefa = "T1", extra: Partial<Comando> = {}): Comando {
  return {
    leitura_id: id,
    account: "oben",
    tarefa_id: tarefa,
    atribuicao_id: "A1",
    tarefa_revisao: 1,
    tipo: "bipe",
    codigo_lido: "789",
    lido_em: "2026-10-11T12:00:00Z",
    ...extra,
  };
}

const aceita: ResultadoEnvio = { tipo: "resposta", resposta: { ok: true, motivo: null, linha_id: "L1", unidades: 1 } };

describe("fila de leituras", () => {
  it("seq cresce na ordem de captura e UUID repetido é recusado", async () => {
    const a = armazemMemoria();
    expect((await enfileirar(a, cmd("u1"))).seq).toBe(1);
    expect((await enfileirar(a, cmd("u2"))).seq).toBe(2);
    await expect(enfileirar(a, cmd("u1"))).rejects.toThrow("fila: leitura u1 já enfileirada");
  });

  it("envia UMA por tarefa, a de menor seq; tarefas diferentes andam em paralelo", async () => {
    const a = armazemMemoria();
    await enfileirar(a, cmd("u1", "T1"));
    await enfileirar(a, cmd("u2", "T1"));
    await enfileirar(a, cmd("u3", "T2"));
    expect(proximosEnvios(await a.todos()).map((i) => i.comando.leitura_id).sort()).toEqual(["u1", "u3"]);
  });

  it("erro de rede mantém a ORDEM: a 2ª da tarefa não passa à frente da 1ª", async () => {
    const a = armazemMemoria();
    await enfileirar(a, cmd("u1"));
    await enfileirar(a, cmd("u2"));
    const enviados: string[] = [];
    const r = await enviarRodada(a, (c) => {
      enviados.push(c.leitura_id);
      return Promise.resolve({ tipo: "transitorio", erro: "Failed to fetch" });
    });
    expect([enviados, r.transitorio, r.maxTentativas]).toEqual([["u1"], true, 1]);
    expect(proximosEnvios(await a.todos()).map((i) => i.comando.leitura_id)).toEqual(["u1"]);
  });

  it("rejeição do servidor é resolução (sai da fila) e libera a próxima", async () => {
    const a = armazemMemoria();
    await enfileirar(a, cmd("u1"));
    await enfileirar(a, cmd("u2"));
    const r = await enviarRodada(a, () =>
      Promise.resolve({ tipo: "resposta", resposta: { ok: false, motivo: "excesso", linha_id: null, unidades: null } }),
    );
    expect(r.resolvidos.map((i) => [i.comando.leitura_id, i.estado, i.motivo])).toEqual([["u1", "rejeitada", "excesso"]]);
    expect(proximosEnvios(await a.todos()).map((i) => i.comando.leitura_id)).toEqual(["u2"]);
  });

  it("`original_nao_recebido` (pendente) não resolve: o estorno continua na fila", () => {
    const it0 = { seq: 1, comando: cmd("e1", "T1", { tipo: "estorno" }), estado: "pendente" as const, tentativas: 0, motivo: null, linha_id: null, unidades: null, previsto: null };
    const novo = aplicarResultado(it0, {
      tipo: "resposta",
      resposta: { ok: false, motivo: "original_nao_recebido", linha_id: null, unidades: null, pendente: true },
    });
    expect([novo.estado, novo.motivo]).toEqual(["pendente", "original_nao_recebido"]);
  });

  it("erro permanente marca `falhou` e impede concluir a atribuição", async () => {
    const a = armazemMemoria();
    await enfileirar(a, cmd("u1"));
    await enfileirar(a, cmd("u2"));
    await enviarRodada(a, () => Promise.resolve(aceita));
    await enviarRodada(a, () => Promise.resolve({ tipo: "permanente", erro: "22023" }));
    expect(leiturasDaAtribuicao(await a.todos(), "A1")).toEqual({ ids: ["u1", "u2"], prontas: false });
  });

  it("concluir exige todos os UUIDs da atribuição resolvidos (aceitas e rejeitadas)", async () => {
    const a = armazemMemoria();
    await enfileirar(a, cmd("u1"));
    await enfileirar(a, cmd("u2", "T1", { atribuicao_id: "A2" }));
    expect(leiturasDaAtribuicao(await a.todos(), "A1").prontas).toBe(false);
    await enviarRodada(a, () => Promise.resolve(aceita));
    expect(leiturasDaAtribuicao(await a.todos(), "A1")).toEqual({ ids: ["u1"], prontas: true });
  });

  it("backoff dobra até 30 s", () => {
    expect([1, 2, 3, 6, 20].map(backoffMs)).toEqual([1000, 2000, 4000, 30000, 30000]);
  });
});
