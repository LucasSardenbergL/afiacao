# Última execução em botões de ação global — design

**Data:** 2026-07-18 · **Aprovado pelo founder:** Abordagem A + automáticas desde o v1
**Origem do pedido:** print de `/admin/analytics-sync` — "ao clicar em sincronizar ou importar podia dizer a última vez que foi feito; quero que isso permeie todo o aplicativo e que sempre aconteça nos próximos".

## Problema

Botões de ação global (sincronizar/importar/recalcular/gerar) não dizem quando a ação rodou pela última vez, nem por quem. Na página do print, os 5 cards (Importar Clientes, Endereços, Pedidos, Motor de Custo, Apriori) não deixam rastro consultável — os motores não gravam nada ao rodar. Pior: `compute-costs-daily` roda no cron **a cada 2 h** (`45 */2 * * *`) e `compute-association-rules-daily` diariamente às 7h30 — invisíveis na UI. Um "última execução" só de cliques manuais mentiria; por isso o v1 já cobre manuais **e** automáticas.

## Decisão (alternativas descartadas)

- **A (aprovada):** tabela genérica `acoes_execucoes` + primitivos de frontend + registro server-side nas edges single-shot + convenção escrita.
- ~~B: derivar de rastros existentes~~ — motores não deixam rastro; fiação bespoke por botão; não vira convenção.
- ~~C: localStorage~~ — mente em multi-dispositivo/multi-usuário.

## Modelo de dados

```sql
create table public.acoes_execucoes (
  id uuid primary key default gen_random_uuid(),
  acao text not null,                    -- slug estável '<area>.<acao>' (espelha convenção do track())
  origem text not null default 'manual' check (origem in ('manual','automatica')),
  executado_por uuid references auth.users(id) on delete set null,  -- null = automática
  executado_por_nome text,               -- snapshot do nome no momento (evita join RLS-dependente)
  iniciado_em timestamptz not null default now(),
  finalizado_em timestamptz,
  status text not null default 'executando' check (status in ('executando','sucesso','erro')),
  detalhes jsonb                          -- resumo pequeno (contagens, erro truncado)
);
create index acoes_execucoes_acao_idx on public.acoes_execucoes (acao, iniciado_em desc);
```

**RLS (fail-closed, staff-only):**
- `SELECT`: staff (idioma do repo: `has_role`/`is_staff` — copiar o padrão vigente das policies em produção).
- `INSERT`: staff **e** `executado_por = auth.uid()` **e** `origem = 'manual'`.
- `UPDATE`: staff **e** `executado_por = auth.uid()` (fechar a própria execução).
- `DELETE`: sem policy (ninguém via PostgREST).
- Grants: revogar `anon` **por nome** (REVOKE FROM PUBLIC não basta — armadilha do CLAUDE.md); conceder a `authenticated`.
- Edges gravam com `service_role` (bypassa RLS por design; gate é o `authorizeCronOrStaff` na fronteira da edge).

**Regra anti-duplicata: cada slug tem UM escritor** — ou o frontend (loops client-side), ou a edge (single-shot). Nunca os dois.

**Retenção:** fora de escopo v1 (volume baixo: dezenas de linhas/dia). Revisitar se crescer.

## Primitivos de frontend — `src/components/execucoes/` (módulo `plataforma`)

1. **`useUltimaExecucao(acao: string | string[])`** — react-query sobre `acoes_execucoes` (linha mais recente entre os slugs; `.order('iniciado_em', desc).limit(1)`), queryKey `['ultima-execucao', ...slugs]`. Tabela ainda fora do `types.ts` gerado → cast `supabase as unknown as {…}` (idioma `useCarteiraSaude`).
2. **`useMutationComRegistro({ acao, detalhes?, ...opts })`** — drop-in do `useMutation`: insere linha `executando` (com `executado_por` + nome do `useAuth`) antes de rodar `mutationFn`, atualiza `sucesso`/`erro` + `finalizado_em` + `detalhes(data)` ao terminar, invalida `['ultima-execucao']` no settled. **Fail-open:** falha no registro (RLS/rede) NUNCA bloqueia a ação real — loga `console.warn` e segue.
3. **`<UltimaExecucao acao className? />`** — caption `text-xs text-muted-foreground`; estados:
   - sem linha → "Nunca executada"
   - `executando` + iniciado < 2 h → "Em andamento (há 5 min)"
   - `executando` + iniciado ≥ 2 h → "Iniciada há 8 h (interrompida?)" — aba fechada no meio
   - `sucesso` → "Última execução: há 2 h · Lucas · ✓" (automática → "· automática")
   - `erro` → "Última execução: há 2 h · Lucas · falhou" (status em `text-status-error`)
   - Tempo relativo `formatDistanceToNow` + `ptBR`; tooltip com data/hora absoluta e a ação específica (útil quando `acao` é array, ex.: card de Pedidos com 2 botões).

