# Canal "Melhorias" — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Canal interno onde staff reporta problemas/sugestões/perguntas; IA tria na hora (Anthropic direto + 2 ferramentas de dados determinísticas); founder consome fila master com prompt pronto pro Claude Code.

**Architecture:** Captação client-side independente da IA (INSERT antes do invoke; falha da edge = item `triagem_status='pendente'` na fila). Edge `melhoria-triagem` lê o item do banco (anti-spoof), roda loop agentic com 3 tools (2 de dados via RPC com o JWT do caller — só quando caller==autor; 1 terminal `triar`) e persiste via service_role. Tela do funcionário (`/melhorias`) + fila master (`/gestao/melhorias`) + botão topbar + badge sidebar.

**Tech Stack:** React 18 + TanStack Query + shadcn · Supabase (Postgres RLS + Edge Function Deno) · `@anthropic-ai/sdk` (`claude-sonnet-4-6`, forced tool-use, prompt caching) · vitest (helpers) + PG17 local (RPCs/RLS).

**Spec:** `docs/superpowers/specs/2026-06-10-melhorias-canal-feedback-design.md`

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
| --- | --- |
| `src/lib/melhorias/types.ts` (novo) | Tipos compartilhados (item, mensagem, payload de triagem, dados de tool) |
| `src/lib/melhorias/triagem-helpers.ts` (novo) | `validarTriagem` (valida/normaliza output da tool `triar`) + `podeReplicar` (cap/status) — espelhados verbatim na edge |
| `src/lib/melhorias/prompt-claude.ts` (novo) | `montarPromptClaudeCode` (bloco copiável determinístico) |
| `src/lib/melhorias/__tests__/*.test.ts` (novos) | Testes vitest dos helpers |
| `supabase/migrations/20260610130000_melhorias_canal.sql` (novo) | 2 tabelas + índices + RLS + 2 RPCs de dados |
| `db/test-melhorias-rpcs.sh` (novo) | Teste PG17: RPCs (agregação, carteira, guards) + RLS (own/master/anon) |
| `supabase/functions/melhoria-triagem/index.ts` (novo) | Edge: gate staff, loop agentic, persistência, cap de réplicas |
| `src/hooks/useMelhorias.ts` (novo) | Queries/mutations/invoke/badge |
| `src/components/melhorias/MelhoriaThread.tsx` (novo) | Thread de mensagens + render de tabelas de dados |
| `src/components/melhorias/MelhoriaDialog.tsx` (novo) | Dialog do topbar (criar + ver resposta da IA inline) |
| `src/pages/Melhorias.tsx` (novo) | Lista própria do funcionário + réplica |
| `src/pages/GestaoMelhorias.tsx` (novo) | Fila master: filtros, status, resposta, copiar prompt, re-triar |
| `src/App.tsx` (modificar) | 2 rotas lazy no bloco `RequireStaff` |
| `src/components/AppShell.tsx` (modificar) | Botão topbar + 2 itens sidebar + badge master |

**Convenções obrigatórias do projeto:** pt-BR em código/labels · `toast` do sonner · `track()` de `@/lib/analytics` · `useUrlState` pra filtros · `EmptyState tone="operational"` · `PageSkeleton` · sem `.or()` com template literal · comandos pesados com `heavy`.

---

### Task 1: Tipos + `validarTriagem` (TDD)

**Files:**
- Create: `src/lib/melhorias/types.ts`
- Create: `src/lib/melhorias/triagem-helpers.ts`
- Test: `src/lib/melhorias/__tests__/triagem-helpers.test.ts`

- [ ] **Step 1.1: Criar os tipos**

```typescript
// src/lib/melhorias/types.ts
// Tipos do canal interno de Melhorias (sugestões/problemas com triagem por IA).
// A edge function `melhoria-triagem` espelha os helpers que consomem estes tipos.

export type MelhoriaTipo = 'problema' | 'sugestao' | 'pergunta';
export type MelhoriaUrgencia = 'baixa' | 'media' | 'alta';
export type MelhoriaStatus = 'aberto' | 'em_andamento' | 'resolvido' | 'descartado';
export type MelhoriaTriagemStatus = 'pendente' | 'ok' | 'erro';
export type MelhoriaPapel = 'funcionario' | 'ia' | 'founder';

export const MELHORIA_MODULOS = [
  'vendas', 'estoque', 'reposicao', 'financeiro', 'tintometrico', 'afiacao',
  'whatsapp', 'rota', 'tarefas', 'producao', 'governanca', 'outro',
] as const;
export type MelhoriaModulo = (typeof MELHORIA_MODULOS)[number];

/** Máximo de mensagens do funcionário por item (1 inicial + 5 réplicas). */
export const MAX_MENSAGENS_FUNCIONARIO = 6;

export interface MelhoriaItem {
  id: string;
  autor_user_id: string;
  empresa: string;
  rota_origem: string | null;
  tipo: MelhoriaTipo | null;
  urgencia: MelhoriaUrgencia | null;
  modulo: string | null;
  titulo: string | null;
  status: MelhoriaStatus;
  triagem_status: MelhoriaTriagemStatus;
  avaliacao_founder: string | null;
  resposta_founder: string | null;
  resolvido_em: string | null;
  created_at: string;
  updated_at: string;
}

export interface MelhoriaMensagem {
  id: string;
  item_id: string;
  autor_user_id: string | null;
  papel: MelhoriaPapel;
  conteudo: string;
  dados: MelhoriaDados | null;
  created_at: string;
}

/** Resultado das ferramentas de dados executadas pela edge (renderizado como tabela). */
export interface MelhoriaDados {
  tools: Array<{
    tool: 'clientes_por_produto' | 'produtos_relacionados';
    input: Record<string, unknown>;
    resultado: unknown;
  }>;
}

/** Output validado da tool `triar` da IA. */
export interface TriagemValidada {
  tipo: MelhoriaTipo;
  urgencia: MelhoriaUrgencia;
  modulo: MelhoriaModulo;
  titulo: string;
  resposta_ao_funcionario: string;
  avaliacao_founder: string;
}
```

- [ ] **Step 1.2: Escrever os testes de `validarTriagem` (falham — função não existe)**

```typescript
// src/lib/melhorias/__tests__/triagem-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { validarTriagem } from '../triagem-helpers';

const base = {
  tipo: 'problema',
  urgencia: 'alta',
  modulo: 'estoque',
  titulo: 'Picking trava ao bipar duas vezes',
  resposta_ao_funcionario: 'Entendi: problema no picking. Vai pra fila do Lucas.',
  avaliacao_founder: 'Provável replay do evento de scan sem guard de idempotência.',
};

describe('validarTriagem', () => {
  it('aceita payload válido e devolve normalizado', () => {
    const r = validarTriagem(base);
    expect(r).not.toBeNull();
    expect(r!.tipo).toBe('problema');
    expect(r!.modulo).toBe('estoque');
  });

  it('normaliza caixa/espaços nos enums', () => {
    const r = validarTriagem({ ...base, tipo: ' Problema ', urgencia: 'ALTA', modulo: 'Estoque' });
    expect(r).not.toBeNull();
    expect(r!.tipo).toBe('problema');
    expect(r!.urgencia).toBe('alta');
    expect(r!.modulo).toBe('estoque');
  });

  it('módulo desconhecido vira "outro" (lista evolui, não rejeita)', () => {
    const r = validarTriagem({ ...base, modulo: 'modulo-inventado' });
    expect(r).not.toBeNull();
    expect(r!.modulo).toBe('outro');
  });

  it('rejeita tipo fora do enum', () => {
    expect(validarTriagem({ ...base, tipo: 'reclamacao' })).toBeNull();
  });

  it('rejeita urgência fora do enum', () => {
    expect(validarTriagem({ ...base, urgencia: 'urgentissima' })).toBeNull();
  });

  it('rejeita título vazio e resposta vazia', () => {
    expect(validarTriagem({ ...base, titulo: '  ' })).toBeNull();
    expect(validarTriagem({ ...base, resposta_ao_funcionario: '' })).toBeNull();
  });

  it('trunca título em 120 chars', () => {
    const r = validarTriagem({ ...base, titulo: 'x'.repeat(300) });
    expect(r!.titulo.length).toBe(120);
  });

  it('avaliacao_founder ausente vira string vazia (não rejeita — campo pro founder é best-effort)', () => {
    const r = validarTriagem({ ...base, avaliacao_founder: undefined });
    expect(r).not.toBeNull();
    expect(r!.avaliacao_founder).toBe('');
  });

  it('rejeita não-objeto', () => {
    expect(validarTriagem(null)).toBeNull();
    expect(validarTriagem('texto')).toBeNull();
    expect(validarTriagem(42)).toBeNull();
  });
});
```

- [ ] **Step 1.3: Rodar e ver falhar**

Run: `bunx vitest run src/lib/melhorias/__tests__/triagem-helpers.test.ts`
Expected: FAIL — `Cannot find module '../triagem-helpers'`

- [ ] **Step 1.4: Implementar `validarTriagem`**

```typescript
// src/lib/melhorias/triagem-helpers.ts
// Helpers puros da triagem — ESPELHADOS VERBATIM na edge `melhoria-triagem`
// (Deno não importa do src/; ao alterar aqui, alterar lá).
import {
  MELHORIA_MODULOS,
  MAX_MENSAGENS_FUNCIONARIO,
  type MelhoriaModulo,
  type MelhoriaTipo,
  type MelhoriaUrgencia,
  type TriagemValidada,
} from './types';

const TIPOS: ReadonlyArray<MelhoriaTipo> = ['problema', 'sugestao', 'pergunta'];
const URGENCIAS: ReadonlyArray<MelhoriaUrgencia> = ['baixa', 'media', 'alta'];

function normStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Valida/normaliza o output da tool `triar` da IA.
 * Retorna null quando o payload é inaproveitável (a edge marca triagem_status='erro').
 * Módulo desconhecido degrada pra 'outro' (lista evolui sem quebrar).
 */
export function validarTriagem(payload: unknown): TriagemValidada | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;

  const tipo = normStr(p.tipo).toLowerCase() as MelhoriaTipo;
  if (!TIPOS.includes(tipo)) return null;

  const urgencia = normStr(p.urgencia).toLowerCase() as MelhoriaUrgencia;
  if (!URGENCIAS.includes(urgencia)) return null;

  const moduloRaw = normStr(p.modulo).toLowerCase();
  const modulo: MelhoriaModulo = (MELHORIA_MODULOS as ReadonlyArray<string>).includes(moduloRaw)
    ? (moduloRaw as MelhoriaModulo)
    : 'outro';

  const titulo = normStr(p.titulo).slice(0, 120);
  const resposta = normStr(p.resposta_ao_funcionario);
  if (!titulo || !resposta) return null;

  return {
    tipo,
    urgencia,
    modulo,
    titulo,
    resposta_ao_funcionario: resposta,
    avaliacao_founder: normStr(p.avaliacao_founder),
  };
}
```

