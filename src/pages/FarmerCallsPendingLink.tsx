import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useLinkCallToCustomer } from '@/hooks/useLinkCallToCustomer';
import { ilikeOr, isSearchablePostgrestTerm } from '@/lib/postgrest';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface Pending {
  id: string;
  phone_dialed: string | null;
  started_at: string;
  duration_seconds: number | null;
}

interface ProfileMatch {
  user_id: string;
  name: string;
  phone: string | null;
}

export default function FarmerCallsPendingLink() {
  // Lente "Ver como": a lista de chamadas pendentes exibida segue o id efetivo (o ALVO
  // na lente, o próprio usuário fora). O vínculo (mutation) é write — bloqueado na lente
  // pelo write-guard + botão "Vincular cliente" disabled.
  const { effectiveUserId, isImpersonating } = useImpersonation();
  const { data, refetch } = useQuery({
    queryKey: ['farmer-pending-link', effectiveUserId],
    enabled: !!effectiveUserId,
    queryFn: async (): Promise<Pending[]> => {

      const { data, error } = await supabase.from('farmer_calls')
        .select('id, phone_dialed, started_at, duration_seconds')
        .eq('farmer_id', effectiveUserId!)
        .is('customer_user_id', null)
        .not('transcript', 'is', null)
        .order('started_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as Pending[];
    },
  });

  return (
    <div className="container mx-auto p-4 space-y-3">
      <h1 className="text-xl font-semibold">Chamadas pendentes de vínculo</h1>
      <p className="text-xs text-muted-foreground">
        Chamadas com transcript salvo mas sem cliente vinculado. Vincule pra
        elas aparecerem no histórico do cliente.
      </p>

      {!data || data.length === 0 ? (
        <Card className="p-8 text-center text-xs text-muted-foreground">
          Nenhuma chamada pendente — todas estão vinculadas a clientes.
        </Card>
      ) : (
        <div className="space-y-2">
          {data.map((p) => (
            <PendingRow key={p.id} pending={p} onLinked={refetch} disabled={isImpersonating} />
          ))}
        </div>
      )}
    </div>
  );
}

function PendingRow({
  pending,
  onLinked,
  disabled,
}: {
  pending: Pending;
  onLinked: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const link = useLinkCallToCustomer();

  const { data: profiles } = useQuery({
    queryKey: ['profiles-search', search],
    enabled: open && search.length >= 2,
    queryFn: async (): Promise<ProfileMatch[]> => {
      // só-wildcard (`**`, passa o length>=2) → `.or()` match-all dos profiles (#1062); busca vazia
      if (!isSearchablePostgrestTerm(search)) return [];
      // `search` é input do usuário — ilikeOr sanitiza (anti-injeção PostgREST)
      const { data } = await supabase.from('profiles')
        .select('user_id, name, phone')
        .or(ilikeOr(['name', 'phone'], search))
        .limit(10);
      return (data ?? []) as ProfileMatch[];
    },
  });

  return (
    <Card className="p-3 flex items-center justify-between gap-3">
      <div>
        <div className="text-sm font-medium">
          {pending.phone_dialed ?? 'Sem telefone'}
        </div>
        <div className="text-2xs text-muted-foreground">
          {formatDistanceToNow(new Date(pending.started_at), {
            locale: ptBR,
            addSuffix: true,
          })}
          {pending.duration_seconds &&
            ` · ${Math.floor(pending.duration_seconds / 60)}min`}
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            title={disabled ? 'Indisponível em modo Ver como' : undefined}
          >
            Vincular cliente
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Vincular a um cliente</DialogTitle>
          </DialogHeader>
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Busque por nome ou telefone…"
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              <CommandEmpty>
                {search.length < 2
                  ? 'Digite ao menos 2 caracteres'
                  : 'Nenhum cliente encontrado'}
              </CommandEmpty>
              {(profiles ?? []).map((p) => (
                <CommandItem
                  key={p.user_id}
                  value={p.user_id}
                  onSelect={() => {
                    link.mutate(
                      { callId: pending.id, customerUserId: p.user_id },
                      {
                        onSuccess: () => {
                          setOpen(false);
                          setSearch('');
                          onLinked();
                        },
                      },
                    );
                  }}
                >
                  <div>
                    <div className="text-sm">{p.name}</div>
                    <div className="text-2xs text-muted-foreground">
                      {p.phone ?? '—'}
                    </div>
                  </div>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