## Edge `omie-analytics-sync` + helper compartilhado

**`supabase/functions/_shared/registro-execucao.ts`** — `comRegistro(admin, acao, auth, fn)`: insere (`origem = auth.via === 'staff' ? 'manual' : 'automatica'`, `executado_por = auth.userId ?? null`, nome via `profiles` quando staff), roda `fn`, fecha com `sucesso`/`erro`. Fail-open (`console.warn`). Teste Deno `registro-execucao_test.ts` (padrão `_shared/*_test.ts`).

**Pontos de wrap no dispatcher** (todos síncronos hoje):
- `case "compute_costs"` → `analytics_sync.recalcular_custos`
- `case "compute_association_rules"` → `analytics_sync.recalcular_regras`
- `case "sync_all"` → `analytics_sync.sync_completo` **e**, por dentro, os dois computes com seus próprios slugs (sync_all recalcula custos de verdade — a verdade é por slug: 3 linhas).

Nenhuma outra edge muda no v1 (uma edge = um deploy manual).

## Adoção PR1 — mapa card → slug → escritor

| Botão | Slug | Escritor |
|---|---|---|
| Importar Clientes (3 contas) | `analytics_sync.importar_clientes` | frontend (loop `omie-cliente`) |
| Sincronizar Endereços | `analytics_sync.sincronizar_enderecos` | frontend (loop) |
| Importar Recentes (180d) | `analytics_sync.importar_pedidos_recentes` | frontend (loop `omie-vendas-sync`) |
| Importar Todos (pedidos) | `analytics_sync.importar_pedidos_todos` | frontend (loop) |
| Recalcular Custos | `analytics_sync.recalcular_custos` | edge (manual + cron 2/2 h) |
| Recalcular Regras | `analytics_sync.recalcular_regras` | edge (manual + cron diário) |
| Sync Completo (header) | `analytics_sync.sync_completo` | edge |

Caption em cada card, sob a linha título+botão. O grid de 4 entidades (`sync_state`) **fica como está** — já mostra frescor manual+cron.

## Convenção durável

Bullet novo em CLAUDE.md §Design System (curto — teto de tamanho no CI):

> Botão de ação **global** (sincronizar/importar/recalcular/gerar): `useMutationComRegistro` + `<UltimaExecucao acao>` — não `useMutation` cru; edge single-shot grava server-side (`_shared/registro-execucao.ts`). Ação sobre UM registro: estado no próprio registro.

Detalhe operacional: JSDoc nos primitivos (é o padrão das outras convenções de UI do repo).

## Fora de escopo (PR2+ — varredura)

Adotar nos pontos inventariados: `tintImport/SyncCard` (Sincronizar Produtos Omie), `dashboard/GestorExcecoes` (Atualizar análise da carteira), `AdminReposicaoPedidos` (Sincronizar e recalcular), `reposicao/GerarCicloDialog`, `reposicao/PrecoEmbalagemDialog`; em cada um, mapear cron sobreposto (ex.: `afiacao_ciclo_oportunidade_diario`) e escolher o escritor certo. Ações **per-registro** (reenvio de portal, importar NF-e por chave) ficam de fora — estado vive no registro.

## Testes / prova

- **Migration provada no PG17 local** (skill `prove-sql-money-path` — RLS nova): asserts positivos e negativos com SQLSTATE esperada, RLS sob `SET ROLE authenticated` + GUC, e falsificação (sabotar → exigir vermelho).
- **Vitest:** estados do `<UltimaExecucao>` (nunca/andamento/interrompida/sucesso/erro/automática), `useMutationComRegistro` fail-open (insert falha → mutationFn roda mesmo assim; erro na mutation → linha fecha `erro`), formatação relativa.
- **Deno test** do helper da edge.

## Riscos e mitigação

- `types.ts` sem a tabela até o Lovable regenerar → cast tipado local; nada de `any` solto.
- Execução abandonada → heurística "interrompida?" no display (sem watchdog no v1).
- Merge ≠ produção: **3 handoffs no fecho** — migration no SQL Editor, deploy da edge pelo chat do Lovable, Publish do frontend.
