import { supabase } from '@/integrations/supabase/client';
import { track, telemetriaAtiva } from '@/lib/analytics';
import { resolverBuildId } from '@/lib/build-id';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { logger } from '@/lib/logger';
import { mensagemDeErro } from '@/lib/erro-mensagem';

/**
 * Probe de CENSURA de telemetria — o par imune × censurável.
 *
 * O problema (medido, #1984): `us.i.posthog.com` está em EasyPrivacy/uBlock.
 * Cliente bloqueado e cliente que não usou produzem o MESMO zero no PostHog, e
 * nenhuma query sobre o PostHog separa os dois — o dado que faria a separação é
 * justamente o que não chega.
 *
 * A mitigação anterior (par `dashboard_visits` × evento, #1997) foi construída
 * num gatilho CEGO no #2010, e o #2016 registrou as duas falhas: "linha sem
 * evento" mede *captura client-side ausente* (SDK que não inicializou, `unload`,
 * offline, identidade divergente produzem o mesmo par), e `dashboard_visits` NÃO
 * TEM COLUNA DE APARELHO — então o pareamento só existe por USUÁRIO e um evento
 * vindo do celular "explica" uma visita bloqueada no desktop.
 *
 * O desenho aqui (ritual Codex, `docs/agent/analytics.md` §6) fecha as duas:
 *   1. um `attempt_id` aleatório por boot AUTENTICADO;
 *   2. gravado em `telemetria_probes` via PostgREST — domínio do app, imune à lista;
 *   3. emitido como propriedade de um evento PostHog — o lado censurável;
 *   4. reconciliado após atraso fixo (`scripts/probe-censura.sh`).
 *
 * O `attempt_id` EMBUTE o aparelho (`<device_id>.<uuid>`), e isso é o ponto: a
 * propriedade do evento carrega o eixo de aparelho sozinha, sem depender de
 * `identify()` — a sonda do #1984 não tinha perfil de pessoa e mesmo assim
 * precisaria ser distinguível.
 *
 * ⚠️ O que este probe NÃO prova: um `attempt_id` sem par não é censura. Fecho de
 * aba entre o INSERT e o flush do SDK produz o mesmo par. A conclusão exige DOIS
 * sem par em sessões DISTINTAS do MESMO aparelho — e é por isso que o
 * `device_id` é coluna, não detalhe.
 */

const DEVICE_ID_KEY = 'afiacao_telemetria_device_id';

/** Por que esta execução emitiu — ou desistiu. Mesmo idioma de `useLastVisit`. */
export type MotivoProbe =
  | 'emitido'
  | 'ja_emitido'
  | 'sem_usuario'
  | 'lente_ativa'
  | 'telemetria_desligada'
  | 'falha_tabela';

export interface ContextoDecisaoProbe {
  jaEmitido: boolean;
  telemetriaLigada: boolean;
  lenteAtiva: boolean;
  userId: string | null | undefined;
}

/**
 * Decisão PURA de emitir ou desistir — separada do IO para ser testável sem
 * browser, sem Supabase e sem PostHog.
 *
 * A ordem dos guards é significativa. `telemetria_desligada` vem ANTES de
 * `sem_usuario` porque é o falso positivo caro: em DEV a telemetria está
 * opt-out, e gravar a linha ali produziria "attempt_id sem par" em toda sessão
 * de desenvolvimento — o sensor fabricando o fenômeno que existe para medir.
 */
export function decidirProbe(ctx: ContextoDecisaoProbe): MotivoProbe | 'prosseguir' {
  if (ctx.jaEmitido) return 'ja_emitido';
  if (!ctx.telemetriaLigada) return 'telemetria_desligada';
  // A lente "ver como" embrulha o client do Supabase e barra INSERT. Desistir
  // aqui, explicitamente, evita que o guard vire `falha_tabela` — que a
  // reconciliação leria como problema de canal.
  if (ctx.lenteAtiva) return 'lente_ativa';
  if (!ctx.userId) return 'sem_usuario';
  return 'prosseguir';
}

/**
 * Identificador estável deste aparelho/navegador para telemetria.
 *
 * Chave própria (`afiacao_telemetria_device_id`) e NÃO o `pcp_device_id` de
 * `src/lib/pcp/device.ts`: aquele é do módulo PCP (fronteira de módulo) e vem
 * acoplado a um `device_seq` que ordena a FSM de apontamento. Compartilhar o
 * identificador acoplaria telemetria a chão de fábrica — limpar um quebraria o outro.
 */
function obterDeviceId(): string {
  if (typeof localStorage === 'undefined') return 'ssr';
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = gerarUuid();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/**
 * `<device_id>.<uuid>` — o aparelho viaja DENTRO da chave de junção.
 *
 * Sem isto, reconciliar exigiria que o PostHog tivesse o aparelho numa
 * propriedade à parte; com isto, um `attempt_id` órfão já se atribui a um
 * aparelho mesmo lido isolado, que é a condição de "duas sessões do MESMO
 * aparelho" ser verificável.
 */
export function gerarAttemptId(deviceId: string): string {
  return `${deviceId}.${gerarUuid()}`;
}

/** Extrai o aparelho de um `attempt_id`. O `.` separa; UUID não contém ponto. */
export function deviceIdDoAttempt(attemptId: string): string | null {
  const ponto = attemptId.indexOf('.');
  if (ponto <= 0 || ponto === attemptId.length - 1) return null;
  return attemptId.slice(0, ponto);
}

function gerarUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

let jaEmitidoNesteBoot = false;

/** Só para teste — o guard é de módulo porque o probe é 1× por boot, não por componente. */
export function _resetProbeParaTeste(): void {
  jaEmitidoNesteBoot = false;
}

/**
 * Executa o probe. Chamado uma vez por boot autenticado (`AnalyticsIdentify`).
 *
 * ⚠️ ORDEM: grava na tabela PRIMEIRO, emite o evento DEPOIS, e só se o INSERT
 * deu certo. É o desenho, não uma preferência — o lado imune registra a
 * INTENÇÃO e o lado censurável confirma a ENTREGA. Invertida, a ordem produz
 * evento sem linha quando o banco falha, que é ruído sem leitura possível.
 */
export async function executarProbeTelemetria(userId: string | null | undefined): Promise<MotivoProbe> {
  const motivo = decidirProbe({
    jaEmitido: jaEmitidoNesteBoot,
    telemetriaLigada: telemetriaAtiva(),
    lenteAtiva: isLensActive(),
    userId,
  });
  if (motivo !== 'prosseguir') return motivo;

  // Marca ANTES do await: duas montagens concorrentes do shell não podem
  // produzir dois probes para o mesmo boot (a reconciliação conta tentativas).
  jaEmitidoNesteBoot = true;

  const deviceId = obterDeviceId();
  const attemptId = gerarAttemptId(deviceId);
  const buildId = resolverBuildId();

  const { error } = await supabase.from('telemetria_probes').insert({
    attempt_id: attemptId,
    device_id: deviceId,
    user_id: userId as string,
    build_id: buildId,
  });

  if (error) {
    // Sem linha na tabela não há par a reconciliar; emitir o evento agora só
    // sujaria o lado censurável. Liberar o guard permite uma nova tentativa.
    jaEmitidoNesteBoot = false;
    logger.warn('Probe de telemetria não gravou na tabela', {
      error: mensagemDeErro(error) ?? '(sem mensagem)',
    });
    return 'falha_tabela';
  }

  track('telemetria.probe', { attempt_id: attemptId, device_id: deviceId });
  return 'emitido';
}
