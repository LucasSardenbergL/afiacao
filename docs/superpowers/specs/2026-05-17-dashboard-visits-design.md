# `dashboard_visits` — Design

> Persiste timestamps de visita do dashboard server-side, complementando
> (não substituindo) `localStorage.dashboardLastVisit`. Habilita análise
> cross-device + queries históricas no PostHog.
>
> Data: 2026-05-17 · Status: spec pronta, implementação = ~1 dia

---

## 1. Por que existe

Hoje `lastVisit` mora em `localStorage` — funciona 95% do tempo, mas tem 3 limites:
1. **Cross-device**: vendedor olha dashboard no laptop manhã, vai pro celular tarde — deltas comparam com null (mostra "Bem-vindo").
2. **Análise histórica**: PostHog tem `dashboard.viewed` event mas sem contagem por usuário ao longo do tempo é difícil ver padrões (frequência, dropoff).
3. **Sincronização entre tabs**: usuário com 2 tabs abertas pode escrever `lastVisit` em ordem confusa.

`dashboard_visits` resolve esses 3 com baixo custo.

---

## 2. Modelo

### Tabela

```sql
CREATE TABLE public.dashboard_visits (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  visited_at timestamptz NOT NULL DEFAULT now(),
  persona text,             -- snapshot da persona na visita
  company_selection text,   -- 'colacor' | 'oben' | 'colacor_sc' | 'all'
  session_minutes int,      -- duração da sessão (null se não detectada)
  -- compõe (user_id, visited_at) pra query latest fast
  UNIQUE (user_id, visited_at)
);

CREATE INDEX idx_dashboard_visits_user_recent
  ON public.dashboard_visits (user_id, visited_at DESC);
```

### RLS

```sql
ALTER TABLE public.dashboard_visits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_inserts_own_visit" ON public.dashboard_visits
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user_reads_own_visits" ON public.dashboard_visits
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "master_reads_all_visits" ON public.dashboard_visits
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master')
  );
```

### Retention

Sem cleanup automático no MVP. Estimativa: 100 staff × 5 visitas/dia × 365d = 182k linhas/ano. Trivial.

Quando crescer: cron mensal que arquiva > 90 dias em tabela cold (`dashboard_visits_archive`).

---

## 3. Edge Function

`supabase/functions/dashboard-record-visit/index.ts`

POST body:
```ts
{
  persona: string;
  company_selection: 'colacor' | 'oben' | 'colacor_sc' | 'all';
  session_minutes?: number;  // calculado client-side (Date.now - mountedAt) / 60_000
}
```

Lógica:
1. Verifica auth via `supabase.auth.getUser()`
2. INSERT em `dashboard_visits` com `user_id = auth.uid()`
3. Returns `{ ok: true, previousVisitIso: <iso> }` — o **iso da visita anterior** (pra que o cliente saiba qual usar como `lastVisit`)

Por que função e não direto via client? Por 2 motivos:
- Validação consistente
- Retorno do "previousVisitIso" numa única roundtrip (em vez de INSERT + SELECT separados)

Skip Edge Function se quisermos simplicidade: client faz INSERT + faz query `SELECT visited_at FROM dashboard_visits ORDER BY visited_at DESC LIMIT 1, 1` (segunda mais recente = a anterior). 2 queries em vez de 1, mas zero deploy de função.

---

## 4. Mudança em `useLastVisit`

Substituir `localStorage`-only por híbrido:

```ts
export function useLastVisit(): UseLastVisitReturn {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // 1. Query do server pra previous visit
  const { data: serverVisit } = useQuery({
    queryKey: ['dashboard', 'previous-visit', user?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('dashboard_visits')
        .select('visited_at')
        .eq('user_id', user!.id)
        .order('visited_at', { ascending: false })
        .range(1, 1)  // segunda mais recente = anterior à atual
        .maybeSingle();
      return data?.visited_at ?? null;
    },
    enabled: !!user?.id,
    staleTime: Infinity, // só refaz no mount
  });

  // 2. Fallback pra localStorage (cobre offline / pre-deploy)
  const [localSnapshot] = useState(() => localStorage.getItem(STORAGE_KEY));

  // 3. Resolve: server primeiro, local fallback
  const lastVisitIso = serverVisit ?? localSnapshot;

  // 4. Record nova visita no mount (se duraem 5min+, escreve)
  useEffect(() => {
    const mountedAt = Date.now();
    return () => {
      const session = Date.now() - mountedAt;
      if (session < MIN_SESSION_MS) return;

      // Persiste local (fallback)
      localStorage.setItem(STORAGE_KEY, new Date().toISOString());

      // Persiste server (best effort, não bloqueia UX)
      void supabase.from('dashboard_visits').insert({
        user_id: user!.id,
        visited_at: new Date().toISOString(),
        // persona/company_selection: pegar dos contexts via ref ou prop
      });
    };
  }, [user?.id]);

  // ... resto igual
}
```

---

## 5. Backfill

Não há histórico server-side. Estratégia:
- Sem backfill — começa do zero quando deploy
- Cliente continua escrevendo `localStorage` em paralelo durante período de transição (30d)
- Depois de 30d, remover `localStorage` legacy (1 linha)

---

## 6. Telemetria

PostHog ganha:
- `dashboard.visit.recorded` `{ session_minutes }` — confirmar inserção
- `dashboard.visit.failed` `{ error }` — debug se RLS bloquear

Dashboard PostHog ganha:
- **Frequência média de visitas/usuário/semana** (chart)
- **Sessão média (minutos)** (chart)
- **Cohort: usuários ativos semanais** (cohort table)

---

## 7. Out-of-scope

- Geo/IP tracking (PostHog já cobre)
- User-agent / device breakdown (PostHog cobre)
- Sync entre múltiplas tabs (cada tab grava sua; query ORDER BY desc resolve)
- Cleanup automático (sob demanda quando volume crescer)

---

## 8. Riscos

| Risco | Mitigação |
|---|---|
| RLS quebra insert silenciosamente | Telemetria `dashboard.visit.failed` + logger.warn |
| Volume explode (100 staff × 1k visits/mês = 100k/mês) | Trivial em PG; partition se 1M+ |
| Auth offline → insert falha | localStorage cobre (fallback) |
| Race condition entre tabs | Ordering por `visited_at DESC` resolve naturalmente |

---

## 9. Plano (1-2 dias)

- **Dia 1**: migration + RLS + Edge Function (ou versão simples sem função) + tests
- **Dia 2**: refactor `useLastVisit` + telemetria + smoke test

Implementação invoca `writing-plans` com este spec.
