// Dialog de validação dos mapeamentos SKU.
// Extraído verbatim de src/pages/AdminSkuMapeamento.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import type { ValidacaoResult } from './types';

interface ValidacaoDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  validando: boolean;
  validacao: ValidacaoResult | null;
}

export function ValidacaoDialog({ open, onOpenChange, validando, validacao }: ValidacaoDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Validação dos mapeamentos</DialogTitle>
          <DialogDescription>
            Confere se todos os SKUs usados em pedidos Sayerlack OBEN têm correspondência no portal.
          </DialogDescription>
        </DialogHeader>
        {validando || !validacao ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <Card><CardContent className="pt-4">
                <div className="text-xs text-muted-foreground">Total</div>
                <div className="text-2xl font-bold">{validacao.total}</div>
              </CardContent></Card>
              <Card><CardContent className="pt-4">
                <div className="text-xs text-muted-foreground">Auto</div>
                <div className="text-2xl font-bold">{validacao.automaticos}</div>
              </CardContent></Card>
              <Card><CardContent className="pt-4">
                <div className="text-xs text-muted-foreground">Manual</div>
                <div className="text-2xl font-bold">{validacao.manuais}</div>
              </CardContent></Card>
            </div>

            {validacao.faltantes.length > 0 ? (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{validacao.faltantes.length} SKU(s) sem mapeamento</AlertTitle>
                <AlertDescription>
                  <div className="max-h-48 overflow-y-auto mt-2 space-y-1 text-xs">
                    {validacao.faltantes.map((f) => (
                      <div key={f.sku_codigo_omie} className="font-mono">
                        {f.sku_codigo_omie} — {f.sku_descricao}
                      </div>
                    ))}
                  </div>
                </AlertDescription>
              </Alert>
            ) : (
              <Alert>
                <CheckCircle2 className="h-4 w-4" />
                <AlertTitle>Todos os SKUs do histórico estão mapeados</AlertTitle>
              </Alert>
            )}

            {validacao.suspeitos.length > 0 && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{validacao.suspeitos.length} mapeamento(s) com SKU portal suspeito</AlertTitle>
                <AlertDescription>
                  <div className="max-h-32 overflow-y-auto mt-2 space-y-1 text-xs">
                    {validacao.suspeitos.map((s) => (
                      <div key={s.id} className="font-mono">
                        {s.sku_omie} → {s.sku_portal ?? '(vazio)'}
                      </div>
                    ))}
                  </div>
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
