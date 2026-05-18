# PR-MULTIVENDOR-4-ROLES — Dashboards por role + Agenda de Hoje

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Vendedor abre o app e vê **dashboard adaptado ao seu papel comercial** (Farmer / Hunter / Closer / Master). Cada um tem KPIs, agenda e fluxos diferentes — mas reusa toda a infra existente (`farmer_client_scores`, `farmer_calls`, `customer_segments`, `commercial_roles`).

**MVP enxuto** — entregar shell funcional dos 4 dashboards + Farmer completo (suas 2 atuais). Hunter/Closer/Master ficam como placeholder rico "em construção" pra próximo PR (PR-MULTIVENDOR-V2).

**Architecture:**
- Migration: `ALTER TYPE commercial_role ADD VALUE` pra adicionar `farmer`, `hunter`, `closer`, `master` (aditivo, não quebra valores antigos)
- Hook `useCommercialRole()` retorna role do user logado (busca em `commercial_roles`)
- Hook `useMyCarteiraScores()` busca `farmer_client_scores` filtrado por `farmer_id = current_user.id`
- Hook `useMyAgendaToday()` deriva top N clientes da agenda (priority_score DESC, limit 10) com tipo de ação (risco/expansão/follow-up)
- Hook `useMyKpis()` deriva KPIs do dia: chamadas feitas, receita gerada, ticket médio, próx ligação
- Componente `CommercialDashboard` (refactor de FarmerDashboard) — renderiza componente apropriado por role
- Componentes: `FarmerDashboardV2`, `HunterDashboard`, `CloserDashboard`, `MasterDashboard`
- Componente `AgendaTodayList` — lista priorizada com botão `[📞 Ligar agora]` que dispara `webrtc.makeCall(phone)`

**Não-objetivos (próximos sub-PRs):**
- Cadência inteligente de relacionamento (PR-CADENCE)
- Sugestões de visita pra Closer com rota geo (PR-VISIT-INTELLIGENCE — já no roadmap)
- Sinais do copilot alimentando scoring (PR-SCORING-V2 — já no roadmap)
- Hunter pipeline kanban completo (PR-HUNTER-PIPELINE)
- Encaminhamento "pedir visita do Closer" (PR-VISIT-REQUEST)

---

## File Structure

**Criar:**
- `supabase/migrations/{ts}_commercial_role_add_values.sql` — ADD ENUM values
- `src/hooks/useCommercialRole.ts`
- `src/hooks/useMyCarteiraScores.ts`
- `src/hooks/useMyAgendaToday.ts`
- `src/hooks/useMyKpis.ts`
- `src/components/dashboard/CommercialDashboard.tsx` — shell switch por role
- `src/components/dashboard/FarmerDashboardV2.tsx`
- `src/components/dashboard/HunterDashboard.tsx`
- `src/components/dashboard/CloserDashboard.tsx`
- `src/components/dashboard/MasterDashboard.tsx`
- `src/components/dashboard/AgendaTodayList.tsx`
- `src/components/dashboard/KpisToday.tsx`

**Modificar:**
- `src/pages/FarmerDashboard.tsx` — vira wrapper de `<CommercialDashboard />`
- `src/integrations/supabase/types.ts` — adicionar valores novos ao enum

---

## Pré-requisito do operador

1. Rodar migration SQL (ADD ENUM VALUE, é trivial)
2. **Atribuir role pros vendedores existentes** via Supabase SQL Editor:
   ```sql
   INSERT INTO commercial_roles (user_id, commercial_role)
   VALUES ('uuid-vendedora-1', 'farmer'), ('uuid-vendedora-2', 'farmer'), ('uuid-lucas', 'master')
   ON CONFLICT (user_id) DO UPDATE SET commercial_role = EXCLUDED.commercial_role;
   ```
   (Se já tem `operacional`, vai precisar atualizar pra `farmer`.)

---

## Tasks (executar em ordem)

### Task 1: Migration (ADD ENUM VALUES)

```sql
-- ADD valores ao enum commercial_role (aditivo, mantém 'operacional', 'gerencial', 'estrategico', 'super_admin')
ALTER TYPE public.commercial_role ADD VALUE IF NOT EXISTS 'farmer';
ALTER TYPE public.commercial_role ADD VALUE IF NOT EXISTS 'hunter';
ALTER TYPE public.commercial_role ADD VALUE IF NOT EXISTS 'closer';
ALTER TYPE public.commercial_role ADD VALUE IF NOT EXISTS 'master';

COMMENT ON TYPE public.commercial_role IS
  'Papel comercial — farmer/hunter/closer/master (PR-MULTIVENDOR) ou operacional/gerencial/estrategico/super_admin (legado).';
```

