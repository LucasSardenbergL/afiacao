// Giro de corante (Fase 1, advisory) — borda tipada de `v_corante_giro` e textos da aba "Corantes".
// O cálculo inteiro vive no banco (`tint_corante_giro_em`, migration 20261028100100); aqui só se
// valida o vocabulário e se formata. Ausente ≠ zero: todo número `null` vira "—", nunca 0.
// Spec: docs/superpowers/specs/2026-10-27-giro-corante-reposicao-design.md §5.2.
import type { Tables } from '@/integrations/supabase/types';

const FAIXAS_CORANTE = ['sem_recomendacao', 'parado', 'muito_pouco', 'devagar', 'rapido'] as const;
export type FaixaCorante = (typeof FAIXAS_CORANTE)[number];

const ROTULO_MOTIVO = {
  mais_de_uma_loja: 'Mais de uma loja na cobertura (a Fase 1 mede uma só)',
  sem_cobertura: 'Sem cobertura do conector ainda',
  dado_desatualizado: 'Dado desatualizado (4 dias ou mais sem cobertura nova)',
  cobertura_insuficiente: 'Cobertura menor que 60 dias',
  capacidade_nao_confirmada: 'Capacidade do canister não confirmada',
  lt_sem_fonte: 'Lead time sem fonte',
  dosagens_sem_ponte: 'Mais de 1% do volume dosado sem corante cadastrado',
  preparacoes_rejeitadas: 'Mais de 1% das preparações rejeitadas na origem',
  sem_consumo_cobertura_parcial: 'Sem consumo, com cobertura ainda parcial (< 180 dias)',
} as const;
export type MotivoCorante = keyof typeof ROTULO_MOTIVO;
export const MOTIVOS_CORANTE = Object.keys(ROTULO_MOTIVO) as MotivoCorante[];

const CONFIANCAS = ['alta', 'baixa'] as const;
const LT_FONTES = ['QT', 'GL', 'mediana_wp'] as const;

type LinhaView = Tables<'v_corante_giro'>;

/** Linha da view com TODO vocabulário provado e as chaves não-nulas. */
export type GiroCorante = Omit<
  LinhaView,
  'tint_corante_id' | 'wp_codigo' | 'faixa' | 'faixa_ultimo_calculo' | 'motivo' | 'confianca' | 'lt_fonte'
> & {
  tint_corante_id: string;
  wp_codigo: string;
  faixa: FaixaCorante;
  faixa_ultimo_calculo: FaixaCorante | null;
  motivo: MotivoCorante | null;
  confianca: (typeof CONFIANCAS)[number] | null;
  lt_fonte: (typeof LT_FONTES)[number] | null;
};

function de<T extends string>(vocab: readonly T[]): (v: unknown) => v is T {
  return (v: unknown): v is T => (vocab as readonly unknown[]).includes(v);
}
const ehFaixa = de(FAIXAS_CORANTE);
const ehMotivo = de(MOTIVOS_CORANTE);
const ehConfianca = de(CONFIANCAS);
const ehLtFonte = de(LT_FONTES);

/** Coluna anulável com vocabulário fechado: `null` passa; valor desconhecido LANÇA. */
function anulavel<T>(v: unknown, eh: (x: unknown) => x is T, coluna: string): T | null {
  if (v === null) return null;
  if (!eh(v)) throw new Error(`v_corante_giro: ${coluna} fora do vocabulário: ${String(v)}`);
  return v;
}

/** Lança fora do vocabulário: um valor que o app não conhece vira falha de leitura (aviso), nunca
 *  texto inventado nem a aba "pronta" (Codex PR C, P1). */
export function paraGiroCorante(l: LinhaView): GiroCorante {
  if (!l.tint_corante_id || !l.wp_codigo) throw new Error('v_corante_giro: linha sem tint_corante_id/wp_codigo');
  if (!ehFaixa(l.faixa)) throw new Error(`v_corante_giro: faixa fora do vocabulário: ${String(l.faixa)}`);
  return {
    ...l,
    tint_corante_id: l.tint_corante_id,
    wp_codigo: l.wp_codigo,
    faixa: l.faixa,
    faixa_ultimo_calculo: anulavel(l.faixa_ultimo_calculo, ehFaixa, 'faixa_ultimo_calculo'),
    motivo: anulavel(l.motivo, ehMotivo, 'motivo'),
    confianca: anulavel(l.confianca, ehConfianca, 'confianca'),
    lt_fonte: anulavel(l.lt_fonte, ehLtFonte, 'lt_fonte'),
  };
}

const ROTULO_FAIXA: Record<FaixaCorante, string> = {
  sem_recomendacao: 'sem recomendação',
  parado: 'parado',
  muito_pouco: 'gira muito pouco',
  devagar: 'gira devagar',
  rapido: 'gira rápido',
};

export function rotuloFaixa(f: FaixaCorante): string {
  return ROTULO_FAIXA[f];
}

/** Texto da coluna "Regra" (§5.2 da spec). `k` só existe na faixa rápida; `ltc` (lead time em
 *  dias corridos) entra no texto da faixa "muito pouco" quando conhecido. */
export function regraDaFaixa(faixa: FaixaCorante, k: number | null, ltc: number | null = null): string {
  switch (faixa) {
    case 'sem_recomendacao':
      return '—';
    case 'parado':
      return 'Não manter lata fechada; avaliar tirar a cor da máquina / sob encomenda.';
    case 'muito_pouco':
      return (
        'Nenhuma lata fechada. Ao abrir a última, não há reserva: pedir 1 QT quando o alarme tocar e aceitar até ' +
        (ltc === null ? 'o lead time' : `${ltc} dias`) +
        ' sem a cor. Recarregar sempre com QT.'
      );
    case 'devagar':
      return 'No máximo 1 lata fechada. Pedir 1 QT ao abrir a última.';
    case 'rapido':
      return k === null
        ? '—'
        : `Pedir quando, ao abrir uma lata, sobrarem ${k} ou menos latas QT fechadas (GL conta pelo equivalente em QT; ` +
          'contando o que já está a caminho).';
  }
}

export function rotuloMotivo(motivo: MotivoCorante): string {
  return ROTULO_MOTIVO[motivo];
}

const NUM = (casas: number) =>
  new Intl.NumberFormat('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });

/** Número com `casas` decimais; `null` → "—" (ausente ≠ zero). */
export function fmtNum(v: number | null | undefined, casas = 0): string {
  return v === null || v === undefined ? '—' : NUM(casas).format(v);
}

const DATA_HORA_SP = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Instante em hora de São Paulo; `null` → "—". */
export function fmtInstanteSP(iso: string | null | undefined): string {
  return iso ? DATA_HORA_SP.format(new Date(iso)) : '—';
}