- [ ] **Step 1.5: Rodar e ver passar**

Run: `bunx vitest run src/lib/melhorias/__tests__/triagem-helpers.test.ts`
Expected: PASS (9 testes)

- [ ] **Step 1.6: Commit**

```bash
git add src/lib/melhorias/
git commit -m "feat(melhorias): tipos + validarTriagem (TDD) — validação do output da IA"
```

---

### Task 2: `podeReplicar` (TDD)

**Files:**
- Modify: `src/lib/melhorias/triagem-helpers.ts`
- Test: `src/lib/melhorias/__tests__/triagem-helpers.test.ts` (append)

- [ ] **Step 2.1: Testes (falham)** — append no mesmo arquivo de teste:

```typescript
import { podeReplicar } from '../triagem-helpers';
import type { MelhoriaItem, MelhoriaMensagem } from '../types';

function item(status: MelhoriaItem['status']): MelhoriaItem {
  return {
    id: 'i1', autor_user_id: 'u1', empresa: 'oben', rota_origem: '/sales/new',
    tipo: 'problema', urgencia: 'media', modulo: 'vendas', titulo: 't',
    status, triagem_status: 'ok', avaliacao_founder: null, resposta_founder: null,
    resolvido_em: null, created_at: '2026-06-10T12:00:00Z', updated_at: '2026-06-10T12:00:00Z',
  };
}
function msgs(nFuncionario: number): MelhoriaMensagem[] {
  const out: MelhoriaMensagem[] = [];
  for (let i = 0; i < nFuncionario; i++) {
    out.push({ id: `f${i}`, item_id: 'i1', autor_user_id: 'u1', papel: 'funcionario', conteudo: 'm', dados: null, created_at: '2026-06-10T12:00:00Z' });
    out.push({ id: `a${i}`, item_id: 'i1', autor_user_id: null, papel: 'ia', conteudo: 'r', dados: null, created_at: '2026-06-10T12:00:01Z' });
  }
  return out;
}

describe('podeReplicar', () => {
  it('permite em item aberto com 1 mensagem', () => {
    expect(podeReplicar(item('aberto'), msgs(1)).ok).toBe(true);
  });
  it('permite em item em_andamento', () => {
    expect(podeReplicar(item('em_andamento'), msgs(2)).ok).toBe(true);
  });
  it('bloqueia em resolvido e descartado', () => {
    expect(podeReplicar(item('resolvido'), msgs(1)).ok).toBe(false);
    expect(podeReplicar(item('descartado'), msgs(1)).ok).toBe(false);
  });
  it('bloqueia na 6ª mensagem do funcionário (cap = 1 inicial + 5 réplicas)', () => {
    expect(podeReplicar(item('aberto'), msgs(5)).ok).toBe(true);
    const r = podeReplicar(item('aberto'), msgs(6));
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('Limite');
  });
  it('mensagens da IA/founder não contam pro cap', () => {
    const extras: MelhoriaMensagem[] = [
      { id: 'x1', item_id: 'i1', autor_user_id: 'mast', papel: 'founder', conteudo: 'ok', dados: null, created_at: '2026-06-10T13:00:00Z' },
    ];
    expect(podeReplicar(item('aberto'), [...msgs(5), ...extras]).ok).toBe(true);
  });
});
```

- [ ] **Step 2.2: Rodar e ver falhar** — `bunx vitest run src/lib/melhorias/__tests__/triagem-helpers.test.ts` → FAIL (`podeReplicar` não exportado)

- [ ] **Step 2.3: Implementar** — append em `triagem-helpers.ts`:

```typescript
import type { MelhoriaItem, MelhoriaMensagem } from './types';

/**
 * Cap de réplicas (app-level; a edge re-valida antes de triar).
 * Réplica só em item aberto/em_andamento e com < MAX_MENSAGENS_FUNCIONARIO do autor.
 */
export function podeReplicar(
  item: Pick<MelhoriaItem, 'status'>,
  mensagens: Array<Pick<MelhoriaMensagem, 'papel'>>,
): { ok: boolean; motivo?: string } {
  if (item.status !== 'aberto' && item.status !== 'em_andamento') {
    return { ok: false, motivo: 'Item já foi finalizado — abra um novo se precisar.' };
  }
  const doFuncionario = mensagens.filter((m) => m.papel === 'funcionario').length;
  if (doFuncionario >= MAX_MENSAGENS_FUNCIONARIO) {
    return { ok: false, motivo: 'Limite de réplicas atingido — abra um novo item se precisar.' };
  }
  return { ok: true };
}
```

- [ ] **Step 2.4: Rodar e ver passar** — Expected: PASS (14 testes)

- [ ] **Step 2.5: Commit**

```bash
git add src/lib/melhorias/
git commit -m "feat(melhorias): podeReplicar — cap de réplicas e gate de status (TDD)"
```

---

### Task 3: `montarPromptClaudeCode` (TDD)

**Files:**
- Create: `src/lib/melhorias/prompt-claude.ts`
- Test: `src/lib/melhorias/__tests__/prompt-claude.test.ts`

- [ ] **Step 3.1: Testes (falham)**

```typescript
// src/lib/melhorias/__tests__/prompt-claude.test.ts
import { describe, it, expect } from 'vitest';
import { montarPromptClaudeCode } from '../prompt-claude';
import type { MelhoriaItem, MelhoriaMensagem } from '../types';

const item: MelhoriaItem = {
  id: 'abc12345-0000-0000-0000-000000000000',
  autor_user_id: 'u1', empresa: 'oben', rota_origem: '/admin/estoque/picking',
  tipo: 'problema', urgencia: 'alta', modulo: 'estoque',
  titulo: 'Picking trava ao bipar duas vezes',
  status: 'aberto', triagem_status: 'ok',
  avaliacao_founder: 'Provável replay sem idempotência no confirmPickItem.',
  resposta_founder: null, resolvido_em: null,
  created_at: '2026-06-10T15:30:00Z', updated_at: '2026-06-10T15:30:00Z',
};
const mensagens: MelhoriaMensagem[] = [
  { id: 'm1', item_id: item.id, autor_user_id: 'u1', papel: 'funcionario', conteudo: 'O picking trava quando bipo duas vezes seguidas', dados: null, created_at: '2026-06-10T15:30:00Z' },
  { id: 'm2', item_id: item.id, autor_user_id: null, papel: 'ia', conteudo: 'Entendi: problema no picking.', dados: { tools: [{ tool: 'clientes_por_produto', input: { p_termo: 'x' }, resultado: { clientes: [] } }] }, created_at: '2026-06-10T15:30:05Z' },
];

describe('montarPromptClaudeCode', () => {
  it('inclui contexto, relato, avaliação e pedido', () => {
    const p = montarPromptClaudeCode(item, mensagens, 'Regina');
    expect(p).toContain('abc12345'); // id curto
    expect(p).toContain('Regina');
    expect(p).toContain('/admin/estoque/picking');
    expect(p).toContain('oben');
    expect(p).toContain('O picking trava quando bipo duas vezes seguidas');
    expect(p).toContain('Provável replay sem idempotência');
    expect(p).toContain('causa raiz');
  });

  it('marca mensagens da IA que consultaram dados, sem despejar a tabela', () => {
    const p = montarPromptClaudeCode(item, mensagens, 'Regina');
    expect(p).toContain('[ia — consultou clientes_por_produto]');
    expect(p).not.toContain('"clientes":');
  });

  it('degrada honesto sem triagem', () => {
    const semTriagem = { ...item, tipo: null, urgencia: null, modulo: null, titulo: null, avaliacao_founder: null };
    const p = montarPromptClaudeCode(semTriagem, [mensagens[0]], 'Regina');
    expect(p).toContain('não triado');
    expect(p).toContain('(triagem indisponível)');
  });

  it('rota nula vira "não informada"', () => {
    const p = montarPromptClaudeCode({ ...item, rota_origem: null }, mensagens, 'Regina');
    expect(p).toContain('não informada');
  });
});
```

- [ ] **Step 3.2: Rodar e ver falhar** — FAIL (módulo não existe)

- [ ] **Step 3.3: Implementar**

```typescript
// src/lib/melhorias/prompt-claude.ts
// Monta o bloco copiável que o founder cola no Claude Code pra atacar um item.
// 100% determinístico (montado client-side da thread atual — nunca persiste stale).
import type { MelhoriaItem, MelhoriaMensagem } from './types';

function fmtData(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function montarPromptClaudeCode(
  item: MelhoriaItem,
  mensagens: MelhoriaMensagem[],
  autorNome: string,
): string {
  const idCurto = item.id.slice(0, 8);
  const thread = mensagens
    .map((m) => {
      const tools = m.dados?.tools?.map((t) => t.tool) ?? [];
      const tag = m.papel === 'ia' && tools.length > 0 ? `[ia — consultou ${tools.join(', ')}]` : `[${m.papel}]`;
      return `${tag} ${m.conteudo}`;
    })
    .join('\n');

  return `## Melhoria reportada no app — item ${idCurto}

- **Reportado por:** ${autorNome} em ${fmtData(item.created_at)}
- **Tela de origem:** ${item.rota_origem ?? 'não informada'} · **Empresa ativa:** ${item.empresa}
- **Tipo (triagem IA):** ${item.tipo ?? 'não triado'} · **Urgência:** ${item.urgencia ?? '—'} · **Módulo:** ${item.modulo ?? '—'}
- **Título (IA):** ${item.titulo ?? '—'}

### Relato (thread completa)
${thread}

### Avaliação técnica da IA
${item.avaliacao_founder || '(triagem indisponível)'}

