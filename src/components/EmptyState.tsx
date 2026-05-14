import { Button } from '@/components/ui/button';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tone = 'operational' | 'friendly';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  helpHref?: string;
  helpLabel?: string;
  className?: string;
  /** "operational" (default, B2B denso) ou "friendly" (cliente final / onboarding) */
  tone?: Tone;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  helpHref,
  helpLabel,
  className,
  tone = 'operational',
}: EmptyStateProps) {
  if (tone === 'friendly') {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center text-center py-10 px-6',
          'bg-card rounded-2xl border border-border',
          className,
        )}
      >
        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
          <Icon className="w-7 h-7 text-muted-foreground" />
        </div>
        <h3 className="font-semibold text-base text-foreground mb-1">{title}</h3>
        <p className="text-sm text-muted-foreground max-w-[280px] leading-relaxed mb-5">
          {description}
        </p>
        {actionLabel && onAction && (
          <Button size="default" onClick={onAction}>
            {actionLabel}
          </Button>
        )}
        {helpHref && (
          <a
            href={helpHref}
            className="mt-3 text-xs text-link-level hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            {helpLabel ?? 'Saiba mais'}
          </a>
        )}
      </div>
    );
  }

  // Operational (B2B default): denso, sem motion. Padrão de pontos decorativo SUTIL no fundo
  // (dots 1px com ~6% opacity) — dá identidade sem distrair.
  return (
    <div
      className={cn(
        'relative flex flex-col items-center justify-center text-center py-8 px-4 overflow-hidden',
        className,
      )}
    >
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none opacity-[0.06]"
        style={{
          backgroundImage: 'radial-gradient(currentColor 1px, transparent 1px)',
          backgroundSize: '14px 14px',
          maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 70%)',
          WebkitMaskImage: 'radial-gradient(ellipse at center, black 30%, transparent 70%)',
        }}
      />
      <Icon className="relative w-8 h-8 text-muted-foreground/60 mb-3" />
      <h3 className="relative text-sm font-semibold text-foreground mb-1">{title}</h3>
      <p className="relative text-sm text-muted-foreground max-w-[360px] leading-snug mb-4">
        {description}
      </p>
      <div className="relative flex items-center gap-2">
        {actionLabel && onAction && (
          <Button size="sm" onClick={onAction}>
            {actionLabel}
          </Button>
        )}
        {secondaryActionLabel && onSecondaryAction && (
          <Button size="sm" variant="outline" onClick={onSecondaryAction}>
            {secondaryActionLabel}
          </Button>
        )}
      </div>
      {helpHref && (
        <a
          href={helpHref}
          className="relative mt-3 text-xs text-link-level hover:underline"
          target="_blank"
          rel="noreferrer"
        >
          {helpLabel ?? 'Saiba mais'}
        </a>
      )}
    </div>
  );
}
