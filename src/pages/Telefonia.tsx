// src/pages/Telefonia.tsx
import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { DialPad } from '@/components/telefonia/DialPad';
import { CallHistoryTabs } from '@/components/telefonia/CallHistoryTabs';
import { useCallBackend } from '@/hooks/useCallBackend';
import { useIsTelefoniaManager } from '@/hooks/useIsTelefoniaManager';
import type { CallLogTab } from '@/hooks/useCallLog';

export default function Telefonia() {
  const { user } = useAuth();
  const [tab, setTab] = useState<CallLogTab>('recentes');
  const [dialPrefill, setDialPrefill] = useState('');
  const call = useCallBackend();
  const isManager = useIsTelefoniaManager();

  return (
    <div className="container py-6">
      <h1 className="text-xl font-semibold mb-4">Central de Telefonia</h1>
      <div className="flex flex-col md:flex-row gap-4">
        <DialPad key={dialPrefill} initialPhone={dialPrefill} />
        <div className="flex-1 rounded-lg border border-border bg-card p-3">
          <CallHistoryTabs
            userId={user?.id} tab={tab} onTabChange={setTab}
            isManager={isManager}
            onCallBack={(phone) => { setDialPrefill(phone); call.makeCall(phone); }}
          />
        </div>
      </div>
    </div>
  );
}
