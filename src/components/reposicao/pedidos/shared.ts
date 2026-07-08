import { format } from 'date-fns';
import type { StatusEnvioPortal } from './types';

export function getEstoqueZoneClass(estoque: number, minimo: number, pp: number): string {
  if (estoque < minimo) return 'text-status-error font-semibold';
  if (estoque <= pp) return 'text-status-warning font-semibold';
  return 'text-status-success';
}

export const EMPRESA = 'OBEN';

export const statusMeta: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; className?: string }> = {
  pendente_aprovacao: { label: 'Pendente', variant: 'secondary', className: 'bg-status-warning/15 text-status-warning border-status-warning/30' },
  aprovado_aguardando_disparo: { label: 'Aprovado', variant: 'secondary', className: 'bg-status-info/15 text-status-info border-status-info/30' },
  bloqueado_guardrail: { label: 'Bloqueado', variant: 'destructive' },
  disparado: { label: 'Disparado', variant: 'secondary', className: 'bg-status-success/15 text-status-success border-status-success/30' },
  disparado_simulado: { label: 'Disparo simulado', variant: 'secondary', className: 'bg-muted text-muted-foreground border-border' },
  falha_envio: { label: 'Falha no envio', variant: 'destructive' },
  cancelado: { label: 'Cancelado', variant: 'outline' },
  cancelado_humano: { label: 'Cancelado (vazio)', variant: 'outline' },
  expirado_sem_aprovacao: { label: 'Expirado sem aprovação', variant: 'secondary', className: 'bg-muted text-muted-foreground border-border' },
  // PR5: pedido pai de um split — não tem mais itens próprios, foi dividido em filhos.
  split_em_filhos: { label: 'Dividido', variant: 'secondary', className: 'bg-status-purple-bg text-status-purple-foreground border-status-purple/30' },
};

export function formatBRL(v: number | null | undefined) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v ?? 0));
}

export function formatTime(iso: string | null) {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'HH:mm');
  } catch {
    return '—';
  }
}

/* ─── Feedback do disparo (compartilhado entre o botão "Disparar" e o "Aprovar e disparar") ─── */
export interface RespostaDisparo {
  disparados?: number | null;
  falhas?: number | null;
  aguardando_portal_sayerlack?: number | null;
}

// Traduz a resposta da edge disparar-pedidos-aprovados num toast.
// O disparo do portal Sayerlack é assíncrono (202 + processamento em background):
// nesse caso a mensagem diz "iniciado", NUNCA "enviado" — o terminal (sucesso/falha)
// aparece na linha do pedido, que atualiza sozinha.
export function interpretarRespostaDisparo(
  data: RespostaDisparo | null | undefined,
  pedidoId: number,
): { tone: 'success' | 'error' | 'info'; message: string } {
  const ok = data?.disparados ?? 0;
  const fail = data?.falhas ?? 0;
  const aguardandoPortal = data?.aguardando_portal_sayerlack ?? 0;
  if (ok > 0) {
    return { tone: 'success', message: `Pedido #${pedidoId} disparado e registrado no Omie` };
  }
  if (aguardandoPortal > 0) {
    return { tone: 'success', message: `Pedido #${pedidoId}: envio ao portal Sayerlack iniciado — acompanhe o status na lista (atualiza sozinho)` };
  }
  if (fail > 0) {
    return { tone: 'error', message: `Pedido #${pedidoId}: falha ao disparar` };
  }
  return { tone: 'info', message: `Pedido #${pedidoId}: nada a disparar` };
}

/* ─── Frescor do snapshot de estoque + feedback do sync manual ─── */
//
// O motor de sugestões lê sku_estoque_atual (snapshot alimentado pela edge
// omie-sync-estoque, cron diário 06:00 BRT + intraday 2h). "Recalcular sugestões"
// NÃO roda esse sync — e quando ele para, a tela mostra estoque velho sem nenhum
// aviso (incidente de 2 dias, jul/2026). O badge torna a idade do snapshot visível
// e o botão "Sincronizar estoque" destrava sem esperar a próxima janela do cron.
//
// Régua do tone: intraday roda a cada 2h (06:40–16:40 BRT) → >4h = duas janelas
// perdidas (warning; inclui a madrugada — honesto, o dado ESTÁ velho e o diário
// 06:00 BRT o renova antes do corte 07:00); >24h = até o diário falhou (error).

