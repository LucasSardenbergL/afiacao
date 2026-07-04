import { registerOfflineHandler } from '@/hooks/useOfflineFlush';
import { confirmUnit, type ConfirmUnitVars } from '@/services/recebimento-confirm';
import { reportDivergencia, type ReportDivergenciaVars } from '@/services/recebimento-divergencia';
import { addCte, type AddCteVars } from '@/services/recebimento-cte';
import { confirmPickItem, type ConfirmPickItemVars } from '@/services/picking-confirm';

/**
 * Registra TODOS os handlers de flush por kind, uma única vez, no boot do app.
 *
 * Por que central (e não por página): os handlers eram registrados dentro de
 * RecebimentoConferencia e desregistravam no unmount — se o conferente confirmava
 * offline e saía da página, o flush ao reconectar não achava handler e o item
 * ficava preso na fila. Registrando no boot, reconectar em QUALQUER tela drena a fila.
 *
 * Retorna uma cleanup que desregistra todos.
 */
export function registerAllOfflineHandlers(): () => void {
  // O 3º arg (invalidateKeys) é revalidado quando o item drena no flush pós-reconnect
  // — assim o que foi confirmado offline aparece na UI sem esperar refetch natural.
  // Keys por prefixo (casam ['nfe_conferencia', id] etc.).
  const unsubs = [
    registerOfflineHandler<ConfirmUnitVars>('recebimento.confirm-unit', async (v) => {
      await confirmUnit(v);
      return true;
    }, [['nfe_conferencia'], ['nfe_lotes']]),
    registerOfflineHandler<ReportDivergenciaVars>('recebimento.report-divergencia', async (v) => {
      await reportDivergencia(v);
      return true;
    }, [['nfe_conferencia']]),
    registerOfflineHandler<AddCteVars>('recebimento.add-cte', async (v) => {
      await addCte(v);
      return true;
    }, [['nfe_conferencia']]),
    registerOfflineHandler<ConfirmPickItemVars>('picking.confirm-item', async (v) => {
      await confirmPickItem(v);
      return true;
    }, [['touch-pk-items'], ['touch-pk-tasks']]),
  ];
  return () => unsubs.forEach((u) => u());
}
