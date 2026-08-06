/**
 * Trecho ASCII e exclusivo da recusa que `criar_plano_tatico` levanta quando já existe
 * plano do dia operacional (BRT) para aquele cliente naquela carteira.
 *
 * Espelha `PADRAO_JA_GERADO_HOJE` de
 * `supabase/functions/generate-tactical-plan/plano-helpers.ts` — mudou lá, mude aqui, e
 * mude junto com a mensagem da migration `20260802130000_tactical_plan_idempotencia_dia`.
 *
 * ASCII de propósito: a mensagem em produção tem acento ("Já existe plano tático…"), e
 * casar o pedaço sem acento evita depender de normalização unicode entre o Postgres, o
 * PostgREST e o runtime (mesma disciplina de `PADROES_SKIP_RPC`).
 */
const PADRAO_JA_GERADO_HOJE = 'gerado hoje para este cliente';

/**
 * A trava de idempotência recusou — não é falha, é a garantia funcionando.
 *
 * POR QUE A TELA PRECISA SABER: a checagem "já gerei hoje?" existia só no caminho do CRON;
 * pelo botão da vendedora a RPC era a primeira e única barreira, e agora ela recusa. Sem
 * este discriminador o toast diria "Erro ao gerar plano" para o caso em que **o plano de
 * hoje já está pronto na lista logo abaixo** — a vendedora tentaria de novo, ou acionaria
 * a equipe, por uma não-falha.
 */
export function ehJaGeradoHoje(mensagem: unknown): boolean {
  if (typeof mensagem !== 'string') return false;
  return mensagem.toLowerCase().includes(PADRAO_JA_GERADO_HOJE);
}