export type FrescorTone = 'ok' | 'warning' | 'error';

export function frescorEstoque(
  ultimaSync: string | null | undefined,
  agora: Date,
): { tone: FrescorTone; label: string } {
  const ts = ultimaSync ? new Date(ultimaSync).getTime() : NaN;
  if (Number.isNaN(ts)) return { tone: 'error', label: 'estoque nunca sincronizado' };

  const horas = (agora.getTime() - ts) / 3_600_000;
  const tone: FrescorTone = horas > 24 ? 'error' : horas > 4 ? 'warning' : 'ok';
  const dias = Math.floor(horas / 24);
  const label =
    dias >= 1
      ? `sincronizado há ${dias} dia${dias > 1 ? 's' : ''}`
      : horas < 1
        ? 'sincronizado há menos de 1h'
        : `sincronizado há ${Math.floor(horas)}h`;
  return { tone, label };
}

// Uma edge de sync (omie-sync-estoque / omie-sync-status-produtos), chamada via
// supabase.functions.invoke dentro de Promise.allSettled, só conta como sucesso se o invoke NÃO
// falhou (rede/HTTP) E o corpo trouxe {ok:true}. HTTP 200 com {ok:false}/{error} é falha LÓGICA da
// edge — não pode virar sucesso, senão o toast mente ("sincronizado" quando não foi).
export function edgeSyncOk(
  settled: { status: 'fulfilled' | 'rejected'; value?: { data?: unknown; error?: unknown } | null },
): boolean {
  if (settled.status !== 'fulfilled' || !settled.value) return false;
  if (settled.value.error) return false;
  return (settled.value.data as { ok?: boolean } | null)?.ok === true;
}

// Botão "Sincronizar e recalcular": dispara SALDO (omie-sync-estoque) + STATUS ativo/inativo
// (omie-sync-status-produtos) em paralelo e, SÓ SE ambas deram certo, recalcula o ciclo. Se uma
// sync falhar, NÃO recalcula (regenerar com saldo/status velho geraria pedido errado = money-path)
// — o usuário reexecuta ou usa "Recalcular sugestões" à parte. `recalc` = null quando não recalculou.
export function resumoSyncRecalc(
  estoqueOk: boolean,
  statusOk: boolean,
  recalc: { ok: boolean; pedidos: number; erro?: string } | null,
): { tone: 'success' | 'warning' | 'error'; message: string } {
  if (!estoqueOk && !statusOk) {
    return { tone: 'error', message: 'Falha ao sincronizar estoque e status do Omie. Não recalculei — tente novamente.' };
  }
  if (!estoqueOk) {
    return { tone: 'warning', message: 'Status sincronizado, mas o estoque do Omie falhou. Não recalculei — tente novamente.' };
  }
  if (!statusOk) {
    return { tone: 'warning', message: 'Estoque sincronizado, mas o status do Omie falhou. Não recalculei — tente novamente.' };
  }
  if (!recalc || !recalc.ok) {
    // Preserva o motivo da RPC (lock/permissão/timeout/bug) — não achatar num genérico (Codex).
    const detalhe = recalc?.erro ? ` (${recalc.erro})` : '';
    return { tone: 'warning', message: `Omie sincronizado, mas o recálculo das sugestões falhou${detalhe}. Use "Recalcular sugestões".` };
  }
  const n = recalc.pedidos;
  return {
    tone: 'success',
    message: `Omie sincronizado e sugestões recalculadas (${n} ${n === 1 ? 'pedido' : 'pedidos'}). Confira os itens antes de aprovar.`,
  };
}