### Task 2: Hooks (4)

```ts
// useCommercialRole.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export type CommercialRole = 'farmer' | 'hunter' | 'closer' | 'master' | 'operacional' | 'gerencial' | 'estrategico' | 'super_admin' | null;

export function useCommercialRole() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['commercial-role', user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<CommercialRole> => {
      if (!user) return null;
      const { data } = await supabase
        .from('commercial_roles')
        .select('commercial_role')
        .eq('user_id', user.id)
        .maybeSingle();
      return (data?.commercial_role ?? null) as CommercialRole;
    },
  });
}
```

```ts
// useMyCarteiraScores.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export function useMyCarteiraScores() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-carteira-scores', user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from('farmer_client_scores')
        .select('*')
        .eq('farmer_id', user.id)
        .order('priority_score', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });
}
```

```ts
// useMyAgendaToday.ts
import { useMemo } from 'react';
import { useMyCarteiraScores } from './useMyCarteiraScores';

export interface AgendaItem {
  customer_user_id: string;
  customer_phone: string | null;
  priority_score: number;
  health_class: string | null;
  agenda_type: 'risco' | 'expansao' | 'follow_up';
  customer_name?: string;
}

/** Top 10 da carteira priorizado por priority_score, classificado por agenda_type */
export function useMyAgendaToday(limit = 10) {
  const { data, isLoading } = useMyCarteiraScores();

  const agenda: AgendaItem[] = useMemo(() => {
    if (!data) return [];
    return data.slice(0, limit).map((s) => {
      let agenda_type: AgendaItem['agenda_type'] = 'follow_up';
      if ((s.churn_risk ?? 0) > 0.5 || s.health_class === 'critico' || s.health_class === 'atencao') {
        agenda_type = 'risco';
      } else if ((s.expansion_score ?? 0) > 0.5) {
        agenda_type = 'expansao';
      }
      return {
        customer_user_id: s.customer_user_id,
        customer_phone: null, // hidratamos separadamente
        priority_score: s.priority_score ?? 0,
        health_class: s.health_class,
        agenda_type,
      };
    });
  }, [data, limit]);

  return { agenda, isLoading };
}
```

```ts
// useMyKpis.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export interface FarmerKpis {
  calls_today: number;
  revenue_today: number;
  margin_today: number;
  avg_ticket_today: number;
  pending_link_count: number;
}

export function useMyKpis() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-kpis', user?.id],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async (): Promise<FarmerKpis> => {
      if (!user) return { calls_today: 0, revenue_today: 0, margin_today: 0, avg_ticket_today: 0, pending_link_count: 0 };
      const todayIso = new Date().toISOString().slice(0, 10);
      const { data: calls } = await supabase
        .from('farmer_calls')
        .select('revenue_generated, margin_generated')
        .eq('farmer_id', user.id)
        .gte('started_at', todayIso);
      const callsArr = calls ?? [];
      const revenue = callsArr.reduce((s, c) => s + Number(c.revenue_generated ?? 0), 0);
      const margin = callsArr.reduce((s, c) => s + Number(c.margin_generated ?? 0), 0);
      const withRevenue = callsArr.filter((c) => Number(c.revenue_generated ?? 0) > 0);

      const { count: pending } = await supabase
        .from('farmer_calls')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .select('id', { count: 'exact', head: true } as any)
        .eq('farmer_id', user.id)
        .is('customer_user_id', null)
        .not('transcript', 'is', null);

      return {
        calls_today: callsArr.length,
        revenue_today: revenue,
        margin_today: margin,
        avg_ticket_today: withRevenue.length > 0 ? revenue / withRevenue.length : 0,
        pending_link_count: pending ?? 0,
      };
    },
  });
}
```

### Task 3: Componentes

