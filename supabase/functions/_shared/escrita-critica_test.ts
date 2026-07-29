// Testa o CÓDIGO REAL de escritaCritica (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/escrita-critica_test.ts
//
// O gate estrutural (src/__tests__/escrita-critica-gate.test.ts) prova que os call-sites
// DELEGAM ao contrato; estes testes provam que o contrato faz o que promete. Os dois se
// complementam: um gate textual verde sobre um helper que engole erro seria teatro.
import { escritaCritica, EscritaCriticaError } from "./escrita-critica.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

/** Silencia o console.error do helper e devolve o que ele registrou. */
async function capturandoLog<T>(fn: () => Promise<T>): Promise<{ r: T; logs: unknown[][] }> {
  const original = console.error;
  const logs: unknown[][] = [];
  console.error = (...args: unknown[]) => void logs.push(args);
  try {
    return { r: await fn(), logs };
  } finally {
    console.error = original;
  }
}

Deno.test("escrita bem-sucedida não lança e AGUARDA a operação", async () => {
  let concluiu = false;
  const op = Promise.resolve().then(() => {
    concluiu = true;
    return { error: null };
  });
  await escritaCritica("t.insert", op);
  assertEquals(concluiu, true, "o helper aguarda a escrita — não dispara e esquece");
});

Deno.test("erro do banco LANÇA EscritaCriticaError com alvo e SQLSTATE", async () => {
  const op = Promise.resolve({
    error: { message: "duplicate key value", code: "23505", details: "Key (id)=(7)", hint: null },
  });
  const { logs } = await capturandoLog(async () => {
    try {
      await escritaCritica("fin_projecao_snapshots.insert", op);
      throw new Error("NÃO LANÇOU — o contrato foi violado");
    } catch (e) {
      assert(e instanceof EscritaCriticaError, `esperado EscritaCriticaError, veio ${e}`);
      const err = e as EscritaCriticaError;
      assertEquals(err.alvo, "fin_projecao_snapshots.insert");
      assertEquals(err.code, "23505");
      assert(err.message.includes("23505"), "a mensagem expõe o SQLSTATE para diagnóstico");
      return null;
    }
  });
  assertEquals(logs.length, 1, "a falha é registrada no console do Deno");
});

// Regressão da lição de PII: o corpo da exceção sobe até a resposta HTTP 500 do serve(),
// então NÃO pode carregar o texto livre do Postgres — que pode interpolar valor de linha
// (RAISE EXCEPTION com id/CPF, erro de cast citando o valor). Domínio fechado só.
Deno.test("a exceção NÃO carrega a mensagem crua do Postgres (PII)", async () => {
  const vazamento = "duplicate key (cpf)=(123.456.789-00) já existe";
  const op = Promise.resolve({ error: { message: vazamento, code: "23505" } });
  const { logs } = await capturandoLog(async () => {
    try {
      await escritaCritica("t.insert", op);
      throw new Error("NÃO LANÇOU");
    } catch (e) {
      assert(
        !(e as Error).message.includes("123.456.789-00"),
        "a mensagem crua do Postgres vazou para a exceção (e daí para o corpo HTTP)",
      );
      return null;
    }
  });
  // …mas o operador ainda precisa diagnosticar: o texto completo vai para o log do Deno.
  assert(
    JSON.stringify(logs[0]).includes("123.456.789-00"),
    "a mensagem completa tem de sobrar no log do Deno para diagnóstico",
  );
});

Deno.test("erro sem `code` ainda lança (SQLSTATE ausente ≠ sucesso)", async () => {
  const op = Promise.resolve({ error: { message: "network unreachable" } });
  await capturandoLog(async () => {
    try {
      await escritaCritica("t.update", op);
      throw new Error("NÃO LANÇOU");
    } catch (e) {
      assert(e instanceof EscritaCriticaError, "erro sem code também é falha de escrita");
      assertEquals((e as EscritaCriticaError).code, null);
      return null;
    }
  });
});
