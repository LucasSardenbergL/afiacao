// Lista de resultados de busca de cor (fórmulas na base atual).
// Extraída verbatim de src/components/TintColorSelectDialog.tsx (god-component split).
// Teclado: o FOCO fica no campo de busca; ↑↓ movem o realce (`realce`) e o Enter
// seleciona — o diálogo é quem ouve as teclas (aria-activedescendant aponta o item).
import { useEffect, useRef } from 'react';
import { Palette } from 'lucide-react';
import type { FormulaResult } from './types';

interface FormulaSearchResultsProps {
  formulas: FormulaResult[];
  onSelect: (f: FormulaResult) => void;
  /** Índice realçado pelo teclado (-1/ausente = nenhum). */
  realce?: number;
  /** Prefixo de id dos itens (aria-activedescendant do campo de busca). */
  idPrefixo?: string;
}

export function FormulaSearchResults({ formulas, onSelect, realce = -1, idPrefixo = 'tint-cor' }: FormulaSearchResultsProps) {
  const listaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (realce < 0) return;
    const el = listaRef.current?.querySelector<HTMLElement>(`[data-indice="${realce}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [realce]);

  return (
    <div ref={listaRef} role="listbox" className="max-h-48 overflow-y-auto border rounded-md divide-y">
      {formulas.map((f, i) => (
        <button
          key={f.id}
          id={`${idPrefixo}-${i}`}
          data-indice={i}
          role="option"
          aria-selected={i === realce}
          tabIndex={-1}
          onClick={() => onSelect(f)}
          className={`w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors text-xs flex items-center gap-2 ${i === realce ? 'bg-muted' : ''}`}
        >
          <Palette className="w-3 h-3 text-primary shrink-0" />
          <span className="font-mono font-medium">{f.cor_id}</span>
          <span className="text-muted-foreground">—</span>
          <span className="truncate">{f.nome_cor}</span>
        </button>
      ))}
    </div>
  );
}
