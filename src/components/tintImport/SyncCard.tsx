// Card "Sincronizar Produtos Omie" da Importação Tintométrica.
// Extraído de src/pages/TintImport.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RefreshCw, Loader2 } from 'lucide-react';
import { UltimaExecucao } from '@/components/execucoes/UltimaExecucao';
import { ACOES_TINT_IMPORT } from './acoes';

export function SyncCard({
  syncing, onSync, tintCounts,
}: {
  syncing: boolean;
  onSync: () => void;
  tintCounts?: { bases: number; concentrados: number };
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sincronizar Produtos Omie</CardTitle>
        <UltimaExecucao acao={ACOES_TINT_IMPORT.sincronizarProdutos} />
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-3">
          Importa bases e concentrados tintométricos do Omie para o sistema.
        </p>
        <Button onClick={onSync} disabled={syncing}>
          {syncing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
          Sincronizar Produtos Omie
        </Button>
        {tintCounts && (tintCounts.bases > 0 || tintCounts.concentrados > 0) && (
          <p className="text-sm text-muted-foreground mt-3">
            <span className="font-medium text-foreground">{tintCounts.bases}</span> bases e{' '}
            <span className="font-medium text-foreground">{tintCounts.concentrados}</span> concentrados encontrados no Omie
          </p>
        )}
      </CardContent>
    </Card>
  );
}
