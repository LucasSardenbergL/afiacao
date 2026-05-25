// Modal de detalhes de um trimestre (checkin + snapshots).
// Extraído verbatim de src/components/des/HistoricoTab.tsx (god-component split).
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fmtBRL, fmtPct, fmtDate } from "./format";
import type { QuarterCard } from "./types";

interface DetalhesDialogProps {
  detalhes: QuarterCard | null;
  onOpenChange: (open: boolean) => void;
}

export function DetalhesDialog({ detalhes: detalhesOpen, onOpenChange }: DetalhesDialogProps) {
  return (
    <Dialog open={!!detalhesOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        {detalhesOpen && (
          <>
            <DialogHeader>
              <DialogTitle>
                Detalhes T{detalhesOpen.trimestre}/{detalhesOpen.ano}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Período</p>
                  <p>{fmtDate(detalhesOpen.inicio)} a {fmtDate(detalhesOpen.fim)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Meta pessoal</p>
                  <p>{fmtBRL(detalhesOpen.meta)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Faturado</p>
                  <p>{fmtBRL(detalhesOpen.faturado)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Faixa DES</p>
                  <p>{detalhesOpen.faixaEstrelas} estrelas</p>
                </div>
              </div>

              {detalhesOpen.ultimoCheckin && (
                <div className="border-t border-border pt-3">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    Último checkin ({detalhesOpen.ultimoCheckin.tipo})
                  </p>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <p className="text-muted-foreground">Data</p>
                      <p>{fmtDate(detalhesOpen.ultimoCheckin.data_avaliacao)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Desconto padrão</p>
                      <p>{fmtPct(detalhesOpen.ultimoCheckin.desconto_padrao)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Qualitativos atingidos</p>
                      <p>{fmtPct(detalhesOpen.ultimoCheckin.qualitativos_atingidos_perc)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Bônus</p>
                      <p>{fmtPct(detalhesOpen.ultimoCheckin.bonus_atingido_perc)}</p>
                    </div>
                    <div className="col-span-2">
                      <p className="text-muted-foreground">Desconto total projetado</p>
                      <p className="font-semibold text-base">
                        {fmtPct(detalhesOpen.ultimoCheckin.desconto_total_projetado)}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {detalhesOpen.snapshots.length > 0 && (
                <div className="border-t border-border pt-3">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    Snapshots GoodData ({detalhesOpen.snapshots.length})
                  </p>
                  <div className="space-y-1 text-xs">
                    {detalhesOpen.snapshots.slice(0, 5).map((s, i) => (
                      <div key={i} className="flex items-center justify-between py-1 border-b border-border/40 last:border-0">
                        <span>{fmtDate(s.data_referencia)}</span>
                        <span className="font-medium">{fmtBRL(s.fat_bruto_valor)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
