import { registerOfflineHandler } from '@/hooks/useOfflineFlush';
import { confirmUnit, type ConfirmUnitVars } from '@/services/recebimento-confirm';
import { reportDivergencia, type ReportDivergenciaVars } from '@/services/recebimento-divergencia';
import { addCte, type AddCteVars } from '@/services/recebimento-cte';
import { confirmPickItem, type ConfirmPickItemVars } from '@/services/picking-confirm';
import { despacharApontamento, type AcaoApontamento } from '@/services/pcp-apontamento';

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
    registerOfflineHandler<ConfirmUnitVars>('recebimento.confirm-unit', async (v, cliente) => {
      await confirmUnit(v, cliente);
      return true;
    }, [['nfe_conferencia'], ['nfe_lotes']]),
    registerOfflineHandler<ReportDivergenciaVars>('recebimento.report-divergencia', async (v, cliente) => {
      await reportDivergencia(v, cliente);
      return true;
    }, [['nfe_conferencia']]),
    registerOfflineHandler<AddCteVars>('recebimento.add-cte', async (v, cliente) => {
      await addCte(v, cliente);
      return true;
    }, [['nfe_conferencia']]),
    registerOfflineHandler<ConfirmPickItemVars>('picking.confirm-item', async (v, cliente) => {
      await confirmPickItem(v, cliente);
      return true;
    }, [['touch-pk-items'], ['touch-pk-tasks']]),
    // PCP no boot também (antes só com a tela de apontamento aberta: sair dela deixava o item
    // sem handler, e voltar a entrar não drenava).
    registerOfflineHandler<AcaoApontamento>('pcp.apontar', async (v, cliente) => {
      await despacharApontamento(v, cliente);
      return true;
    }, [['pcp-apontamento-ops']]),
  ];
  return () => unsubs.forEach((u) => u());
}