### Pedido
Investigue e resolva o item acima no app Afiação. Comece reproduzindo na tela \`${item.rota_origem ?? '(rota não informada)'}\`. Se for bug, ache a causa raiz antes de corrigir; se for sugestão, avalie e proponha o design antes de implementar. Ao final, me diga o que foi feito pra eu responder ao funcionário.`;
}
```

- [ ] **Step 3.4: Rodar e ver passar** — `bunx vitest run src/lib/melhorias/` → PASS (18 testes)

- [ ] **Step 3.5: Commit**

```bash
git add src/lib/melhorias/
git commit -m "feat(melhorias): montarPromptClaudeCode — bloco copiável pro founder (TDD)"
```

---

### Task 4: Migration — tabelas + RLS + RPCs de dados

**Files:**
- Create: `supabase/migrations/20260610130000_melhorias_canal.sql`

- [ ] **Step 4.1: Checar colisão de timestamp/trabalho paralelo** (lição §10 do CLAUDE.md)

Run: `git fetch origin main --quiet 2>/dev/null; git ls-tree origin/main supabase/migrations/ | grep 20260610 || echo "sem migration de hoje na main"`
Expected: nenhuma colisão com `20260610130000`. Se houver, realocar pra timestamp maior.

- [ ] **Step 4.2: Escrever a migration** (conteúdo COMPLETO):

```sql
-- 20260610130000_melhorias_canal.sql
-- Canal interno de Melhorias: staff reporta problema/sugestão/pergunta; IA tria
-- na hora (edge melhoria-triagem); founder consome fila master.
-- Spec: docs/superpowers/specs/2026-06-10-melhorias-canal-feedback-design.md
-- ⚠️ APLICAÇÃO MANUAL via SQL Editor do Lovable (§5 CLAUDE.md).

-- ============ TABELAS ============

