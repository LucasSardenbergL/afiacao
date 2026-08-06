import { useQueryClient } from '@tanstack/react-query';
import { invokeFunction } from '@/lib/invoke-function';
import { toast } from 'sonner';
import { useMutationComRegistro } from '@/components/execucoes/useMutationComRegistro';
import type { TintSyncResult } from '@/components/tintImport/types';
import { useTintProductCounts } from '@/components/tintImport/queries';
import { SyncCard } from '@/components/tintImport/SyncCard';
import { ACOES_TINT_IMPORT } from '@/components/tintImport/acoes';

// Catálogo tintométrico é AUTOMÁTICO (sync do Sayersystem em tempo real). A importação
// manual por CSV foi aposentada e removida em 2026-07-13 (Opção A → remoção total; ver
// docs/runbooks/tint-sync-corte-csv.md). Esta tela mantém só o sync de produtos do Omie.
export default function TintImport() {
  const queryClient = useQueryClient();
  const { data: tintCounts } = useTintProductCounts();

  const syncMutation = useMutationComRegistro({
    acao: ACOES_TINT_IMPORT.sincronizarProdutos,
    detalhes: (res) => ({ sincronizados: res.total_sincronizado ?? res.totalSynced ?? 0 }),
    mutationFn: () => invokeFunction<TintSyncResult>('tint-omie-sync', { action: 'sync_tint_products' }),
    onSuccess: (res) => {
      const total = res.total_sincronizado ?? res.totalSynced ?? 0;
      toast.success(`${total} produtos tintométricos sincronizados`);
      queryClient.invalidateQueries({ queryKey: ['tint'] });
      queryClient.invalidateQueries({ queryKey: ['tint-product-counts'] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Erro ao sincronizar');
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tintométrico — Produtos &amp; Sincronização</h1>
      <SyncCard syncing={syncMutation.isPending} onSync={() => syncMutation.mutate()} tintCounts={tintCounts} />
    </div>
  );
}
