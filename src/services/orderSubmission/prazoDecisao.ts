import { logger } from '@/lib/logger';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { classificarDecisao, dominaCalendario, parseCalendarioParcela, type FormaLegivel } from '@/lib/unified-order/prazo-sugestao';
import type { SubmitClient } from './types';

/**
 * Registro da decisão de prazo (Frente B, PR1): o que a tela mostrou/sugeriu para um cliente com
 * vencido e o que a vendedora fez, gravado pela RPC `venda_prazo_decisao_registrar` DEPOIS que o
 * envio àquela conta terminou — com o desfecho real (enviado, bloqueado, erro).
 *
 * FAIL-OPEN por desenho: auditoria/telemetria nunca desfaz nem segura a venda. A perda não é
 * silenciosa — vai ao `logger`. O servidor reconfere pedido↔conta↔cliente e relê o vencido;
 * aqui só se declara o que a UI viu.
 *
 * Achados do Codex adversarial (2026-10-31) honrados aqui: o registro NÃO fica na sequência entre
 * os envios (corre em paralelo e é esperado com TETO ao fim); `ja_enviado` (PV de uma tentativa
 * anterior) não registra — a condição daquela tentativa é desconhecida e a seleção atual não
 * preenche lacuna histórica; o desfecho sai dos erros do PRÓPRIO PV (divergência antes de "já
 * enviado"; ordem de produção não rebaixa um PV confirmado).
 */

export type ContaPedido = 'oben' | 'colacor';
export type DesfechoEnvio = 'enviado' | 'bloqueado_credito' | 'erro' | 'ja_enviado';

/** O que o aviso mostrou e o que a vendedora fez, congelado na tela até o envio. */
export interface PrazoDecisaoEstado {
  company: ContaPedido;
  codigo: number;
  nomeCliente: string | null;
  /** Condição selecionada quando a sugestão foi congelada (habitual do cliente ou a já escolhida). */
  parcelaHabitual: string;
  /** Código sugerido pela tela; `null` quando não houve sugestão (ver `motivoSistema`). */
  sugerida: string | null;
  /** Descrição da sugerida no momento do congelamento — valida que o código ainda significa o mesmo. */
  sugeridaDescricao: string | null;
  motivoSistema: string | null;
  /** A vendedora clicou em Aplicar/Manter (vs. ignorou o chip). */
  interagiu: boolean;
  /** Motivo escolhido ao Manter; `null` se não informou. */
  motivo: string | null;
}

export type PrazoDecisaoPorConta = Partial<Record<ContaPedido, PrazoDecisaoEstado>>;

/** Teto de espera pela auditoria ao FIM do envio (a venda já aconteceu; isto só não pode pendurar o retorno). */
const TETO_REGISTRO_MS = 6_000;

/**
 * Desfecho do PV da conta pelos erros NOVOS da tentativa: bloqueio de crédito > PV divergente >
 * erro do PRÓPRIO PV (sync/bloqueios da conta) > já enviado antes > enviado. Erro acessório
 * (ordem de produção) não muda o desfecho de um PV confirmado.
 */
export function desfechoDosErros(novosSteps: string[], alreadySent: boolean, conta: ContaPedido): DesfechoEnvio {
  if (novosSteps.includes(`bloqueio_credito_${conta}`)) return 'bloqueado_credito';
  if (novosSteps.includes(`pv_divergente_${conta}`)) return 'erro';
  const doPv = novosSteps.some((s) => s === `sync_${conta}_omie` || (s.startsWith('bloqueio_') && s.endsWith(`_${conta}`)));
  if (doPv) return 'erro';
  if (alreadySent) return 'ja_enviado';
  return 'enviado';
}

/** `escolhida` já antecipa pelo menos tanto quanto a sugerida (igual ou dominante) → conta como aceite. */
export function escolhidaCobreSugerida(formas: FormaLegivel[], escolhida: string, sugerida: string | null): boolean {
  if (sugerida === null) return false;
  if (escolhida === sugerida) return true;
  const ce = parseCalendarioParcela(formas.find((f) => f.codigo === escolhida)?.descricao);
  const cs = parseCalendarioParcela(formas.find((f) => f.codigo === sugerida)?.descricao);
  return !!ce && !!cs && dominaCalendario(ce, cs);
}

