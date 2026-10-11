import { describe, expect, it } from "vitest";
import {
  aplicarResultado,
  armazemMemoria,
  backoffMs,
  type Comando,
  enviarRodada,
  type ItemFila,
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

function novo(id: string, tarefa = "T1", extra: Partial<Comando> = {}, dono = "U1", previsto: ItemFila["previsto"] = { linha_id: "L1", unidades: 1 }) {
  return { comando: cmd(id, tarefa, extra), operador_id: dono, estado: "pendente" as const, tentativas: 0, motivo: null, linha_id: null, unidades: null, previsto, divergente_nao_visto: false };
}

const aceita: ResultadoEnvio = { tipo: "resposta", resposta: { ok: true, motivo: null, linha_id: "L1", unidades: 1 } };

describe("fila de leituras", () => {
  it("seq cresce na ordem de captura e UUID repetido é recusado", async () => {
    const a = armazemMemoria();
    expect((await a.enfileirar(novo("u1"))).seq).toBe(1);
    expect((await a.enfileirar(novo("u2"))).seq).toBe(2);
    await expect(a.enfileirar(novo("u1"))).rejects.toThrow("fila: leitura u1 já enfileirada");
  });

  it("duas capturas concorrentes nunca pegam o mesmo seq", async () => {
    const a = armazemMemoria();
    const [x, y] = await Promise.all([a.enfileirar(novo("u1")), a.enfileirar(novo("u2"))]);
    expect(new Set([x.seq, y.seq]).size).toBe(2);
  });

  it("envia UMA por tarefa, a de menor seq; tarefas diferentes andam em paralelo", async () => {
    const a = armazemMemoria();
    await a.enfileirar(novo("u1", "T1"));
    await a.enfileirar(novo("u2", "T1"));
    await a.enfileirar(novo("u3", "T2"));
    expect(proximosEnvios(await a.todos(), "U1").map((i) => i.comando.leitura_id).sort()).toEqual(["u1", "u3"]);
  });

  it("só o DONO envia; leitura de outro operador na frente trava a tarefa (não fura a ordem)", async () => {
    const a = armazemMemoria();
    await a.enfileirar(novo("u1", "T1", {}, "U1"));
    await a.enfileirar(novo("u2", "T1", {}, "U2"));
    await a.enfileirar(novo("u3", "T2", {}, "U2"));
    expect(proximosEnvios(await a.todos(), "U2").map((i) => i.comando.leitura_id)).toEqual(["u3"]);
    expect(proximosEnvios(await a.todos(), "U1").map((i) => i.comando.leitura_id)).toEqual(["u1"]);
  });

  it("erro de rede mantém a ORDEM: a 2ª da tarefa não passa à frente da 1ª", async () => {
    const a = armazemMemoria();
    await a.enfileirar(novo("u1"));
    await a.enfileirar(novo("u2"));
    const enviados: string[] = [];
    const r = await enviarRodada(a, (c) => {
      enviados.push(c.leitura_id);
      return Promise.resolve({ tipo: "transitorio", erro: "Failed to fetch" });
    }, "U1");
    expect([enviados, r.transitorio, r.maxTentativas]).toEqual([["u1"], true, 1]);
    expect(proximosEnvios(await a.todos(), "U1").map((i) => i.comando.leitura_id)).toEqual(["u1"]);
  });

  it("rejeição do servidor de uma leitura PREVISTA como aceita fica marcada como divergente não vista", async () => {
    const a = armazemMemoria();
    await a.enfileirar(novo("u1"));
    await a.enfileirar(novo("u2"));
    const r = await enviarRodada(a, () =>
      Promise.resolve({ tipo: "resposta", resposta: { ok: false, motivo: "excesso", linha_id: null, unidades: null } }), "U1");
    expect(r.resolvidos.map((i) => [i.comando.leitura_id, i.estado, i.motivo, i.divergente_nao_visto])).toEqual([["u1", "rejeitada", "excesso", true]]);
    expect(proximosEnvios(await a.todos(), "U1").map((i) => i.comando.leitura_id)).toEqual(["u2"]);
  });

  it("rejeição já prevista (previsto null) não é divergência; aceita inesperada é", () => {
    const base = { ...novo("x"), seq: 1, previsto: null };
    expect(aplicarResultado(base, { tipo: "resposta", resposta: { ok: false, motivo: "excesso", linha_id: null, unidades: null } }).divergente_nao_visto).toBe(false);
    expect(aplicarResultado(base, aceita).divergente_nao_visto).toBe(true);
  });

  it("`original_nao_recebido` (pendente) não resolve: o estorno continua na fila", () => {
    const novoItem = aplicarResultado({ ...novo("e1", "T1", { tipo: "estorno" }), seq: 1 }, {
      tipo: "resposta",
      resposta: { ok: false, motivo: "original_nao_recebido", linha_id: null, unidades: null, pendente: true },
    });
    expect([novoItem.estado, novoItem.motivo]).toEqual(["pendente", "original_nao_recebido"]);
  });

  it("erro permanente marca `falhou` (divergente) e impede concluir a atribuição", async () => {
    const a = armazemMemoria();
    await a.enfileirar(novo("u1"));
    await a.enfileirar(novo("u2"));
    await enviarRodada(a, () => Promise.resolve(aceita), "U1");
    await enviarRodada(a, () => Promise.resolve({ tipo: "permanente", erro: "22023" }), "U1");
    expect(leiturasDaAtribuicao(await a.todos(), "A1")).toEqual({ ids: ["u1", "u2"], prontas: false });
  });

  it("concluir exige todos os UUIDs da atribuição resolvidos (aceitas e rejeitadas)", async () => {
    const a = armazemMemoria();
    await a.enfileirar(novo("u1"));
    await a.enfileirar(novo("u2", "T1", { atribuicao_id: "A2" }));
    expect(leiturasDaAtribuicao(await a.todos(), "A1").prontas).toBe(false);
    await enviarRodada(a, () => Promise.resolve(aceita), "U1");
    expect(leiturasDaAtribuicao(await a.todos(), "A1")).toEqual({ ids: ["u1"], prontas: true });
  });

  it("backoff dobra até 30 s", () => {
    expect([1, 2, 3, 6, 20].map(backoffMs)).toEqual([1000, 2000, 4000, 30000, 30000]);
  });
});
