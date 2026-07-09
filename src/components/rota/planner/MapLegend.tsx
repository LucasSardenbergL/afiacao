// Legenda do mapa (Sub-PR 4, ponto E): decodifica cor=urgência / forma=tipo (§4).
// Colapsável — não rouba área do mapa no celular.
import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { TONE_CSS, type MarkerTone, type MarkerShape } from '@/lib/route/marker-visual';

interface ItemLegenda {
  tone: MarkerTone;
  shape: MarkerShape;
  label: string;
}

const ITENS: ItemLegenda[] = [
  { tone: 'success', shape: 'circle', label: 'Cliente — visitado ≤30d' },
  { tone: 'warning', shape: 'circle', label: 'Cliente — 31 a 90d' },
  { tone: 'error', shape: 'circle', label: 'Cliente — >90d' },
  { tone: 'neutral', shape: 'circle', label: 'Cliente — nunca visitado' },
  { tone: 'info', shape: 'diamond', label: 'Prospect — a contatar' },
  { tone: 'warning', shape: 'diamond', label: 'Prospect — sem resposta' },
  { tone: 'error', shape: 'diamond', label: 'Prospect — em conversa' },
];

function Glifo({ tone, shape }: { tone: MarkerTone; shape: MarkerShape }) {
  return (
    <span
      aria-hidden
      className="inline-block h-3 w-3 shrink-0 border border-white shadow-sm"
      style={{
        background: TONE_CSS[tone],
        borderRadius: shape === 'circle' ? '50%' : '2px',
        transform: shape === 'diamond' ? 'rotate(45deg)' : undefined,
      }}
    />
  );
}

export function MapLegend() {
  const [aberta, setAberta] = useState(false);
  return (
    <div className="border-t bg-muted/30 text-xs">
      <button
        type="button"
        onClick={() => setAberta((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={aberta}
      >
        <span>Legenda do mapa</span>
        {aberta ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
      {aberta && (
        <ul className="grid grid-cols-1 gap-1.5 px-3 pb-3 sm:grid-cols-2">
          {ITENS.map((it) => (
            <li key={`${it.tone}-${it.shape}-${it.label}`} className="flex items-center gap-2">
              <Glifo tone={it.tone} shape={it.shape} />
              <span className="text-muted-foreground">{it.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