/* ─── Conciliação inline (Fase 3 · 3b) ─── */
//
// O pedido cai num estado de conciliação quando o disparo ao portal Sayerlack termina
// AMBÍGUO. Dois estados, com risco DIFERENTE de PO duplicado no fornecedor:
//
//  - aceito_portal_sem_protocolo → o portal aceitou mas não devolveu o número.
//    O pedido quase-certamente JÁ EXISTE no fornecedor; conciliar (só registrar o
//    protocolo) é de baixo risco.
//  - indeterminado_requer_conciliacao → AMBÍGUO; o pedido pode ou NÃO existir no
//    portal. Conciliar às cegas pode duplicar → exige conferir no portal ANTES.
//
// Estados de erro genuíno (no fluxo portal-first o portal falhou ANTES de obter
// protocolo, então NÃO há PO no fornecedor) → reenviar é seguro (retry de verdade).
// Estados de sucesso / em-trânsito → reenviar duplicaria; não oferecer reset.

export type AcaoPortal =
  | { kind: 'conciliar'; warn: boolean } // warn=true → avisar risco de duplicar antes de conciliar
  | { kind: 'reenviar' } // erro genuíno sem PO criado → retry seguro
  | { kind: 'nenhuma' }; // sucesso / em-trânsito / nao_aplicavel → nenhuma ação destrutiva

const STATUS_CONCILIAVEIS_FRONT: ReadonlySet<StatusEnvioPortal> = new Set<StatusEnvioPortal>([
  'aceito_portal_sem_protocolo',
  'indeterminado_requer_conciliacao',
]);

// Erros genuínos onde (no fluxo portal-first) NÃO há PO no fornecedor → reset seguro.
const STATUS_REENVIO_SEGURO_FRONT: ReadonlySet<StatusEnvioPortal> = new Set<StatusEnvioPortal>([
  'erro_retentavel',
  'falha_envio_portal',
  'erro_nao_retentavel',
]);

// Decide a ação disponível no PortalDrawer p/ um status de envio ao portal.
// indeterminado_requer_conciliacao → conciliar com AVISO (risco de duplicar).
// aceito_portal_sem_protocolo → conciliar sem aviso (PO quase-certamente já existe).
export function decidirAcaoPortal(status: StatusEnvioPortal | null | undefined): AcaoPortal {
  const s = (status ?? 'nao_aplicavel') as StatusEnvioPortal;
  if (STATUS_CONCILIAVEIS_FRONT.has(s)) {
    return { kind: 'conciliar', warn: s === 'indeterminado_requer_conciliacao' };
  }
  if (STATUS_REENVIO_SEGURO_FRONT.has(s)) {
    return { kind: 'reenviar' };
  }
  return { kind: 'nenhuma' };
}

/* ─── "Precisa de atenção" — fila cross-ciclo (Fase 3 · 3c) ─── */
//
// Pedidos que EXIGEM ação humana, em QUALQUER ciclo (a lista "ciclo de hoje" não
// pega pedido travado de ciclo passado). Dois grupos:
//
//  - status='falha_envio' → o disparo ao Omie falhou (motivo em resposta_canal.erro).
//    Precisa re-disparar ou corrigir (ex.: SKU sem custo).
//  - status_envio_portal em {aceito_portal_sem_protocolo, indeterminado_requer_conciliacao,
//    falha_envio_portal, erro_nao_retentavel} → conciliação (PO pode existir no
//    fornecedor) + falhas duras do portal (definitiva / sem retry automático).
//
// NÃO inclui pendente_envio_portal/enviando_portal (drenados pelo motor de retry +
// já vigiados pelo Sentinela — incluí-los falsearia pedido em voo) nem erro_retentavel
// (o motor sayerlack-retry-orfaos re-tenta sozinho).
export const STATUS_PORTAL_PRECISA_ATENCAO: ReadonlySet<StatusEnvioPortal> = new Set<StatusEnvioPortal>([
  'aceito_portal_sem_protocolo',
  'indeterminado_requer_conciliacao',
  'falha_envio_portal',
  'erro_nao_retentavel',
]);