```tsx
// AgendaTodayList.tsx
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Phone, AlertTriangle, TrendingUp, Clock, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useMyAgendaToday } from '@/hooks/useMyAgendaToday';
import { useWebRTCCallContext } from '@/contexts/WebRTCCallContext';
import { toast } from 'sonner';

const AGENDA_TYPE: Record<string, { label: string; icon: typeof Phone; color: string }> = {
  risco: { label: 'Risco', icon: AlertTriangle, color: 'text-status-error' },
  expansao: { label: 'Expansão', icon: TrendingUp, color: 'text-status-success' },
  follow_up: { label: 'Follow-up', icon: Clock, color: 'text-status-info' },
};

export function AgendaTodayList() {
  const { agenda, isLoading } = useMyAgendaToday(10);
  const { makeCall } = useWebRTCCallContext();

  // Hydrate phones em batch
  const { data: phoneMap } = useQuery({
    queryKey: ['agenda-phones', agenda.map((a) => a.customer_user_id).join(',')],
    enabled: agenda.length > 0,
    queryFn: async (): Promise<Record<string, { name: string; phone: string | null }>> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase.from('profiles') as any)
        .select('user_id, name, razao_social, phone')
        .in('user_id', agenda.map((a) => a.customer_user_id));
      const map: Record<string, { name: string; phone: string | null }> = {};
      for (const p of data ?? []) {
        map[p.user_id] = { name: p.razao_social || p.name || 'Cliente', phone: p.phone };
      }
      return map;
    },
  });

  if (isLoading) {
    return (
      <Card className="p-6 flex justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </Card>
    );
  }

  if (agenda.length === 0) {
    return (
      <Card className="p-6 text-center text-xs text-muted-foreground">
        Sem clientes na agenda de hoje. Recalcule o scoring no Farmer.
      </Card>
    );
  }

  const handleCall = async (phone: string | null) => {
    if (!phone) {
      toast.error('Cliente sem telefone cadastrado');
      return;
    }
    try {
      await makeCall(phone);
      toast.success('Discando...');
    } catch (err) {
      toast.error('Erro ao discar', { description: err instanceof Error ? err.message : '' });
    }
  };

  return (
    <Card className="divide-y divide-border">
      {agenda.map((item) => {
        const meta = AGENDA_TYPE[item.agenda_type];
        const Icon = meta.icon;
        const info = phoneMap?.[item.customer_user_id];
        return (
          <div key={item.customer_user_id} className="p-3 flex items-center gap-3 hover:bg-muted/30">
            <Icon className={`w-4 h-4 ${meta.color} shrink-0`} />
            <Link
              to={`/admin/customers/${item.customer_user_id}`}
              className="flex-1 min-w-0"
            >
              <div className="text-sm font-medium truncate">{info?.name ?? '…'}</div>
              <div className="text-2xs text-muted-foreground flex items-center gap-2">
                <Badge variant="outline" className="text-2xs">{meta.label}</Badge>
                {item.health_class && (
                  <span>health: {item.health_class}</span>
                )}
                <span>priority: {item.priority_score.toFixed(0)}</span>
              </div>
            </Link>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 shrink-0"
              onClick={() => handleCall(info?.phone ?? null)}
              disabled={!info?.phone}
            >
              <Phone className="w-3.5 h-3.5" />
              Ligar
            </Button>
          </div>
        );
      })}
    </Card>
  );
}
```

```tsx
// KpisToday.tsx
import { Card } from '@/components/ui/card';
import { Phone, DollarSign, TrendingUp, Link2, Loader2 } from 'lucide-react';
import { useMyKpis } from '@/hooks/useMyKpis';
import { Link } from 'react-router-dom';

export function KpisToday() {
  const { data: k, isLoading } = useMyKpis();
  if (isLoading || !k) {
    return <Card className="p-4 flex justify-center"><Loader2 className="w-4 h-4 animate-spin" /></Card>;
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Kpi icon={Phone} label="Chamadas hoje" value={String(k.calls_today)} />
      <Kpi icon={DollarSign} label="Receita hoje" value={`R$ ${k.revenue_today.toLocaleString('pt-BR')}`} />
      <Kpi icon={TrendingUp} label="Ticket médio" value={k.avg_ticket_today > 0 ? `R$ ${Math.round(k.avg_ticket_today).toLocaleString('pt-BR')}` : '—'} />
      <Link to="/farmer/calls/pending-link">
        <Kpi icon={Link2} label="Pendentes de vínculo" value={String(k.pending_link_count)} clickable />
      </Link>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, clickable }: { icon: typeof Phone; label: string; value: string; clickable?: boolean }) {
  return (
    <Card className={`p-3 space-y-1 ${clickable ? 'hover:bg-muted/40 cursor-pointer transition-colors' : ''}`}>
      <div className="flex items-center gap-1 text-2xs uppercase tracking-wide text-muted-foreground">
        <Icon className="w-3 h-3" />{label}
      </div>
      <div className="text-base font-medium tabular-nums">{value}</div>
    </Card>
  );
}
```

