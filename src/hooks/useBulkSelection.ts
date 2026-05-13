import { useCallback, useMemo, useState } from 'react';

/**
 * Multi-seleção padrão para tabelas/listas:
 *  - Click simples: toggle individual
 *  - Shift+click: seleciona range (do último clicado até o atual, na ordem do array)
 *  - selectAll/clear/isAll/isSelected
 *  - Esc limpa (precisa ser conectado pela página via useShortcut)
 *
 * Uso:
 *   const sel = useBulkSelection(rows.map(r => r.id));
 *   <Checkbox checked={sel.isSelected(row.id)} onCheckedChange={(_, e) => sel.toggle(row.id, e)} />
 *   <BulkActionsBar count={sel.size} onClear={sel.clear} actions={[...]} />
 */
export interface BulkSelection<T extends string | number> {
  ids: T[];
  size: number;
  isSelected: (id: T) => boolean;
  isAll: boolean;
  toggle: (id: T, ev?: { shiftKey?: boolean }) => void;
  selectAll: () => void;
  clear: () => void;
  set: (ids: T[]) => void;
}

export function useBulkSelection<T extends string | number>(orderedIds: T[]): BulkSelection<T> {
  const [selected, setSelected] = useState<Set<T>>(() => new Set());
  const [lastTouched, setLastTouched] = useState<T | null>(null);

  const idsArray = useMemo(() => Array.from(selected), [selected]);

  const isSelected = useCallback((id: T) => selected.has(id), [selected]);
  const isAll = orderedIds.length > 0 && selected.size === orderedIds.length;

  const toggle = useCallback(
    (id: T, ev?: { shiftKey?: boolean }) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (ev?.shiftKey && lastTouched !== null) {
          // Range select
          const a = orderedIds.indexOf(lastTouched);
          const b = orderedIds.indexOf(id);
          if (a !== -1 && b !== -1) {
            const [start, end] = a < b ? [a, b] : [b, a];
            for (let i = start; i <= end; i++) next.add(orderedIds[i]);
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setLastTouched(id);
    },
    [orderedIds, lastTouched],
  );

  const selectAll = useCallback(() => {
    setSelected(new Set(orderedIds));
  }, [orderedIds]);

  const clear = useCallback(() => {
    setSelected(new Set());
    setLastTouched(null);
  }, []);

  const set = useCallback((ids: T[]) => {
    setSelected(new Set(ids));
  }, []);

  return {
    ids: idsArray,
    size: selected.size,
    isSelected,
    isAll,
    toggle,
    selectAll,
    clear,
    set,
  };
}
