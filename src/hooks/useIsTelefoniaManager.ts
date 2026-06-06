// src/hooks/useIsTelefoniaManager.ts
import { useDisplayAccess } from '@/hooks/useDisplayAccess';

/**
 * A aba "Time" do histórico de chamadas é para gestores comerciais/master.
 * Usa o acesso de EXIBIÇÃO (useDisplayAccess): fora da lente espelha o usuário
 * real (master OU commercial_role em gerencial/estrategico/super_admin — o mesmo
 * critério de antes); na lente "Ver como", reflete o cargo do ALVO, então um
 * farmer impersonado não vê a aba Time (como ele de fato não vê no app dele).
 */
export function useIsTelefoniaManager(): boolean {
  const { displayIsMaster, displayIsGestorComercial } = useDisplayAccess();
  return displayIsMaster || displayIsGestorComercial;
}
