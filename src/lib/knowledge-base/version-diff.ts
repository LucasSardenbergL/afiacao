import type { KbExtractedSpec } from '@/lib/knowledge-base/specs-types';

export type DiffTipo = 'added' | 'removed' | 'changed';
export interface CampoDiff { campo: string; de: unknown; para: unknown; tipo: DiffTipo; }

/** Campos técnicos comparáveis (espelha kb_product_specs; exclui metadata/audit). */
const CAMPOS_DIFF: (keyof KbExtractedSpec)[] = [
  'product_name','product_line','product_category','densidade_g_cm3','solidos_pct',
  'viscosidade_aplicacao_s','viscosidade_copo','brilho_ub','dureza','rendimento_m2_por_litro',
  'demaos_recomendadas','gramatura_g_m2_min','gramatura_g_m2_max','pot_life_horas',
  'temp_aplicacao_c_min','temp_aplicacao_c_max','umidade_aplicacao_pct_min','umidade_aplicacao_pct_max',
  'catalisador_codigo','catalisador_proporcao_pct','diluente_codigo','equipamentos_aplicacao',
  'lixa_recomendada','substrato','secagem_manuseio_h','secagem_empilhamento_h','secagem_total_h',
  'validade_dias','temp_armazenamento_c_min','temp_armazenamento_c_max','certificacoes_aplicaveis',
  'isento_metais_pesados','isento_substancias','diferenciais_chave','uso_recomendado','publico_alvo',
];

function vazio(v: unknown): boolean {
  return v == null || (Array.isArray(v) && v.length === 0) || v === '';
}
function igual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const sa = [...a].map(String).sort(); const sb = [...b].map(String).sort();
    return sa.length === sb.length && sa.every((x, i) => x === sb[i]);
  }
  return a === b;
}

/** Diff campo-a-campo entre duas versões (a=anterior, b=atual). Arrays ordem-insensível. */
export function diffVersions(
  a: Partial<KbExtractedSpec>, b: Partial<KbExtractedSpec>,
): CampoDiff[] {
  const out: CampoDiff[] = [];
  for (const campo of CAMPOS_DIFF) {
    const de = a[campo]; const para = b[campo];
    if (igual(de, para)) continue;
    const tipo: DiffTipo = vazio(de) ? 'added' : vazio(para) ? 'removed' : 'changed';
    out.push({ campo, de: de ?? null, para: para ?? null, tipo });
  }
  return out;
}

export type AcaoVersao = 'novo_documento' | 'corrigir' | 'completar';
export function decidirChangeType(input: { acao: AcaoVersao }): 'bulletin_revision' | 'correction' | 'data_completion' {
  switch (input.acao) {
    case 'novo_documento': return 'bulletin_revision';
    case 'corrigir': return 'correction';
    case 'completar': return 'data_completion';
  }
}

/**
 * Infere o change_type de uma edição manual (Fase B2) a partir do diff vs a ficha atual.
 * Mudou/removeu valor que já existia → 'correction'; só preencheu campos vazios (added) →
 * 'data_completion'. Pré: diff NÃO-vazio (o chamador barra diff vazio = "nenhuma alteração").
 */
export function inferirChangeTypeDoDiff(diff: CampoDiff[]): 'correction' | 'data_completion' {
  return diff.some((d) => d.tipo === 'changed' || d.tipo === 'removed')
    ? 'correction'
    : 'data_completion';
}
