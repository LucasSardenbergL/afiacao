// Borda de `fin_dre_snapshots` → FinDRE. Antes: `(data || []) as unknown as FinDRE[]`, que afirmava as 16
// colunas numéricas como `number` (no schema são nullable com DEFAULT 0) e o `detalhamento` (jsonb) como
// objeto estruturado sem olhar nada. Agora: coluna numérica NULL LANÇA (ausente ≠ zero — nunca vira 0 numa
// DRE) e o detalhamento é lido POR FORMA, cobrindo tudo que o tipo FinDRE promete aos consumidores.
// Medido em prod (psql-ro, 2026-10-20): 133 snapshots, 0 NULL nas 16 colunas e no detalhamento; chaves e
// tipos aninhados conferidos um a um (impostos, imposto_teorico, confianca, fora_dre, listas).
import type { Json, Tables } from '@/integrations/supabase/types';
import type { FinDRE } from '@/services/financeiroService';
import { exigirColunas } from '@/lib/linha-view';
import {
  anulavel, booleano, campo, lista, numero, objeto, opcional, registro, texto, uniao, type Leitor,
} from './borda-json';

export type DetalhamentoDre = FinDRE['detalhamento'];

/** As colunas numéricas que o FinDRE declara `number` (não-nulas). */
const COLUNAS_NUMERICAS_DRE = [
  'receita_bruta', 'deducoes', 'receita_liquida', 'cmv', 'lucro_bruto', 'despesas_operacionais',
  'despesas_administrativas', 'despesas_comerciais', 'despesas_financeiras', 'receitas_financeiras',
  'resultado_operacional', 'outras_receitas', 'outras_despesas', 'resultado_antes_impostos', 'impostos',
  'resultado_liquido',
] as const;

const IMPOSTOS = ['ded_icms', 'ded_iss', 'ded_pis', 'ded_cofins', 'ded_ipi', 'das', 'irpj', 'csll'] as const;

type Impostos = NonNullable<DetalhamentoDre['impostos']>;
const lerImpostos: Leitor<Impostos> = (v, onde) => {
  const o = objeto(v, onde);
  const out: Impostos = {};
  for (const k of IMPOSTOS) opcional(out, o, k, numero, onde);
  return out;
};

const lerConfianca: Leitor<NonNullable<DetalhamentoDre['confianca']>> = (v, onde) => {
  const o = objeto(v, onde);
  return {
    nivel: campo(o, 'nivel', uniao(['alta', 'media', 'baixa']), onde),
    motivos: campo(o, 'motivos', lista(texto), onde),
    pct_mapeado_valor: campo(o, 'pct_mapeado_valor', numero, onde),
    fallback_pct: campo(o, 'fallback_pct', numero, onde),
  };
};

const lerSaidasEntradas: Leitor<{ saidas: number; entradas: number }> = (v, onde) => {
  const o = objeto(v, onde);
  return { saidas: campo(o, 'saidas', numero, onde), entradas: campo(o, 'entradas', numero, onde) };
};

const lerForaDre: Leitor<NonNullable<DetalhamentoDre['fora_dre']>> = (v, onde) => {
  const o = objeto(v, onde);
  return {
    ...lerSaidasEntradas(o, onde),
    por_codigo: campo(o, 'por_codigo', registro(lerSaidasEntradas), onde),
    composicao_pendente: campo(o, 'composicao_pendente', booleano, onde),
    motivo: campo(o, 'motivo', anulavel(texto), onde),
  };
};

type MapeamentoInvalido = NonNullable<DetalhamentoDre['mapeamentos_invalidos']>[number];
const lerMapeamentoInvalido: Leitor<MapeamentoInvalido> = (v, onde) => {
  const o = objeto(v, onde);
  const m: MapeamentoInvalido = {
    codigo: campo(o, 'codigo', texto, onde),
    valor: campo(o, 'valor', texto, onde),
    origem: campo(o, 'origem', uniao(['exato', 'prefixo']), onde),
    motivo: campo(o, 'motivo', texto, onde),
    codigo_titulo: campo(o, 'codigo_titulo', texto, onde),
    valor_afetado: campo(o, 'valor_afetado', numero, onde),
  };
  return opcional(m, o, 'empresa', texto, onde);
};

/** `detalhamento` por forma. Chave opcional ausente continua ausente (snapshot antigo ≠ snapshot com zero). */
export const lerDetalhamentoDre: Leitor<DetalhamentoDre> = (v, onde) => {
  const o = objeto(v, onde);
  const d: DetalhamentoDre = {
    receitas: campo(o, 'receitas', registro(numero), onde),
    despesas: campo(o, 'despesas', registro(numero), onde),
  };
  opcional(d, o, 'categorias_nao_mapeadas', lista(texto), onde);
  opcional(d, o, 'impostos', lerImpostos, onde);
  opcional(d, o, 'regime_tributario', uniao(['simples', 'presumido']), onde);
  opcional(d, o, 'caixa_estimado', booleano, onde);
  opcional(d, o, 'confianca', lerConfianca, onde);
  opcional(d, o, 'imposto_teorico', anulavel(registro(anulavel(numero))), onde);
  opcional(d, o, 'delta_imposto_pct', anulavel(numero), onde);
  opcional(d, o, 'config_tributaria_completa', booleano, onde);
  opcional(d, o, 'fora_dre', lerForaDre, onde);
  opcional(d, o, 'mapeamentos_invalidos', lista(lerMapeamentoInvalido), onde);
  return d;
};

/**
 * Linha de `fin_dre_snapshots` → FinDRE. Coluna numérica NULL, regime fora de caixa|competencia e
 * detalhamento fora da forma LANÇAM (o caller expõe o erro; a DRE nunca soma uma linha pela metade).
 * O spread preserva as demais colunas da linha, como o cast antigo deixava passar.
 */
export function paraFinDRE(l: Tables<'fin_dre_snapshots'>): FinDRE {
  const onde = `fin_dre_snapshots ${l.company} ${l.ano}-${l.mes} (${l.regime})`;
  exigirColunas(l, COLUNAS_NUMERICAS_DRE, onde);
  return {
    ...l,
    regime: uniao(['caixa', 'competencia'])(l.regime, `${onde}.regime`),
    detalhamento: lerDetalhamentoDre(l.detalhamento, `${onde}.detalhamento`),
  };
}

/**
 * DRE fase 2: composição chave → linha → R$. Ausente ou NULL ⇒ null (snapshot legado). Presente mas
 * malformada — inclusive valor que não é número de verdade (NULL, "", string numérica) — LANÇA. Não
 * há marcador seguro para "inválida": o antigo `Number(null) === 0` às vezes fazia o helper rejeitar,
 * e um `{}` sentinela colide com a composição vazia legítima (achado Codex adversarial: PE=0 aceito).
 */
export function lerComposicaoDespesas(c: Json | undefined, onde: string): Record<string, Record<string, number>> | null {
  if (c === undefined || c === null) return null;
  return registro(registro(numero))(c, onde);
}
