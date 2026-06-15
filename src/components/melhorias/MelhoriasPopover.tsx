// src/components/melhorias/MelhoriasPopover.tsx
// Toggle "Minhas melhorias" no topo: badge de não-resolvidos + popover com a
// lista enxuta, atalho de Reportar (MelhoriaDialog) e "Ver todas" (/melhorias).
// Substituiu o item do menu lateral + a lâmpada solta da topbar (decisão Lucas, 2026-06-15).
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lightbulb, Plus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { MelhoriaDialog } from '@/components/melhorias/MelhoriaDialog';
import { MelhoriaStatusBadge } from '@/components/melhorias/MelhoriaStatusBadge';
import { useMeusMelhoriaItens } from '@/hooks/useMelhorias';
import { contarMelhoriasNaoResolvidas } from '@/lib/melhorias/badge-helpers';

const MAX_LISTA = 6;

function fmtData(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export function MelhoriasPopover() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data: itens, isLoading } = useMeusMelhoriaItens();

  const naoResolvidos = contarMelhoriasNaoResolvidas(itens ?? []);
  const recentes = (itens ?? []).slice(0, MAX_LISTA);

  const abrirReportar = () => {
    setOpen(false);
    setDialogOpen(true);
  };

  const irParaPagina = () => {
    setOpen(false);
    navigate('/melhorias');
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="relative h-8 w-8 text-muted-foreground"
            aria-label={
              naoResolvidos > 0
                ? `Minhas melhorias — ${naoResolvidos} em aberto`
                : 'Minhas melhorias'
            }
          >
            <Lightbulb className="w-4 h-4" />
            {naoResolvidos > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
                {naoResolvidos > 9 ? '9+' : naoResolvidos}
              </span>
            )}
          </Button>
        </PopoverTrigger>

        <PopoverContent align="end" className="w-80 p-2">
          {/* Cabeçalho */}
          <div className="flex items-center justify-between gap-2 border-b px-1 pb-2">
            <p className="text-sm font-semibold">Minhas melhorias</p>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={abrirReportar}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Reportar
            </Button>
          </div>

          {/* Conteúdo */}
          <div className="py-1">
            {isLoading ? (
              <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
              </div>
            ) : recentes.length === 0 ? (
              <div className="px-2 py-6 text-center">
                <Lightbulb className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
                <p className="text-sm font-medium">Nenhuma melhoria ainda</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Reporte um problema ou sugestão — a IA avalia e o Lucas recebe na hora.
                </p>
              </div>
            ) : (
              <ul className="space-y-0.5">
                {recentes.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={irParaPagina}
                      className="flex w-full items-start gap-2 rounded-md p-2 text-left transition-colors hover:bg-muted/60"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {item.titulo ?? 'Aguardando avaliação…'}
                        </p>
                        <div className="mt-1 flex items-center gap-1.5">
                          <MelhoriaStatusBadge status={item.status} />
                          <span className="text-xs text-muted-foreground">
                            {fmtData(item.created_at)}
                          </span>
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Rodapé */}
          <div className="border-t pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-center text-xs"
              onClick={irParaPagina}
            >
              Ver todas
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <MelhoriaDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
