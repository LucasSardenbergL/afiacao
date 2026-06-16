export interface LeadingTrailingThrottle {
  /**
   * Pede uma execução: roda NA HORA se a janela está livre (leading edge);
   * senão agenda UM único trailing pro fim da janela — uma rajada de N fires
   * colapsa em 1 execução.
   */
  fire: () => void;
  /** Cancela o trailing pendente SEM executar (uso típico: cleanup de effect). */
  cancel: () => void;
}

/**
 * Throttle leading+trailing para invalidações disparadas por realtime: o 1º
 * evento reflete na hora (leading) e a rajada (sync em lote, cron, blast)
 * colapsa numa única execução por janela (trailing).
 *
 * Consumidores: useWhatsappSla (invalidação da view de SLA por mensagem) e
 * AdminReposicaoCockpit (6 invalidations + toast por evento de tabela).
 */
export function createLeadingTrailingThrottle(
  fn: () => void,
  windowMs: number,
): LeadingTrailingThrottle {
  let lastRun = 0;
  let timer: number | undefined;

  const run = () => {
    lastRun = Date.now();
    fn();
  };

  return {
    fire() {
      const elapsed = Date.now() - lastRun;
      if (elapsed >= windowMs) {
        run();
        return;
      }
      if (timer !== undefined) return; // trailing já agendado — colapsa a rajada
      timer = window.setTimeout(() => {
        timer = undefined;
        run();
      }, windowMs - elapsed);
    },
    cancel() {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
