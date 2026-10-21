// Borda das leituras de tarefas: a view `v_tarefas_estado` e a tabela `tarefa_templates` chegam do
// `types.ts` com vocabulário como `string` (e a view, toda coluna `| null`). O jeito antigo era
// `(data ?? []) as TarefaEstado[]`, que afirmava 6 vocabulários e uma dúzia de NOT NULL sem conferir
// nada — e escondia dois desvios reais: `conclusao_origem = 'comprovacao'` (no CHECK da prod, fora
// do tipo local) e `customer_user_id` NULL (nullable na base; a instância recorrente nasce sem
// cliente). Aqui cada vocabulário é conferido contra o CHECK da prod (psql-ro, 2026-10-21) e cada
// coluna que a prod garante é EXIGIDA: valor fora lança com a coluna, nunca vira um default.
import type { Database } from '@/integrations/supabase/types';
import { exigirColunas } from '@/lib/linha-view';
import type { TarefaInstancia, TarefaTemplate, TarefaTemplateCadencia, TarefaTipoComprovacao } from './templates-types';
import type { TarefaAutoSatisfy, TarefaCategoria, TarefaEstado, TarefaInteracaoTipo, TarefaModo } from './types';

type LinhaView = Database['public']['Views']['v_tarefas_estado']['Row'];
type LinhaTemplate = Database['public']['Tables']['tarefa_templates']['Row'];

const CATEGORIAS = ['ligar', 'oferecer', 'preco', 'whatsapp', 'outro'] as const satisfies readonly TarefaCategoria[];
const MODOS = ['data', 'interacao'] as const satisfies readonly TarefaModo[];
const INTERACOES = ['ligacao', 'visita', 'entrega'] as const satisfies readonly TarefaInteracaoTipo[];
const AUTO_SATISFY = ['off', 'interacao', 'conteudo'] as const satisfies readonly TarefaAutoSatisfy[];
const STATUS = ['aberta', 'concluida', 'cancelada'] as const;
const ORIGENS = ['manual', 'auto_interacao', 'sugestao_confirmada', 'whatsapp', 'comprovacao'] as const;
const AUDITORIA = ['nao_requer', 'dispensada', 'pendente', 'aprovada', 'reprovada'] as const;
const CADENCIAS = ['diaria', 'dias_uteis', 'semanal', 'dias_especificos'] as const satisfies readonly TarefaTemplateCadencia[];
const COMPROVACOES = ['nenhuma', 'foto', 'leitura', 'foto_e_leitura'] as const satisfies readonly TarefaTipoComprovacao[];

function ehDe<T extends string>(v: string, valores: readonly T[]): v is T {
  return valores.some((x) => x === v);
}

function vocab<T extends string>(v: string, valores: readonly T[], coluna: string, fonte: string): T {
  if (!ehDe(v, valores)) throw new Error(`${fonte}: "${coluna}" = "${v}" fora do vocabulário`);
  return v;
}

function vocabOuNulo<T extends string>(v: string | null, valores: readonly T[], coluna: string, fonte: string): T | null {
  return v === null ? null : vocab(v, valores, coluna, fonte);
}

const F_VIEW = 'v_tarefas_estado';

/** Uma linha de `v_tarefas_estado` como `TarefaEstado`; lança se faltar coluna garantida ou o vocabulário divergir. */
export function paraTarefaEstado(l: LinhaView): TarefaEstado {
  exigirColunas(
    l,
    ['id', 'descricao', 'categoria', 'assigned_to', 'created_by', 'empresa', 'modo', 'backstop_days',
      'tolerancia_dias', 'auto_satisfy_mode', 'status', 'effective_due', 'responsavel_efetivo', 'atrasada',
      'escalavel', 'tem_sugestao_pendente'],
    F_VIEW,
  );
  return {
    id: l.id,
    descricao: l.descricao,
    categoria: vocab(l.categoria, CATEGORIAS, 'categoria', F_VIEW),
    customer_user_id: l.customer_user_id,
    assigned_to: l.assigned_to,
    created_by: l.created_by,
    empresa: l.empresa,
    modo: vocab(l.modo, MODOS, 'modo', F_VIEW),
    due_date: l.due_date,
    interacao_tipo: vocabOuNulo(l.interacao_tipo, INTERACOES, 'interacao_tipo', F_VIEW),
    backstop_days: l.backstop_days,
    tolerancia_dias: l.tolerancia_dias,
    adiada_para: l.adiada_para,
    motivo_adiamento: l.motivo_adiamento,
    auto_satisfy_mode: vocab(l.auto_satisfy_mode, AUTO_SATISFY, 'auto_satisfy_mode', F_VIEW),
    target_produto_id: l.target_produto_id,
    target_texto: l.target_texto,
    target_preco_centavos: l.target_preco_centavos,
    status: vocab(l.status, STATUS, 'status', F_VIEW),
    concluida_em: l.concluida_em,
    concluida_por: l.concluida_por,
    conclusao_origem: vocabOuNulo(l.conclusao_origem, ORIGENS, 'conclusao_origem', F_VIEW),
    nota_conclusao: l.nota_conclusao,
    escalado_em: l.escalado_em,
    effective_due: l.effective_due,
    responsavel_efetivo: l.responsavel_efetivo,
    atrasada: l.atrasada,
    escalavel: l.escalavel,
    tem_sugestao_pendente: l.tem_sugestao_pendente,
  };
}

/** `TarefaEstado` + os campos da Fase 2 (recorrentes, comprovação e auditoria). */
export function paraTarefaInstancia(l: LinhaView): TarefaInstancia {
  const base = paraTarefaEstado(l);
  exigirColunas(l, ['requer_comprovacao', 'requer_auditoria', 'auditoria_status'], F_VIEW);
  return {
    ...base,
    template_id: l.template_id,
    requer_comprovacao: l.requer_comprovacao,
    requer_auditoria: l.requer_auditoria,
    auditoria_status: vocab(l.auditoria_status, AUDITORIA, 'auditoria_status', F_VIEW),
    auditoria_motivo: l.auditoria_motivo,
    tipo_comprovacao: vocabOuNulo(l.tipo_comprovacao, COMPROVACOES, 'tipo_comprovacao', F_VIEW),
    leitura_min: l.leitura_min,
    leitura_max: l.leitura_max,
    leitura_unidade: l.leitura_unidade,
    comprovacao_leitura: l.comprovacao_leitura,
    comprovacao_em: l.comprovacao_em,
    comprovacao_url: l.comprovacao_url,
    janela_fim: l.janela_fim,
    supervisor_user_id: l.supervisor_user_id,
  };
}

/** Uma linha de `tarefa_templates`: as colunas já vêm NOT NULL; só os vocabulários são conferidos. */
export function paraTarefaTemplate(l: LinhaTemplate): TarefaTemplate {
  const f = 'tarefa_templates';
  return {
    ...l,
    categoria: vocab(l.categoria, CATEGORIAS, 'categoria', f),
    cadencia: vocab(l.cadencia, CADENCIAS, 'cadencia', f),
    tipo_comprovacao: vocab(l.tipo_comprovacao, COMPROVACOES, 'tipo_comprovacao', f),
  };
}
