// Helper do LEASE row-based (exclusão mútua entre runs de uma mesma edge).
//
// Existe separado do index.ts porque a suíte Deno roda com `--no-remote`: um teste que importasse a
// edge puxaria `npm:@supabase/supabase-js@2` e colocaria o registry no caminho de entrega de TODO PR.
// Lógica PURA aqui, testada em lease_test.ts.

/** Erro de RPC como o supabase-js o devolve (só o que este helper lê). */
export interface ErroRpc {
  code?: string;
  message?: string;
}

/**
 * O claim falhou porque a FUNÇÃO DE LEASE ainda não existe no banco?
 *
 * Por que a distinção importa: no Lovable, a edge e a migration são publicações MANUAIS e
 * INDEPENDENTES, em qualquer ordem. Se a edge nova subir antes da migration, `claim_*` não existe.
 * Tratar isso como fatal transformaria a janela entre as duas publicações em CRON QUEBRADO — a
 * armadilha que a migration 20260723160000 já documentou. Nesse caso o caller segue SEM lease
 * (exatamente o comportamento anterior: nada piora) e DECLARA o aviso no log e na resposta.
 *
 * Qualquer OUTRO erro tem de ser fail-closed: a função existe e o lease está quebrado, e aí a
 * exclusão mútua não pode ser presumida.
 *
 * FAIL-CLOSED POR DESENHO: só devolve true com evidência POSITIVA de "função ausente". Erro sem
 * `code` e sem mensagem reconhecível → false (o caller lança). Um falso positivo aqui seria pior que
 * um falso negativo: silenciaria um lease quebrado e reabriria a corrida sem ninguém saber.
 *
 * Os dois códigos: `42883` = undefined_function do Postgres; `PGRST202` = o PostgREST não achou a
 * função no schema cache (o que o supabase-js devolve quando a RPC não existe ou o cache está velho).
 */
export function leaseIndisponivel(erro: ErroRpc | null | undefined): boolean {
  if (erro == null) return false;
  const codigo = typeof erro.code === 'string' ? erro.code : '';
  // SÓ código, ZERO heurística de mensagem. `42883` é `undefined_function` do Postgres e `PGRST202`
  // é "função não encontrada" do PostgREST — juntos cobrem os casos canônicos de RPC ausente, e
  // ambos são inequívocos.
  //
  // Por que NÃO casar a mensagem (challenge /codex, convergindo com o auto-challenge): `does not
  // exist` aparece em erros de OUTROS objetos — `42P01 relation "sync_state" does not exist`,
  // `42703 column ... does not exist`. Qualquer um deles casaria a frase e faria a edge seguir
  // fail-open sobre um banco quebrado, reintroduzindo exatamente a corrupção que o lease fecha.
  // Um primeiro aperto (exigir que a mensagem citasse a própria função) reduzia o falso positivo
  // mas mantinha a heurística; o Codex foi além e recomendou eliminá-la, e ele está certo: num
  // predicado que decide entre "proteger" e "não proteger", heurística de texto é o lado errado da
  // troca. Erro sem `code` reconhecível → false → o caller LANÇA. Fail-closed é o default correto:
  // não rodar é recuperável (o próximo cron converge), rodar sem exclusão não é.
  return codigo === '42883' || codigo === 'PGRST202';
}
