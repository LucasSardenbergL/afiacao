import { useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { useWhatsappConversations, useWhatsappThread } from '@/queries/useWhatsappInbox';
import { useSendWhatsapp } from '@/hooks/useSendWhatsapp';
import { formatBrPhone } from '@/lib/phone';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/EmptyState';

export default function WhatsappInbox() {
  const { data: conversations = [] } = useWhatsappConversations();
  const [activeId, setActiveId] = useState<string | undefined>();
  const { data: messages = [] } = useWhatsappThread(activeId);
  const send = useSendWhatsapp(activeId);
  const [draft, setDraft] = useState('');

  return (
    <div className="flex h-[calc(100vh-3rem)]">
      <aside className="w-80 border-r overflow-y-auto">
        {conversations.length === 0 ? (
          <EmptyState
            tone="operational"
            icon={MessageCircle}
            title="Sem conversas"
            description="As conversas aparecem quando um cliente responde."
          />
        ) : conversations.map((c) => (
          <button key={c.id} onClick={() => setActiveId(c.id)}
            className={`block w-full text-left p-3 border-b hover:bg-muted ${activeId === c.id ? 'bg-muted' : ''}`}>
            <div className="font-medium">{c.contact_name ?? formatBrPhone(c.phone_e164)}</div>
            <div className="text-xs text-muted-foreground">{c.status}{c.customer_user_id ? '' : ' · sem cadastro'}</div>
          </button>
        ))}
      </aside>
      <main className="flex-1 flex flex-col">
        {!activeId ? (
          <EmptyState
            tone="operational"
            icon={MessageCircle}
            title="Selecione uma conversa"
            description=""
          />
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {messages.map((m) => (
                <div key={m.id} className={`max-w-[70%] rounded p-2 text-sm ${m.direction === 'out' ? 'ml-auto bg-primary text-primary-foreground' : 'bg-muted'}`}>
                  {m.type === 'text' ? m.body : `[${m.type}]`}
                </div>
              ))}
            </div>
            <form className="p-3 border-t flex gap-2"
              onSubmit={(e) => { e.preventDefault(); const t = draft.trim(); if (t) send.mutate(t, { onSuccess: () => setDraft('') }); }}>
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Responder…" />
              <Button type="submit" disabled={send.isPending}>Enviar</Button>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
