# Pedidos do ciclo: tela limpa + botões à prova de erro — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Na aba "Ciclo de hoje" de `/admin/reposicao/pedidos`, esconder os pedidos terminais (cancelado/expirado) num "Histórico de hoje" recolhido e deixar os botões à prova de erro, pra acabar com a pilha de fantasmas e o clique acidental que gera pedidos sem querer.

**Architecture:** 100% frontend. Um helper puro particiona a lista do dia em ativos/histórico; a tela renderiza só os ativos + um `Collapsible` com os terminais; os botões são renomeados e a geração ganha confirmação. Nada toca o banco/RPC.

**Tech Stack:** React + TypeScript, shadcn/ui (Collapsible, AlertDialog), vitest. Sem migration, sem edge. Deploy = Publish no Lovable.

**Spec:** `docs/superpowers/specs/2026-06-06-reposicao-pedidos-ciclo-tela-limpa-design.md`

---

## File Structure

- `src/components/reposicao/pedidos/shared.ts` — **modify**: `STATUS_TERMINAIS_CICLO`, `ehTerminalCiclo`, `particionarCicloHoje` (junto dos helpers puros já existentes).
- `src/components/reposicao/pedidos/__tests__/particionar-ciclo.test.ts` — **create**: testes do helper (espelha `split-visivel.test.ts`).
- `src/pages/AdminReposicaoPedidos.tsx` — **modify**: derivar ativos/histórico, renderizar só ativos + `Collapsible` "Histórico de hoje", renomear botões + confirmação na geração.

**Reuso confirmado:** `PedidoRow` já condiciona suas ações por status (`podeAprovar`/`podeDisparar`/`podeCancelar`) — para um pedido terminal (cancelado/expirado) todas são `false`, então ele renderiza **só "Detalhes"**. Reusá-lo no histórico funciona sem mudança.

**Gate:** herdado da rota (comprador/gestor/master). Sem mudança.

---

## Task 1: Helper puro — partição ativos/histórico (TDD)

**Files:**
- Test: `src/components/reposicao/pedidos/__tests__/particionar-ciclo.test.ts`
- Modify: `src/components/reposicao/pedidos/shared.ts`

- [ ] **Step 1: Escrever o teste que falha**

Crie `src/components/reposicao/pedidos/__tests__/particionar-ciclo.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ehTerminalCiclo, particionarCicloHoje, STATUS_TERMINAIS_CICLO } from '../shared';

describe('ehTerminalCiclo', () => {
  it('true para os 3 estados terminais', () => {
    expect(ehTerminalCiclo({ status: 'cancelado' })).toBe(true);
    expect(ehTerminalCiclo({ status: 'cancelado_humano' })).toBe(true);
    expect(ehTerminalCiclo({ status: 'expirado_sem_aprovacao' })).toBe(true);
  });
  it('false para estados ativos/operacionais', () => {
    for (const s of [
      'pendente_aprovacao', 'aprovado_aguardando_disparo', 'bloqueado_guardrail',
      'disparado', 'disparado_simulado', 'falha_envio', 'concluido_recebido',
    ]) {
      expect(ehTerminalCiclo({ status: s })).toBe(false);
    }
  });
});

describe('particionarCicloHoje', () => {
  it('separa ativos de terminais preservando ordem', () => {
    const lista = [
      { id: 1, status: 'pendente_aprovacao' },
      { id: 2, status: 'cancelado' },
      { id: 3, status: 'disparado' },
      { id: 4, status: 'expirado_sem_aprovacao' },
      { id: 5, status: 'cancelado_humano' },
    ];
    const { ativos, historico } = particionarCicloHoje(lista);
    expect(ativos.map((p) => p.id)).toEqual([1, 3]);
    expect(historico.map((p) => p.id)).toEqual([2, 4, 5]);
  });
  it('lista vazia → ambos vazios', () => {
    expect(particionarCicloHoje([])).toEqual({ ativos: [], historico: [] });
  });
  it('STATUS_TERMINAIS_CICLO tem exatamente os 3 estados', () => {
    expect([...STATUS_TERMINAIS_CICLO].sort()).toEqual([
      'cancelado', 'cancelado_humano', 'expirado_sem_aprovacao',
    ]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `bun run test src/components/reposicao/pedidos/__tests__/particionar-ciclo.test.ts`
Expected: FAIL — `ehTerminalCiclo is not a function` / `particionarCicloHoje is not a function`.

- [ ] **Step 3: Implementar em `shared.ts`**

No fim de `src/components/reposicao/pedidos/shared.ts` (após o bloco `pedidosVisiveis`/`ehPaiSplit`, antes do `portalStatusMeta` — ou simplesmente no fim do arquivo), adicione:

```ts
/* ─── Partição do ciclo de hoje: ativos × terminais ─── */
//
// A geração só apaga 'pendente_aprovacao'; o que já virou terminal (cancelado pelo
// humano, cancelado vazio, ou expirado por falta de aprovação) fica como fantasma no
// ciclo de hoje. A lista principal mostra só os ATIVOS; os terminais vão pro
// "Histórico de hoje" recolhido. Pura organização de UI — nada some do banco.
export const STATUS_TERMINAIS_CICLO: ReadonlySet<string> = new Set([
  'cancelado',
  'cancelado_humano',
  'expirado_sem_aprovacao',
]);

