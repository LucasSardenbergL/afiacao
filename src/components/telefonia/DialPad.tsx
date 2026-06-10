// src/components/telefonia/DialPad.tsx
import { useState } from 'react';
import { Phone, Delete } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { formatBrPhone, normalizeBrPhone } from '@/lib/phone';

const KEYS = ['1','2','3','4','5','6','7','8','9','*','0','#'];

export interface DialPadProps {
  initialPhone?: string;
  /** Inicia a chamada via backend (NVOIP/WebRTC). Dono da sessão é a página. */
  onCall: (phone: string, opts: { forceRecord: boolean }) => void;
  /** Backend ativo, só pra rótulo informativo. */
  backend: string;
  /** Desabilita o botão "Ligar" enquanto há chamada em andamento. */
  busy?: boolean;
}

export function DialPad({ initialPhone = '', onCall, backend, busy = false }: DialPadProps) {
  const [value, setValue] = useState(initialPhone);
  // Política (founder, 2026-06-09): gravação OBRIGATÓRIA na Central de Telefonia —
  // o switch é a exceção ("cliente pediu pra não gravar") e re-arma a cada chamada.
  const [forceRecord, setForceRecord] = useState(true);
  const normalized = normalizeBrPhone(value);
  const valid = normalized.length >= 10;

  return (
    <div className="w-full max-w-[260px] rounded-lg border border-border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">Discar</div>
      <div className="flex items-center gap-1">
        <Input value={value} onChange={(e) => setValue(e.target.value)}
          inputMode="tel" placeholder="número" className="text-center font-mono" />
        <Button size="icon" variant="ghost" className="h-11 w-11 shrink-0"
          aria-label="Apagar último dígito"
          onClick={() => setValue((v) => v.slice(0, -1))}><Delete className="h-4 w-4" /></Button>
      </div>
      <div className="grid grid-cols-3 gap-1.5 mt-2">
        {KEYS.map((k) => (
          <Button key={k} variant="outline" className="h-12 text-base" onClick={() => setValue((v) => v + k)}>{k}</Button>
        ))}
      </div>
      <div className="flex items-center justify-between mt-2 text-xs">
        <span className="text-muted-foreground">Gravação da chamada</span>
        <Switch checked={forceRecord} onCheckedChange={setForceRecord} aria-label="Gravação da chamada" />
      </div>
      {/* Número fica numa linha NÃO-interativa — fora do label do botão pra não
          virar <a href="tel:"> auto-detectado pelo iOS (abriria o app Telefone do SO). */}
      {valid && (
        <p className="mt-2 text-center font-mono text-sm tabular-nums" aria-hidden="true">
          {formatBrPhone(value)}
        </p>
      )}
      <Button className="w-full mt-2 h-12 bg-status-success hover:bg-status-success/90"
        disabled={!valid || busy}
        aria-label={valid ? `Ligar para ${formatBrPhone(value)}` : 'Ligar'}
        onClick={() => {
          onCall(normalized, { forceRecord });
          // Re-arma: o opt-out vale só pra ESTA chamada — não vaza pra próxima.
          setForceRecord(true);
        }}>
        <Phone className="h-4 w-4 mr-1.5" /> {busy ? 'Em chamada…' : 'Ligar'}
      </Button>
      <p className="text-[10px] text-center text-muted-foreground mt-1.5">
        backend: {backend.toUpperCase()} · gravação obrigatória — desligue só a pedido do cliente
      </p>
    </div>
  );
}
