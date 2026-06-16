// Lista de resultados de busca de cor (fórmulas na base atual).
// Extraída verbatim de src/components/TintColorSelectDialog.tsx (god-component split).
import { Palette } from 'lucide-react';
import type { FormulaResult } from './types';

interface FormulaSearchResultsProps {
  formulas: FormulaResult[];
  onSelect: (f: FormulaResult) => void;
}

export function FormulaSearchResults({ formulas, onSelect }: FormulaSearchResultsProps) {
  return (
    <div className="max-h-48 overflow-y-auto border rounded-md divide-y">
      {formulas.map(f => (
        <button
          key={f.id}
          onClick={() => onSelect(f)}
          className="w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors text-xs flex items-center gap-2"
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