```tsx
// FarmerDashboardV2.tsx
import { KpisToday } from './KpisToday';
import { AgendaTodayList } from './AgendaTodayList';
import { Card } from '@/components/ui/card';
import { Calendar } from 'lucide-react';

export function FarmerDashboardV2() {
  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">Meu dia</h1>
        <p className="text-xs text-muted-foreground">
          Agenda priorizada da sua carteira. Foque em risco e expansão primeiro.
        </p>
      </div>

      <KpisToday />

      <Card className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-status-warning" />
          <h2 className="text-sm font-semibold">Agenda de hoje (top 10)</h2>
        </div>
        <p className="text-2xs text-muted-foreground">
          Priorizada por priority_score do farmer_client_scores. Clique no nome pra ficha; clique Ligar pra disparar chamada WebRTC.
        </p>
      </Card>

      <AgendaTodayList />
    </div>
  );
}
```

```tsx
// HunterDashboard.tsx (PLACEHOLDER rico)
import { Card } from '@/components/ui/card';
import { Phone, PhoneIncoming, UserPlus, Construction } from 'lucide-react';

export function HunterDashboard() {
  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">Dashboard Hunter (inbound)</h1>
        <p className="text-xs text-muted-foreground">
          Foco em chamadas que chegam de clientes novos e qualificação rápida pra entregar pro Closer ou fechar direto.
        </p>
      </div>

      <Card className="p-4 border-dashed border-2 border-status-warning/30 bg-status-warning-bg/20">
        <div className="flex items-center gap-2 mb-2">
          <Construction className="w-4 h-4 text-status-warning" />
          <span className="text-sm font-medium">Em construção — PR-MULTIVENDOR-V2</span>
        </div>
        <p className="text-2xs text-muted-foreground">
          Próximas features:
        </p>
        <ul className="text-2xs text-muted-foreground space-y-1 mt-2 ml-4 list-disc">
          <li>Pipeline kanban (lead novo → contactado → qualificado → entregue ao Closer)</li>
          <li>Taxa de qualificação + motivos de descarte</li>
          <li>Cadência de follow-up automática (D+1, D+3, D+7)</li>
          <li>Botão "Encaminhar pro Closer" com contexto (transcript, captura)</li>
          <li>Métricas: dials/dia, conexões, SQLs entregues</li>
        </ul>
      </Card>

      <div className="grid grid-cols-3 gap-3">
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <PhoneIncoming className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Chamadas hoje<div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <UserPlus className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Prospects criados<div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <Phone className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Entregues ao Closer<div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
      </div>
    </div>
  );
}
```

```tsx
// CloserDashboard.tsx (PLACEHOLDER rico)
import { Card } from '@/components/ui/card';
import { Construction, MapPin, Target, TrendingUp } from 'lucide-react';

export function CloserDashboard() {
  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">Dashboard Closer (outbound presencial)</h1>
        <p className="text-xs text-muted-foreground">
          Foco em visitas de alto valor — fechar deals complexos pro Hunter, expansão pra Farmer, recovery de churn.
        </p>
      </div>

      <Card className="p-4 border-dashed border-2 border-status-warning/30 bg-status-warning-bg/20">
        <div className="flex items-center gap-2 mb-2">
          <Construction className="w-4 h-4 text-status-warning" />
          <span className="text-sm font-medium">Em construção — PR-VISIT-INTELLIGENCE</span>
        </div>
        <p className="text-2xs text-muted-foreground">
          Próximas features:
        </p>
        <ul className="text-2xs text-muted-foreground space-y-1 mt-2 ml-4 list-disc">
          <li>4 tipos de missão: Closing / Expansion / Recovery / Relationship</li>
          <li>Algoritmo de visit_score com pesos configuráveis</li>
          <li>Rota geográfica eficiente (visitas agrupadas por região)</li>
          <li>Pre-call brief INCRÍVEL antes de cada visita</li>
          <li>Registro de resultado da visita + métricas (Visit Conversion, ROI por visita)</li>
        </ul>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <Target className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Visitas pendentes<div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <MapPin className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Próxima visita<div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <TrendingUp className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Win rate<div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
        <Card className="p-3 text-center text-xs text-muted-foreground">
          Avg deal size<div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
      </div>
    </div>
  );
}
```