create table if not exists public.melhoria_itens (
  id uuid primary key default gen_random_uuid(),
  autor_user_id uuid not null,
  empresa text not null check (empresa in ('colacor','oben','colacor_sc')),
  rota_origem text,
  tipo text check (tipo in ('problema','sugestao','pergunta')),
  urgencia text check (urgencia in ('baixa','media','alta')),
  modulo text,
  titulo text,
  status text not null default 'aberto' check (status in ('aberto','em_andamento','resolvido','descartado')),
  triagem_status text not null default 'pendente' check (triagem_status in ('pendente','ok','erro')),
  avaliacao_founder text,
  resposta_founder text,
  resolvido_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_melhoria_itens_status on public.melhoria_itens (status, created_at desc);
create index if not exists idx_melhoria_itens_autor on public.melhoria_itens (autor_user_id, created_at desc);

create table if not exists public.melhoria_mensagens (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.melhoria_itens(id) on delete cascade,
  autor_user_id uuid,
  papel text not null check (papel in ('funcionario','ia','founder')),
  conteudo text not null check (length(trim(conteudo)) > 0),
  dados jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_melhoria_mensagens_item on public.melhoria_mensagens (item_id, created_at);

-- updated_at automático (padrão do projeto)
create or replace function public.melhoria_itens_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_melhoria_itens_touch on public.melhoria_itens;
create trigger trg_melhoria_itens_touch
  before update on public.melhoria_itens
  for each row execute function public.melhoria_itens_touch_updated_at();

-- ============ RLS ============

alter table public.melhoria_itens enable row level security;
alter table public.melhoria_mensagens enable row level security;

-- Itens: autor vê os próprios; master vê tudo.
drop policy if exists melhoria_itens_select on public.melhoria_itens;
create policy melhoria_itens_select on public.melhoria_itens for select to authenticated
using (
  autor_user_id = (select auth.uid())
  or has_role((select auth.uid()), 'master'::app_role)
);

-- INSERT: qualquer staff (employee/master), sempre como autor de si mesmo.
drop policy if exists melhoria_itens_insert on public.melhoria_itens;
create policy melhoria_itens_insert on public.melhoria_itens for insert to authenticated
with check (
  autor_user_id = (select auth.uid())
  and (has_role((select auth.uid()), 'employee'::app_role) or has_role((select auth.uid()), 'master'::app_role))
);

-- UPDATE: só master (status/resposta/triagem manual). Campos da IA são gravados via service_role (bypassa RLS).
drop policy if exists melhoria_itens_update on public.melhoria_itens;
create policy melhoria_itens_update on public.melhoria_itens for update to authenticated
using (has_role((select auth.uid()), 'master'::app_role))
with check (has_role((select auth.uid()), 'master'::app_role));

-- Sem policy de DELETE (descartar é status; nada é apagado).

-- Mensagens: vê quem vê o item.
drop policy if exists melhoria_mensagens_select on public.melhoria_mensagens;
create policy melhoria_mensagens_select on public.melhoria_mensagens for select to authenticated
using (
  exists (
    select 1 from public.melhoria_itens i
    where i.id = melhoria_mensagens.item_id
      and (i.autor_user_id = (select auth.uid()) or has_role((select auth.uid()), 'master'::app_role))
  )
);

-- INSERT: autor do item manda réplica (papel funcionario) em item não-finalizado;
-- master responde (papel founder). Mensagens papel='ia' SÓ via service_role (sem policy — bypassa).
drop policy if exists melhoria_mensagens_insert on public.melhoria_mensagens;
create policy melhoria_mensagens_insert on public.melhoria_mensagens for insert to authenticated
with check (
  autor_user_id = (select auth.uid())
  and (
    (
      papel = 'funcionario'
      and exists (
        select 1 from public.melhoria_itens i
        where i.id = melhoria_mensagens.item_id
          and i.autor_user_id = (select auth.uid())
          and i.status in ('aberto','em_andamento')
      )
    )
    or (
      papel = 'founder'
      and has_role((select auth.uid()), 'master'::app_role)
    )
  )
);

-- ============ RPCs DE DADOS (ferramentas da IA) ============
-- SECURITY DEFINER com gate interno: staff obrigatório; visibilidade de clientes
-- respeita carteira (pode_ver_carteira_completa / carteira_visivel_para — #329).
-- Chamadas pela edge com o JWT do CALLER (auth.uid() = solicitante real).

create or replace function public.melhoria_clientes_por_produto(p_termo text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_full boolean;
  v_result jsonb;
begin
  if v_uid is null or not (has_role(v_uid,'employee'::app_role) or has_role(v_uid,'master'::app_role)) then
    raise exception 'Apenas staff pode consultar';
  end if;
  if length(trim(coalesce(p_termo,''))) < 3 then
    raise exception 'Termo de busca muito curto (mínimo 3 caracteres)';
  end if;
  v_full := pode_ver_carteira_completa(v_uid);

  with prods as (
    select id, descricao, codigo, account
    from omie_products
    where coalesce(ativo, true) = true
      and (descricao ilike '%' || trim(p_termo) || '%' or codigo ilike '%' || trim(p_termo) || '%')
    order by descricao
    limit 5
  ),
  compras as (
    select oi.customer_user_id,
           count(distinct oi.sales_order_id) as n_pedidos,
           max(coalesce(so.order_date_kpi, so.created_at::date)) as ultima_compra,
           sum(oi.quantity * oi.unit_price) as valor_12m
    from order_items oi
    join sales_orders so on so.id = oi.sales_order_id
    join prods p on p.id = oi.product_id
    where so.status not in ('cancelado','rascunho','pendente')   -- pedido válido (padrão #279)
      and so.deleted_at is null
      and coalesce(so.order_date_kpi, so.created_at::date) >= current_date - interval '12 months'
    group by oi.customer_user_id
  ),
  visiveis as (
    select c.* from compras c
    where v_full or carteira_visivel_para(c.customer_user_id, v_uid)
  ),
  top50 as (
    select * from visiveis order by valor_12m desc limit 50
  )
  select jsonb_build_object(
    'produtos_casados', (select coalesce(jsonb_agg(jsonb_build_object(
        'descricao', descricao, 'codigo', codigo, 'account', account)), '[]'::jsonb) from prods),
    'clientes', (select coalesce(jsonb_agg(jsonb_build_object(
        'cliente', coalesce(pr.razao_social, pr.name),
        'n_pedidos', t.n_pedidos,
        'ultima_compra', t.ultima_compra,
        'valor_12m', round(t.valor_12m::numeric, 2)
      ) order by t.valor_12m desc), '[]'::jsonb)
      from top50 t join profiles pr on pr.user_id = t.customer_user_id),
    'total_clientes_visiveis', (select count(*) from visiveis),
    'escopo', case when v_full then 'todos' else 'minha_carteira' end
  ) into v_result;

  return v_result;
end $$;

revoke execute on function public.melhoria_clientes_por_produto(text) from anon, public;
grant execute on function public.melhoria_clientes_por_produto(text) to authenticated, service_role;

create or replace function public.melhoria_produtos_relacionados(p_termo text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  if v_uid is null or not (has_role(v_uid,'employee'::app_role) or has_role(v_uid,'master'::app_role)) then
    raise exception 'Apenas staff pode consultar';
  end if;
  if length(trim(coalesce(p_termo,''))) < 3 then
    raise exception 'Termo de busca muito curto (mínimo 3 caracteres)';
  end if;

  with alvo as (
    select id, descricao, codigo, familia, account
    from omie_products
    where coalesce(ativo, true) = true
      and (descricao ilike '%' || trim(p_termo) || '%' or codigo ilike '%' || trim(p_termo) || '%')
    order by descricao
    limit 5
  ),
  mesma_familia as (
    select distinct op.descricao, op.codigo, op.familia
    from omie_products op
    join alvo a on a.familia is not null and op.familia = a.familia and op.account = a.account
    where coalesce(op.ativo, true) = true
      and op.id not in (select id from alvo)
    limit 10
  ),
  regras as (
    -- arrays gravados pelo engine de associação guardam omie_products.id como texto
    select cons_id, max(r.confidence) as confidence, max(r.lift) as lift
    from farmer_association_rules r
    cross join lateral unnest(r.consequent_product_ids::text[]) as cons_id
    where exists (select 1 from alvo a where a.id::text = any(r.antecedent_product_ids::text[]))
    group by cons_id
    order by max(r.lift) desc
    limit 10
  ),
  comprados_juntos as (
    select op.descricao, op.codigo, round(r.confidence::numeric, 3) as confidence, round(r.lift::numeric, 2) as lift
    from regras r
    join omie_products op on op.id::text = r.cons_id
    where coalesce(op.ativo, true) = true
      and op.id not in (select id from alvo)
  )
  select jsonb_build_object(
    'produtos_casados', (select coalesce(jsonb_agg(jsonb_build_object(
        'descricao', descricao, 'codigo', codigo, 'account', account)), '[]'::jsonb) from alvo),
    'mesma_familia', (select coalesce(jsonb_agg(jsonb_build_object(
        'descricao', descricao, 'codigo', codigo, 'familia', familia)), '[]'::jsonb) from mesma_familia),
    'comprados_juntos', (select coalesce(jsonb_agg(jsonb_build_object(
        'descricao', descricao, 'codigo', codigo, 'confidence', confidence, 'lift', lift)), '[]'::jsonb) from comprados_juntos)
  ) into v_result;

  return v_result;
end $$;

revoke execute on function public.melhoria_produtos_relacionados(text) from anon, public;
grant execute on function public.melhoria_produtos_relacionados(text) to authenticated, service_role;
```

- [ ] **Step 4.3: Regenerar o audit de migrations**

Run: `bun run audit:migrations`
Expected: `docs/migrations-audit.md` + `scripts/audit-custom-migrations.sql` regenerados incluindo a nova migration.

- [ ] **Step 4.4: Commit**

```bash
git add supabase/migrations/20260610130000_melhorias_canal.sql docs/migrations-audit.md scripts/audit-custom-migrations.sql
git commit -m "feat(melhorias): migration — melhoria_itens/mensagens + RLS + 2 RPCs de dados (apply manual)"
```

---

### Task 5: Teste PG17 das RPCs + RLS

**Files:**
- Create: `db/test-melhorias-rpcs.sh` (executável)

- [ ] **Step 5.1: Escrever o script** seguindo o esqueleto de `db/test-minimo-forcado.sh` (initdb PG17 porta 5434→usar **5436** pra não colidir, stubs + snapshot + migration + seeds + asserts). Estrutura:

```bash
#!/usr/bin/env bash
# Teste PG17 do canal Melhorias — RPCs de dados (agregação/carteira/guards) + RLS (own/master/anon).
# Aplica stubs + schema-snapshot + 20260610130000_melhorias_canal.sql, semeia produtos/pedidos/
# carteira/roles e assere: clientes_por_produto (master full vs vendedora só-carteira, janela 12m,
# pedido válido), produtos_relacionados (família + associação), guards (anon/cliente/termo curto),
# RLS de itens/mensagens (own/master/insert alheio barrado).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5436
DATA="$(mktemp -d /tmp/pgtest-melhorias.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-melhorias.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres melhorias_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d melhorias_verify "$@"; }

echo "— aplicando stubs + snapshot + migration…"
P -q -v ON_ERROR_STOP=1 -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q -v ON_ERROR_STOP=1 -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" 2>/dev/null || true
P -q -f "$REPO_ROOT/supabase/schema-snapshot.sql" >/dev/null 2>&1 || true   # snapshot tolera ruído (padrão dos irmãos)
P -q -v ON_ERROR_STOP=1 -f "$REPO_ROOT/supabase/migrations/20260610130000_melhorias_canal.sql"
```

Depois do boilerplate: bloco de **seeds** + **asserts** (`P -v ON_ERROR_STOP=1 -q <<'SQL' ... SQL`). Seeds mínimos:
- `auth.users`: `u-master`, `u-vend` (vendedora), `u-cli` (cliente), `c1`/`c2` (clientes compradores).
- `user_roles`: master→u-master, employee→u-vend, customer→u-cli.
- `profiles`: name pra todos (`user_id` = ids acima).
- `carteira_assignments`: c1→owner u-vend (c2 fica fora da carteira dela).
- `omie_products`: P1 'LIXA GR80' familia 'ABRASIVOS' account oben ativo; P2 'LIXA GR120' mesma família; P3 'COLA X' outra família; P4 inativo 'LIXA GR240'.
- `sales_orders`+`order_items`: c1 comprou P1 há 2 meses (válido), c2 comprou P1 há 3 meses (válido), c1 comprou P1 há 14 meses (fora da janela), c2 pedido cancelado com P1 (excluído).
- `farmer_association_rules`: antecedent [P1::text] → consequent [P3::text], confidence 0.4, lift 2.1.

Mecanismo de identidade: copiar o override de `auth.uid()` por GUC usado em `db/verify-snapshot-replay.sh` (redefinir `auth.uid()` pra ler `current_setting('test.uid', true)::uuid`), e setar `set local role authenticated; set local test.uid = '<id>';` por cenário em transação.

Asserts (todos com `do $$ ... assert ... $$;` ou `\gset` + comparação):
1. **Master vê os 2 clientes** (`melhoria_clientes_por_produto('LIXA GR80')` → `total_clientes_visiveis=2`, escopo `todos`; pedido de 14 meses e cancelado NÃO inflam `n_pedidos`/`valor_12m` — assert nos valores exatos de c1).
2. **Vendedora vê só c1** (escopo `minha_carteira`, `total_clientes_visiveis=1`).
3. **Cliente (customer) → exception** 'Apenas staff'.
4. **Termo curto → exception**.
5. **produtos_relacionados('LIXA GR80')** → `mesma_familia` contém P2 e NÃO P4 (inativo) nem P1 (alvo); `comprados_juntos` contém P3 com lift 2.1.
6. **RLS itens**: como u-vend INSERT item ok (autor=self); como u-vend SELECT só o próprio (item do master invisível); como u-master SELECT vê ambos; u-vend UPDATE status → 0 linhas afetadas (sem grito, mas sem efeito); u-cli INSERT → barrado (RLS error).
7. **RLS mensagens**: u-vend INSERT réplica no próprio item aberto ok; em item do master → barrado; papel 'founder' por u-vend → barrado; u-master INSERT papel 'founder' em item da vendedora ok.

Final: `echo "✅ test-melhorias-rpcs: todos os asserts passaram"`.

- [ ] **Step 5.2: Tornar executável e rodar**

Run: `chmod +x db/test-melhorias-rpcs.sh && heavy ./db/test-melhorias-rpcs.sh`
Expected: `✅ test-melhorias-rpcs: todos os asserts passaram`. Iterar na migration até passar (erros de tipo das colunas reais do snapshot — ex.: `antecedent_product_ids` uuid[] vs text[] — aparecem AQUI; ajustar a migration, não o teste).

- [ ] **Step 5.3: Commit**

```bash
git add db/test-melhorias-rpcs.sh supabase/migrations/20260610130000_melhorias_canal.sql
git commit -m "test(melhorias): PG17 — RPCs (carteira/janela/guards) + RLS own/master validados"
```

---

### Task 6: Edge function `melhoria-triagem`

**Files:**
- Create: `supabase/functions/melhoria-triagem/index.ts`

- [ ] **Step 6.1: Escrever a edge** (completa; espelha `validarTriagem` verbatim):

```typescript
// supabase/functions/melhoria-triagem/index.ts
// Triagem por IA do canal de Melhorias. Anthropic direto (caminho canônico (a) do CLAUDE.md):
// claude-sonnet-4-6 + forced tool-use + prompt caching. Loop agentic com 2 tools de dados
// (RPCs com o JWT do CALLER — só quando caller == autor do item) + tool terminal `triar`.
// A captação NUNCA depende daqui: falha => triagem_status='erro' e o item segue na fila.
import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import { createClient } from "npm:@supabase/supabase-js@^2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const MAX_MENSAGENS_FUNCIONARIO = 6;
const MAX_TOOL_CALLS_DADOS = 3;

// ===== Espelho VERBATIM de src/lib/melhorias/triagem-helpers.ts (Deno não importa do src/) =====
const MELHORIA_MODULOS = [
  "vendas", "estoque", "reposicao", "financeiro", "tintometrico", "afiacao",
  "whatsapp", "rota", "tarefas", "producao", "governanca", "outro",
] as const;
type MelhoriaModulo = (typeof MELHORIA_MODULOS)[number];
type MelhoriaTipo = "problema" | "sugestao" | "pergunta";
type MelhoriaUrgencia = "baixa" | "media" | "alta";
interface TriagemValidada {
  tipo: MelhoriaTipo; urgencia: MelhoriaUrgencia; modulo: MelhoriaModulo;
  titulo: string; resposta_ao_funcionario: string; avaliacao_founder: string;
}
const TIPOS: ReadonlyArray<MelhoriaTipo> = ["problema", "sugestao", "pergunta"];
const URGENCIAS: ReadonlyArray<MelhoriaUrgencia> = ["baixa", "media", "alta"];
function normStr(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }
function validarTriagem(payload: unknown): TriagemValidada | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const tipo = normStr(p.tipo).toLowerCase() as MelhoriaTipo;
  if (!TIPOS.includes(tipo)) return null;
  const urgencia = normStr(p.urgencia).toLowerCase() as MelhoriaUrgencia;
  if (!URGENCIAS.includes(urgencia)) return null;
  const moduloRaw = normStr(p.modulo).toLowerCase();
  const modulo: MelhoriaModulo = (MELHORIA_MODULOS as ReadonlyArray<string>).includes(moduloRaw)
    ? (moduloRaw as MelhoriaModulo) : "outro";
  const titulo = normStr(p.titulo).slice(0, 120);
  const resposta = normStr(p.resposta_ao_funcionario);
  if (!titulo || !resposta) return null;
  return { tipo, urgencia, modulo, titulo, resposta_ao_funcionario: resposta, avaliacao_founder: normStr(p.avaliacao_founder) };
}
// ===== fim do espelho =====

const SYSTEM_PROMPT = `Você é a triagem do canal interno de melhorias do sistema operacional B2B "Colacor" (grupo de 3 empresas: Colacor = indústria de abrasivos; Oben = distribuidora para indústria moveleira; Colacor SC = serviços de afiação). Funcionários (vendedoras, separadores, conferentes, compradores, operadores tintométricos, gestores) mandam mensagens que são PROBLEMAS (algo quebrado/errado no app), SUGESTÕES (melhoria de fluxo/tela) ou PERGUNTAS (dúvida ou pedido de dados).

Módulos do app: vendas (pedidos, clientes, carteira), estoque (picking, recebimento), reposicao (compras, fornecedores, portal Sayerlack), financeiro, tintometrico (tintas e fórmulas), afiacao (ordens de serviço de afiação), whatsapp (inbox), rota (lista de ligação/entregas), tarefas, producao, governanca, outro.

REGRAS INEGOCIÁVEIS:
1. NUNCA invente números, nomes de clientes ou produtos. Números só podem vir de resultado de ferramenta (tool_result). Na prosa, não repita os números linha a linha — a interface mostra a tabela; você pode citar o total retornado.
2. Se a mensagem contém uma PERGUNTA DE DADOS que casa com uma ferramenta disponível, chame a ferramenta. Se nenhuma casa, classifique como "pergunta" e diga honestamente que vai para a fila do Lucas (o founder).
3. SEMPRE termine chamando a tool "triar" — mesmo quando usou ferramentas de dados antes.
4. resposta_ao_funcionario: português brasileiro, cordial, curta (2 a 5 frases), tratando por "você". Confirme o que entendeu. Se consultou dados, resuma em 1-2 frases (a tabela aparece junto da sua mensagem). Se for problema/sugestão, confirme que foi para a fila do founder.
5. avaliacao_founder: nota técnica para o founder (que é dev): hipótese de causa provável, módulo/tela onde mexer, o que validar primeiro. Seja específico e honesto sobre incerteza — nunca afirme causa sem evidência.
6. urgencia: alta = trava operação ou dinheiro hoje; media = atrapalha mas tem contorno; baixa = melhoria/cosmético.
7. Se a thread tem mais de uma mensagem do funcionário (réplica), re-classifique considerando a conversa inteira.`;

const TOOL_TRIAR = {
  name: "triar",
  description: "Finaliza a triagem do item com classificação e respostas. SEMPRE é a última chamada.",
  input_schema: {
    type: "object",
    properties: {
      tipo: { type: "string", enum: ["problema", "sugestao", "pergunta"] },
      urgencia: { type: "string", enum: ["baixa", "media", "alta"] },
      modulo: { type: "string", enum: [...MELHORIA_MODULOS] },
      titulo: { type: "string", description: "Resumo de 1 linha do item" },
      resposta_ao_funcionario: { type: "string" },
      avaliacao_founder: { type: "string" },
    },
    required: ["tipo", "urgencia", "modulo", "titulo", "resposta_ao_funcionario", "avaliacao_founder"],
  },
} as const;

const TOOL_CLIENTES = {
  name: "clientes_por_produto",
  description: "Lista clientes que compraram um produto nos últimos 12 meses (nº de pedidos, última compra, valor). Use quando a pergunta é sobre QUEM compra/usa um produto. O resultado respeita a visibilidade de carteira de quem perguntou.",
  input_schema: {
    type: "object",
    properties: { p_termo: { type: "string", description: "Nome ou código do produto (mínimo 3 caracteres)" } },
    required: ["p_termo"],
  },
} as const;

const TOOL_RELACIONADOS = {
  name: "produtos_relacionados",
  description: "Lista produtos substitutos/relacionados: mesma família no catálogo + produtos comprados juntos (regras de associação com confiança e lift). Use para perguntas de substituição/alternativa/cross-sell de um produto.",
  input_schema: {
    type: "object",
    properties: { p_termo: { type: "string", description: "Nome ou código do produto (mínimo 3 caracteres)" } },
    required: ["p_termo"],
  },
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;
  // Triagem é sempre disparada por um usuário; cron/service_role não se aplicam aqui.
  if (auth.via !== "staff" || !auth.userId) return jsonResponse({ error: "Apenas staff" }, 403);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  let itemId = "";
  try {
    const body = await req.json();
    itemId = String(body?.item_id ?? "").trim();
  } catch { /* body inválido cai no guard abaixo */ }
  if (!itemId) return jsonResponse({ error: "item_id obrigatório" }, 400);

  // Anti-spoof: conteúdo vem do banco, nunca do payload.
  const { data: item, error: itemErr } = await admin
    .from("melhoria_itens").select("*").eq("id", itemId).maybeSingle();
  if (itemErr) return jsonResponse({ error: `Falha ao ler item: ${itemErr.message}` }, 500);
  if (!item) return jsonResponse({ error: "Item não encontrado" }, 404);

  // Autorização: autor do item OU master.
  const callerIsAutor = auth.userId === item.autor_user_id;
  if (!callerIsAutor) {
    const { data: isMaster, error: roleErr } = await admin.rpc("has_role", { _user_id: auth.userId, _role: "master" });
    if (roleErr || isMaster !== true) return jsonResponse({ error: "Forbidden" }, 403);
  }

  const { data: mensagens, error: msgErr } = await admin
    .from("melhoria_mensagens").select("*").eq("item_id", itemId).order("created_at", { ascending: true });
  if (msgErr) return jsonResponse({ error: `Falha ao ler thread: ${msgErr.message}` }, 500);
  if (!mensagens || mensagens.length === 0) return jsonResponse({ error: "Item sem mensagens" }, 422);

  // Cap de réplicas (re-validação server-side do app-level cap).
  const doFuncionario = mensagens.filter((m) => m.papel === "funcionario").length;
  if (doFuncionario > MAX_MENSAGENS_FUNCIONARIO) {
    return jsonResponse({ error: "Limite de réplicas do item atingido" }, 422);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  const marcarErro = async () => {
    await admin.from("melhoria_itens").update({ triagem_status: "erro" }).eq("id", itemId);
  };
  if (!apiKey) {
    await marcarErro();
    return jsonResponse({ ok: false, fallback: true });
  }

  // ⚠️ Anti-vazamento de carteira (P1 da spec §5): tools de dados SÓ quando o caller
  // é o autor (o JWT do caller define o escopo). Re-triagem por master de item alheio
  // roda SEM tools de dados — só classificação.
  const toolsDadosHabilitadas = callerIsAutor;
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });

  try {
    const client = new Anthropic({ apiKey });
    const thread = mensagens
      .map((m) => `[${m.papel}] ${m.conteudo}`)
      .join("\n");
    const userMsg = `Contexto do item:
- Empresa ativa no envio: ${item.empresa}
- Tela de origem: ${item.rota_origem ?? "não informada"}
- Ferramentas de dados ${toolsDadosHabilitadas ? "DISPONÍVEIS" : "INDISPONÍVEIS nesta execução (apenas classifique)"}

Thread do funcionário:
"""
${thread}
"""

Avalie e finalize chamando a tool "triar".`;

    const tools = toolsDadosHabilitadas ? [TOOL_CLIENTES, TOOL_RELACIONADOS, TOOL_TRIAR] : [TOOL_TRIAR];
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMsg }];
    const dadosExecutados: Array<{ tool: string; input: Record<string, unknown>; resultado: unknown }> = [];
    let triagem: TriagemValidada | null = null;

    for (let i = 0; i < MAX_TOOL_CALLS_DADOS + 2; i++) {
      const forcarTriar = !toolsDadosHabilitadas || dadosExecutados.length >= MAX_TOOL_CALLS_DADOS || i === MAX_TOOL_CALLS_DADOS + 1;
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2500,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools,
        tool_choice: forcarTriar ? { type: "tool", name: "triar" } : { type: "auto" },
        messages,
      });

      const toolUse = response.content.find((b) => b.type === "tool_use");
      if (!toolUse || toolUse.type !== "tool_use") break;

      if (toolUse.name === "triar") {
        triagem = validarTriagem(toolUse.input);
        break;
      }

      // Tool de dados: executa a RPC com o JWT do caller (escopo de carteira correto).
      const input = toolUse.input as { p_termo?: string };
      const rpcName = toolUse.name === "clientes_por_produto" ? "melhoria_clientes_por_produto" : "melhoria_produtos_relacionados";
      const { data: rpcData, error: rpcErr } = await userClient.rpc(rpcName, { p_termo: String(input?.p_termo ?? "") });
      const resultado = rpcErr ? { erro: rpcErr.message } : rpcData;
      if (!rpcErr) dadosExecutados.push({ tool: toolUse.name, input: { p_termo: input?.p_termo }, resultado });

      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(resultado) }],
      });
    }

    if (!triagem) {
      await marcarErro();
      return jsonResponse({ ok: false, fallback: true });
    }

    // Persistência (service_role): item + mensagem da IA.
    const { error: upErr } = await admin.from("melhoria_itens").update({
      tipo: triagem.tipo,
      urgencia: triagem.urgencia,
      modulo: triagem.modulo,
      titulo: triagem.titulo,
      avaliacao_founder: triagem.avaliacao_founder || null,
      triagem_status: "ok",
    }).eq("id", itemId);
    if (upErr) throw new Error(`Falha ao gravar triagem: ${upErr.message}`);

    const { error: insErr } = await admin.from("melhoria_mensagens").insert({
      item_id: itemId,
      autor_user_id: null,
      papel: "ia",
      conteudo: triagem.resposta_ao_funcionario,
      dados: dadosExecutados.length > 0 ? { tools: dadosExecutados } : null,
    });
    if (insErr) throw new Error(`Falha ao gravar mensagem da IA: ${insErr.message}`);

    return jsonResponse({ ok: true, resposta: triagem.resposta_ao_funcionario, tipo: triagem.tipo, teve_dados: dadosExecutados.length > 0 });
  } catch (e) {
    console.error("[melhoria-triagem]", e);
    await marcarErro();
    return jsonResponse({ ok: false, fallback: true });
  }
});
```

- [ ] **Step 6.2: Checar tipos do Deno (best-effort)**

Run: `command -v deno >/dev/null && deno check supabase/functions/melhoria-triagem/index.ts || echo "deno ausente — CI não roda deno check (ok, §5)"`
Expected: sem erros NOVOS além dos 4 conhecidos de typing do supabase-js sem generic (pré-existentes em outras functions; se deno ausente, seguir).

- [ ] **Step 6.3: Commit**

```bash
git add supabase/functions/melhoria-triagem/
git commit -m "feat(melhorias): edge melhoria-triagem — loop agentic + tools de dados JWT-scoped + anti-vazamento na re-triagem"
```

---

### Task 7: Hook `useMelhorias`

**Files:**
- Create: `src/hooks/useMelhorias.ts`

- [ ] **Step 7.1: Escrever o hook** (completo):

```typescript
// src/hooks/useMelhorias.ts
// Queries/mutations do canal de Melhorias. Captação independe da IA:
// criarMelhoria grava item+mensagem ANTES do invoke; invoke falho = item pendente na fila.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import type { MelhoriaItem, MelhoriaMensagem, MelhoriaStatus } from '@/lib/melhorias/types';

