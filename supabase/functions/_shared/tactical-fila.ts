// Janela da fila do Plano Tático — a régua que diz se um plano ainda está ABERTO.
//
// Lógica PURA extraída para caber no `--no-remote` do `test:edges`.
// Testes em tactical-fila_test.ts.
//
// POR QUE EXISTE — a fase 2 (2026-08-08). A idempotência da geração era "já gerei HOJE?"
// (dia-operacional.ts), e o cliente voltava a ser candidato na madrugada seguinte. Efeito
// medido em prod: 23 dos 25 planos de 07/08 eram regeração de cliente que JÁ estava na fila;
// a fila viva tinha 169 planos para 35 clientes distintos, 14 deles com 7 cópias — uma por
// dia da janela. A vendedora abria a tela e via o mesmo cliente sete vezes.
//
// A régua certa não é o DIA, é a JANELA: enquanto o plano estiver aberto na fila de alguém,
// gerar outro para o mesmo cliente só produz cópia. Quando ele sai (expirado pelo cron
// `expirar-planos-taticos`, ou concluído), o cliente volta a ser candidato — é o que faz a
// fila circular em vez de entupir.
//
// ⚠️ TRÊS LUGARES compartilham este 7, e divergir tem consequência assimétrica:
//   1. src/hooks/useTacticalPlan.ts:238  `JANELA_FILA_DIAS` — o recorte que a tela exibe
//   2. expirar_planos_taticos(_dias=7)   — o cron que muda `gerado` → `expirado`
//   3. esta constante                    — a idempotência da geração
// Se esta janela ficar MAIOR que a da tela, o cliente sai de vista mas continua bloqueado, e
// ninguém gera plano para ele — buraco silencioso. Se ficar MENOR, volta a duplicata. Mantenha
// as três iguais; ao mudar uma, mude as três.
//
// Por que a idempotência não olha só `status = 'gerado'` (sem janela nenhuma): isso a deixaria
// dependente do cron de expiração ter rodado. Cron morto ⇒ nada expira ⇒ NENHUM plano novo é
// gerado para ninguém, e a fila congela inteira. Com a janela explícita, um plano velho demais
// deixa de bloquear mesmo que o cron não tenha passado — a fase 1 tomou a mesma decisão do lado
// da tela ("o front aplica a janela por conta própria em vez de confiar que o cron rodou").

/** Dias que um plano permanece na fila. Espelha useTacticalPlan.ts:238 e expirar_planos_taticos. */
export const JANELA_FILA_DIAS = 7;

const DIA_MS = 86_400_000;

/**
 * Limite inferior (ISO) da janela da fila — use com `>=` sobre `created_at`.
 *
 * Janela DESLIZANTE de 7×24h, idêntica ao front (`Date.now() - JANELA_FILA_DIAS * 86_400_000`),
 * e não dia-calendário: as duas pontas precisam concordar sobre quem está na fila, e uma
 * janela por calendário discordaria da outra por até 24h todo dia.
 *
 * `agora` é parâmetro (não `Date.now()` interno) para o comportamento ser testável sem
 * depender do relógio da máquina — mesmo padrão de dia-operacional.ts.
 */
export function inicioDaJanelaFila(agora: Date, dias: number = JANELA_FILA_DIAS): string {
  // Guard fail-closed, espelhando o 22023 de expirar_planos_taticos: com `dias <= 0` a janela
  // seria vazia ou futura, TODO plano deixaria de bloquear, e a duplicata voltaria em silêncio.
  if (!Number.isFinite(dias) || dias < 1) {
    throw new RangeError(`janela da fila inválida: ${dias} (esperado inteiro >= 1)`);
  }
  return new Date(agora.getTime() - dias * DIA_MS).toISOString();
}
