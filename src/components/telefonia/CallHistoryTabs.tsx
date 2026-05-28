// src/components/telefonia/CallHistoryTabs.tsx
import { useMemo, useEffect } from 'react';
import { Phone } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useCallLog, useAcknowledgeMissed, type CallLogTab } from '@/hooks/useCallLog';
import { CallHistoryRow } from './CallHistoryRow';
import { EmptyState } from '@/components/EmptyState';

const TABS: { id: CallLogTab; label: string }[] = [
  { id: 'recentes', label: 'Recentes' },
  { id: 'recebidas', label: 'Recebidas' },
  { id: 'perdidas', label: 'Perdidas' },
  { id: 'feitas', label: 'Feitas' },
];

export function CallHistoryTabs({
  userId, tab, onTabChange, onCallBack, isManager,
}: {
  userId: string | undefined; tab: CallLogTab; onTabChange: (t: CallLogTab) => void;
  onCallBack: (phone: string, name?: string) => void; isManager: boolean;
}) {
  const { data: rows = [], isLoading } = useCallLog(tab, userId);
  const ack = useAcknowledgeMissed(userId);

  // Ao abrir a aba Perdidas, marca como lidas (zera badge)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'perdidas') ack.mutate(); }, [tab]);

  const allTabs = useMemo(() => isManager ? [...TABS, { id: 'time' as CallLogTab, label: 'Time' }] : TABS, [isManager]);

  return (
    <Tabs value={tab} onValueChange={(v) => onTabChange(v as CallLogTab)}>
      <TabsList>{allTabs.map((t) => <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>)}</TabsList>
      <TabsContent value={tab} className="mt-3">
        {isLoading ? <p className="text-sm text-muted-foreground py-6 text-center">Carregando…</p>
          : rows.length === 0 ? <EmptyState tone="operational" icon={Phone} title="Sem chamadas" description="Nada por aqui ainda." />
          : rows.map((r) => <CallHistoryRow key={r.id} row={r} onCallBack={onCallBack} />)}
      </TabsContent>
    </Tabs>
  );
}
