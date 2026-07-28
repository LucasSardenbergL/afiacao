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

/** O que fazer depois de UMA tentativa de claim. */
export type DecisaoClaim =
  | 'adquirido'          // o lease é meu; siga o run
  | 'seguir_sem_lease'   // a função não existe (janela de deploy) — fail-open DECLARADO
  | 'esperar_e_retentar' // lease ocupado por outro run, ou transporte incerto, e ainda há tentativa
  | 'pular'              // lease segue ocupado depois de esgotar as tentativas → 200 skipped
  | 'lancar';            // erro real → fail-closed

/**
 * Decide o próximo passo após uma tentativa de claim. PURA: o caller executa a espera e o efeito.
 *
 * Fecha DOIS furos apontados pelo challenge /codex no #1578, que têm causas opostas e a mesma cura:
 *
 * 1. **Transporte perdido.** Se o banco COMMITA o claim mas a resposta HTTP se perde, o caller vê um
 *    erro, `leaseAdquirido` fica false e o `finally` não libera — o lease fica PRESO até o TTL de
 *    15min. A cláusula de re-claim da migration existe justamente para isso, mas ninguém a usava:
 *    "a suposta idempotência está desconectada", já que cada invocação gera um UUID novo e havia uma
 *    única tentativa. Retentar com o MESMO run_id conecta as duas pontas — se o commit passou, o
 *    re-claim reconhece o dono e devolve true; se não passou, é um claim normal.
 *
 * 2. **Perda de frescor.** Com uma única tentativa, o run que encontra o lease ocupado é PULADO e
 *    não volta: o próximo disparo real é o cron do dia seguinte. Trocamos corrupção por até 24h de
 *    dado velho — melhor que o bug, mas ainda uma regressão. Como um run dura ~17s (medido em prod),
 *    esperar poucos segundos e retentar quase sempre pega o lease logo depois que o outro fecha.
 *
 * ⚠️ O erro de transporte é AMBÍGUO por natureza — não dá para saber se o banco commitou. Retentar
 * com o mesmo run_id é seguro justamente por isso: nas DUAS hipóteses o resultado é correto, e é o
 * que torna esta decisão diferente de "engolir erro".
 *
 * ⚠️ `leaseIndisponivel` é checado ANTES de qualquer retry: insistir numa função que não existe só
 * queima o wall-clock da edge para chegar ao mesmo lugar.
 */
export function decidirClaim(
  resultado: { claimed?: boolean | null; erro?: ErroRpc | null },
  tentativa: number,
  maxTentativas: number,
): DecisaoClaim {
  const { claimed, erro } = resultado;

  if (erro != null) {
    if (leaseIndisponivel(erro)) return 'seguir_sem_lease';
    // Erro real. Uma retentativa cobre o transporte perdido (caso 1); esgotada, é fail-closed.
    return tentativa < maxTentativas ? 'esperar_e_retentar' : 'lancar';
  }

  if (claimed === true) return 'adquirido';

  // claimed false/null/ausente = lease ocupado por outro run (caso 2).
  return tentativa < maxTentativas ? 'esperar_e_retentar' : 'pular';
}

/**
 * Espera antes da próxima tentativa, em ms. Backoff linear curto.
 *
 * Calibrado pelo que foi MEDIDO em produção, não por hábito: um run dura ~17s (cron às 06:00:00, o
 * history começa 06:00:13 e leva ~4s). Com 3 tentativas o total de espera é 5+10 = 15s, que cobre a
 * maior parte de um run em andamento sem ameaçar o teto de wall-clock do edge (150s Free / 400s
 * pago) — sobra folga de sobra para o recompute inteiro depois de adquirir o lease.
 *
 * Deliberadamente NÃO cobre o run inteiro: insistir até o fim transformaria dois disparos
 * simultâneos em dois recomputes em série toda vez. Esperar um pouco e desistir mantém o
 * 200-skipped como desfecho normal do caso comum (cron + clique acidental no mesmo instante),
 * e usa o retry para o caso que importa — o run saudável que perdeu para um degradado.
 */
export function esperaClaimMs(tentativa: number): number {
  return tentativa * 5000;
}
