import { camposFaltantes } from '@/lib/knowledge-base/completude';
import { rotularCampo } from '@/lib/knowledge-base/campo-labels';
import type { KbProductSpec } from '@/lib/knowledge-base/specs-types';
import { AlertTriangle } from 'lucide-react';

/**
 * Aviso discreto na ficha atual quando há campos importantes faltando (Fase B1, bônus).
 * Retorna null quando a ficha está completa nos campos importantes.
 */
export function CompletudeBadge({ spec }: { spec: KbProductSpec | null | undefined }) {
  if (!spec) return null;
  const faltantes = camposFaltantes(spec);
  if (faltantes.length === 0) return null;
  const plural = faltantes.length > 1;
  return (
    <div className="flex items-start gap-1.5 text-2xs text-status-warning pt-2 border-t border-border">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>
        {faltantes.length} dado{plural ? 's' : ''} importante{plural ? 's' : ''} faltando:{' '}
        <span className="text-muted-foreground">{faltantes.map(rotularCampo).join(' · ')}</span>
      </span>
    </div>
  );
}
