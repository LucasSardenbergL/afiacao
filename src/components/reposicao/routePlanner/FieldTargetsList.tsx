// Lista VIRTUALIZADA do universo de alvos (contexto campo). Divinópolis tem 600+
// alvos; renderizar todos os cards de uma vez trava. @tanstack/react-virtual só
// monta as linhas visíveis. Altura estimada ~64px/linha (FieldTargetCard denso).
import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FieldTargetCard } from './FieldTargetCard';
import type { RouteStop } from './types';

export function FieldTargetsList({
  stops,
  isNaRota,
  onToggleRota,
}: {
  stops: RouteStop[];
  isNaRota: (id: string) => boolean;
  onToggleRota: (id: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: stops.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 8,
  });

  return (
    <div ref={parentRef} className="max-h-[60vh] overflow-y-auto rounded-md">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const stop = stops[vi.index];
          return (
            <div
              key={stop.id}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
              className="pb-1.5"
            >
              <FieldTargetCard
                stop={stop}
                naRota={isNaRota(stop.id)}
                onToggleRota={() => onToggleRota(stop.id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