// Predicado puro: o pedido precisa de ação humana? (usado pela fila cross-ciclo da
// tela de pedidos — o chip "⚠ N precisam de atenção").
export function pedidoPrecisaAtencao(p: {
  status: string;
  status_envio_portal: StatusEnvioPortal | null | undefined;
}): boolean {
  if (p.status === 'falha_envio') return true;
  return STATUS_PORTAL_PRECISA_ATENCAO.has((p.status_envio_portal ?? 'nao_aplicavel') as StatusEnvioPortal);
}

/* ─── Override do gate de mínimo de faturamento Sayerlack ─── */
//
// O gate [GATE-MIN-FATURAMENTO] da edge marca falha_envio + resposta_canal.gate=
// 'minimo_faturamento' quando um pedido Sayerlack fica abaixo da régua (R$3k = mínimo de
// faturamento do fornecedor; abaixo disso ele não fatura, o pedido fica parado lá). O botão
// "Re-disparar" re-bate no gate → loop sem saída. A exceção é o override consciente por
// pedido ("Disparar mesmo assim"), só pra gestor/master.
//
// Este predicado detecta SÓ esse estado: falha_envio cuja causa É o gate. Uma falha_envio
// por OUTRO motivo (SKU sem custo, qtde 0, erro do Omie) NÃO casa — oferecer override ali
// seria inútil (não há régua a pular) e mascararia o erro real.
export function ehGateMinimoFaturamento(p: {
  status: string;
  resposta_canal: { gate?: unknown; [key: string]: unknown } | null | undefined;
}): boolean {
  return p.status === 'falha_envio' && p.resposta_canal?.gate === 'minimo_faturamento';
}

/* ─── Partição da fila de atenção: ação real × barrado por mínimo (A′) ─── */
//
// A fila "precisa de atenção" mistura dois animais com risco money-path MUITO
// diferente:
//  - BENIGNO: falha_envio por gate de mínimo de faturamento Sayerlack (fornecedor
//    não fatura < R$3k). O pedido NÃO foi comprado e o motor re-sugere o SKU no
//    ciclo seguinte se ele seguir abaixo do ponto (ou o estoque normaliza). Não há
//    risco de compra-dupla — só de stockout silencioso. Vira RUÍDO vermelho que
//    acumula (o gate não dedup) e gera fadiga de alerta.
//  - AÇÃO REAL: conciliação de PO (aceito_portal_sem_protocolo / requer_conciliacao
//    — o pedido PODE já existir no fornecedor), falhas duras do portal, e qualquer
//    OUTRO falha_envio (SKU sem custo, qtde 0, erro do Omie).
//
// ⚠️ PORTAL VENCE SEMPRE (Codex xhigh, money-path): um pedido pode ser gate-mínimo
// E TAMBÉM estar em conciliação de portal. Recolhê-lo no balde benigno esconderia
// risco de comprar 2× no fornecedor. Só é benigno quem é gate-mínimo E não tem
// NENHUM status_envio_portal de atenção.
export function ehAbaixoMinimoBenigno(p: {
  status: string;
  status_envio_portal: StatusEnvioPortal | null | undefined;
  resposta_canal: { gate?: unknown; [key: string]: unknown } | null | undefined;
}): boolean {
  return (
    ehGateMinimoFaturamento(p) &&
    !STATUS_PORTAL_PRECISA_ATENCAO.has((p.status_envio_portal ?? 'nao_aplicavel') as StatusEnvioPortal)
  );
}

// Particiona a fila (JÁ filtrada por pedidoPrecisaAtencao na query) em:
//  - vermelha: exige ação humana AGORA (alarme no topo conta ISTO).
//  - abaixoMinimo: barrado por mínimo do fornecedor, benigno (seção neutra recolhida).
// Nada some — a soma das duas é a lista de entrada.
export function particionarAtencao<T extends {
  status: string;
  status_envio_portal: StatusEnvioPortal | null | undefined;
  resposta_canal: { gate?: unknown; [key: string]: unknown } | null | undefined;
}>(lista: readonly T[]): { vermelha: T[]; abaixoMinimo: T[] } {
  const vermelha: T[] = [];
  const abaixoMinimo: T[] = [];
  for (const p of lista) (ehAbaixoMinimoBenigno(p) ? abaixoMinimo : vermelha).push(p);
  return { vermelha, abaixoMinimo };
}

