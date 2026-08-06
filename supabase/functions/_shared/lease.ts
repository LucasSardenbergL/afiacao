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
  | 'esperar_e_retentar' // transporte INCERTO e ainda há tentativa
  | 'pular'              // lease ocupado por outro run → 200 skipped
  | 'lancar';            // erro permanente, resposta inválida, ou tentativas esgotadas → fail-closed

/**
 * O erro pode ter OUTRO resultado numa nova tentativa?
 *
 * Sem esta classificação, um erro PERMANENTE (permissão, argumento, sintaxe) é retentado 3× — um
 * retry storm que só atrasa o inevitável e queima wall-clock do edge. Achado do challenge /codex:
 * *"Nem todo erro deve ser retentado. Só transporte incerto/transiente deve retentar; erro
 * permanente deve lançar imediatamente."*
 *
 * FAIL-CLOSED NA DÚVIDA — mas note que aqui "fail-closed" é NÃO retentar: a lista é de INCLUSÃO, e
 * código desconhecido cai em `false` (lança na hora). O único caso sem código é a rejeição de
 * fetch/rede, que é exatamente o transporte perdido que motivou o retry.
 */
export function erroTransitorio(erro: ErroRpc | null | undefined): boolean {
  if (erro == null) return false;
  const c = typeof erro.code === 'string' ? erro.code : '';
  // Sem código = rejeição de fetch/rede. É O caso do transporte perdido: o banco pode ter commitado
  // e só a resposta se perdeu — e é justamente por ser AMBÍGUO que retentar com o mesmo run_id vale.
  if (c === '') return true;
  // Classe 08 = connection_exception (08000/08003/08006/08P01): conexão caiu, pode voltar.
  if (c.startsWith('08')) return true;
  if (c === '57014') return true;             // query_canceled (statement timeout)
  if (c === '40001' || c === '40P01') return true; // serialization_failure / deadlock_detected
  if (c === '53300') return true;             // too_many_connections
  // Permanentes — 42501 (permissão), 22004/22023 (argumento), 42601 (sintaxe), 42P01 (relação
  // ausente): retentar dá exatamente o mesmo erro.
  return false;
}

/**
 * Decide o próximo passo após uma tentativa de claim. PURA: o caller executa a espera e o efeito.
 *
 * ESCOPO: fecha **um** dos dois furos que o challenge /codex apontou no #1578 — o **transporte
 * perdido**. Se o banco COMMITA o claim mas a resposta HTTP se perde, o caller vê erro,
 * `leaseAdquirido` fica false, o `finally` não libera, e o lease fica PRESO até o TTL de 15min. A
 * cláusula de re-claim da migration existe para isso, mas ninguém a usava — *"a suposta idempotência
 * está desconectada"*, já que cada invocação gera um UUID novo e havia uma ÚNICA tentativa.
 * Retentar com o MESMO run_id conecta as pontas.
 *
 * ⚠️ O erro de transporte é AMBÍGUO por natureza — não dá para saber se o banco commitou. Retentar
 * com o mesmo run_id é seguro *justamente* por isso: nas DUAS hipóteses o desfecho é correto. É o
 * que separa esta decisão de "engolir erro".
 *
 * ⚠️ O run_id TEM de ser um token aleatório por INVOCAÇÃO (`crypto.randomUUID()`), nunca um id
 * lógico do job nem valor vindo do caller. Se dois processos compartilhassem um run_id, ambos
 * passariam pelo `OR run_id = p_run_id` e se julgariam donos do lease — dois writers, que é o bug
 * que o lease existe para fechar. Invariante levantada pelo /codex; o caller a cumpre.
 *
 * ❌ O QUE ESTA FUNÇÃO **NÃO** FAZ (e por quê): não retenta por **lease ocupado**. A primeira versão
 * deste retry esperava e retentava para fechar a perda de frescor, e o /codex mostrou que a
 * calibragem não fechava nada: as tentativas caíam em t=0/5/15s e o run mediu **~29s** em prod
 * (28/07: cron às 06:00:00, finalize do lease às 06:00:29) — a última tentativa acontecia com o
 * lease ainda ocupado. Cobrir de verdade exigiria esperar >30s, o que come a margem de wall-clock
 * do edge (150s Free) para um cenário que exige dois disparos dentro de ~30s. Esperar sem fechar é
 * pior que não esperar: paga latência, cria retry storm e ainda mente sobre o furo. O frescor
 * segue como limitação DECLARADA, com a cura certa proposta à parte (um segundo disparo do cron).
 */
export function decidirClaim(
  resultado: { claimed?: boolean | null; erro?: ErroRpc | null },
  tentativa: number,
  maxTentativas: number,
): DecisaoClaim {
  const { claimed, erro } = resultado;

  // `erro` antes de `claimed` de propósito: com erro presente, o `claimed` não é confiável.
  if (erro != null) {
    if (leaseIndisponivel(erro)) return 'seguir_sem_lease';
    // Erro PERMANENTE (permissão, argumento, sintaxe) não muda de resultado: lança na hora em vez
    // de gastar 3 tentativas para chegar ao mesmo erro.
    if (!erroTransitorio(erro)) return 'lancar';
    return tentativa < maxTentativas ? 'esperar_e_retentar' : 'lancar';
  }

  if (claimed === true) return 'adquirido';

  // `false` é resposta VÁLIDA: outro run tem o lease. Pula — idempotente, o próximo cron converge.
  if (claimed === false) return 'pular';

  // null/undefined NÃO é "ocupado": é resposta INVÁLIDA de uma RPC que deveria devolver boolean.
  // Tratá-la como ocupado devolveria 200 "já em andamento" sobre um estado desconhecido — a mesma
  // troca de "não consegui ler" por "não existe" que o money-path proíbe (achado /codex).
  return 'lancar';
}

/**
 * Espera antes da próxima tentativa, em ms.
 *
 * Curta de propósito: o retry cobre APENAS transporte incerto (ver `decidirClaim`), então basta
 * absorver uma oscilação de rede — não há run alheio para esperar. Com 2 tentativas, a espera total
 * é de 2s, o que não move a agulha do wall-clock do edge nem cria janela para herd.
 */
export function esperaClaimMs(tentativa: number): number {
  return tentativa * 2000;
}
