# Consolidação de roles: admin + manager → master

## Objetivo
Eliminar os roles `admin` e `manager` do aplicativo. O role `master` passa a ser o único nível de privilégio elevado, herdando todas as permissões anteriores.

## Escopo medido
- **289 policies RLS** referenciam `'admin'` ou `'manager'`
- **37 arquivos** TypeScript (frontend + edge functions) com checagens de role
- **2 funções SQL** com lógica baseada em role
- **Enum `app_role`** contém os valores `admin`, `manager`, `master`, `employee`, `customer`

## Estratégia em 3 ondas

### Onda 1 — Banco (sem downtime, retrocompatível)
1. Migração de dados: para todo usuário em `user_roles` com role `admin` ou `manager`, garantir que tenha role `master` (INSERT idempotente). Depois, deletar as linhas `admin`/`manager`.
2. Reescrever a função `public.has_role(uuid, app_role)` para que:
   - `has_role(uid, 'admin')` retorne true se usuário tem `master`
   - `has_role(uid, 'manager')` retorne true se usuário tem `master`
   - Demais roles continuam exatamente iguais
3. Resultado imediato: as 289 policies continuam funcionando sem alteração; ninguém perde acesso.

### Onda 2 — Código (frontend + edge functions)
Substituir nos 37 arquivos as checagens `=== 'admin'`, `=== 'manager'`, `hasRole('admin')`, `hasRole('manager')` por verificações em `master`. Pontos de cuidado:
- **Não tocar em rotas** `/admin/...` — são paths de URL, não roles.
- **Não tocar em nomes de tabelas/policies** que contenham a palavra `admin`/`manager` (ex.: `staff_xxx_admin_select`).
- Atualizar `useUserRole`, `useCommercialRole`, `ProtectedRoute`, `AppShell`, telas de Governance.
- Edge functions: ajustar verificações de RBAC interno.

### Onda 3 — Limpeza opcional (depois de validar)
- Reescrever as 289 policies trocando literais `'admin'`/`'manager'` por `'master'` (cosmético — comportamento já idêntico após Onda 1).
- Remover `admin` e `manager` do enum `app_role` via `ALTER TYPE … RENAME VALUE` ou recriação. Esta etapa é destrutiva e não é estritamente necessária para o objetivo funcional.

## Detalhes técnicos

### Override de has_role (Onda 1)
```sql
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND (
        role = _role
        OR (_role IN ('admin','manager') AND role = 'master')
      )
  )
$$;
```

### Migração de dados
```sql
INSERT INTO public.user_roles (user_id, role)
SELECT DISTINCT user_id, 'master'::app_role
FROM public.user_roles
WHERE role IN ('admin','manager')
ON CONFLICT DO NOTHING;

DELETE FROM public.user_roles WHERE role IN ('admin','manager');
```

### UI de gestão de roles
Em `GovernancePermissions.tsx` / `GovernanceUsers.tsx`, remover `admin` e `manager` das listas de roles atribuíveis, mantendo apenas: `master`, `employee`, `customer` (e demais existentes).

## Riscos
- **Médio** — algum gatilho/edge function pode ter um literal `'admin'` esquecido em string concatenada e não pego pelo grep. A Onda 1 mitiga isso (master cobre os dois nomes).
- **Baixo** — recriar enum sem `admin`/`manager` exigiria revisar todos os defaults de coluna; por isso fica como Onda 3 opcional.

## Entregáveis
- 1 migration (Onda 1) — aplicada e validada antes de mexer em código.
- N edits TypeScript (Onda 2) — em PRs lógicos por área (governance, hooks, telas admin, edge functions).
- 1 migration final (Onda 3) — somente se você quiser eliminar literais `'admin'`/`'manager'` do banco.

## O que NÃO será alterado
- Rotas `/admin/...`
- Nomes de tabelas, índices, policies (ex.: `staff_pedido_compra_sugerido_insert`)
- Conteúdo de colunas que armazenem strings `"admin"` em outros contextos
