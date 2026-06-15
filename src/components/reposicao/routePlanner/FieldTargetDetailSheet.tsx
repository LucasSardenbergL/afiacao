// Sheet de detalhe do alvo (contexto campo, ponto B). Renderiza o view-model
// AlvoDetalhe (montado pelo hook): razão social + CNPJ + status (prospect) ou
// recência (carteira), endereço completo e os telefones com Ligar (tel:) / WhatsApp
// (wa.me). Rodapé: adicionar/remover da rota + remover da sessão (ponto F).
import { Plus, Check, Phone, MessageCircle, Trash2, MapPin } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { STOP_CONFIG } from './constants';
import type { RouteStop } from './types';
import type { AlvoDetalhe } from '@/lib/route/alvo-detalhe';

export function FieldTargetDetailSheet({
  stop,
  detalhe,
  naRota,
  onToggleRota,
  onRemover,
  onOpenChange,
}: {
  stop: RouteStop | null;
  detalhe: AlvoDetalhe | null;
  naRota: boolean;
  onToggleRota: () => void;
  onRemover: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const open = stop != null && detalhe != null;
  const cfg = stop ? STOP_CONFIG[stop.stopType] : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        {detalhe && (
          <>
            <SheetHeader className="text-left">
              <div className="flex items-center gap-2 flex-wrap">
                <SheetTitle className="text-lg">{detalhe.nome}</SheetTitle>
                {cfg && (
                  <Badge className={`text-[10px] px-1.5 py-0 ${cfg.bgClass} border-0`}>
                    {cfg.label}
                  </Badge>
                )}
              </div>
              {detalhe.subtitulo && (
                <SheetDescription className="text-xs">{detalhe.subtitulo}</SheetDescription>
              )}
            </SheetHeader>

            <div className="space-y-4 py-4 text-sm">
              {/* Identificação (prospect) / recência (carteira) */}
              <div className="space-y-1.5">
                {detalhe.cnpjFormatado && (
                  <p className="text-muted-foreground">
                    CNPJ <span className="text-foreground tabular-nums">{detalhe.cnpjFormatado}</span>
                  </p>
                )}
                {detalhe.statusLabel && (
                  <p className="text-muted-foreground">
                    Status <span className="text-foreground">{detalhe.statusLabel}</span>
                  </p>
                )}
                {detalhe.recenciaLabel && (
                  <p className="text-muted-foreground">{detalhe.recenciaLabel}</p>
                )}
              </div>

              <Separator />

              {/* Endereço */}
              <div className="flex gap-2">
                <MapPin className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  {detalhe.enderecoLinhas.length > 0 ? (
                    detalhe.enderecoLinhas.map((linha, i) => (
                      <p key={i} className="text-foreground">{linha}</p>
                    ))
                  ) : (
                    <p className="text-muted-foreground">Endereço não informado</p>
                  )}
                </div>
              </div>

              {/* Contatos */}
              {detalhe.contatos.length > 0 && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    {detalhe.contatos.map((c) => (
                      <div key={c.rotulo} className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-[11px] text-muted-foreground">{c.rotulo}</p>
                          <p className="text-foreground tabular-nums truncate">{c.display}</p>
                        </div>
                        <Button size="sm" variant="outline" className="h-8 gap-1 shrink-0" asChild>
                          <a href={c.telHref} aria-label={`Ligar ${c.display}`}>
                            <Phone className="w-3.5 h-3.5" /> Ligar
                          </a>
                        </Button>
                        {c.whatsappHref && (
                          <Button size="sm" variant="outline" className="h-8 gap-1 shrink-0" asChild>
                            <a href={c.whatsappHref} target="_blank" rel="noopener noreferrer" aria-label={`WhatsApp ${c.display}`}>
                              <MessageCircle className="w-3.5 h-3.5" /> WhatsApp
                            </a>
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <SheetFooter className="flex-row gap-2 sm:flex-row">
              <Button
                variant={naRota ? 'default' : 'outline'}
                className="flex-1 gap-1"
                onClick={onToggleRota}
              >
                {naRota ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                {naRota ? 'Na rota' : 'Adicionar à rota'}
              </Button>
              <Button
                variant="ghost"
                className="gap-1 text-muted-foreground hover:text-status-error"
                onClick={onRemover}
                aria-label="Remover da sessão"
              >
                <Trash2 className="w-4 h-4" /> Remover
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
