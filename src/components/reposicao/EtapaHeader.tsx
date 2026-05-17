import { LucideIcon } from "lucide-react";

interface Props {
  step: number;
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}

export function EtapaHeader({ step, icon: Icon, title, subtitle, actions }: Props) {
  return (
    <header className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
      <div className="flex items-center gap-3">
        <Icon className="h-6 w-6 text-primary" />
        <div>
          {step > 0 && (
            <div className="text-[10px] font-semibold tracking-wider text-primary uppercase">
              Etapa {step}
            </div>
          )}
          <h1 className="text-2xl font-bold">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </header>
  );
}

