import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { CLASSE_TOM, type TomStatus } from '@/lib/radar/ui-helpers';

/**
 * O selo do Radar (pacote B3): a classe `rounded border px-1.5 py-px text-[11px] leading-4` + tom estava copiada
 * em ~14 lugares. Um componente só mantém o visual e o tom (`CLASSE_TOM`) coerentes na linha, na ficha e nos
 * filtros. `title` complementa no desktop — no toque ele é invisível, então o texto do selo tem de se bastar.
 */
export function Selo({
  tom = 'neutro',
  title,
  className,
  children,
  'data-testid': testId,
}: {
  tom?: TomStatus;
  title?: string;
  className?: string;
  children: ReactNode;
  'data-testid'?: string;
}) {
  return (
    <span
      className={cn('inline-block shrink-0 rounded border px-1.5 py-px text-[11px] leading-4', CLASSE_TOM[tom], className)}
      title={title}
      data-testid={testId}
    >
      {children}
    </span>
  );
}
