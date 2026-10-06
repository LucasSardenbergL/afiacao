// registroComPrazo × comRegistro REAL (_shared/registro-execucao.ts), sobre um banco falso que responde, pendura ou
// rejeita tarde. Prova o contrato do adaptador e, de quebra, o que o adversarial do #2817 achou sem prova nenhuma:
// o comRegistro RELANÇA o mesmo erro da ação. Sem dependência remota (o CI roda `deno test --no-remote`).
import { comRegistro, type DbRegistro } from "../_shared/registro-execucao.ts";
import { registroComPrazo } from "./registro-com-prazo.ts";

function confere(condicao: unknown, mensagem: string): asserts condicao {
  if (!condicao) throw new Error(`FALHOU: ${mensagem}`);
}

const dorme = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nunca = <T>() => new Promise<T>(() => {});

type RespostaInsert = { data: { id: string } | null; error: { message: string } | null };
type RespostaUpdate = { error: { message: string } | null };

function bancoFalso(plano: { insert: () => Promise<RespostaInsert>; update: () => Promise<RespostaUpdate> }) {
  const updates: Record<string, unknown>[] = [];
  const db: DbRegistro = {
    from: () => ({
      insert: () => ({ select: () => ({ single: plano.insert }) }),
      update: (patch) => ({
        eq: () => {
          updates.push(patch);
          return plano.update();
        },
      }),
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
    }),
  };
  return { db, updates };
}

// Teto do PRÓPRIO teste: `deno test` não tem timeout, e uma sabotagem que tire o prazo penduraria o runner em vez de
// ficar vermelha.
const ESTOUROU = "ESTOUROU_O_TETO_DO_TESTE";
async function comTeto<T>(p: Promise<T>, ms: number): Promise<T | typeof ESTOUROU> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const teto = new Promise<typeof ESTOUROU>((resolve) => {
    timer = setTimeout(() => resolve(ESTOUROU), ms);
  });
  try {
    return await Promise.race([p, teto]);
  } finally {
    clearTimeout(timer);
  }
}

const abreRapido = () => Promise.resolve({ data: { id: "r1" }, error: null });

Deno.test("fechamento pendurado: a ação devolve o resultado dentro do prazo", async () => {
  const { db, updates } = bancoFalso({ insert: abreRapido, update: () => nunca<RespostaUpdate>() });
  const inicio = Date.now();
  const r = await comTeto(comRegistro(registroComPrazo(db, 30), "x", { via: "cron" }, async () => 42), 1000);
  confere(r === 42, `esperava 42, veio ${String(r)}`);
  confere(Date.now() - inicio < 500, `levou ${Date.now() - inicio}ms com prazo de 30ms`);
  confere(updates.length === 1 && updates[0].status === "sucesso", "o fechamento foi tentado com status sucesso");
});

Deno.test("ação que falha com o fechamento pendurado: o MESMO erro sobe dentro do prazo", async () => {
  const { db, updates } = bancoFalso({ insert: abreRapido, update: () => nunca<RespostaUpdate>() });
  const erro = new Error("AUTH_ERROR: credencial recusada");
  let pego: unknown = null;
  const r = await comTeto(
    comRegistro(registroComPrazo(db, 30), "x", { via: "cron" }, async () => {
      throw erro;
    }).catch((e: unknown) => {
      pego = e;
      return "rejeitou" as const;
    }),
    1000,
  );
  confere(r === "rejeitou", `esperava a rejeição, veio ${String(r)}`);
  confere(pego === erro, "o comRegistro relançou OUTRO objeto — o catch final perderia o AUTH_ERROR");
  confere(updates.length === 1 && updates[0].status === "erro", "o fechamento foi tentado com status erro");
});

Deno.test("abertura pendurada: a ação roda mesmo assim e o fechamento é pulado", async () => {
  const { db, updates } = bancoFalso({ insert: () => nunca<RespostaInsert>(), update: () => Promise.resolve({ error: null }) });
  const r = await comTeto(comRegistro(registroComPrazo(db, 30), "x", { via: "cron" }, async () => "feito"), 1000);
  confere(r === "feito", `esperava "feito", veio ${String(r)}`);
  confere(updates.length === 0, "sem id do registro não há o que fechar");
});

Deno.test("banco rápido: a resposta passa intacta e nenhum timer fica pendurado", async () => {
  // prazo LONGO de propósito: se o timer não fosse limpo, o sanitizer de ops do Deno reprovaria este teste.
  const { db, updates } = bancoFalso({ insert: abreRapido, update: () => Promise.resolve({ error: null }) });
  const r = await comRegistro(registroComPrazo(db, 2_000), "x", { via: "cron" }, async () => ({ n: 7 }), (v) => ({ n: v.n }));
  confere(r.n === 7, "o resultado da ação volta intacto");
  confere(updates.length === 1, "fechou uma vez");
  const detalhes = updates[0].detalhes as Record<string, unknown>;
  confere(updates[0].status === "sucesso" && detalhes.n === 7, "fechou com sucesso e os detalhes da ação");
});

Deno.test("rejeição do banco depois do prazo não vira uncaught", async () => {
  const rejeitaTarde = () =>
    new Promise<RespostaUpdate>((_, reject) => setTimeout(() => reject(new Error("conexão caiu")), 50));
  const { db } = bancoFalso({ insert: abreRapido, update: rejeitaTarde });
  const r = await comRegistro(registroComPrazo(db, 10), "x", { via: "cron" }, async () => "ok");
  confere(r === "ok", "a ação segue");
  await dorme(120); // a rejeição tardia acontece aqui; sem handler, o Deno reprova com "Uncaught (in promise)"
});

Deno.test("prazo estourado resolve { error } nomeando a operação", async () => {
  const { db } = bancoFalso({ insert: abreRapido, update: () => nunca<RespostaUpdate>() });
  const r = await comTeto(registroComPrazo(db, 10).from("acoes_execucoes").update({ a: 1 }).eq("id", "r1"), 1000);
  confere(r !== ESTOUROU, "o prazo não foi aplicado");
  confere(r.error !== null && r.error.message.startsWith("update sem resposta em 10ms"), `mensagem: ${r.error?.message}`);
});
