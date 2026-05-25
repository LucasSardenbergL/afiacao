// Chips multi-select de status do SLA.
// Extraído verbatim de src/pages/AdminReposicaoSlaFornecedor.tsx (god-component split).
import { STATUS_LABEL } from "./config";
import type { SlaStatus } from "./types";

interface StatusChipsProps {
  filtroStatus: SlaStatus[];
  onToggle: (s: SlaStatus) => void;
}

export function StatusChips({ filtroStatus, onToggle }: StatusChipsProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <span className="text-xs text-muted-foreground self-center mr-1">Status:</span>
      {(["cumprindo", "limite", "violando", "critico", "poucos_dados", "sem_sla_teorico"] as SlaStatus[]).map(
        (s) => {
          const active = filtroStatus.includes(s);
          return (
            <button
              key={s}
              onClick={() => onToggle(s)}
              className={`text-xs px-2 py-1 rounded-full border transition-colors ${
                active
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground border-border hover:bg-muted"
              }`}
            >
              {STATUS_LABEL[s]}
            </button>
          );
        },
      )}
    </div>
  );
}
