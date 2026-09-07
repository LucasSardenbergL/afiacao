import { useState } from 'react';
import { useCustomerCalls, type CustomerCallRow } from '@/hooks/useCustomerCalls';
import { CallSessionRow } from './CallSessionRow';
import { CallSessionDetail } from './CallSessionDetail';
import { Loader2 } from 'lucide-react';
import { estadoDeLeitura, naoConsegui } from '@/lib/leitura/estado-de-leitura';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';

export function CustomerCallsTab({ customerId }: { customerId: string }) {
  // Desestruturação DIRETA nomeando `status`/`fetchStatus`: um `const q = useX()` faria o
  // sítio sumir do gate da classe por CEGUEIRA, não por conserto.
  const { data, status, fetchStatus, isLoading } = useCustomerCalls(customerId);
  const leitura = estadoDeLeitura({ status, fetchStatus });
  const [selected, setSelected] = useState<CustomerCallRow | null>(null);

  // ANTES do loading: sem rede a query fica pending+paused e `isLoading` é FALSE — o 4º
  // estado cairia no "Nenhuma chamada com transcript ainda".
  if (naoConsegui(leitura)) {
    return (
      <div className="py-4">
        <AvisoLeituraFalhou oque="as chamadas deste cliente" estado={leitura} testId="aviso-chamadas" />
      </div>
    );
  }

  if (isLoading) {
    return <div className="flex items-center justify-center py-8 text-xs text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin mr-2"/>Carregando…</div>;
  }

  if (!data || data.length === 0) {
    return (
      <div className="text-center py-8 text-xs text-muted-foreground">
        Nenhuma chamada com transcript ainda. As próximas ligações via copilot serão registradas aqui automaticamente.
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2">
        {data.map((call) => (
          <CallSessionRow key={call.id} call={call} onClick={() => setSelected(call)} />
        ))}
      </div>
      <CallSessionDetail call={selected} onClose={() => setSelected(null)} />
    </>
  );
}