const ITENS_KEY = ['melhorias', 'meus'] as const;
const GESTAO_KEY = ['melhorias', 'gestao'] as const;
const threadKey = (itemId: string) => ['melhorias', 'thread', itemId] as const;

async function invocarTriagem(itemId: string): Promise<{ ok: boolean; fallback?: boolean }> {
  const { data, error } = await supabase.functions.invoke('melhoria-triagem', { body: { item_id: itemId } });
  if (error) return { ok: false, fallback: true };
  return (data as { ok: boolean; fallback?: boolean }) ?? { ok: false, fallback: true };
}

/** Itens do próprio usuário (RLS já filtra; ordena mais novo primeiro). */
export function useMeusMelhoriaItens() {
  return useQuery({
    queryKey: ITENS_KEY,
    queryFn: async (): Promise<MelhoriaItem[]> => {
      const { data, error } = await supabase
        .from('melhoria_itens').select('*')
        .order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      return (data ?? []) as MelhoriaItem[];
    },
  });
}

export function useMelhoriaThread(itemId: string | null) {
  return useQuery({
    queryKey: threadKey(itemId ?? 'none'),
    enabled: !!itemId,
    queryFn: async (): Promise<MelhoriaMensagem[]> => {
      const { data, error } = await supabase
        .from('melhoria_mensagens').select('*')
        .eq('item_id', itemId!).order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as MelhoriaMensagem[];
    },
  });
}

