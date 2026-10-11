import { describe, expect, it } from "vitest";
import type { ItemFila } from "../scanner/fila";
import { type LeituraServidor, type LinhaServidor, linhaAtual, progressoLocal, tudoSeparado } from "../progresso-local";

const L1: LinhaServidor = { id: "L1", codigo_item: 1, omie_codigo_produto: 1, unidade: "UN", ean: "7", quantidade: 3, fracionaria: false, ativa: true, revisao: 2 };
const L2: LinhaServidor = { ...L1, id: "L2", codigo_item: 2, quantidade: 1 };

function item(id: string, estado: ItemFila["estado"], extra: Partial<ItemFila> = {}): ItemFila {
  return {
    seq: 1,
    comando: { leitura_id: id, account: "oben", tarefa_id: "T", atribuicao_id: "A", tarefa_revisao: 1, tipo: "bipe", lido_em: "x" },
    estado,
    tentativas: 0,
    motivo: null,
    linha_id: null,
    unidades: null,
    previsto: { linha_id: "L1", unidades: 1 },
    ...extra,
  };
}

const lida = (id: string, rev = 2, aceita = true): LeituraServidor => ({ id, linha_id: "L1", linha_revisao: rev, unidades: 1, aceita });

describe("progresso local", () => {
  it("soma servidor (revisão vigente) + fila pendente pela previsão", () => {
    const r = progressoLocal([L1, L2], [lida("a"), lida("velha", 1), lida("rej", 2, false)], [item("p", "pendente")]);
    expect(r.find((l) => l.id === "L1")?.separada).toBe(2);
  });

  it("leitura que o servidor já tem não conta duas vezes", () => {
    const r = progressoLocal([L1], [lida("a")], [item("a", "aceita", { linha_id: "L1", unidades: 1 })]);
    expect(r[0].separada).toBe(1);
  });

  it("aceita pelo servidor mas ainda fora do refetch conta pelo resultado do servidor, não pela previsão", () => {
    const r = progressoLocal([L1, L2], [], [item("b", "aceita", { linha_id: "L2", unidades: 1 })]);
    expect([r[0].separada, r[1].separada]).toEqual([0, 1]);
  });

  it("rejeitada ou falhou não conta", () => {
    expect(progressoLocal([L1], [], [item("r", "rejeitada"), item("f", "falhou")])[0].separada).toBe(0);
  });

  it("linha atual = 1ª incompleta por codigo_item; tudoSeparado só com todas completas", () => {
    const ls = progressoLocal([L2, L1], [lida("a"), lida("b"), lida("c")], []);
    expect(linhaAtual(ls)?.id).toBe("L2");
    expect(tudoSeparado(ls)).toBe(false);
    expect(tudoSeparado([])).toBe(false);
  });
});
