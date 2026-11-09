// Grade do cockpit COM arrastar-e-soltar. Mora num módulo à parte para o
// @hello-pangea/dnd sair do chunk da home: o CockpitGrid só importa este
// arquivo (lazy) na 1ª entrada no modo edição (F13 do plano v7).
// Depois de carregado, o CockpitGrid continua nesta variante mesmo fora da
// edição (isDragDisabled), exatamente como era antes do F13.
import type { ReactNode } from 'react';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import type { ZoneId } from '@/lib/dashboard/persona-config';
import { cn } from '@/lib/utils';

export interface CockpitGridArrastavelProps {
  zonas: ZoneId[];
  isEditMode: boolean;
  classeSecao: string;
  classeZona: string;
  onReorder: (de: number, para: number) => void;
  registrarRef: (i: number, el: HTMLDivElement | null) => void;
  renderZona: (zoneId: ZoneId, alcaProps: Record<string, unknown> | null) => ReactNode;
}

export default function CockpitGridArrastavel({
  zonas,
  isEditMode,
  classeSecao,
  classeZona,
  onReorder,
  registrarRef,
  renderZona,
}: CockpitGridArrastavelProps) {
  const handleDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    if (result.source.index === result.destination.index) return;
    onReorder(result.source.index, result.destination.index);
  };

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <Droppable droppableId="cockpit-grid" direction="horizontal" isDropDisabled={!isEditMode}>
        {(droppableProvided) => (
          <section
            id="cockpit-grid"
            ref={droppableProvided.innerRef}
            {...droppableProvided.droppableProps}
            className={classeSecao}
          >
            {zonas.map((zoneId, i) => (
              <Draggable key={zoneId} draggableId={zoneId} index={i} isDragDisabled={!isEditMode}>
                {(provided, snapshot) => (
                  <div
                    ref={(el) => {
                      provided.innerRef(el);
                      registrarRef(i, el);
                    }}
                    {...provided.draggableProps}
                    className={cn(
                      classeZona,
                      snapshot.isDragging && 'shadow-xl ring-2 ring-primary/50 opacity-95',
                    )}
                  >
                    {renderZona(zoneId, (provided.dragHandleProps ?? null) as Record<string, unknown> | null)}
                  </div>
                )}
              </Draggable>
            ))}
            {droppableProvided.placeholder}
          </section>
        )}
      </Droppable>
    </DragDropContext>
  );
}
