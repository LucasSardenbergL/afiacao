// src/lib/fila/critica/montar.ts
import type { CriticaInput, CriticaCfg, DetectResult, SinalVoz, EvidencePack, Contradicao } from './types';
import { CRITICA_CFG_DEFAULT } from './types';

// ── helpers ──────────────────────────────────────────────────────────
const num = (v: number | null | undefined): number | null =>
  v != null && Number.isFinite(v) ? v : null;
const pct = (p: number): string => `${Math.round(p * 100)}%`;
const brl = (v: number): string => Math.round(v).toLocaleString('pt-BR');
const fonteMetrica = (id: string) => ({ tabela: 'customer_metrics_mv', id, observadoEm: null });

// ── 1. recorrente_sumiu (order-delta) ────────────────────────────────
export function detectRecorrenteSumiu(input: CriticaInput, cfg: CriticaCfg): DetectResult {
  const m = input.metrica;
  if (m == null || m.isColdStart) return { sinais: [], contradicao: null };

  const intervalo = num(m.intervaloMedioDias);
  const atraso = num(m.atrasoRelativo);
  const dias = num(m.diasDesdeUltimaCompra);
  const fat = num(m.faturamento90d);
  const prev = num(m.faturamentoPrev90d);

  const ev: SinalVoz[] = [];
  if (intervalo != null && atraso != null && atraso >= cfg.atrasoRelativoMin) {
    const txtDias = dias != null ? `${dias}d sem comprar` : 'atrasado';
    ev.push({
      tipo: 'order_delta',
      texto: `Comprava a cada ${Math.round(intervalo)}d; ${txtDias} (${atraso.toFixed(1)}× o intervalo)`,
      fonte: fonteMetrica(input.clienteUserId),
      severidade: 'critico',
    });
  }
  if (prev != null && prev > 0 && fat != null && fat < prev * cfg.quedaFatPct) {
    const queda = 1 - fat / prev;
    ev.push({
      tipo: 'order_delta',
      texto: `Faturamento caiu ${pct(queda)} (R$ ${brl(fat)} vs R$ ${brl(prev)})`,
      fonte: fonteMetrica(input.clienteUserId),
      severidade: 'critico',
    });
  }
  if (ev.length === 0) return { sinais: [], contradicao: null };
  return {
    sinais: ev,
    contradicao: { chave: 'recorrente_sumiu', texto: 'Cliente recorrente parou/caiu', evidencias: ev, confianca: 'alta' },
  };
}

// ── 2. sem_resposta_repetido (rota) ──────────────────────────────────
export function detectSemResposta(input: CriticaInput, cfg: CriticaCfg): DetectResult {
  const r = input.rota;
  if (r == null || r.semRespostaRecenteN < cfg.semRespostaMin) return { sinais: [], contradicao: null };
  const ev: SinalVoz = {
    tipo: 'rota_outcome',
    texto: `${r.semRespostaRecenteN} tentativas de contato sem resposta`,
    fonte: { tabela: 'route_contact_log', id: input.clienteUserId, observadoEm: null },
    severidade: 'atencao',
  };
  return { sinais: [ev], contradicao: { chave: 'sem_resposta_repetido', texto: 'Sem resposta repetida', evidencias: [ev], confianca: 'alta' } };
}

// ── 3. tarefa_feita_sem_prova (escada de certeza) ────────────────────
export function detectTarefaSemProva(input: CriticaInput, _cfg: CriticaCfg): DetectResult {
  const t = input.tarefa;
  if (t == null || !t.temSugestaoPendente) return { sinais: [], contradicao: null };
  const ev: SinalVoz = {
    tipo: 'tarefa_estado',
    texto: `Tarefa "${t.descricao}" tem indício de cumprida, sem prova confirmada${t.atrasada ? ' (atrasada)' : ''}`,
    fonte: { tabela: 'v_tarefas_estado', id: input.clienteUserId, observadoEm: null },
    severidade: t.atrasada ? 'critico' : 'atencao',
  };
  return { sinais: [ev], contradicao: { chave: 'tarefa_feita_sem_prova', texto: 'Tarefa com indício sem prova', evidencias: [ev], confianca: 'media' } };
}

// ── 4. alto_valor_fora_rota (cruzamento) ─────────────────────────────
// Suprimido pelo composer se recorrente_sumiu já disparou (evita badge duplo).
export function detectAltoValorForaRota(input: CriticaInput, cfg: CriticaCfg): DetectResult {
  const m = input.metrica;
  const r = input.rota;
  if (m == null || m.isColdStart || r == null) return { sinais: [], contradicao: null };
  const fat = num(m.faturamento90d);
  const dias = num(m.diasDesdeUltimaCompra);
  if (fat == null || dias == null) return { sinais: [], contradicao: null };
  if (fat < cfg.altoValorFat90dMin || dias < cfg.altoValorDiasQuietoMin || r.naCallQueue) {
    return { sinais: [], contradicao: null };
  }
  const ev: SinalVoz = {
    tipo: 'order_delta',
    texto: `Alto valor (R$ ${brl(fat)}/90d), ${dias}d sem comprar e fora da sua lista de ligação`,
    fonte: fonteMetrica(input.clienteUserId),
    severidade: 'atencao',
  };
  return { sinais: [ev], contradicao: { chave: 'alto_valor_fora_rota', texto: 'Alto valor quieto, fora da lista de ligação', evidencias: [ev], confianca: 'media' } };
}

// ── composer ─────────────────────────────────────────────────────────
export function montarEvidencePack(input: CriticaInput, cfg: CriticaCfg = CRITICA_CFG_DEFAULT): EvidencePack {
  const faltaDado: string[] = [];
  if (input.metrica == null) faltaDado.push('Sem métricas de compra deste cliente.');
  else if (input.metrica.isColdStart) faltaDado.push('Cliente novo, sem histórico de compra.');
  if (input.rota == null) faltaDado.push('Sinais de rota indisponíveis (cadência não lida).');

  const resultados = [
    detectRecorrenteSumiu(input, cfg),
    detectSemResposta(input, cfg),
    detectTarefaSemProva(input, cfg),
    detectAltoValorForaRota(input, cfg),
  ];

  const sinais: SinalVoz[] = [];
  let contradicoes: Contradicao[] = [];
  for (const r of resultados) {
    sinais.push(...r.sinais);
    if (r.contradicao && r.contradicao.evidencias.length > 0) contradicoes.push(r.contradicao);
  }

  // suprime alto_valor_fora_rota se recorrente_sumiu já cobre o mesmo cliente
  if (contradicoes.some(c => c.chave === 'recorrente_sumiu')) {
    contradicoes = contradicoes.filter(c => c.chave !== 'alto_valor_fora_rota');
  }

  return { clienteUserId: input.clienteUserId, clienteNome: input.clienteNome, sinais, contradicoes, faltaDado };
}