/* ─── Split (PR5) — esconder o pai da lista ─── */
//
// Quando um pedido grande é dividido em chunks, o PAI vira status='split_em_filhos':
// não tem mais itens próprios nem ação útil, e seu valor_total é a SOMA dos filhos.
// Exibir o pai E os N filhos dobra o "valor do ciclo" e polui a lista. Os FILHOS
// (status normal, com os itens reais + split_lote/split_total) é que ficam visíveis.
//
// Predicados PUROS (a página filtra a lista renderizada E os totais com eles).
export function ehPaiSplit(p: { status: string }): boolean {
  return p.status === 'split_em_filhos';
}

// Remove os pais de split de uma lista (mantém os filhos). Usar tanto pro render
// quanto pro cálculo de valor/contagem do ciclo — consistente em todo lugar.
export function pedidosVisiveis<T extends { status: string }>(lista: readonly T[]): T[] {
  return lista.filter((p) => !ehPaiSplit(p));
}

/* ─── Partição do ciclo de hoje: ativos × terminais ─── */
//
// A geração só apaga 'pendente_aprovacao'; o que já virou terminal (cancelado pelo
// humano, cancelado vazio, ou expirado por falta de aprovação) fica como fantasma no
// ciclo de hoje. A lista principal mostra só os ATIVOS; os terminais vão pro
// "Histórico de hoje" recolhido. Pura organização de UI — nada some do banco.
export const STATUS_TERMINAIS_CICLO: ReadonlySet<string> = new Set([
  'cancelado',
  'cancelado_humano',
  'expirado_sem_aprovacao',
]);

export function ehTerminalCiclo(p: { status: string }): boolean {
  return STATUS_TERMINAIS_CICLO.has(p.status);
}

// Particiona a lista do ciclo (JÁ sem pais de split — chamar sobre pedidosVisiveis)
// em ativos (lista principal) e historico (terminais, recolhido). Ordem preservada.
export function particionarCicloHoje<T extends { status: string }>(
  lista: readonly T[],
): { ativos: T[]; historico: T[] } {
  const ativos: T[] = [];
  const historico: T[] = [];
  for (const p of lista) (ehTerminalCiclo(p) ? historico : ativos).push(p);
  return { ativos, historico };
}

/* ─── Portal B2B status meta ─── */
export const portalStatusMeta: Record<StatusEnvioPortal, { label: string; className: string }> = {
  nao_aplicavel: { label: '—', className: 'bg-muted text-muted-foreground border-border' },
  pendente_envio_portal: { label: 'Aguardando envio', className: 'bg-status-info/15 text-status-info border-status-info/30' },
  enviando_portal: { label: 'Enviando…', className: 'bg-status-info/20 text-status-info border-status-info/40 animate-pulse' },
  erro_retentavel: { label: 'Retentável', className: 'bg-status-info/15 text-status-info border-status-info/30' },
  enviado_portal: { label: '✓ Enviado', className: 'bg-status-success/15 text-status-success border-status-success/30' },
  sucesso_portal: { label: '✓ Enviado', className: 'bg-status-success/15 text-status-success border-status-success/30' },
  aceito_portal_sem_protocolo: { label: 'Sem protocolo', className: 'bg-status-warning/15 text-status-warning border-status-warning/30' },
  indeterminado_requer_conciliacao: { label: 'Requer conciliação', className: 'bg-status-warning/15 text-status-warning border-status-warning/30' },
  falha_envio_portal: { label: 'Falha', className: 'bg-destructive/15 text-destructive border-destructive/30' },
  erro_nao_retentavel: { label: 'Falha definitiva', className: 'bg-destructive/15 text-destructive border-destructive/30' },
};