/** A sugestão congelada ainda vale na lista vigente (mesmo código e MESMA descrição). */
export function sugestaoAindaVale(formas: FormaLegivel[], estado: PrazoDecisaoEstado): boolean {
  if (estado.sugerida === null) return true;
  const f = formas.find((x) => x.codigo === estado.sugerida);
  return !!f && (estado.sugeridaDescricao === null || f.descricao === estado.sugeridaDescricao);
}

export async function registrarDecisaoPrazo(
  supabase: SubmitClient,
  input: { estado: PrazoDecisaoEstado; salesOrderId: string; parcelaEscolhida: string; desfecho: DesfechoEnvio; formas: FormaLegivel[] },
): Promise<void> {
  // Sob a lente "Ver como" quem grava seria o MASTER — a decisão sairia atribuída a quem audita.
  if (isLensActive()) return;
  // Testes do submit usam um client parcial sem `rpc`: registro é acessório, nunca derruba o envio.
  if (typeof (supabase as { rpc?: unknown }).rpc !== 'function') return;
  const { estado, salesOrderId, parcelaEscolhida, desfecho, formas } = input;
  if (desfecho === 'ja_enviado') {
    logger.info('Decisão de prazo não registrada: PV já estava no Omie (condição da tentativa original desconhecida)', {
      stage: 'prazo_decisao', account: estado.company, salesOrderId,
    });
    return;
  }
  // Formas recarregadas com outro significado para o código sugerido ⇒ a oferta expirou: sem sugestão.
  const valida = sugestaoAindaVale(formas, estado);
  const sugerida = valida ? estado.sugerida : null;
  const motivoSistema = valida ? estado.motivoSistema : 'formas_mudaram';
  const { decisao, motivo } = classificarDecisao({
    sugerida,
    escolhida: parcelaEscolhida,
    interagiu: estado.interagiu,
    motivo: estado.motivo,
    escolhidaCobre: sugerida !== null && escolhidaCobreSugerida(formas, parcelaEscolhida, sugerida),
  });
  try {
    const { error } = await supabase.rpc('venda_prazo_decisao_registrar', {
      p: {
        sales_order_id: salesOrderId,
        company: estado.company,
        omie_codigo_cliente: estado.codigo,
        nome_cliente: estado.nomeCliente,
        parcela_habitual: estado.parcelaHabitual,
        parcela_sugerida: sugerida,
        parcela_escolhida: parcelaEscolhida,
        escolhida_cobre: decisao === 'aceitou' && parcelaEscolhida !== sugerida,
        decisao,
        motivo,
        motivo_sistema: motivoSistema,
        desfecho_envio: desfecho,
      },
    });
    if (error) {
      logger.warn('Decisão de prazo não registrada', { stage: 'prazo_decisao', account: estado.company, salesOrderId, error: error.message });
    }
  } catch (e: unknown) {
    logger.warn('Decisão de prazo falhou', { stage: 'prazo_decisao', account: estado.company, salesOrderId, error: e });
  }
}

/** Espera o lote de registros com TETO: o retorno do envio nunca fica pendurado na auditoria. */
export async function aguardarRegistrosComTeto(pendentes: Promise<void>[], tetoMs = TETO_REGISTRO_MS): Promise<void> {
  if (pendentes.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const teto = new Promise<'teto'>((resolve) => { timer = setTimeout(() => resolve('teto'), tetoMs); });
  const r = await Promise.race([Promise.allSettled(pendentes).then(() => 'ok' as const), teto]);
  if (timer) clearTimeout(timer);
  if (r === 'teto') logger.warn('Decisão de prazo: registro ainda pendente ao fim do envio (teto atingido)', { stage: 'prazo_decisao', tetoMs });
}
