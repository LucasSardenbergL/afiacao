/**
 * Faixa de margem do cliente — vocabulário herdado de `get_preco_cockpit` (FU4-F).
 *
 * É o SUBSTITUTO do número para quem não tem `cap_custo_ler`: a vendedora deixa de ver
 * "margem 23,4%" e passa a ver "abaixo do piso". Decisão de produto (dono, 2026-07-20):
 * o NÚMERO de custo fecha, o SINAL fica.
 *
 * Produzido por `public.get_carteira_margem_faixa()`; o front só classifica a cor.
 *
 * ⚠️ NÃO existe um `gDaFaixa()` aqui, e a ausência é deliberada. A versão inicial do plano
 * mapeava faixa → componente G (verde/amarelo/vermelho → 1/0,5/0). Medido sobre a prod, isso
 * descartaria a régua de percentis e mudaria o health score de 68% dos clientes com margem
 * (5,73 pontos em média, 14,42 no pior caso) — uma mudança de PRODUTO embutida numa entrega de
 * AUTORIZAÇÃO. O `g` passou a vir calculado do servidor, com a mesma régua de sempre.
 */
export type FaixaMargem = 'verde' | 'amarelo' | 'vermelho' | 'neutro';

/**
 * Rótulo exibível de cada faixa.
 *
 * `neutro` NÃO é uma cor pálida: é a degradação honesta de "não sei". Empurrá-lo para uma cor
 * fabricaria veredito — margem 0 é um julgamento legítimo ("cliente não-lucrativo") e é
 * diferente de "nenhum item deste cliente tem custo conhecido".
 */
export const FAIXA_LABEL: Record<FaixaMargem, string> = {
  verde: 'Margem saudável',
  amarelo: 'Margem abaixo do piso',
  vermelho: 'Abaixo do custo',
  neutro: 'Sem custo conhecido',
};

/** Classe de cor do design system por faixa. `neutro` é neutro de propósito — não é alerta. */
export const FAIXA_TOM: Record<FaixaMargem, string> = {
  verde: 'text-status-success',
  amarelo: 'text-status-warning',
  vermelho: 'text-status-error',
  neutro: 'text-muted-foreground',
};
