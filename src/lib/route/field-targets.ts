// Helpers puros do contexto "Visitas em campo" (hunter) do Roteirizador.
// Eixo de CONTEXTO ('campo' | 'equipe') acima do eixo de MODO existente.
// O contexto "campo" reusa internamente planningMode='prospeccao'.
import type { PlanningContext, PlanningMode } from '@/components/reposicao/routePlanner/types';

/** Contexto inicial por papel: master entra na caça (campo); o resto, na equipe. */
export function defaultContextForRole(isMaster: boolean): PlanningContext {
  return isMaster ? 'campo' : 'equipe';
}

/**
 * Modo de planejamento resultante ao trocar de contexto.
 * - campo → sempre 'prospeccao' (a infra de prospects+carteira).
 * - equipe → se vinha de 'prospeccao', cai no 'hibrido' (default operacional);
 *   senão preserva o modo de equipe já escolhido.
 */
export function nextModeForContext(ctx: PlanningContext, currentMode: PlanningMode): PlanningMode {
  if (ctx === 'campo') return 'prospeccao';
  return currentMode === 'prospeccao' ? 'hibrido' : currentMode;
}
