/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { abrirBarreira, criarMotor, ehChaveEpoca, fecharBarreira, lerEpoca } from "../motor-fila";
import { armazemMemoria, type Comando, type ItemFila, type ResultadoEnvio } from "../scanner/fila";

function item(id: string, dono = "U1", tarefa = "T1"): Omit<ItemFila, "seq"> {
  const comando: Comando = { leitura_id: id, account: "oben", tarefa_id: tarefa, atribuicao_id: "A1", tarefa_revisao: 1, tipo: "bipe", lido_em: "x" };
  return { comando, operador_id: dono, estado: "pendente", tentativas: 0, motivo: null, linha_id: null, unidades: null, previsto: { linha_id: "L", unidades: 1 }, divergente_nao_visto: false };
}

const aceita: ResultadoEnvio = { tipo: "resposta", resposta: { ok: true, motivo: null, linha_id: "L", unidades: 1 } };
const espera = () => new Promise((r) => setTimeout(r, 0));

/** Ambiente mutável: o teste troca a sessão e a lente como o app trocaria (sem página montada). */
type Valor<T> = T | ((n: number) => T);
const ler = <T,>(v: Valor<T>, n: number): T => (typeof v === "function" ? (v as (n: number) => T)(n) : v);

/** `sessao`/`lente` podem variar pela N-ésima leitura — para provar cada camada da guarda sozinha. */
async function montar(
  enviar: (c: Comando) => Promise<ResultadoEnvio>,
  itens: string[],
  dono = "U1",
  inicio: { sessao?: Valor<string | null>; lente?: Valor<boolean> } = {},
) {
  const a = armazemMemoria();
  for (const id of itens) await a.enfileirar(item(id, dono));
  const enviados: string[] = [];
  const amb: { sessao: Valor<string | null>; lente: Valor<boolean>; aoEnviar: () => void } = { sessao: "U1", lente: false, aoEnviar: () => {}, ...inicio };
  let nSessao = 0;
  let nLente = 0;
  const motor = criarMotor(
    (c) => {
      enviados.push(c.leitura_id);
      amb.aoEnviar();
      return enviar(c);
    },
    () => Promise.resolve(a),
    () => {},
    { sessao: () => Promise.resolve(ler(amb.sessao, ++nSessao)), lente: () => ler(amb.lente, ++nLente) },
  );
  await espera();
  return { motor, enviados, a, amb };
}

describe("motor da fila", () => {
  it("sob a lente NÃO envia nada; desligada a lente, envia sem precisar de página", async () => {
    const { motor, enviados, amb } = await montar(() => Promise.resolve(aceita), ["u1"], "U1", { lente: true });
    expect(await motor.drenar("T1")).toBe(false);
    expect(enviados).toEqual([]);
    amb.lente = false;
    expect(await motor.drenar("T1")).toBe(true);
    expect(enviados).toEqual(["u1"]);
  });

  it("com o dono logado, drena a tarefa em ordem", async () => {
    const { motor, enviados } = await montar(() => Promise.resolve(aceita), ["u1", "u2"]);
    expect(await motor.drenar("T1")).toBe(true);
    expect(enviados.slice(0, 2)).toEqual(["u1", "u2"]);
  });

  it("logout/login como outro usuário: as leituras de U1 não saem com a sessão de U2", async () => {
    const { motor, enviados } = await montar(() => Promise.resolve(aceita), ["u1"], "U1", { sessao: "U2" });
    expect(await motor.drenar("T1")).toBe(false);
    expect(enviados).toEqual([]);
  });

  it("sessão trocada entre a seleção e o envio: a guarda POR ENVIO segura (camada interna)", async () => {
    // Lente ligada na criação: o laço de fundo não lê a sessão. Depois: leitura 1 (drenar) e 2
    // (rodada) veem U1 — passam pelas guardas externas —, a 3ª (no envio) já vê U2.
    const { motor, enviados, amb, a } = await montar(() => Promise.resolve(aceita), ["u1"], "U1", { lente: true });
    amb.lente = false;
    amb.sessao = (n) => (n <= 2 ? "U1" : "U2");
    expect(await motor.drenar("T1")).toBe(false);
    expect(enviados).toEqual([]);
    expect((await a.todos())[0].estado).toBe("pendente");
  });

  it("lente ligada entre a seleção e o envio: a guarda POR ENVIO segura (camada interna)", async () => {
    const { motor, enviados, amb } = await montar(() => Promise.resolve(aceita), ["u1"], "U1", { lente: true });
    let base = 0;
    amb.lente = (n) => {
      if (base === 0) base = n; // 1ª leitura depois de religar = drenar
      return n - base >= 2; // drenar e rodada veem desligada; o envio vê ligada
    };
    expect(await motor.drenar("T1")).toBe(false);
    expect(enviados).toEqual([]);
  });

  it("offline: drenar devolve false sem marcar nada como resolvido", async () => {
    const { motor, a } = await montar(() => Promise.resolve({ tipo: "transitorio", erro: "Failed to fetch" }), ["u1"]);
    expect(await motor.drenar("T1")).toBe(false);
    expect((await a.todos())[0].estado).toBe("pendente");
  });

  it("armazém que não abre vira erro visível (sem fallback em memória)", async () => {
    const motor = criarMotor(
      () => Promise.resolve(aceita),
      () => Promise.reject(new Error("IndexedDB indisponível")),
      () => {},
      { sessao: () => Promise.resolve("U1"), lente: () => false },
    );
    await espera();
    expect([motor.estado().pronto, motor.estado().erroArmazem]).toEqual([false, "IndexedDB indisponível"]);
  });
});

describe("época da tarefa entre abas", () => {
  it("abrir = ímpar (aberta), fechar = par; por tarefa; a chave do storage identifica a tarefa", () => {
    localStorage.clear();
    expect(lerEpoca("T1")).toEqual({ n: 0, aberta: false });
    expect(abrirBarreira("T1")).toEqual({ n: 1, aberta: true });
    expect(fecharBarreira("T1")).toEqual({ n: 2, aberta: false });
    expect(abrirBarreira("T1").n).toBe(3);
    expect(lerEpoca("T2").n).toBe(0);
    expect(ehChaveEpoca("picking-v2:epoca:T1", "T1")).toBe(true);
    expect(ehChaveEpoca("picking-v2:epoca:T1", "T2")).toBe(false);
  });

  it("barreira aberta por aba que morreu expira (não trava ninguém para sempre)", () => {
    localStorage.clear();
    abrirBarreira("T1");
    expect(lerEpoca("T1", Date.now() + 121_000)).toEqual({ n: 1, aberta: false });
    // Relógio volta para dentro da janela: a época já expirada NÃO reabre (Codex r6).
    expect(lerEpoca("T1", Date.now())).toEqual({ n: 1, aberta: false });
    // Uma barreira NOVA (outra época) abre normalmente.
    expect(fecharBarreira("T1").n).toBe(2);
    expect(abrirBarreira("T1")).toEqual({ n: 3, aberta: true });
  });
});
