// src/lib/gestor/excecoes/montar.ts
import type {
  ExcecoesInput, ExcecoesCfg, ConsoleExcecoes, LinhaExcecao, GrupoExcecao,
  DecisaoRiscoInput, SaudeCheckInput, TarefaGapInput, FrescorCarteira,
} from './types';
import { EXCECOES_CFG_DEFAULT } from './types';

const num = (v: number | null | undefined): number | null =>
  v != null && Number.isFinite(v) ? v : null;

/** Horas inteiras entre dois ISO (agora − ref). null/inválido → null. */
export function idadeHoras(refIso: string | null, agoraIso: string): number | null {
  if (!refIso) return null;
  const t = Date.parse(refIso), a = Date.parse(agoraIso);
  if (!Number.isFinite(t) || !Number.isFinite(a)) return null;
  return Math.floor((a - t) / 3_600_000);
}

/** Escada de frescor da carteira (ai_decisions). Sem dado → desatualizada. */
export function frescorCarteira(maxCreatedAtIso: string | null, agoraIso: string, cfg: ExcecoesCfg): FrescorCarteira {
  const h = idadeHoras(maxCreatedAtIso, agoraIso);
  if (h == null) return 'desatualizada';
  if (h < cfg.staleHoras) return 'fresh';
  if (h < cfg.desatualizadaHoras) return 'stale';
  return 'desatualizada';
}

/** "há Xh" até 48h; "há Nd" acima. null → null. */
export function frescorTexto(horas: number | null): string | null {
  if (horas == null) return null;
  if (horas < 48) return `há ${horas}h`;
  return `há ${Math.floor(horas / 24)}d`;
}

// ── grupo 3: confirmações pendentes (proof-gap; NUNCA "enganando") ────
export function detectarConfirmacoesPendentes(
  tarefas: TarefaGapInput[], hojeSp: string, cfg: ExcecoesCfg,
): LinhaExcecao[] {
  // vencida em dia ANTERIOR a hoje (>=1 dia de atraso); mais antiga primeiro.
  const vencidas = tarefas
    .filter(t => t.effectiveDue < hojeSp)
    .sort((a, b) => a.effectiveDue.localeCompare(b.effectiveDue))
    .slice(0, cfg.capTarefas);
  return vencidas.map((t): LinhaExcecao => ({
    id: `conf:${t.tarefaId}`,
    grupo: 'confirmacoes_pendentes',
    titulo: `Tarefa atrasada com indício não resolvido: "${t.descricao}"`,
    detalhe: 'Vale confirmar ou rejeitar.',
    donoNome: t.donoNome,
    severidade: 'aviso',
    reciboFonte: 'v_tarefas_estado',
    reciboFrescor: null,
    acao: { tipo: 'tarefa', tarefaId: t.tarefaId, clienteUserId: t.clienteUserId, candidatoId: t.candidatoId },
    badges: [],
  }));
}

// ── grupo 2: clientes em risco (ai_decisions, freshness-first) ────────
// Predicado de risco reusa o useAiOps (atraso>=2 OU queda de faturamento >50%),
// apertado com confidence != 'baixa'.
function ehRisco(d: DecisaoRiscoInput): boolean {
  if (d.confidence === 'baixa') return false;
  const atraso = num(d.atrasoRelativo) ?? 0;
  const fat = num(d.faturamento90d) ?? 0;
  const prev = num(d.faturamentoPrev90d) ?? 0;
  return atraso >= 2.0 || (prev > 0 && fat < prev * 0.5);
}

export function detectarClientesRisco(
  decisoes: DecisaoRiscoInput[], maxCreatedAtIso: string | null, agoraIso: string, cfg: ExcecoesCfg,
): LinhaExcecao[] {
  if (decisoes.length === 0) return [];
  const frescor = frescorCarteira(maxCreatedAtIso, agoraIso, cfg);

  if (frescor === 'desatualizada') {
    return [{
      id: 'risco:meta_desatualizada',
      grupo: 'clientes_risco',
      titulo: 'Análise de carteira desatualizada',
      detalhe: 'Rode a análise para ver os clientes em risco do time.',
      donoNome: null,
      severidade: 'aviso',
      reciboFonte: 'ai_decisions',
      reciboFrescor: frescorTexto(idadeHoras(maxCreatedAtIso, agoraIso)),
      acao: { tipo: 'rodar_agente' },
      badges: [],
    }];
  }

  const selo = frescor === 'stale' ? frescorTexto(idadeHoras(maxCreatedAtIso, agoraIso)) : null;
  return decisoes.filter(ehRisco).slice(0, cfg.capClientes).map((d): LinhaExcecao => ({
    id: `risco:${d.clienteUserId}`,
    grupo: 'clientes_risco',
    titulo: d.clienteNome ?? 'Cliente sem nome',
    detalhe: d.primaryReason,
    donoNome: d.donoNome,
    severidade: 'critico',
    reciboFonte: 'ai_decisions',
    reciboFrescor: selo,
    acao: { tipo: 'abrir_cliente', clienteUserId: d.clienteUserId },
    badges: [],
  }));
}

