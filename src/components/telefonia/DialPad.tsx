// src/components/telefonia/DialPad.tsx
import { useState } from 'react';
import { Phone, Delete } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useCallBackend } from '@/hooks/useCallBackend';
import { formatBrPhone, normalizeBrPhone } from '@/lib/phone';

const KEYS = ['1','2','3','4','5','6','7','8','9','*','0','#'];

export function DialPad({ initialPhone = '' }: { initialPhone?: string }) {
  const [value, setValue] = useState(initialPhone);
  const [forceRecord, setForceRecord] = useState(false);
  const call = useCallBackend();
  const valid = normalizeBrPhone(value).length >= 10;

  return (
    <div className="w-full max-w-[240px] rounded-lg border border-border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">Discar</div>
      <div className="flex items-center gap-1">
        <Input value={value} onChange={(e) => setValue(e.target.value)}
          placeholder="número" className="text-center font-mono" />
        <Button size="icon" variant="ghost" className="h-9 w-9 shrink-0"
          onClick={() => setValue((v) => v.slice(0, -1))}><Delete className="h-4 w-4" /></Button>
      </div>
      <div className="grid grid-cols-3 gap-1.5 mt-2">
        {KEYS.map((k) => (
          <Button key={k} variant="outline" className="h-10" onClick={() => setValue((v) => v + k)}>{k}</Button>
        ))}
      </div>
      <div className="flex items-center justify-between mt-2 text-xs">
        <span className="text-muted-foreground">Gravar esta chamada</span>
        <Switch checked={forceRecord} onCheckedChange={setForceRecord} />
      </div>
      <Button className="w-full mt-2 bg-status-success hover:bg-status-success/90" disabled={!valid}
        onClick={() => call.makeCall(normalizeBrPhone(value), { forceRecord })}>
        <Phone className="h-4 w-4 mr-1.5" /> Ligar {valid ? formatBrPhone(value) : ''}
      </Button>
      <p className="text-[10px] text-center text-muted-foreground mt-1.5">
        backend: {call.backend.toUpperCase()} · cliente/fornecedor grava automático
      </p>
    </div>
  );
}
