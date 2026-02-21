import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Send, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';

interface Message {
  id: string;
  order_id: string;
  sender_id: string;
  message: string;
  is_staff: boolean;
  read_at: string | null;
  created_at: string;
}

interface OrderChatProps {
  orderId: string;
}

export function OrderChat({ orderId }: OrderChatProps) {
  const { user, isStaff } = useAuth();
  const { toast } = useToast();
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadMessages();

    // Subscribe to realtime messages
    const channel = supabase
      .channel(`order-messages-${orderId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'order_messages',
          filter: `order_id=eq.${orderId}`,
        },
        (payload) => {
          const newMsg = payload.new as Message;
          setMessages(prev => {
            if (prev.some(m => m.id === newMsg.id)) return prev;
            return [...prev, newMsg];
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [orderId]);

  const loadMessages = async () => {
    try {
      const { data, error } = await (supabase as any)
        .from('order_messages')
        .select('*')
        .eq('order_id', orderId)
        .order('created_at', { ascending: true });

      if (error) throw error;
      setMessages((data || []) as Message[]);
    } catch (error) {
      console.error('Error loading messages:', error);
    } finally {
      setLoading(false);
    }
  };

  const sendMessage = async () => {
    if (!newMessage.trim() || !user) return;
    setSending(true);

    try {
      const { error } = await (supabase as any).from('order_messages').insert({
        order_id: orderId,
        sender_id: user.id,
        message: newMessage.trim(),
        is_staff: !!isStaff,
      });

      if (error) throw error;
      setNewMessage('');
    } catch (error) {
      console.error('Error sending message:', error);
      toast({ title: 'Erro ao enviar mensagem', variant: 'destructive' });
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Messages */}
      <div className="max-h-64 overflow-y-auto space-y-2 p-1">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            Nenhuma mensagem ainda. Inicie a conversa!
          </p>
        )}
        {messages.map(msg => {
          const isOwn = msg.sender_id === user?.id;
          return (
            <div
              key={msg.id}
              className={cn(
                'flex flex-col max-w-[80%] rounded-2xl px-3 py-2',
                isOwn
                  ? 'ml-auto bg-primary text-primary-foreground rounded-br-md'
                  : 'mr-auto bg-muted text-foreground rounded-bl-md'
              )}
            >
              {!isOwn && (
                <span className="text-xs font-medium opacity-70 mb-0.5">
                  {msg.is_staff ? '👷 Equipe' : '👤 Cliente'}
                </span>
              )}
              <p className="text-sm whitespace-pre-wrap">{msg.message}</p>
              <span className={cn(
                'text-[10px] mt-1 self-end',
                isOwn ? 'text-primary-foreground/60' : 'text-muted-foreground'
              )}>
                {format(new Date(msg.created_at), 'HH:mm', { locale: ptBR })}
              </span>
            </div>
          );
        })}
      </div>

      {/* Input */}
      <div className="flex gap-2">
        <Textarea
          value={newMessage}
          onChange={e => setNewMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Digite sua mensagem..."
          rows={1}
          className="min-h-[40px] max-h-[80px] resize-none"
        />
        <Button
          size="icon"
          onClick={sendMessage}
          disabled={sending || !newMessage.trim()}
          className="flex-shrink-0"
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </Button>
      </div>
    </div>
  );
}