interface CriarMelhoriaInput {
  conteudo: string;
  empresa: string;
  rotaOrigem: string;
  autorUserId: string;
}

/** Cria item + mensagem inicial e dispara a triagem. A escrita NUNCA depende da IA. */
export function useCriarMelhoria() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CriarMelhoriaInput) => {
      const { data: item, error: itemErr } = await supabase
        .from('melhoria_itens')
        .insert({ autor_user_id: input.autorUserId, empresa: input.empresa, rota_origem: input.rotaOrigem })
        .select('*').single();
      if (itemErr) throw itemErr;

      const { error: msgErr } = await supabase.from('melhoria_mensagens').insert({
        item_id: item.id, autor_user_id: input.autorUserId, papel: 'funcionario', conteudo: input.conteudo.trim(),
      });
      if (msgErr) throw msgErr;

      track('melhoria.criada', { empresa: input.empresa, rota: input.rotaOrigem });
      const triagem = await invocarTriagem(item.id);
      track('melhoria.ia_respondeu', { ok: triagem.ok });
      return { item: item as MelhoriaItem, triagemOk: triagem.ok };
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['melhorias'] });
    },
  });
}

export function useEnviarReplica(itemId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ conteudo, autorUserId }: { conteudo: string; autorUserId: string }) => {
      if (!itemId) throw new Error('Item indefinido');
      const { error } = await supabase.from('melhoria_mensagens').insert({
        item_id: itemId, autor_user_id: autorUserId, papel: 'funcionario', conteudo: conteudo.trim(),
      });
      if (error) throw error;
      track('melhoria.replica', {});
      return invocarTriagem(itemId);
    },
    onSettled: () => {
      if (itemId) qc.invalidateQueries({ queryKey: threadKey(itemId) });
      qc.invalidateQueries({ queryKey: ['melhorias'] });
    },
  });
}

/** Fila completa (master; RLS barra os demais). Filtros aplicados client-side sobre 200 itens. */
export function useGestaoMelhorias(enabled: boolean) {
  return useQuery({
    queryKey: GESTAO_KEY,
    enabled,
    queryFn: async (): Promise<MelhoriaItem[]> => {
      const { data, error } = await supabase
        .from('melhoria_itens').select('*')
        .order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      return (data ?? []) as MelhoriaItem[];
    },
  });
}

export function useAlterarStatusMelhoria() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, status, resposta }: { itemId: string; status: MelhoriaStatus; resposta?: string }) => {
      const patch: Record<string, unknown> = { status };
      if (resposta !== undefined) patch.resposta_founder = resposta.trim() || null;
      patch.resolvido_em = status === 'resolvido' || status === 'descartado' ? new Date().toISOString() : null;
      const { error } = await supabase.from('melhoria_itens').update(patch).eq('id', itemId);
      if (error) throw error;
      track('melhoria.status_alterado', { status });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['melhorias'] }),
  });
}

export function useRetriarMelhoria() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => invocarTriagem(itemId),
    onSettled: () => qc.invalidateQueries({ queryKey: ['melhorias'] }),
  });
}

/** Badge master: itens abertos. Gate no caller (enabled) — só polar quando master real. */
export function useMelhoriasBadge(enabled: boolean) {
  return useQuery({
    queryKey: ['melhorias', 'badge-abertos'],
    enabled,
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
    staleTime: 30000,
    queryFn: async (): Promise<number> => {
      const { count, error } = await supabase
        .from('melhoria_itens').select('id', { count: 'exact', head: true })
        .eq('status', 'aberto');
      if (error) return 0;
      return count ?? 0;
    },
  });
}
```

- [ ] **Step 7.2: Typecheck**

Run: `heavy bun run typecheck > /tmp/tc-melhorias.log 2>&1; echo "exit=$?"; tail -5 /tmp/tc-melhorias.log`
Expected: `exit=0`. ⚠️ Se as tabelas novas não existirem no `types.ts` gerado, o `.from('melhoria_itens')` quebra o typecheck — nesse caso usar o padrão de cast do projeto: `(supabase.from('melhoria_itens' as never) as ...)` NÃO; o padrão correto no repo para tabela ainda-sem-types é `(supabase as any)` ser PROIBIDO (lint). Solução canônica: conferir se `types.ts` precisa do bloco novo — como o Lovable regenera types no deploy, ADICIONAR manualmente as definições mínimas das 2 tabelas em `src/integrations/supabase/types.ts` seguindo o shape das vizinhas (Row/Insert/Update/Relationships) — o Lovable sobrescreve depois com o gerado real (idêntico). Validar de novo até `exit=0`.

- [ ] **Step 7.3: Commit**

```bash
git add src/hooks/useMelhorias.ts src/integrations/supabase/types.ts
git commit -m "feat(melhorias): useMelhorias — captação independente da IA + queries/badge"
```

---

### Task 8: Componentes — `MelhoriaThread` + `MelhoriaDialog`

**Files:**
- Create: `src/components/melhorias/MelhoriaThread.tsx`
- Create: `src/components/melhorias/MelhoriaDialog.tsx`

- [ ] **Step 8.1: `MelhoriaThread`** (thread + tabelas de dados; usado no dialog e nas 2 páginas):

```tsx
// src/components/melhorias/MelhoriaThread.tsx
// Thread de um item de melhoria + render das tabelas de dados das ferramentas da IA.
import type { MelhoriaDados, MelhoriaMensagem } from '@/lib/melhorias/types';
import { cn } from '@/lib/utils';