export function ehTerminalCiclo(p: { status: string }): boolean {
  return STATUS_TERMINAIS_CICLO.has(p.status);
}

// Particiona a lista do ciclo (JÁ sem pais de split — chamar sobre pedidosVisiveis)
// em ativos (lista principal) e historico (terminais, recolhido). Ordem preservada.
export function particionarCicloHoje<T extends { status: string }>(
  lista: readonly T[],
): { ativos: T[]; historico: T[] } {
  const ativos: T[] = [];
  const historico: T[] = [];
  for (const p of lista) (ehTerminalCiclo(p) ? historico : ativos).push(p);
  return { ativos, historico };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `bun run test src/components/reposicao/pedidos/__tests__/particionar-ciclo.test.ts`
Expected: PASS (todos).

- [ ] **Step 5: Typecheck**

Run: `heavy bun run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/components/reposicao/pedidos/shared.ts src/components/reposicao/pedidos/__tests__/particionar-ciclo.test.ts
git commit -m "feat(reposicao): helper particionarCicloHoje (ativos x historico do ciclo)"
```

---

## Task 2: `AdminReposicaoPedidos.tsx` — lista limpa + histórico recolhido + botões à prova de erro

**Files:**
- Modify: `src/pages/AdminReposicaoPedidos.tsx`

Faça os edits abaixo na ordem. Leia o arquivo inteiro primeiro pra localizar cada âncora com precisão.

- [ ] **Step 1: Imports**

(a) Adicione `ChevronDown, ChevronRight` ao import de `lucide-react` (que hoje é `import { AlertTriangle, CheckCircle2, Eye, Loader2, RefreshCw, Zap } from 'lucide-react';`):

```tsx
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Eye, Loader2, RefreshCw, Zap } from 'lucide-react';
```

(b) Adicione `particionarCicloHoje` ao import de `shared` (hoje `import { EMPRESA, formatBRL, interpretarRespostaDisparo, pedidosVisiveis, type RespostaDisparo } from '@/components/reposicao/pedidos/shared';`):

```tsx
import { EMPRESA, formatBRL, interpretarRespostaDisparo, particionarCicloHoje, pedidosVisiveis, type RespostaDisparo } from '@/components/reposicao/pedidos/shared';
```

(c) Adicione, junto dos imports de UI (ex.: após o import de `Tabs`):

```tsx
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
```

- [ ] **Step 2: Estado do Collapsible**

Logo após os `useState` existentes do componente (ex.: após `const [mostrarAtencao, setMostrarAtencao] = useState(false);`), adicione:

```tsx
  const [histAberto, setHistAberto] = useState(false);
```

- [ ] **Step 3: Derivar ativos/histórico**

Logo após a linha `const pedidosCiclo = pedidosVisiveis(pedidos ?? []);`, adicione:

```tsx
  // Separa os pedidos do dia em ativos (lista principal) e terminais (Histórico de hoje,
  // recolhido). Os terminais — cancelado/cancelado_humano/expirado_sem_aprovacao — são o
  // "lixo do dia" que a geração não varre; tirá-los da lista principal limpa a poluição
  // sem apagar nada do banco.
  const { ativos, historico } = particionarCicloHoje(pedidosCiclo);
```

- [ ] **Step 4: Botões à prova de erro (header)**

Localize o bloco dos dois botões no header:

```tsx
          <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={`w-4 h-4 mr-1 ${isLoading ? 'animate-spin' : ''}`} />Atualizar
          </Button>
          <Button onClick={() => gerarMutation.mutate()} disabled={gerarMutation.isPending}>
            {gerarMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Rodar geração manual
          </Button>
```

Substitua por:

```tsx
          <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={`w-4 h-4 mr-1 ${isLoading ? 'animate-spin' : ''}`} />Atualizar lista
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" disabled={gerarMutation.isPending}>
                {gerarMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                Recalcular sugestões
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Recalcular sugestões de hoje?</AlertDialogTitle>
                <AlertDialogDescription>
                  Recalcula as sugestões de compra a partir do estoque atual. Não altera pedidos
                  já aprovados, disparados ou cancelados. O sistema já faz isso sozinho 1×/dia —
                  use só se você mudou um parâmetro (ponto de pedido, mínimo forçado etc.).
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Voltar</AlertDialogCancel>
                <AlertDialogAction onClick={() => gerarMutation.mutate()}>Recalcular</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
```

- [ ] **Step 5: Título conta ativos**

Localize `<CardTitle className="text-base">Pedidos do dia ({pedidosCiclo.length})</CardTitle>` e troque `{pedidosCiclo.length}` por `{ativos.length}`:

```tsx
              <CardTitle className="text-base">Pedidos do dia ({ativos.length})</CardTitle>
```

- [ ] **Step 6: Empty state + tabela renderizam ativos; Collapsible do histórico**

Localize o bloco do `<CardContent>` da aba "hoje" — do `{isLoading ? (` até o `)}` que fecha logo antes de `</CardContent>` (inclui o empty state e a `<Table>` que mapeia `pedidosCiclo`). Substitua o conteúdo INTEIRO desse `<CardContent>` por:

```tsx
            <CardContent>
              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : ativos.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  {historico.length > 0
                    ? 'Nenhum pedido ativo hoje — veja o Histórico de hoje abaixo.'
                    : 'Nenhum pedido gerado para o ciclo de hoje. Use "Recalcular sugestões" para criar.'}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>Fornecedor / Grupo</TableHead>
                      <TableHead className="text-right">Nº SKUs</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                      <TableHead>Portal</TableHead>
                      <TableHead>Aprovado em</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ativos.map((p) => (
                      <PedidoRow
                        key={p.id}
                        p={p}
                        onVerDetalhes={() => setDetalhesPedido(p)}
                        onCancelar={() => setCancelarPedido(p)}
                        onVerPortal={() => setPortalPedido(p)}
                        onDisparar={() => dispararMutation.mutate(p.id)}
                        disparando={dispararMutation.isPending && dispararMutation.variables === p.id}
                      />
                    ))}
                  </TableBody>
                </Table>
              )}

              {!isLoading && historico.length > 0 && (
                <Collapsible open={histAberto} onOpenChange={setHistAberto} className="mt-4 border-t pt-2">
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="w-full flex items-center justify-between py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <span className="font-medium">Histórico de hoje ({historico.length})</span>
                      {histAberto ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <p className="text-xs text-muted-foreground pb-2">
                      Pedidos cancelados ou expirados de hoje. Ficam aqui só pra registro — não saem do banco.
                    </p>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Status</TableHead>
                          <TableHead>Fornecedor / Grupo</TableHead>
                          <TableHead className="text-right">Nº SKUs</TableHead>
                          <TableHead className="text-right">Valor</TableHead>
                          <TableHead>Portal</TableHead>
                          <TableHead>Aprovado em</TableHead>
                          <TableHead className="text-right">Ações</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {historico.map((p) => (
                          <PedidoRow
                            key={p.id}
                            p={p}
                            onVerDetalhes={() => setDetalhesPedido(p)}
                            onCancelar={() => setCancelarPedido(p)}
                            onVerPortal={() => setPortalPedido(p)}
                            onDisparar={() => dispararMutation.mutate(p.id)}
                            disparando={dispararMutation.isPending && dispararMutation.variables === p.id}
                          />
                        ))}
                      </TableBody>
                    </Table>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </CardContent>
```

- [ ] **Step 7: Typecheck + lint**

Run: `heavy bun run typecheck && bun lint`
Expected: typecheck exit 0; lint sem novos erros.

- [ ] **Step 8: Commit**

```bash
git add src/pages/AdminReposicaoPedidos.tsx
git commit -m "feat(reposicao): tela de pedidos mostra so ativos + Historico de hoje + botoes a prova de erro"
```

---

## Task 3: Verificação integrada

- [ ] **Step 1: Suíte completa**

Run: `heavy bun run test`
Expected: PASS (a suíte da reposição + os novos testes do helper; nada quebra).

- [ ] **Step 2: Build**

Run: `heavy bun run build`
Expected: build OK (exit 0).

- [ ] **Step 3: Commit (se a verificação exigiu algum ajuste)**

Se nada mudou nos passos 1-2, pule. Caso contrário:

```bash
git add -A
git commit -m "test(reposicao): ajustes pos-verificacao da tela de pedidos"
```

---

## Verificação manual (critério de pronto — pós-Publish no Lovable)

1. Em `/admin/reposicao/pedidos` (aba "Ciclo de hoje") com fantasmas no dia: a lista principal mostra só os ativos; o título conta só ativos.
2. "Histórico de hoje (N)" aparece recolhido abaixo; expandir mostra os cancelados/expirados (só com "Detalhes").
3. "Atualizar lista" só recarrega. "Recalcular sugestões" abre confirmação; só após confirmar é que gera.
4. Se não houver nenhum ativo mas houver histórico: a área principal diz "Nenhum pedido ativo hoje — veja o Histórico de hoje abaixo."

## Deploy

**Só Publish do frontend no Lovable.** Sem SQL Editor, sem deploy de edge.
