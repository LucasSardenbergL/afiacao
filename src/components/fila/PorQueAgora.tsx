// src/components/fila/PorQueAgora.tsx
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { track } from '@/lib/analytics';
import type { EvidencePack, SeveridadeSinal } from '@/lib/fila/critica/types';

const SEV_CLS: Record<SeveridadeSinal, string> = {
  critico: 'text-status-error',
  atencao: 'text-status-warning',
  info: 'text-status-info',
};

type Feedback = 'util' | 'errado' | 'ja_resolvi' | 'falta_dado';
const FEEDBACK_LABEL: Record<Feedback, string> = {
  util: 'Útil', errado: 'Errado', ja_resolvi: 'Já resolvi', falta_dado: 'Falta dado',
};

/** Bloco "Por que agora": badges de contradição + timeline expansível + feedback. */
export function PorQueAgora({ pack }: { pack: EvidencePack }) {
  const [aberto, setAberto] = useState(false);
  const [enviado, setEnviado] = useState<Feedback | null>(null);

  if (pack.contradicoes.length === 0) return null; // nada a mostrar → card normal

  const chaves = pack.contradicoes.map(c => c.chave);

  const onToggle = () => {
    const novo = !aberto;
    setAberto(novo);
    if (novo) track('fila.critica_opened', { cliente: pack.clienteUserId, chaves });
  };
  const onFeedback = (f: Feedback) => {
    setEnviado(f);
    track('fila.critica_feedback', { cliente: pack.clienteUserId, feedback: f, chaves });
  };

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap gap-1 items-center">
        {pack.contradicoes.map(c => (
          <Badge key={c.chave} variant="outline" className={`text-2xs ${SEV_CLS[c.evidencias[0]?.severidade ?? 'atencao']}`}>
            {c.texto}
          </Badge>
        ))}
        <button type="button" onClick={onToggle} className="text-2xs text-muted-foreground underline ml-1">
          {aberto ? 'ocultar' : 'por que agora'}
        </button>
      </div>

      {aberto && (
        <div className="mt-1.5 rounded-md border border-border bg-muted/20 p-2 space-y-1">
          <ul className="space-y-0.5">
            {pack.sinais.map((s, i) => (
              <li key={i} className={`text-2xs ${SEV_CLS[s.severidade]}`}>• {s.texto}</li>
            ))}
          </ul>
          {pack.faltaDado.length > 0 && (
            <div className="text-2xs text-muted-foreground">
              {pack.faltaDado.map((f, i) => <div key={i}>— {f}</div>)}
            </div>
          )}
          <div className="flex gap-1 pt-1">
            {(Object.keys(FEEDBACK_LABEL) as Feedback[]).map(f => (
              <Button
                key={f}
                size="sm"
                variant={enviado === f ? 'default' : 'outline'}
                className="h-6 text-2xs px-2"
                disabled={enviado != null}
                onClick={() => onFeedback(f)}
              >
                {FEEDBACK_LABEL[f]}
              </Button>
            ))}
            {enviado && <span className="text-2xs text-status-success self-center">obrigado</span>}
          </div>
        </div>
      )}
    </div>
  );
}