function DadosTabelas({ dados }: { dados: MelhoriaDados }) {
  return (
    <div className="mt-2 space-y-3">
      {dados.tools.map((t, i) => {
        const r = t.resultado as Record<string, unknown> | null;
        if (!r) return null;
        const clientes = Array.isArray(r.clientes) ? (r.clientes as Array<Record<string, unknown>>) : null;
        const familia = Array.isArray(r.mesma_familia) ? (r.mesma_familia as Array<Record<string, unknown>>) : null;
        const juntos = Array.isArray(r.comprados_juntos) ? (r.comprados_juntos as Array<Record<string, unknown>>) : null;
        return (
          <div key={i} className="rounded-md border bg-card p-2 text-xs">
            {clientes && (
              <table className="w-full font-tabular">
                <thead><tr className="text-muted-foreground text-left">
                  <th className="pr-2 pb-1">Cliente</th><th className="pr-2 pb-1">Pedidos</th>
                  <th className="pr-2 pb-1">Última compra</th><th className="pb-1 text-right">Valor 12m</th>
                </tr></thead>
                <tbody>
                  {clientes.map((c, j) => (
                    <tr key={j} className="border-t">
                      <td className="pr-2 py-1">{String(c.cliente ?? '—')}</td>
                      <td className="pr-2 py-1">{String(c.n_pedidos ?? '—')}</td>
                      <td className="pr-2 py-1">{c.ultima_compra ? new Date(String(c.ultima_compra)).toLocaleDateString('pt-BR') : '—'}</td>
                      <td className="py-1 text-right">{typeof c.valor_12m === 'number' ? c.valor_12m.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—'}</td>
                    </tr>
                  ))}
                  {clientes.length === 0 && <tr><td colSpan={4} className="py-1 text-muted-foreground">Nenhum cliente encontrado.</td></tr>}
                </tbody>
              </table>
            )}
            {(familia || juntos) && (
              <div className="space-y-2">
                {familia && (
                  <div>
                    <p className="text-muted-foreground mb-1">Mesma família:</p>
                    {familia.length === 0 ? <p className="text-muted-foreground">—</p> :
                      <ul className="list-disc pl-4">{familia.map((p, j) => <li key={j}>{String(p.descricao ?? '—')}</li>)}</ul>}
                  </div>
                )}
                {juntos && (
                  <div>
                    <p className="text-muted-foreground mb-1">Comprados juntos (associação):</p>
                    {juntos.length === 0 ? <p className="text-muted-foreground">—</p> :
                      <ul className="list-disc pl-4">{juntos.map((p, j) => (
                        <li key={j}>{String(p.descricao ?? '—')} <span className="text-muted-foreground">(lift {String(p.lift ?? '—')})</span></li>
                      ))}</ul>}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const PAPEL_LABEL: Record<MelhoriaMensagem['papel'], string> = {
  funcionario: 'Você', ia: 'IA', founder: 'Lucas',
};

export function MelhoriaThread({ mensagens, papelDe }: { mensagens: MelhoriaMensagem[]; papelDe?: (m: MelhoriaMensagem) => string }) {
  return (
    <div className="space-y-2">
      {mensagens.map((m) => (
        <div key={m.id} className={cn('rounded-md p-2 text-sm', m.papel === 'funcionario' ? 'bg-muted' : 'border bg-card')}>
          <p className="text-2xs text-muted-foreground mb-0.5">
            {papelDe ? papelDe(m) : PAPEL_LABEL[m.papel]} · {new Date(m.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </p>
          <p className="whitespace-pre-wrap">{m.conteudo}</p>
          {m.dados && <DadosTabelas dados={m.dados} />}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 8.2: `MelhoriaDialog`** (criação + resposta inline):

```tsx
// src/components/melhorias/MelhoriaDialog.tsx
// Dialog global (topbar) de criação de melhoria. Captura rota/empresa sozinho;
// mostra a resposta da IA inline. Falha da IA = degradação honesta (item segue na fila).
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { useCompany } from '@/contexts/CompanyContext';
import { useCriarMelhoria, useMelhoriaThread } from '@/hooks/useMelhorias';
import { MelhoriaThread } from './MelhoriaThread';

export function MelhoriaDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { user } = useAuth();
  const { activeCompany } = useCompany();
  const location = useLocation();
  const navigate = useNavigate();
  const [texto, setTexto] = useState('');
  const [itemCriadoId, setItemCriadoId] = useState<string | null>(null);
  const criar = useCriarMelhoria();
  const { data: thread } = useMelhoriaThread(itemCriadoId);

  const fechar = (o: boolean) => {
    if (!o) { setTexto(''); setItemCriadoId(null); criar.reset(); }
    onOpenChange(o);
  };

  const enviar = async () => {
    if (!user?.id || texto.trim().length < 5) return;
    try {
      const r = await criar.mutateAsync({
        conteudo: texto, empresa: activeCompany, rotaOrigem: location.pathname, autorUserId: user.id,
      });
      setItemCriadoId(r.item.id);
      if (!r.triagemOk) {
        toast.info('Recebido! A avaliação automática falhou, mas sua mensagem está na fila do Lucas.');
      }
    } catch {
      toast.error('Não consegui enviar — tente de novo.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={fechar}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Sugerir melhoria · reportar problema</DialogTitle>
          <DialogDescription>
            Escreva livre: o que travou, o que poderia ser melhor, ou uma pergunta. A IA avalia na hora e o Lucas vê tudo.
          </DialogDescription>
        </DialogHeader>

        {!itemCriadoId ? (
          <div className="space-y-3">
            <Textarea
              value={texto} onChange={(e) => setTexto(e.target.value)}
              placeholder="Ex.: o picking trava quando bipo duas vezes seguidas…" rows={4} autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => fechar(false)}>Cancelar</Button>
              <Button onClick={enviar} disabled={criar.isPending || texto.trim().length < 5}>
                {criar.isPending ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> A IA está avaliando…</>) : 'Enviar'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <MelhoriaThread mensagens={thread ?? []} />
            <div className="flex justify-between">
              <Button variant="ghost" size="sm" onClick={() => { fechar(false); navigate('/melhorias'); }}>
                Ver meus envios
              </Button>
              <Button size="sm" onClick={() => fechar(false)}>Fechar</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 8.3: Typecheck + commit**

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo "exit=$?"`
Expected: `exit=0`

```bash
git add src/components/melhorias/
git commit -m "feat(melhorias): MelhoriaThread + MelhoriaDialog — criação com resposta da IA inline"
```

---

### Task 9: Páginas + rotas

**Files:**
- Create: `src/pages/Melhorias.tsx`
- Create: `src/pages/GestaoMelhorias.tsx`
- Modify: `src/App.tsx` (bloco `<Route element={<RequireStaff />}>`)

- [ ] **Step 9.1: `Melhorias.tsx`** (lista própria + réplica):

```tsx
// src/pages/Melhorias.tsx
// Meus envios do canal de Melhorias: status + thread + réplica (cap via podeReplicar).
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Lightbulb, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { useMeusMelhoriaItens, useMelhoriaThread, useEnviarReplica } from '@/hooks/useMelhorias';
import { MelhoriaThread } from '@/components/melhorias/MelhoriaThread';
import { MelhoriaDialog } from '@/components/melhorias/MelhoriaDialog';
import { podeReplicar } from '@/lib/melhorias/triagem-helpers';
import type { MelhoriaItem, MelhoriaStatus } from '@/lib/melhorias/types';
import { cn } from '@/lib/utils';

const STATUS_BADGE: Record<MelhoriaStatus, { label: string; cls: string }> = {
  aberto: { label: 'Aberto', cls: 'bg-status-info-bg text-status-info-fg' },
  em_andamento: { label: 'Em andamento', cls: 'bg-status-warning-bg text-status-warning-fg' },
  resolvido: { label: 'Resolvido', cls: 'bg-status-success-bg text-status-success-fg' },
  descartado: { label: 'Descartado', cls: 'bg-muted text-muted-foreground' },
};

function ItemCard({ item }: { item: MelhoriaItem }) {
  const { user } = useAuth();
  const [aberto, setAberto] = useState(false);
  const [replica, setReplica] = useState('');
  const { data: thread } = useMelhoriaThread(aberto ? item.id : null);
  const enviar = useEnviarReplica(item.id);
  const gate = podeReplicar(item, thread ?? []);
  const badge = STATUS_BADGE[item.status];

  return (
    <div className="rounded-lg border bg-card p-3">
      <button type="button" className="w-full text-left" onClick={() => setAberto((v) => !v)}>
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium text-sm truncate">{item.titulo ?? 'Aguardando avaliação…'}</p>
          <Badge className={cn('shrink-0', badge.cls)}>{badge.label}</Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {new Date(item.created_at).toLocaleDateString('pt-BR')} · {item.tipo ?? 'não triado'}{item.modulo ? ` · ${item.modulo}` : ''}
        </p>
      </button>

      {aberto && (
        <div className="mt-3 space-y-3">
          <MelhoriaThread mensagens={thread ?? []} />
          {item.resposta_founder && (
            <div className="rounded-md border-l-2 border-status-success bg-status-success-bg p-2 text-sm">
              <p className="text-2xs text-muted-foreground mb-0.5">Resposta do Lucas</p>
              <p className="whitespace-pre-wrap">{item.resposta_founder}</p>
            </div>
          )}
          {gate.ok ? (
            <div className="flex gap-2">
              <Textarea value={replica} onChange={(e) => setReplica(e.target.value)} rows={2} placeholder="Complementar…" />
              <Button
                size="sm" disabled={enviar.isPending || replica.trim().length < 3}
                onClick={async () => {
                  if (!user?.id) return;
                  try { await enviar.mutateAsync({ conteudo: replica, autorUserId: user.id }); setReplica(''); }
                  catch { toast.error('Não consegui enviar a réplica.'); }
                }}
              >
                {enviar.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Enviar'}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{gate.motivo}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function Melhorias() {
  const { data: itens, isLoading } = useMeusMelhoriaItens();
  const [dialogOpen, setDialogOpen] = useState(false);

  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display">Melhorias</h1>
          <p className="text-sm text-muted-foreground">Suas sugestões, problemas e perguntas — com o status de cada um.</p>
        </div>
        <Button onClick={() => setDialogOpen(true)}><Lightbulb className="w-4 h-4 mr-2" /> Nova</Button>
      </div>

      {(itens ?? []).length === 0 ? (
        <EmptyState
          tone="operational" icon={Lightbulb} title="Nada por aqui ainda"
          description="Viu algo quebrado ou tem uma ideia? Manda — a IA avalia na hora e o Lucas vê tudo."
          action={<Button onClick={() => setDialogOpen(true)}>Enviar a primeira</Button>}
        />
      ) : (
        <div className="space-y-2">{(itens ?? []).map((i) => <ItemCard key={i.id} item={i} />)}</div>
      )}

      <MelhoriaDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
```

⚠️ Conferir as props reais de `EmptyState` (`src/components/EmptyState.tsx`) e `PageSkeleton` antes de finalizar — ajustar chamada ao shape real (ex.: `action` pode ser objeto/slot diferente). ⚠️ Conferir também as utilities de status REAIS em `src/index.css` (§4 CLAUDE.md: `text-status-*`/`bg-status-*`; as classes compostas tipo `bg-status-info-bg`/`text-status-info-fg` usadas neste plano devem ser trocadas pelas utilities que existirem — espelhar um badge de status existente, ex. `PortalStatusBadge`).

- [ ] **Step 9.2: `GestaoMelhorias.tsx`** (fila master):

```tsx
// src/pages/GestaoMelhorias.tsx
// Fila master do canal de Melhorias: filtros, avaliação da IA, copiar prompt
// pro Claude Code, status + resposta, re-triagem. Gate master-only (spec §11).
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { ClipboardCopy, Lightbulb, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useUrlState } from '@/hooks/useUrlState';
import { useGestaoMelhorias, useMelhoriaThread, useAlterarStatusMelhoria, useRetriarMelhoria } from '@/hooks/useMelhorias';
import { MelhoriaThread } from '@/components/melhorias/MelhoriaThread';
import { montarPromptClaudeCode } from '@/lib/melhorias/prompt-claude';
import { track } from '@/lib/analytics';
import type { MelhoriaItem, MelhoriaStatus } from '@/lib/melhorias/types';
import { cn } from '@/lib/utils';

const URGENCIA_ORD: Record<string, number> = { alta: 0, media: 1, baixa: 2 };

function useAutorNomes(itens: MelhoriaItem[]) {
  const ids = useMemo(() => [...new Set(itens.map((i) => i.autor_user_id))], [itens]);
  return useQuery({
    queryKey: ['melhorias', 'autores', ids],
    enabled: ids.length > 0,
    queryFn: async (): Promise<Map<string, string>> => {
      const { data } = await supabase.from('profiles').select('user_id, name').in('user_id', ids);
      return new Map((data ?? []).map((p) => [p.user_id as string, p.name as string]));
    },
  });
}

function GestaoItemCard({ item, autorNome }: { item: MelhoriaItem; autorNome: string }) {
  const [aberto, setAberto] = useState(false);
  const [resposta, setResposta] = useState(item.resposta_founder ?? '');
  const { data: thread } = useMelhoriaThread(aberto ? item.id : null);
  const alterar = useAlterarStatusMelhoria();
  const retriar = useRetriarMelhoria();

  const copiarPrompt = async () => {
    const prompt = montarPromptClaudeCode(item, thread ?? [], autorNome);
    await navigator.clipboard.writeText(prompt);
    track('melhoria.prompt_copiado', { item_id: item.id });
    toast.success('Prompt copiado — cola no Claude Code.');
  };

  const mudarStatus = async (status: MelhoriaStatus) => {
    try {
      await alterar.mutateAsync({ itemId: item.id, status, resposta });
      toast.success(`Item ${status === 'resolvido' ? 'resolvido' : status === 'descartado' ? 'descartado' : 'atualizado'}.`);
    } catch { toast.error('Falha ao atualizar o item.'); }
  };

  return (
    <div className="rounded-lg border bg-card p-3">
      <button type="button" className="w-full text-left" onClick={() => setAberto((v) => !v)}>
        <div className="flex items-center gap-2 flex-wrap">
          {item.urgencia && (
            <Badge className={cn(
              item.urgencia === 'alta' ? 'bg-status-error-bg text-status-error-fg'
                : item.urgencia === 'media' ? 'bg-status-warning-bg text-status-warning-fg'
                : 'bg-muted text-muted-foreground')}>
              {item.urgencia}
            </Badge>
          )}
          <Badge variant="outline">{item.tipo ?? 'não triado'}</Badge>
          {item.modulo && <Badge variant="outline">{item.modulo}</Badge>}
          {item.triagem_status !== 'ok' && <Badge className="bg-status-warning-bg text-status-warning-fg">triagem {item.triagem_status}</Badge>}
          <span className="text-xs text-muted-foreground ml-auto">{autorNome} · {new Date(item.created_at).toLocaleDateString('pt-BR')}</span>
        </div>
        <p className="font-medium text-sm mt-1">{item.titulo ?? '(sem triagem — abrir pra ver o relato)'}</p>
      </button>

      {aberto && (
        <div className="mt-3 space-y-3">
          {item.rota_origem && <p className="text-xs text-muted-foreground">Tela de origem: <code>{item.rota_origem}</code> · empresa: {item.empresa}</p>}
          <MelhoriaThread mensagens={thread ?? []} papelDe={(m) => (m.papel === 'funcionario' ? autorNome : m.papel === 'ia' ? 'IA' : 'Você')} />
          {item.avaliacao_founder && (
            <div className="rounded-md border-l-2 border-status-info bg-status-info-bg p-2 text-sm">
              <p className="text-2xs text-muted-foreground mb-0.5">Avaliação técnica da IA</p>
              <p className="whitespace-pre-wrap">{item.avaliacao_founder}</p>
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="outline" onClick={copiarPrompt}><ClipboardCopy className="w-4 h-4 mr-1" /> Copiar prompt pro Claude Code</Button>
            {item.triagem_status !== 'ok' && (
              <Button size="sm" variant="outline" disabled={retriar.isPending}
                onClick={() => retriar.mutateAsync(item.id).then((r) => r.ok ? toast.success('Re-triado.') : toast.error('Triagem falhou de novo.'))}>
                {retriar.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />} Re-triar
              </Button>
            )}
          </div>
          <Textarea value={resposta} onChange={(e) => setResposta(e.target.value)} rows={2}
            placeholder="Resposta pro funcionário (opcional — ele vê no item)" />
          <div className="flex gap-2">
            {item.status !== 'em_andamento' && <Button size="sm" variant="outline" onClick={() => mudarStatus('em_andamento')}>Em andamento</Button>}
            <Button size="sm" onClick={() => mudarStatus('resolvido')}>Resolver</Button>
            <Button size="sm" variant="ghost" onClick={() => mudarStatus('descartado')}>Descartar</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function GestaoMelhorias() {
  const { isMaster } = useAuth();
  const [filtros, setFiltros] = useUrlState({ status: 'aberto', tipo: 'all' });
  const { data: itens, isLoading } = useGestaoMelhorias(isMaster);
  const { data: nomes } = useAutorNomes(itens ?? []);

  const filtrados = useMemo(() => {
    return (itens ?? [])
      .filter((i) => (filtros.status === 'all' ? true : i.status === filtros.status))
      .filter((i) => (filtros.tipo === 'all' ? true : i.tipo === filtros.tipo))
      .sort((a, b) =>
        (URGENCIA_ORD[a.urgencia ?? 'baixa'] - URGENCIA_ORD[b.urgencia ?? 'baixa'])
        || (Date.parse(b.created_at) - Date.parse(a.created_at)));
  }, [itens, filtros]);

  if (!isMaster) return <EmptyState tone="operational" icon={Lightbulb} title="Acesso restrito" description="Esta fila é só do founder." />;
  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4">
      <div>
        <h1 className="font-display">Melhorias — fila</h1>
        <p className="text-sm text-muted-foreground">O que o time reportou, triado pela IA. Copie o prompt e ataque no Claude Code.</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {(['aberto', 'em_andamento', 'resolvido', 'descartado', 'all'] as const).map((s) => (
          <Button key={s} size="sm" variant={filtros.status === s ? 'default' : 'outline'}
            onClick={() => setFiltros({ ...filtros, status: s })}>
            {s === 'all' ? 'Todos' : s.replace('_', ' ')}
          </Button>
        ))}
        {(['all', 'problema', 'sugestao', 'pergunta'] as const).map((t) => (
          <Button key={t} size="sm" variant={filtros.tipo === t ? 'secondary' : 'ghost'}
            onClick={() => setFiltros({ ...filtros, tipo: t })}>
            {t === 'all' ? 'Todo tipo' : t}
          </Button>
        ))}
      </div>

      {filtrados.length === 0 ? (
        <EmptyState tone="operational" icon={Lightbulb} title="Fila limpa" description="Nenhum item neste filtro." />
      ) : (
        <div className="space-y-2">
          {filtrados.map((i) => <GestaoItemCard key={i.id} item={i} autorNome={nomes?.get(i.autor_user_id) ?? 'Funcionário'} />)}
        </div>
      )}
    </div>
  );
}
```

⚠️ Conferir assinatura real de `useUrlState` (`src/hooks/useUrlState.ts`) e ajustar a chamada (`setFiltros` pode ser parcial). Conferir props de `EmptyState`/`PageSkeleton` como na Task 9.1.

- [ ] **Step 9.3: Rotas em `App.tsx`** — adicionar os lazy imports junto dos existentes e as rotas DENTRO do bloco `<Route element={<RequireStaff />}>`:

```tsx
const Melhorias = lazy(() => import('./pages/Melhorias'));
const GestaoMelhorias = lazy(() => import('./pages/GestaoMelhorias'));
```

```tsx
<Route path="melhorias" element={<Melhorias />} />
<Route path="gestao/melhorias" element={<GestaoMelhorias />} />
```

- [ ] **Step 9.4: Typecheck + testes + commit**

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo "exit=$?"; bunx vitest run src/lib/melhorias/ 2>&1 | tail -3`
Expected: `exit=0` + testes PASS

```bash
git add src/pages/Melhorias.tsx src/pages/GestaoMelhorias.tsx src/App.tsx
git commit -m "feat(melhorias): páginas /melhorias e /gestao/melhorias + rotas staff"
```

---

### Task 10: Topbar + sidebar + badge

**Files:**
- Modify: `src/components/AppShell.tsx`

- [ ] **Step 10.1: Botão no topbar** — na flexbox de ações (junto de `<HelpDrawer />`, ~linha 696-702), adicionar ANTES do HelpDrawer:

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => setMelhoriaOpen(true)}>
      <Lightbulb className="w-4 h-4" />
    </Button>
  </TooltipTrigger>
  <TooltipContent>Sugerir melhoria · reportar problema</TooltipContent>
</Tooltip>
```

Com estado no componente do shell: `const [melhoriaOpen, setMelhoriaOpen] = useState(false);` e o dialog montado no fim do JSX do shell: `<MelhoriaDialog open={melhoriaOpen} onOpenChange={setMelhoriaOpen} />`. Imports: `Lightbulb` no import de `lucide-react` existente; `import { MelhoriaDialog } from '@/components/melhorias/MelhoriaDialog';`. ⚠️ O botão só aparece pra staff: envolver com a flag de staff já disponível no shell (`displayIsStaff` ou equivalente em uso no topbar — seguir o padrão dos vizinhos).

- [ ] **Step 10.2: Itens da sidebar** — no array de seções de navegação:
- Seção **Principal**: `{ icon: Lightbulb, label: 'Melhorias', path: '/melhorias', managerOnly: true }` (managerOnly = visível só pra staff, conforme filtro existente `(!item.managerOnly || displayIsStaff)`).
- Seção **Gestão**: `{ icon: Lightbulb, label: 'Melhorias (fila)', path: '/gestao/melhorias', masterOnly: true }`.

- [ ] **Step 10.3: Badge master** — junto dos outros polls de badge (região `enableStaffPolls`, ~linha 366+):

```tsx
const { isMaster } = useAuth(); // já disponível no shell — reusar o existente
const { data: melhoriasAbertas } = useMelhoriasBadge(enableStaffPolls && isMaster);
```

E na injeção de badges nos itens (padrão `if (it.path === '/whatsapp' ...)`):

```tsx
if (it.path === '/gestao/melhorias' && melhoriasAbertas && melhoriasAbertas > 0) {
  return { ...it, badge: melhoriasAbertas };
}
```

Import: `import { useMelhoriasBadge } from '@/hooks/useMelhorias';`

- [ ] **Step 10.4: Typecheck + lint + commit**

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo "exit=$?"; bun lint 2>&1 | tail -5`
Expected: `exit=0`, lint sem errors novos

```bash
git add src/components/AppShell.tsx
git commit -m "feat(melhorias): botão topbar + itens sidebar + badge master de abertos"
```

---

### Task 11: Validação final + docs

**Files:**
- Modify: `docs/roadmap-sessao.md`

- [ ] **Step 11.1: Suíte completa**

Run: `heavy bun run typecheck > /tmp/v1.log 2>&1; echo "tc=$?"; heavy bun run test > /tmp/v2.log 2>&1; echo "test=$?"; bun lint > /tmp/v3.log 2>&1; echo "lint=$?"; heavy bun build > /tmp/v4.log 2>&1; echo "build=$?"`
Expected: `tc=0 test=0 lint=0 build=0` (⚠️ NUNCA pipe pra `tail` direto — engole exit code, lição §2). Conferir os logs se ≠0.

- [ ] **Step 11.2: Rodar o PG17 de novo** (garante que iterações do front não tocaram a migration)

Run: `heavy ./db/test-melhorias-rpcs.sh`
Expected: `✅`

- [ ] **Step 11.3: Atualizar roadmap da sessão** — marcar implementação ✅, deixar deploy ⏳ founder.

- [ ] **Step 11.4: Commit final**

```bash
git add docs/roadmap-sessao.md
git commit -m "docs(melhorias): roadmap — implementação completa; resta apply manual + deploy edge + Publish"
```

---

## Pós-implementação (handoff — NÃO faz parte das tasks)

1. **PR** com aviso "**ATENÇÃO: migration manual necessária**" + SQL no body (fluxo `finishing-a-development-branch` / lovable-db-operator pro bloco SQL).
2. **Founder**: colar migration no SQL Editor → deploy `melhoria-triagem` via chat do Lovable (verbatim da main pós-merge) → Publish.
3. **Smoke prod**: criar item real ("quais clientes compram lixa?"), conferir triagem + tabela + prompt copiável + badge.
4. **Codex adversarial retroativo** (cota volta 11/06): spec + migration + edge (registrado no roadmap).
