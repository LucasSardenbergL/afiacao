import { useState } from 'react';
import { useCustomerCalls, type CustomerCallRow } from '@/hooks/useCustomerCalls';
import { CallSessionRow } from './CallSessionRow';
import { CallSessionDetail } from './CallSessionDetail';
import { Loader2 } from 'lucide-react';

export function CustomerCallsTab({ customerId }: { customerId: string }) {
  const { data, isLoading } = useCustomerCalls(customerId);
  const [selected, setSelected] = useState<CustomerCallRow | null>(null);

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