// ── grupo 1: dados quebrados (Sentinela) ─────────────────────────────
export function detectarDadosQuebrados(saude: SaudeCheckInput[], cfg: ExcecoesCfg): LinhaExcecao[] {
  const naoOk = saude.filter(s => s.status !== 'ok');
  const criticos = naoOk.filter(s => s.severity === 'critical');
  const avisos = naoOk.filter(s => s.severity === 'warning').slice(0, cfg.capWarnSaude);
  const escolhidos = [...criticos, ...avisos];
  return escolhidos.map((s): LinhaExcecao => ({
    id: `saude:${s.source}`,
    grupo: 'dados_quebrados',
    titulo: s.message,
    detalhe: s.domain,
    donoNome: null,
    severidade: s.severity === 'critical' ? 'critico' : 'aviso',
    reciboFonte: 'data_health',
    reciboFrescor: frescorTexto(s.ageSeconds != null ? Math.floor(s.ageSeconds / 3600) : null),
    acao: { tipo: 'nenhum' },
    badges: [],
  }));
}

// ── composer ─────────────────────────────────────────────────────────
const TITULO_GRUPO: Record<GrupoExcecao['key'], string> = {
  dados_quebrados: 'Dados quebrados',
  clientes_risco: 'Clientes em risco',
  confirmacoes_pendentes: 'Confirmações pendentes',
};

export function montarExcecoes(input: ExcecoesInput, cfg: ExcecoesCfg = EXCECOES_CFG_DEFAULT): ConsoleExcecoes {
  const dados = detectarDadosQuebrados(input.saude, cfg);
  const risco = detectarClientesRisco(input.decisoes, input.decisoesMaxCreatedAtIso, input.agoraIso, cfg);
  let conf = detectarConfirmacoesPendentes(input.tarefas, input.hojeSp, cfg);

  // merge visual: cliente em risco E em tarefa → badge na linha de risco, remove da seção de tarefas.
  const clientesEmRisco = new Set(
    risco.filter(l => l.acao.tipo === 'abrir_cliente').map(l => (l.acao as { clienteUserId: string }).clienteUserId),
  );
  if (clientesEmRisco.size > 0) {
    for (const l of risco) {
      if (l.acao.tipo === 'abrir_cliente') {
        const cid = (l.acao as { clienteUserId: string }).clienteUserId;
        const temTarefa = conf.some(t => t.acao.tipo === 'tarefa' && (t.acao as { clienteUserId: string | null }).clienteUserId === cid);
        if (temTarefa && !l.badges.includes('também há tarefa pendente')) l.badges.push('também há tarefa pendente');
      }
    }
    conf = conf.filter(t => !(t.acao.tipo === 'tarefa' && (t.acao as { clienteUserId: string | null }).clienteUserId != null
      && clientesEmRisco.has((t.acao as { clienteUserId: string }).clienteUserId)));
  }

  // teto total: críticos de dados SEMPRE entram; depois risco; depois confirmações.
  const criticosDados = dados.filter(l => l.severidade === 'critico');
  const avisosDados = dados.filter(l => l.severidade !== 'critico');
  const orcamento = Math.max(cfg.totalMax - criticosDados.length, 0);

  const restoPriorizado: LinhaExcecao[] = [...avisosDados, ...risco, ...conf];
  const restoIncluido = restoPriorizado.slice(0, orcamento);
  const excedente = restoPriorizado.length - restoIncluido.length;

  const incluidas = [...criticosDados, ...restoIncluido];

  // reagrupar preservando a ordem de dependência
  const ordem: GrupoExcecao['key'][] = ['dados_quebrados', 'clientes_risco', 'confirmacoes_pendentes'];
  const grupos: GrupoExcecao[] = ordem
    .map(key => ({ key, titulo: TITULO_GRUPO[key], linhas: incluidas.filter(l => l.grupo === key) }))
    .filter(g => g.linhas.length > 0);

  const totalLinhas = incluidas.length;
  return { grupos, totalLinhas, excedente, vazio: totalLinhas === 0 };
}
