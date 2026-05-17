import { useEffect, useRef } from 'react';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import { Eye, GripVertical, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { VendasZone } from './zones/VendasZone';
import { EstoqueZone } from './zones/EstoqueZone';
import { ReposicaoZone } from './zones/ReposicaoZone';
import { FinanceiroZone } from './zones/FinanceiroZone';
import { TintometricoZone } from './zones/TintometricoZone';
import { SistemaZone } from './zones/SistemaZone';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';
import { useDashboardEditMode } from '@/contexts/DashboardEditModeContext';
import { useDashboardLayout } from '@/hooks/useDashboardLayout';
import { type ZoneId } from '@/lib/dashboard/persona-config';
import { ZONE_META } from '@/lib/dashboard/zone-meta';
import { cn } from '@/lib/utils';

const ZONE_COMPONENTS: Record<ZoneId, () => JSX.Element> = {
  vendas: VendasZone,
  estoque: EstoqueZone,
  reposicao: ReposicaoZone,
  financeiro: FinanceiroZone,
  tintometrico: TintometricoZone,
  sistema: SistemaZone,
};

export function CockpitGrid() {
  const { persona } = useDashboardPersonaContext();
  const { isEditMode, exit } = useDashboardEditMode();
  const { visibleZones, hiddenZones, isCustomized, reorder, hide, show, reset } = useDashboardLayout(persona);

  // Refs pros atalhos 1..6 (scroll-to + outline temporário)
  const refs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    // Atalhos 1..6 desativados em edit mode (evita conflito com drag)
    if (isEditMode) return;

    const handler = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (n >= 1 && n <= 6) {
        const ref = refs.current[n - 1];
        if (!ref) return;
        ref.scrollIntoView({ behavior: 'smooth', block: 'center' });
        ref.classList.add('ring-2', 'ring-foreground/20');
        setTimeout(() => ref?.classList.remove('ring-2', 'ring-foreground/20'), 1200);
      }
    };
    const guarded = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return handler(e);
      const tag = target.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target.isContentEditable) return;
      handler(e);
    };
    window.addEventListener('keydown', guarded);
    return () => window.removeEventListener('keydown', guarded);
  }, [isEditMode]);

  // Esc sai do edit mode
  useEffect(() => {
    if (!isEditMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exit();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isEditMode, exit]);

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    if (result.source.index === result.destination.index) return;
    reorder(result.source.index, result.destination.index);
  };

  return (
    <>
      {isEditMode && (
        <EditModeBanner
          isCustomized={isCustomized}
          hiddenZones={hiddenZones}
          onReset={reset}
          onShow={show}
          onDone={exit}
        />
      )}
      <DragDropContext onDragEnd={handleDragEnd}>
        <Droppable droppableId="cockpit-grid" direction="horizontal" isDropDisabled={!isEditMode}>
          {(droppableProvided) => (
            <section
              id="cockpit-grid"
              ref={droppableProvided.innerRef}
              {...droppableProvided.droppableProps}
              className={cn(
                'max-w-7xl mx-auto px-4 lg:px-6 py-6 lg:py-8',
                'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4',
                isEditMode && 'ring-2 ring-primary/30 ring-offset-4 rounded-lg',
              )}
            >
              {visibleZones.map((zoneId, i) => {
                const Comp = ZONE_COMPONENTS[zoneId];
                return (
                  <Draggable
                    key={zoneId}
                    draggableId={zoneId}
                    index={i}
                    isDragDisabled={!isEditMode}
                  >
                    {(provided, snapshot) => (
                      <div
                        ref={(el) => {
                          provided.innerRef(el);
                          refs.current[i] = el;
                        }}
                        {...provided.draggableProps}
                        className={cn(
                          'rounded-lg transition-shadow relative',
                          snapshot.isDragging && 'shadow-xl ring-2 ring-primary/50 opacity-95',
                        )}
                      >
                        {isEditMode && (
                          <div className="absolute -top-2 -right-2 z-10 flex gap-1">
                            <button
                              type="button"
                              onClick={() => hide(zoneId)}
                              aria-label={`Esconder ${ZONE_META[zoneId].label}`}
                              className="h-7 w-7 rounded-full bg-destructive text-destructive-foreground shadow-md flex items-center justify-center hover:scale-110 transition-transform"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                            <div
                              {...provided.dragHandleProps}
                              aria-label={`Arrastar ${ZONE_META[zoneId].label}`}
                              className="h-7 w-7 rounded-full bg-foreground text-background shadow-md flex items-center justify-center cursor-grab active:cursor-grabbing"
                            >
                              <GripVertical className="w-3.5 h-3.5" />
                            </div>
                          </div>
                        )}
                        <Comp />
                      </div>
                    )}
                  </Draggable>
                );
              })}
              {droppableProvided.placeholder}
            </section>
          )}
        </Droppable>
      </DragDropContext>
    </>
  );
}

function EditModeBanner({
  isCustomized,
  hiddenZones,
  onReset,
  onShow,
  onDone,
}: {
  isCustomized: boolean;
  hiddenZones: ZoneId[];
  onReset: () => void;
  onShow: (z: ZoneId) => void;
  onDone: () => void;
}) {
  return (
    <div className="max-w-7xl mx-auto px-4 lg:px-6 pt-4">
      <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-0 text-xs text-foreground">
          <span className="font-semibold">Editando dashboard:</span>{' '}
          arraste pelas alças (cinza) pra reordenar · X (vermelho) pra esconder ·{' '}
          <kbd className="px-1 rounded bg-muted text-[10px]">Esc</kbd> ou
          <b> Concluir</b> pra sair.
        </div>
        {hiddenZones.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-[11px] text-muted-foreground">Escondidas:</span>
            {hiddenZones.map((z) => (
              <button
                key={z}
                type="button"
                onClick={() => onShow(z)}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-background border border-border hover:border-primary/40 transition-colors"
              >
                <Eye className="w-3 h-3" />
                {ZONE_META[z].label}
              </button>
            ))}
          </div>
        )}
        {isCustomized && (
          <Button variant="ghost" size="sm" onClick={onReset} className="h-7 text-xs">
            <RotateCcw className="w-3 h-3 mr-1" />
            Restaurar padrão
          </Button>
        )}
        <Button size="sm" onClick={onDone} className="h-7 text-xs">
          Concluir
        </Button>
      </div>
    </div>
  );
}
