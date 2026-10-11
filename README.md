# Afiação — sistema operacional B2B do grupo Colacor

App interno (staff) e portal do cliente (loja, afiação, pedidos) do grupo Colacor. Cobre vendas,
financeiro, reposição/compras, estoque/picking, tintométrico e telefonia, integrado ao ERP Omie.

O grupo opera **3 empresas** com CNPJs distintos, escolhidas em `src/contexts/CompanyContext.tsx`:

| Chave | Empresa | O que é |
|---|---|---|
| `colacor` | Colacor | indústria de abrasivos |
| `oben` | Oben Comercial | distribuidora moveleira (compra/revende) |
| `colacor_sc` | Colacor SC | serviços, Simples Nacional |

Stack: React 18 + TypeScript (strict) + Vite, shadcn/ui + Tailwind, Supabase (Postgres, RLS, edge
functions em Deno), hospedado no Lovable Cloud. O que cada empresa significa no banco e nas telas
está em [docs/agent/mapa-do-app.md](docs/agent/mapa-do-app.md).

## Setup local

Use **`bun`**, não `npm` — os scripts e o CI rodam com `bun`.

```bash
bun install
bun dev
```

- O **`.env`** já vem versionado com as chaves **públicas** do frontend (`VITE_SUPABASE_URL`,
  `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`, `VITE_POSTHOG_*`). O modelo das
  variáveis está em [`.env.example`](.env.example).
- **Segredo de backend nunca vai para o `.env`** nem para o git: fica em *Supabase → Edge Functions → Secrets*.
- Prefixo `VITE_` = vai para o bundle, ou seja, é público.

## Testar, checar e buildar

Na máquina de desenvolvimento (M2 8GB), prefixe o que é pesado com **`heavy`**, o semáforo de RAM
compartilhado entre worktrees (instale com `bash scripts/heavy-install.sh`):

```bash
heavy bun run test        # vitest — o mesmo que o CI roda (`bun test` é OUTRO runner)
heavy bun run typecheck   # tsc do app + tsc de scripts/ e db/
heavy bun run build       # vite build
bun lint
```

## Do PR à produção

1. Abra o PR a partir de um worktree (abaixo). Todo PR **não-draft** auto-mergeia (squash) quando o
   CI `validate` passa — para segurar, deixe em **draft**.
2. **Merge na `main` não é produção.** Há 3 camadas de deploy manuais e independentes:
   - **Migration** → colar o SQL no **SQL Editor** do Lovable (migration de nome custom não auto-aplica);
   - **Edge function** → deploy pelo **chat do Lovable**, que lê `supabase/functions/<nome>/` do repo;
   - **Frontend** → **Publish** no editor do Lovable.
3. O que falta deployar: `bun run pendencias:deploy`.

Ordem, armadilhas e verificação: [docs/agent/deploy.md](docs/agent/deploy.md) e
[docs/runbooks/lovable-supabase.md](docs/runbooks/lovable-supabase.md).

## Worktrees

Várias sessões (humanas e de agente) trabalham em paralelo. **Nunca trabalhe no checkout principal**:
duas sessões no mesmo diretório trocam a branch uma da outra e podem perder commits. Crie um
worktree por tarefa, a partir de `origin/main`:

```bash
bun run wt minha-branch   # cria ../afiacao-minha-branch, já com bun install
bun run wt:status         # lista worktrees e sessões; wt:clean / wt:reap liberam RAM
```

Detalhe: [docs/agent/worktrees.md](docs/agent/worktrees.md).

## Acesso de leitura ao banco

Diagnóstico em produção usa o wrapper **`~/.config/afiacao/psql-ro`** (papel `claude_ro`, sessão
read-only com timeout). A credencial vive só na máquina, **fora do repositório** — peça ao founder;
nunca a cole em issue, PR ou chat. Escrita em produção não passa por ele. Ver
[docs/agent/database.md](docs/agent/database.md) §1.

## Mapa de leitura

- [`CLAUDE.md`](CLAUDE.md) — as **regras vivas** do projeto (valem para humanos e agentes). Leia antes do 1º PR.
- [`docs/agent/`](docs/agent/) — referência operacional por domínio (banco, deploy, sync, money-path,
  financeiro, reposição…); o índice está no `CLAUDE.md`.
- [`docs/historico/`](docs/historico/) — diário de PRs e lições.
- [`docs/superpowers/`](docs/superpowers/) — specs e planos de entregas grandes.
