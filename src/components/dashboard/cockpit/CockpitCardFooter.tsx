import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { track } from '@/lib/analytics';
import type { ZoneId } from '@/lib/dashboard/persona-config';
import type { Persona } from '@/lib/dashboard/persona-config';

export function CockpitCardFooter({
  zone,
  persona,
  label,
  path,
}: {
  zone: ZoneId;
  persona: Persona;
  label: string;
  path: string;
}) {
  const navigate = useNavigate();
  return (
    <footer className="border-t border-border/60">
      <button
        onClick={() => {
          track('dashboard.zone.open_cockpit', { zone, persona });
          navigate(path);
        }}
        className="w-full py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors flex items-center justify-center gap-1.5 group"
      >
        {label}
        <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
      </button>
    </footer>
  );
}