```tsx
// MasterDashboard.tsx (PLACEHOLDER rico + cruzamento)
import { Card } from '@/components/ui/card';
import { Construction, BarChart3, Users, Briefcase } from 'lucide-react';
import { KpisToday } from './KpisToday';

export function MasterDashboard() {
  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">Dashboard Master (CEO)</h1>
        <p className="text-xs text-muted-foreground">
          Visão consolidada do time. KPIs agregados, ranking de vendedores, alertas estratégicos.
        </p>
      </div>

      <Card className="p-4 border-dashed border-2 border-status-warning/30 bg-status-warning-bg/20">
        <div className="flex items-center gap-2 mb-2">
          <Construction className="w-4 h-4 text-status-warning" />
          <span className="text-sm font-medium">Em construção — PR-MULTIVENDOR-V2</span>
        </div>
        <p className="text-2xs text-muted-foreground">
          Próximas features:
        </p>
        <ul className="text-2xs text-muted-foreground space-y-1 mt-2 ml-4 list-disc">
          <li>Ranking de vendedores (chamadas/dia, R$ gerado, ticket médio, NRR)</li>
          <li>Carteira agregada por vendedor (health médio, churn risk médio)</li>
          <li>Alertas estratégicos (cliente VIP esfriou, vendedor caiu produção)</li>
          <li>Toggle "ver como Farmer/Hunter/Closer" pra entrar na visão de cada um</li>
        </ul>
      </Card>

      {/* KPIs do próprio Master (ele também é Closer) */}
      <KpisToday />

      <div className="grid grid-cols-3 gap-3">
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <Users className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Vendedores ativos<div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <Briefcase className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Receita time hoje<div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <BarChart3 className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Pipeline total<div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
      </div>
    </div>
  );
}
```

```tsx
// CommercialDashboard.tsx (shell switch)
import { useCommercialRole, type CommercialRole } from '@/hooks/useCommercialRole';
import { FarmerDashboardV2 } from './FarmerDashboardV2';
import { HunterDashboard } from './HunterDashboard';
import { CloserDashboard } from './CloserDashboard';
import { MasterDashboard } from './MasterDashboard';
import { Loader2 } from 'lucide-react';

export function CommercialDashboard() {
  const { data: role, isLoading } = useCommercialRole();

  if (isLoading) {
    return <div className="flex justify-center p-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;
  }

  const r = (role ?? 'farmer') as CommercialRole;

  switch (r) {
    case 'hunter': return <HunterDashboard />;
    case 'closer': return <CloserDashboard />;
    case 'master':
    case 'super_admin': return <MasterDashboard />;
    case 'farmer':
    case 'operacional':
    case 'gerencial':
    case 'estrategico':
    default:
      return <FarmerDashboardV2 />;
  }
}
```

### Task 4: Wire em FarmerDashboard

Substituir conteúdo de `FarmerDashboard.tsx` por:

```tsx
import { CommercialDashboard } from '@/components/dashboard/CommercialDashboard';

const FarmerDashboard = () => <CommercialDashboard />;
export default FarmerDashboard;
```

(legado de 438 LoC vira proxy de 3 linhas. Backup do legado fica em git history.)

### Task 5: QA + PR

- tsc clean
- vitest passing
- bun build passes
- Push + PR contra main

---

## Self-Review

**Spec coverage:**
- 4 dashboards por commercial_role → Task 3
- Atribuição vendedor→cliente reusa `farmer_client_scores.farmer_id` (existe!)
- Agenda priorizada + "Ligar agora" → AgendaTodayList
- KPIs do dia → KpisToday
- Multi-role com fallback farmer → CommercialDashboard switch
- Hunter/Closer/Master placeholders ricos → próximo PR

**Riscos:**
- `farmer_client_scores.farmer_id` pode estar vazio pra vendedores novos. Mitigação: AgendaTodayList mostra empty state "recalcule scoring".
- `commercial_roles.commercial_role` pode estar com valor legado (`operacional`). Fallback: trata como farmer.
- Refactor de FarmerDashboard.tsx pode quebrar links externos. Mitigação: mantém mesma rota `/farmer`.
- `webrtc.makeCall` exige feature flag `useWebRTCCall=true`. Botão "Ligar" não funciona sem isso. Mitigação: documentar.

**Não-objetivos confirmados pra PR-MULTIVENDOR-V2:**
- Hunter pipeline kanban completo
- Closer visit_score algorithm + rota geo
- Master ranking de vendedores + cruzamento
- Encaminhamento entre roles ("pedir visita pro Closer")
