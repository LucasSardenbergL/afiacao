// Dialog de validação dos mapeamentos SKU.
// Extraído verbatim de src/pages/AdminSkuMapeamento.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AlertTriangle, CheckCircle2, Loader2, Wand2 } from 'lucide-react';
import type { ValidacaoResult } from './types';
import type { SugestaoSegura } from '@/lib/reposicao/sayerlack-sku';

interface ValidacaoDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  validando: boolean;
  validacao: ValidacaoResult | null;
  gravarSeguros: (seguros: SugestaoSegura[]) => void;
  gravandoSeguros: boolean;
}

export function ValidacaoDialog({ open, onOpenChange, validando, validacao, gravarSeguros, gravandoSeguros }: ValidacaoDialogProps) {
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

            {validacao.sugestoes && validacao.gabarito && (
              <div className="rounded-md border border-status-info/40 bg-status-info-bg p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Wand2 className="h-4 w-4 text-status-info" />
                  Auto-preenchimento (código embutido na descrição)
                </div>
                <div className="text-xs text-muted-foreground">
                  Gate: o parser reproduz <b>{validacao.gabarito.batem}</b> de{' '}
                  {validacao.gabarito.batem + validacao.gabarito.divergem.length + validacao.gabarito.naoValidavel} mapeamentos manuais
                  {validacao.gabarito.divergem.length > 0 && (
                    <> · <span className="text-status-warning">{validacao.gabarito.divergem.length} divergência(s) pra revisar</span></>
                  )}
                </div>
                {validacao.gabarito.divergem.length > 0 && (
                  <div className="max-h-24 overflow-y-auto text-xs font-mono space-y-0.5 text-status-warning">
                    {validacao.gabarito.divergem.map((d) => (
                      <div key={d.sku_omie}>{d.sku_omie}: salvo <b>{d.salvo}</b> ≠ extraído <b>{d.extraido}</b></div>
                    ))}
                  </div>
                )}
                {validacao.sugestoes.seguros.length > 0 ? (
                  <>
                    <div className="max-h-40 overflow-y-auto text-xs font-mono space-y-0.5 border-t pt-2">
                      {validacao.sugestoes.seguros.map((s) => (
                        <div key={s.sku_omie}>{s.sku_omie} → <b>{s.sku_portal}</b> <span className="text-muted-foreground">({s.sufixo})</span></div>
                      ))}
                    </div>
                    {(validacao.gabarito?.divergem.length ?? 0) > 0 ? (
                      // GATE money-path: se o parser DIVERGE de algum mapeamento manual, não auto-gravar
                      // em lote — gravar agora arriscaria de-para errado (PO errado no fornecedor).
                      <div className="text-xs text-status-warning border-t pt-2">
                        Auto-gravação bloqueada: resolva as {validacao.gabarito!.divergem.length} divergência(s) do gabarito
                        acima antes de gravar em lote (o parser discorda de um mapeamento manual existente).
                      </div>
                    ) : (
                      <Button size="sm" onClick={() => gravarSeguros(validacao.sugestoes!.seguros)} disabled={gravandoSeguros}>
                        {gravandoSeguros ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Wand2 className="h-4 w-4 mr-1" />}
                        Gravar {validacao.sugestoes.seguros.length} automaticamente (fator 1 · revise)
                      </Button>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-muted-foreground border-t pt-2">Nenhum código novo extraível dos faltantes.</div>
                )}
                {(validacao.sugestoes.semCodigo.length > 0 || validacao.sugestoes.multiplos.length > 0) && (
                  <div className="text-xs text-muted-foreground">
                    Revisão manual: {validacao.sugestoes.semCodigo.length} sem código · {validacao.sugestoes.multiplos.length} com múltiplos códigos
                  </div>
                )}
              </div>
            )}

            {validacao.faltantesMotor.length > 0 ? (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{validacao.faltantesMotor.length} SKU(s) que o motor pode pedir sem de-para no portal</AlertTitle>
                <AlertDescription>
                  <div className="text-xs mt-1 mb-2">
                    Compráveis pela reposição automática e sem mapeamento ativo — o disparo falharia
                    com "erro_nao_retentavel". {validacao.faltantes.length} também aparecem no histórico de pedidos.
                  </div>
                  <div className="max-h-48 overflow-y-auto space-y-1 text-xs">
                    {validacao.faltantesMotor.map((f) => (
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
                <AlertTitle>Nenhum SKU comprável pelo motor está sem mapeamento</AlertTitle>
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
