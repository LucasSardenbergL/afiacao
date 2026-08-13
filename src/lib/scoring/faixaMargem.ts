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

// NÃO existe um `FAIXA_TOM` (classe de cor por faixa) aqui, e a ausência é deliberada. Ele
// existiu na primeira versão desta entrega e saiu no rebase: o único consumidor seria o
// `MetricRow` do FarmerDashboard, que aceita `value: string` — colori-lo exigiria alargar um
// componente compartilhado, ou seja, mudança de UI embutida numa entrega de AUTORIZAÇÃO (o
// mesmo erro que o `gDaFaixa` evitou acima). Export sem consumidor também é dead code, e o
// `knip` é gate do `validate`. Quando a faixa ganhar tratamento visual próprio, a paleta
// volta junto do componente que a usa.
