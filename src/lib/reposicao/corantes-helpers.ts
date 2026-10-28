// Giro de corante (Fase 1, advisory) — borda tipada de `v_corante_giro` e textos da aba "Corantes".
// O cálculo inteiro vive no banco (`tint_corante_giro_em`, migration 20261028100100); aqui só se
// valida o vocabulário e se formata. Ausente ≠ zero: todo número `null` vira "—", nunca 0.
// Spec: docs/superpowers/specs/2026-10-27-giro-corante-reposicao-design.md §5.2.
import type { Tables } from '@/integrations/supabase/types';

export const FAIXAS_CORANTE = ['sem_recomendacao', 'parado', 'muito_pouco', 'devagar', 'rapido'] as const;
export type FaixaCorante = (typeof FAIXAS_CORANTE)[number];

type LinhaView = Tables<'v_corante_giro'>;

/** Linha da view com o vocabulário provado e as chaves não-nulas. */
export type GiroCorante = Omit<LinhaView, 'tint_corante_id' | 'wp_codigo' | 'faixa' | 'faixa_ultimo_calculo'> & {
  tint_corante_id: string;
  wp_codigo: string;
  faixa: FaixaCorante;
  faixa_ultimo_calculo: FaixaCorante | null;
};

function ehFaixa(v: unknown): v is FaixaCorante {
  return (FAIXAS_CORANTE as readonly unknown[]).includes(v);
}

/** Lança fora do vocabulário: uma faixa que o app não conhece não pode virar texto de regra. */
export function paraGiroCorante(l: LinhaView): GiroCorante {
  if (!l.tint_corante_id || !l.wp_codigo) throw new Error('v_corante_giro: linha sem tint_corante_id/wp_codigo');
  if (!ehFaixa(l.faixa)) throw new Error(`v_corante_giro: faixa fora do vocabulário: ${String(l.faixa)}`);
  if (l.faixa_ultimo_calculo !== null && !ehFaixa(l.faixa_ultimo_calculo)) {
    throw new Error(`v_corante_giro: faixa_ultimo_calculo fora do vocabulário: ${String(l.faixa_ultimo_calculo)}`);
  }
  return {
    ...l,
    tint_corante_id: l.tint_corante_id,
    wp_codigo: l.wp_codigo,
    faixa: l.faixa,
    faixa_ultimo_calculo: l.faixa_ultimo_calculo,
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
        : `Pedir quando, ao abrir uma lata, sobrarem ${k} ou menos fechadas (contando o que já está a caminho).`;
  }
}

const ROTULO_MOTIVO: Record<string, string> = {
  mais_de_uma_loja: 'Mais de uma loja na cobertura (a Fase 1 mede uma só)',
  sem_cobertura: 'Sem cobertura do conector ainda',
  dado_desatualizado: 'Dado desatualizado (4 dias ou mais sem cobertura nova)',
  cobertura_insuficiente: 'Cobertura menor que 60 dias',
  capacidade_nao_confirmada: 'Capacidade do canister não confirmada',
  lt_sem_fonte: 'Lead time sem fonte',
  dosagens_sem_ponte: 'Mais de 1% do volume dosado sem corante cadastrado',
  preparacoes_rejeitadas: 'Mais de 1% das preparações rejeitadas na origem',
  sem_consumo_cobertura_parcial: 'Sem consumo, com cobertura ainda parcial (< 180 dias)',
};

export const MOTIVOS_CORANTE = Object.keys(ROTULO_MOTIVO);

/** Motivo desconhecido aparece cru: melhor um código feio que um texto inventado. */
export function rotuloMotivo(motivo: string): string {
  return ROTULO_MOTIVO[motivo] ?? motivo;
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
