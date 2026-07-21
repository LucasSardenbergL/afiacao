// Mini-seletor de fonte de preço (calculado × tabela) de uma embalagem alternativa
// (Fase 2b-fix): a escolha que o card principal dá para a cor selecionada, replicada
// nas "outras embalagens" e na busca global. Só renderiza quando AMBAS as fontes têm
// valor — a validação do override (fonte sem valor → default; sem preço confiável →
// nenhuma escolha) mora em selectAltPrice, não aqui.
import type { AltPriceDisplay, AltPriceSource } from '@/lib/tint/select-price';

// Formata BRL local — não importar o `fmt` de useUnifiedOrder (vendas): aresta nova
// tintometrico→vendas é barrada pelo gate de fronteiras (a dívida existente é baseline).
const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

interface AltPriceSourcePickerProps {
  formulaId: string;
  altSel: AltPriceDisplay;
  /** Canônica da alternativa é SL → rótulo "Tabela (versão anterior)" (a view
   *  garante a proveniência desde a 20260722100002); ausente/false → "Tabela". */
  isSl?: boolean | null;
  setOverride: (formulaId: string, source: AltPriceSource) => void;
  className?: string;
}

export function AltPriceSourcePicker({ formulaId, altSel, isSl, setOverride, className }: AltPriceSourcePickerProps) {
  if (altSel.precoCalc == null || altSel.precoTabela == null) return null;
  const fontes: { key: AltPriceSource; label: string; preco: number }[] = [
    { key: 'calculado', label: 'Calculado', preco: altSel.precoCalc },
    { key: 'tabela', label: isSl ? 'Tabela (versão anterior)' : 'Tabela', preco: altSel.precoTabela },
  ];
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`}>
      {fontes.map((f) => (
        <button
          key={f.key}
          type="button"
          onClick={() => setOverride(formulaId, f.key)}
          className={`px-1.5 py-0.5 rounded border text-[10px] transition-all ${altSel.fonte === f.key ? 'border-primary bg-primary/10 text-primary font-semibold' : 'border-border text-muted-foreground hover:border-primary/50'}`}
        >
          {f.label} {fmt(f.preco)}
        </button>
      ))}
    </div>
  );
}
