import {
  desatualizado,
  estadoDeLeitura,
  naoConsegui,
  type EstadoSemLeitura,
  type FatiaDeQuery,
} from '@/lib/leitura/estado-de-leitura';

/**
 * O contrato de um badge de CONTAGEM da navegação (plano v7, C11 — começou pelo de melhorias).
 *
 * O defeito: `if (error) return 0` no `queryFn` + o shell só desenhar o badge com valor > 0 = a
 * falha some calada, e "badge ausente" vira "nada aberto". Trocar o `0` por `null` NÃO muda nada,
 * porque `null` também esconde. Um contrato completo precisa de TRÊS faces:
 *
 *  - `numero`       → lido e > 0: o número;
 *  - `oculto`       → lido e 0 (o zero da navegação é ausência de badge, convenção da sidebar),
 *                     OU a pergunta ainda não foi respondida (carregando/desabilitada): badge
 *                     piscando "?" no 1º paint seria alarme fabricado (precisão > recall);
 *  - `indisponivel` → a leitura NÃO aconteceu (erro/sem rede). Vale também com número antigo em
 *                     cache: repetir o "3" de 20 minutos atrás como atual é afirmar uma contagem
 *                     vencida — o número velho vai no tooltip, marcado como última leitura.
 *
 * Pré-condição: o `queryFn` LANÇA no erro; com `return 0` a query fica `success` e a face
 * `indisponivel` é inalcançável.
 */
export type FaceDoBadge =
  | { tipo: 'oculto' }
  | { tipo: 'numero'; valor: number }
  | { tipo: 'indisponivel'; estado: EstadoSemLeitura; ultimo: number | null };

export function faceDoBadge(q: FatiaDeQuery & { data: number | undefined }): FaceDoBadge {
  const temDado = q.data !== undefined;
  const velho = desatualizado(q, temDado);
  if (velho) return { tipo: 'indisponivel', estado: velho, ultimo: q.data ?? null };
  if (q.data === undefined) {
    const estado = estadoDeLeitura(q);
    return naoConsegui(estado) ? { tipo: 'indisponivel', estado, ultimo: null } : { tipo: 'oculto' };
  }
  return q.data > 0 ? { tipo: 'numero', valor: q.data } : { tipo: 'oculto' };
}

export function motivoDoBadgeIndisponivel(
  oque: string,
  estado: EstadoSemLeitura,
  ultimo: number | null,
): string {
  const base =
    estado === 'sem-rede'
      ? `Sem conexão — não foi possível contar ${oque}`
      : `Não foi possível contar ${oque}`;
  return ultimo == null ? base : `${base} (última leitura: ${ultimo})`;
}
