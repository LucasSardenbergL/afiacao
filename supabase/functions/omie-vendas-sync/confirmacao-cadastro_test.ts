// Sem rede (`--no-remote` do test:edges): assert inline, como os demais _test.ts desta edge.
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg ?? `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}
import { type BancoConfirmacao, gravarConfirmacao, type LinhaConfirmacao, linhaConfirmacao } from "./confirmacao-cadastro.ts";

const UID = "00000000-0000-0000-0000-0000000000a1";

Deno.test("oben + CNPJ + código numérico → linha (número e string aparada)", () => {
  assertEquals(linhaConfirmacao("oben", "12ABC34501DE35", 4242, "incluir", UID), {
    account: "oben", documento: "12ABC34501DE35", codigo_cliente: "4242", origem: "incluir", confirmado_por: UID,
  });
  assertEquals(linhaConfirmacao("oben", "00123456000191", " 77 ", "lookup", null)?.codigo_cliente, "77");
});

Deno.test("nada a confirmar: outra conta, CPF, código ausente/zero/não numérico/fracionário", () => {
  assertEquals(linhaConfirmacao("colacor", "11111111000111", 1, "incluir", UID), null);
  assertEquals(linhaConfirmacao("oben", "12345678909", 1, "incluir", UID), null);
  for (const codigo of [null, undefined, "", "  ", 0, "0", "abc", 12.5, Number.NaN, -3, "0012"]) {
    assertEquals(linhaConfirmacao("oben", "11111111000111", codigo, "lookup", UID), null, `código ${String(codigo)} não pode confirmar`);
  }
});

function banco(resposta: () => PromiseLike<{ error: { message: string } | null }>, gravadas: LinhaConfirmacao[] = []): BancoConfirmacao {
  return {
    from: () => ({
      insert: (linha) => ({
        abortSignal: (sinal) => {
          gravadas.push(linha);
          return new Promise((resolve, reject) => {
            sinal.addEventListener("abort", () => reject(new Error("aborted")));
            resposta().then(resolve, reject);
          });
        },
      }),
    }),
  };
}
const LINHA = linhaConfirmacao("oben", "12ABC34501DE35", 4242, "incluir", UID)!;

Deno.test("gravarConfirmacao: true só com sucesso confirmado; grava a linha pedida", async () => {
  const gravadas: LinhaConfirmacao[] = [];
  assertEquals(await gravarConfirmacao(banco(() => Promise.resolve({ error: null }), gravadas), LINHA), true);
  assertEquals(gravadas, [LINHA]);
});

Deno.test("gravarConfirmacao: erro do PostgREST ou exceção → false, sem lançar", async () => {
  assertEquals(await gravarConfirmacao(banco(() => Promise.resolve({ error: { message: "relation does not exist" } })), LINHA), false);
  assertEquals(await gravarConfirmacao(banco(() => Promise.reject(new Error("rede"))), LINHA), false);
});

Deno.test("gravarConfirmacao: INSERT pendurado → false no prazo (não segura a action)", async () => {
  const inicio = Date.now();
  assertEquals(await gravarConfirmacao(banco(() => new Promise(() => {})), LINHA, 30), false);
  if (Date.now() - inicio > 2000) throw new Error("o prazo não abortou o INSERT");
});
