import { supabase } from '@/integrations/supabase/client';
import { canonicalizarRota } from '@/lib/analytics-rota-canonica';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { logger } from '@/lib/logger';
import { mensagemDeErro } from '@/lib/erro-mensagem';

/**
 * Ledger autenticado — o canal server-side para telemetria DECISÓRIA de jornada
 * que não muta o domínio.
 *
 * Por que existe: a telemetria client-side é CENSURADA por bloqueadores de
 * rastreador (PR #1984), e a censura correlaciona com perfil — quem bloqueia
 * tende a usar mais. Um evento que vai fundamentar decisão de produto não pode
 * nascer num cano que o navegador do usuário escolhe se entrega. Este caminho
 * escreve no Postgres (PostgREST), que a mesma medição mostrou entregando na
 * janela em que o PostHog estava mudo.
 *
 * ⚠️ É UM ledger, não 111 tabelas espelho. Interação puramente de UI
 * (`cmdk.opened`, `theme.changed`) continua no `track()` e assumidamente
 * censurável — a regra não é espelhar tudo, é que o sinal que DECIDE nasça
 * fora do cano censurável.
 *
 * ⚠️ Isto NÃO substitui o `track()`: é um segundo canal, com allowlist fechada
 * no banco. Chamar com um evento fora dela levanta 22023 do lado do Postgres.
 *
 * Spec: docs/superpowers/specs/2026-08-25-analytics-outbox-design.md
 */

/**
 * Eventos aceitos. Tem de casar com a allowlist da RPC
 * `analytics_ledger_registrar` — o banco é quem manda, este tipo só antecipa o
 * erro para o TypeScript.
 *
 * ⚠️ `servido`, não `visto`: o servidor prova que ENTREGOU a informação;
 * percepção humana ele não consegue provar, e um nome que afirma "visto" seria
 * uma garantia sem teste.
 */
export type EventoLedger =
  | 'carteira.mixgap_servido'
  /**
   * Uma rota canônica servida a um titular, UMA VEZ POR DIA (a janela de dedup
   * é da RPC). Responde "quais telas chegam a ser abertas" por um cano que o
   * navegador não escolhe entregar — a pergunta que o canal do PostHog não
   * consegue responder, medido em `docs/historico/proxy-posthog-reavaliado.md`.
   *
   * ⚠️ `servido`, não `visto`: prova que o app RENDERIZOU a rota. Aba aberta e
   * ignorada conta igual.
   */
  | 'navegacao.rota_servida';

/**
 * Registra um evento decisório no ledger server-side.
 *
 * FAIL-OPEN por desenho: telemetria nunca pode quebrar a tela de quem está
 * trabalhando. A perda não é silenciosa, porém — ela aparece no `logger`, e a
 * fila do lado do banco tem a view `analytics_outbox_reconciliacao`.
 */
export async function registrarNoLedger(
  evento: EventoLedger,
  chave: string,
  props: Record<string, unknown> = {},
): Promise<void> {
  // ⚠️ Gate na FONTE, não no client embrulhado: sob a lente "Ver como" o
  // `auth.uid()` continua sendo o do MASTER, então o evento sairia atribuído a
  // quem está auditando, não a quem usa. Isso infla adoção com a própria
  // atividade de inspeção — o erro que `fase-sem-sinal.md` documenta como o
  // tipo que faz um denominador mentir para cima.
  if (isLensActive()) return;

  try {
    // `as never`: os tipos de `src/integrations/supabase/types.ts` são gerados
    // pelo Lovable a partir do banco, e a migration desta RPC ainda é apply
    // MANUAL — até ela rodar, a função não existe nos tipos. Mesmo padrão de
    // `consolidar_demanda_sku` e `registrar_substituicao_sku`.
    const { error } = await supabase.rpc('analytics_ledger_registrar' as never, {
      p_evento: evento,
      p_chave: chave,
      p_props: props,
    } as never);
    if (error) {
      logger.warn('Ledger de analytics não registrou', {
        evento,
        error: error.message,
      });
    }
  } catch (e) {
    logger.warn('Ledger de analytics falhou', {
      evento,
      error: mensagemDeErro(e) ?? '(sem mensagem)',
    });
  }
}

/**
 * Rotas já registradas NESTA aba, por dia UTC. Não é a fonte da verdade do
 * dedup — essa é o `chave_dedup` da RPC, que sobrevive a recarga, a outra aba e
 * a outro aparelho. Isto aqui só evita a viagem de rede que o banco descartaria
 * com `ON CONFLICT DO NOTHING`, e evita a chamada dupla do StrictMode em dev.
 *
 * O dia entra na chave porque uma aba aberta atravessa a meia-noite UTC: sem
 * ele, a sessão longa deixaria de registrar a partir do 2º dia — o dedup local
 * calaria um sinal que o banco aceitaria.
 */
const rotasDaSessao = new Set<string>();

/**
 * Registra que uma rota foi servida ao titular logado.
 *
 * Recebe `pathname` — nunca `pathname + search`; ver `canonicalizarRota`.
 *
 * ⚠️ Marca a rota como enviada ANTES de saber se a RPC deu certo. É troca
 * deliberada: sem isso, uma falha de rede vira uma tentativa por navegação até
 * a aba fechar. O custo é perder o registro daquela rota naquele dia naquela
 * aba — e a mesma rota volta amanhã, ou em outra aba hoje.
 */
export async function registrarNavegacaoNoLedger(pathname: string): Promise<void> {
  // Mesmo gate da fonte que `registrarNoLedger` aplica — repetido aqui para não
  // queimar a marca de sessão sob a lente: sem isto, sair da lente na mesma aba
  // deixaria as rotas já visitadas mudas pelo resto do dia.
  if (isLensActive()) return;

  const rota = canonicalizarRota(pathname);
  const diaUtc = new Date().toISOString().slice(0, 10);
  const marca = `${diaUtc}|${rota}`;
  if (rotasDaSessao.has(marca)) return;
  rotasDaSessao.add(marca);

  await registrarNoLedger('navegacao.rota_servida', rota, { rota });
}
