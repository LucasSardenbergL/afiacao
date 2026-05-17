# `user_departments` — Design

> Substitui a heurística de persona (top prefixo de rota) por persistência
> determinística de "departamento operacional" do usuário.
>
> Data: 2026-05-17 · Status: spec pronta, implementação = sprint próprio (~3-5 dias)

---

## 1. Por que existe

A spec do Dashboard V3 (§4.1) mapeia 8 personas. 4 delas dependem hoje de
**heurística por uso** (≥40% das visitas dos últimos 30d em prefixo de rota):
- `comprador` ← `/admin/reposicao/*`
- `estoque` ← `/admin/estoque/*` ou `/recebimento`
- `tintometrico` ← `/tintometrico/*`
- (financeiro tem `commercial_role` `estrategico`? não — ainda inferida)

A heurística tem 3 problemas:
1. **Inverte causalidade**: usuário só é classificado depois de já usar o módulo.
   Funcionário novo recebe persona "geral" e vê dashboard mal otimizado por 1-2 semanas.
2. **Não respeita realidade organizacional**: o separador X é separador antes
   de logar — fato organizacional, não comportamental.
3. **Não dá pra usar fora do dashboard**: outras telas (notificações por persona,
   relatórios por departamento) precisam de persistência.

`user_departments` resolve isso com fato organizacional explícito.

---

## 2. Modelo de dados

### Tabela

```sql
CREATE TYPE public.department AS ENUM (
  'separador',
  'conferente',
  'comprador',
  'tintometrico',
  'financeiro',
  'vendas',
  'gestao',
  'outro'
);

CREATE TABLE public.user_departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  department public.department NOT NULL,
  primary_dept boolean DEFAULT true,  -- usuário pode ter múltiplos; um é primário
  created_at timestamptz DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  -- unique: 1 primary por user
  CONSTRAINT one_primary_per_user EXCLUDE USING btree (user_id WITH =) WHERE (primary_dept = true)
);

CREATE INDEX idx_user_departments_user ON public.user_departments(user_id);
CREATE INDEX idx_user_departments_dept ON public.user_departments(department);
```

### RLS

```sql
ALTER TABLE public.user_departments ENABLE ROW LEVEL SECURITY;

-- Usuário lê o próprio
CREATE POLICY "user_reads_own_dept" ON public.user_departments
  FOR SELECT USING (auth.uid() = user_id);

-- Master/admin lê e escreve todos
CREATE POLICY "master_full_dept" ON public.user_departments
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('master')
    )
  );
```

### Mapping persona ← department

| `user_departments.department` | Dashboard persona |
|---|---|
| `vendas` | `vendedor` (overrideable por commercial_role) |
| `gestao` | `gestor` ou `master` (depende de commercial_role) |
| `comprador` | `comprador` |
| `separador` | `estoque` |
| `conferente` | `estoque` |
| `tintometrico` | `tintometrico` |
| `financeiro` | `financeiro` |
| `outro` | `geral` |

---

## 3. Mudança no `persona-detect.ts`

Adicionar 4º nível na cascata (entre override e commercial_role):

```ts
// 1. Override manual (mantém)
// 2. user_department primário (NOVO)  ← persistência > inferência
// 3. salesOnlyCpfs → vendedor
// 4. commercial_role → vendedor/gestor/master
// 5. Heurística por uso (mantém como fallback pra novos staff sem dept)
// 6. Default
```

Hook `usePersona` ganha mais um sinal:

```ts
const { data: userDept } = useQuery({
  queryKey: ['user-department', user?.id],
  queryFn: async () => {
    const { data } = await supabase
      .from('user_departments')
      .select('department')
      .eq('user_id', user!.id)
      .eq('primary_dept', true)
      .maybeSingle();
    return data?.department ?? null;
  },
  enabled: !!user?.id,
  staleTime: 5 * 60 * 1000,
});
```

Source enum ganha `'department'`. Passa pra `inferPersona({ ..., userDepartment: userDept })`.

---

## 4. UI Admin

Onde: `/admin/approvals` (já existe; estende) OU nova `/admin/departments`.

Mínimo viável:
- Tabela de usuários staff (filtra `profiles where is_approved = true and role != 'customer'`)
- Coluna "Departamento" com dropdown editável (8 options)
- Save inline → POST/PATCH em `user_departments`
- Bulk: selecionar múltiplos + atribuir mesmo dept

Plus (nice to have):
- Filtro por department
- Contagem por department (KPI inline)
- Histórico de mudanças (audit log opcional)

---

## 5. Migração de dados

Não existem dados em `user_departments` na primeira instalação. Estratégia:
- **Não fazer backfill automático** — heurística que existe continua cobrindo durante o período de adoção
- **UI admin permite "Atribuir baseado em uso atual"** — botão que roda `inferPersona` por usuário e propõe departments
- **Decay**: usuário sem `user_departments` por 30+ dias após deploy = aviso pro master atribuir

---

## 6. Telemetria

3 novos eventos PostHog:
- `department.assigned` `{ user_id, department, by_user_id }` — quando admin atribui
- `department.changed` `{ user_id, from, to, by_user_id }`
- `department.bulk_assigned` `{ count, department, by_user_id }`

Dashboard PostHog ganha 1 chart: "% staff com department atribuído" — meta 95% em 60 dias.

---

## 7. Out-of-scope

- Departments compostos (usuário em "vendas+gestão"). MVP single primary; multi via `primary_dept = false`.
- Auto-assign baseado em login email pattern (@vendas.colacor.com.br). Manual primeiro, automação depois.
- Department-scoped RLS em outras tabelas (ex: comprador só vê fornecedores do seu dept). Sprint próprio quando houver necessidade.
- Sync com Omie/Sayerlack (eles não têm conceito de department).

---

## 8. Riscos

| Risco | Mitigação |
|---|---|
| Master esquece de atribuir, novos staff caem em "geral" | Banner no admin: "X usuários sem dept" |
| Constraint `one_primary_per_user` quebra ao trocar dept | Patch deve fazer UPDATE com `BEGIN; UPDATE old SET primary=false; INSERT new SET primary=true; COMMIT` (transação) |
| Heurística e department divergem (usuário marcado "vendas" mas só usa reposição) | Logger warn no dev quando divergir; UI admin mostra alerta |
| Constraint de exclusion exige PostgreSQL recente | Supabase está em PG 15+ → OK |

---

## 9. Plano de implementação (resumo)

Sprint de ~3-5 dias:
- **Dia 1**: migration (tabela + RLS + enum) + types regenerados via `supabase gen types`
- **Dia 2**: extends `usePersona` + `inferPersona` com 4º nível + tests
- **Dia 3**: UI admin (`/admin/departments` ou estende `/admin/approvals`)
- **Dia 4**: telemetria + chart PostHog + docs
- **Dia 5**: QA + deploy + criar `make-plan` artifact

Quando for executar, invocar `writing-plans` com este spec como input.
