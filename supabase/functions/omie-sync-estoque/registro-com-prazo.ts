// Adaptador do DbRegistro (_shared/registro-execucao.ts) com PRAZO em cada escrita do registro.
//
// [Codex P1 2026-10-05, adversarial do #2817] O comRegistro é fail-open contra REJEIÇÃO, mas aguarda o banco sem
// prazo — e o fechamento roda depois do corte de 85s do run. Banco lento ⇒ a resposta passava dos 90s do pg_net (o
// cron registrava timeout com o dado já publicado) e, no erro, o marcador `error` da Sentinela, que o catch final
// grava DEPOIS do comRegistro, atrasava junto. Aqui a ESPERA também é fail-open: estourou o prazo, a escrita
// resolve como erro ("não abriu"/"não fechou" — o caminho que o registro já trata) e a ação real segue.
//
// Contrato:
//   - banco respondeu dentro do prazo → a resposta dele, intacta, e o timer é limpo (nada pendurado no isolate);
//   - banco rejeitou dentro do prazo → a MESMA rejeição (o try/catch do registro a absorve);
//   - prazo estourou → { error } com o nome da operação; a escrita atrasada segue sozinha, e se ela rejeitar
//     depois, a rejeição tem handler (o Promise.race já assinou) — no Deno, rejeição órfã derruba o isolate.
import type { DbRegistro } from "../_shared/registro-execucao.ts";

function comPrazo<R>(operacao: PromiseLike<R>, prazoMs: number, aoEstourar: () => R): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<R>((resolve) => {
    timer = setTimeout(() => resolve(aoEstourar()), prazoMs);
  });
  return Promise.race([Promise.resolve(operacao), limite]).finally(() => clearTimeout(timer));
}

export function registroComPrazo(db: DbRegistro, prazoMs: number): DbRegistro {
  const estourou = (op: string) => ({ message: `${op} sem resposta em ${prazoMs}ms (prazo do registro)` });
  return {
    from(tabela) {
      const t = db.from(tabela);
      return {
        insert: (linha) => ({
          select: (colunas) => ({
            single: () =>
              comPrazo(t.insert(linha).select(colunas).single(), prazoMs, () => ({ data: null, error: estourou("insert") })),
          }),
        }),
        update: (patch) => ({
          eq: (coluna, valor) => comPrazo(t.update(patch).eq(coluna, valor), prazoMs, () => ({ error: estourou("update") })),
        }),
        select: (colunas) => ({
          eq: (coluna, valor) => ({
            maybeSingle: () =>
              comPrazo(t.select(colunas).eq(coluna, valor).maybeSingle(), prazoMs, () => ({ data: null, error: estourou("select") })),
          }),
        }),
      };
    },
  };
}
