import { useMemo, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { useWhatsappConversations, useWhatsappThread } from '@/queries/useWhatsappInbox';
import { useWhatsappSla } from '@/queries/useWhatsappSla';
import { SlaBadge } from '@/components/whatsapp/SlaBadge';
import { useSendWhatsapp } from '@/hooks/useSendWhatsapp';
import { isOptimisticMessage } from '@/lib/whatsapp/thread-cache';
import { formatBrPhone } from '@/lib/phone';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';

/**
 * Form de resposta com estado PRÓPRIO: digitar não re-renderiza a lista de
 * conversas (até 200 itens) nem a thread — antes o draft vivia na page e cada
 * tecla re-executava os dois maps. O draft limpa NO CLIQUE (a mensagem
 * otimista já apareceu na thread via useSendWhatsapp.onMutate) e é restaurado
 * se o envio falhar (sem sobrescrever o que o usuário já re-digitou).
 */
function ReplyForm({ conversationId }: { conversationId: string }) {
  const send = useSendWhatsapp(conversationId);
  const [draft, setDraft] = useState('');
  return (
    <form
      className="p-3 border-t flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const t = draft.trim();
        if (!t) return;
        setDraft('');
        send.mutate(t, { onError: () => setDraft((cur) => cur || t) });
      }}
    >
      <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Responder…" autoFocus />
      <Button type="submit">Enviar</Button>
    </form>
  );
}

const ConversationsSkeleton = () => (
  <div className="p-3 space-y-3">
    {[0, 1, 2, 3, 4].map((i) => (
      <div key={i} className="space-y-1.5">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    ))}
  </div>
);

export default function WhatsappInbox() {
  const conversationsQuery = useWhatsappConversations();
  const conversations = conversationsQuery.data ?? [];
  const { data: slaRows = [] } = useWhatsappSla();
  const slaByConv = useMemo(
    () => new Map(slaRows.map((r) => [r.conversation_id, r])),
    [slaRows],
  );
  const [activeId, setActiveId] = useState<string | undefined>();
  const threadQuery = useWhatsappThread(activeId);
  const messages = threadQuery.data ?? [];

  return (
    <div className="flex h-[calc(100vh-3rem)]">
      <aside className="w-80 border-r overflow-y-auto">
        {conversationsQuery.isLoading ? (
          // Loading ≠ vazio: o "Sem conversas" durante o fetch escondia
          // cliente esperando resposta (SLA de 15/30min em jogo).
          <ConversationsSkeleton />
        ) : conversationsQuery.isError ? (
          <EmptyState tone="operational" icon={MessageCircle} title="Não consegui carregar"
            description="Falha ao buscar as conversas — não significa que não há clientes esperando."
            actionLabel="Tentar de novo" onAction={() => conversationsQuery.refetch()} />
        ) : conversations.length === 0 ? (
          <EmptyState tone="operational" icon={MessageCircle} title="Sem conversas"
            description="As conversas aparecem quando um cliente responde." />
        ) : conversations.map((c) => {
          const sla = slaByConv.get(c.id);
          return (
            <button key={c.id} onClick={() => setActiveId(c.id)}
              className={`block w-full text-left p-3 border-b hover:bg-muted ${activeId === c.id ? 'bg-muted' : ''}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium truncate">{c.contact_name ?? formatBrPhone(c.phone_e164)}</div>
                {sla && <SlaBadge minutos={sla.minutos_uteis_aguardando} nivel={sla.nivel} />}
              </div>
              <div className="text-xs text-muted-foreground">{c.status}{c.customer_user_id ? '' : ' · sem cadastro'}</div>
            </button>
          );
        })}
      </aside>
      <main className="flex-1 flex flex-col">
        {!activeId ? (
          <EmptyState tone="operational" icon={MessageCircle} title="Selecione uma conversa" description="" />
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {threadQuery.isError ? (
                <EmptyState tone="operational" icon={MessageCircle} title="Não consegui carregar a conversa"
                  description="" actionLabel="Tentar de novo" onAction={() => threadQuery.refetch()} />
              ) : (
                messages.map((m) => (
                  <div
                    key={m.id}
                    className={`max-w-[70%] rounded p-2 text-sm ${m.direction === 'out' ? 'ml-auto bg-primary text-primary-foreground' : 'bg-muted'} ${isOptimisticMessage(m) ? 'opacity-60' : ''}`}
                  >
                    {m.type === 'text' ? m.body : `[${m.type}]`}
                  </div>
                ))
              )}
            </div>
            {/* key por conversa: troca de conversa zera o draft */}
            <ReplyForm key={activeId} conversationId={activeId} />
          </>
        )}
      </main>
    </div>
  );
}
