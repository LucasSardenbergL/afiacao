import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function CockpitCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Card
      className={cn(
        'flex flex-col h-[320px] overflow-hidden border border-border hover:border-foreground/15 transition-colors',
        className,
      )}
    >
      {children}
    </Card>
  );
}
