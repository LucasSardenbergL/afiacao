import { useState, useEffect, type ChangeEvent } from 'react';
import { Settings2, ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouteDisparoConfig, useUpdateRouteDisparoConfig } from '@/queries/useRouteDisparoConfig';
import { configToForm, formToConfig } from '@/lib/whatsapp/disparo-config';
import type { ConfigForm } from '@/lib/whatsapp/disparo-config';

const EMPTY: ConfigForm = {
  disparoInicio: '07:30', disparoCorte: '15:30', metaTierCap: '1000',
  winBackReservaPercent: '20', coldStartPisoDia: '3', capacidadeLigacoesDia: '40', cadenciaMinDias: '3',
};

function Campo({ id, label, value, onChange, hint, type = 'number' }: {
  id: string; label: string; value: string; onChange: (e: ChangeEvent<HTMLInputElement>) => void; hint?: string; type?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input id={id} type={type} value={value} onChange={onChange} className="h-8" />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Tela de tuning (master-only) dos parâmetros da lista de ligação + disparo. Self-gated por isMaster. */
export function RouteDisparoConfigPanel() {
  const { isMaster } = useAuth();
  const { data } = useRouteDisparoConfig();
  const update = useUpdateRouteDisparoConfig();
  const [aberto, setAberto] = useState(false);
  const [form, setForm] = useState<ConfigForm>(EMPTY);

  useEffect(() => { if (data) setForm(configToForm(data)); }, [data]);

  if (!isMaster) return null;

  const set = (k: keyof ConfigForm) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const salvar = () => {
    update.mutate(formToConfig(form), {
      onSuccess: () => toast.success('Parâmetros salvos — a lista re-ranqueia.'),
      onError: (err) => toast.error(`Falha ao salvar: ${err instanceof Error ? err.message : 'erro'}`),
    });
  };

  return (
    <Card className="p-3">
      <button
        type="button"
        onClick={() => setAberto(a => !a)}
        className="flex items-center gap-2 w-full text-left text-sm font-medium"
      >
        <Settings2 className="w-4 h-4 text-muted-foreground" />
        Configurar parâmetros
        <span className="text-xs font-normal text-muted-foreground">(master)</span>
        {aberto ? <ChevronUp className="w-4 h-4 ml-auto" /> : <ChevronDown className="w-4 h-4 ml-auto" />}
      </button>

      {aberto && (
        <div className="mt-3 space-y-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Lista de ligação (ao vivo)</div>
            <div className="grid grid-cols-2 gap-3">
              <Campo id="capacidadeLigacoesDia" label="Ligações/dia (por vendedora)" value={form.capacidadeLigacoesDia} onChange={set('capacidadeLigacoesDia')} />
              <Campo id="winBackReservaPercent" label="Reserva win-back (%)" hint="0–100" value={form.winBackReservaPercent} onChange={set('winBackReservaPercent')} />
              <Campo id="coldStartPisoDia" label="Piso de novos clientes/dia" value={form.coldStartPisoDia} onChange={set('coldStartPisoDia')} />
              <Campo id="cadenciaMinDias" label="Cadência mínima (dias)" value={form.cadenciaMinDias} onChange={set('cadenciaMinDias')} />
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Disparo WhatsApp (ativa no PR2b-send)</div>
            <div className="grid grid-cols-2 gap-3">
              <Campo id="disparoInicio" label="Início do disparo" type="time" value={form.disparoInicio} onChange={set('disparoInicio')} />
              <Campo id="disparoCorte" label="Corte do disparo" type="time" value={form.disparoCorte} onChange={set('disparoCorte')} />
              <Campo id="metaTierCap" label="Teto Meta (msgs/24h)" value={form.metaTierCap} onChange={set('metaTierCap')} />
            </div>
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={salvar} disabled={update.isPending}>
              {update.isPending ? 'Salvando…' : 'Salvar'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
