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
  if (codigo === '42883' || codigo === 'PGRST202') return true;
  const msg = typeof erro.message === 'string' ? erro.message : '';
  if (msg === '') return false;
  // Âncoras ASCII e exclusivas do modo "não existe". NÃO casar 'schema cache' solto: o PostgREST usa
  // essa expressão em erros de coluna/relação também, e casá-la faria um erro de contrato virar
  // fail-open. Aqui só entra a frase completa do PGRST202.
  return /(does not exist|could not find the function|not find the function .* in the schema cache)/i.test(msg);
}
