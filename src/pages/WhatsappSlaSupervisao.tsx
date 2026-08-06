import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useWhatsappSla, type WaSlaRow } from '@/queries/useWhatsappSla';
import { useWhatsappFunil } from '@/hooks/useWhatsappFunil';
import { formatSlaWait } from '@/lib/whatsapp/sla-format';

// formatador local (padrão do repo: cada módulo tem o seu — evita aresta cross-módulo)
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

interface Grupo { ownerId: string | null; total: number; vermelhos: number; amarelos: number; pior: number; }

/** Funil do canal (PR-3): estágios agregados dos últimos 30 dias, atribuição por elo explícito. */
function FunilDoCanal() {
  const { data: funil, isLoading, isError } = useWhatsappFunil(30);

  if (isLoading) return <Card className="p-3"><Skeleton className="h-10 w-full" /></Card>;
  if (isError || !funil) {
    return (
      <Card className="p-3 text-xs text-muted-foreground">
        Funil do canal indisponível agora — não significa que não houve envios.
      </Card>
    );
  }

  const estagios: Array<{ label: string; valor: string; destaque?: string }> = [
    { label: 'Enviadas', valor: String(funil.enviados) },
    { label: 'Entregues', valor: String(funil.entregues) },
    { label: 'Lidas', valor: String(funil.lidos) },
    { label: 'Responderam', valor: String(funil.respondidos), destaque: 'text-status-success' },
    { label: 'Falhas', valor: String(funil.falhas), destaque: funil.falhas > 0 ? 'text-status-error' : undefined },
    { label: 'Propostas', valor: String(funil.propostas) },
    { label: 'Pedidos Omie', valor: String(funil.pedidosOmie), destaque: 'text-status-info' },
    // ausente ≠ zero: sem pedido com total conhecido mostra "—", nunca R$ 0
    { label: 'Receita', valor: funil.receitaOmie === null ? '—' : BRL.format(funil.receitaOmie) },
  ];

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-medium">Funil do canal — últimos 30 dias</div>
        <div className="text-[11px] text-muted-foreground">templates HSM</div>
      </div>
      <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
        {estagios.map((e) => (
          <div key={e.label}>
            <div className={`text-lg font-semibold tabular-nums ${e.destaque ?? ''}`}>{e.valor}</div>
            <div className="text-[11px] text-muted-foreground">{e.label}</div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Atribuição conservadora: proposta/pedido contam só com elo explícito à conversa
        (nasce no envio de proposta pela conversa — PR-4). Pedido por telefone não entra.
      </p>
    </Card>
  );
}

function agrupar(rows: WaSlaRow[]): Grupo[] {
  const map = new Map<string, Grupo>();
  for (const r of rows) {
    const key = r.owner_user_id ?? '__sem_dono__';
    const g = map.get(key) ?? { ownerId: r.owner_user_id, total: 0, vermelhos: 0, amarelos: 0, pior: 0 };
    g.total += 1;
    if (r.nivel === 'vermelho') g.vermelhos += 1;
    if (r.nivel === 'amarelo') g.amarelos += 1;
    g.pior = Math.max(g.pior, r.minutos_uteis_aguardando);
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => b.vermelhos - a.vermelhos || b.pior - a.pior);
}

export default function WhatsappSlaSupervisao() {
  const { isMaster, isGestorComercial } = useAuth();
  const { data: rows = [] } = useWhatsappSla();
  const grupos = useMemo(() => agrupar(rows), [rows]);

  const ownerIds = useMemo(
    () => [...new Set(rows.map((r) => r.owner_user_id).filter((x): x is string => !!x))],
    [rows],
  );
  const { data: nomes } = useQuery({
    queryKey: ['whatsapp-sla-owner-nomes', ownerIds],
    queryFn: async () => {
      const map: Record<string, string> = {};
      if (ownerIds.length === 0) return map;
      const { data } = await supabase.from('profiles').select('user_id,name').in('user_id', ownerIds);
      for (const p of (data ?? []) as Array<{ user_id: string; name: string | null }>) {
        if (p.name) map[p.user_id] = p.name;
      }
      return map;
    },
    enabled: ownerIds.length > 0,
    staleTime: 300000,
  });

  if (!isMaster && !isGestorComercial) {
    return <div className="container mx-auto p-4 text-sm text-muted-foreground">Acesso restrito a gestão.</div>;
  }

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">SLA do WhatsApp — supervisão</h1>
        <p className="text-xs text-muted-foreground">Clientes sem resposta, por vendedora. Atualiza ao vivo.</p>
      </div>
      <FunilDoCanal />
      {grupos.length === 0 ? (
        <Card className="p-4 text-sm text-muted-foreground">Nenhum cliente esperando agora. 👌</Card>
      ) : grupos.map((g) => (
        <Card key={g.ownerId ?? 'sem'} className={`p-3 flex items-center justify-between ${g.ownerId === null ? 'border-status-error/40' : ''}`}>
          <div>
            <div className="text-sm font-medium">
              {g.ownerId === null ? '⚠️ Sem dono (cliente sem carteira)' : (nomes?.[g.ownerId] ?? `Vendedora ${g.ownerId.slice(0, 8)}`)}
            </div>
            <div className="text-xs text-muted-foreground">
              {g.total} esperando · <span className="text-status-error">{g.vermelhos} atrasado(s)</span> · {g.amarelos} em atenção · pior {formatSlaWait(g.pior)}
            </div>
          </div>
          <Link to="/whatsapp" className="text-xs text-primary hover:underline">Inbox →</Link>
        </Card>
      ))}
    </div>
  );
}
