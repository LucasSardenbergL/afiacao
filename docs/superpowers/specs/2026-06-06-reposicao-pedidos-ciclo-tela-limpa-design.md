# Reposição — Pedidos do ciclo: tela limpa + botões à prova de erro (Nível 1)

**Data:** 2026-06-06
**Rota:** `/admin/reposicao/pedidos` (`src/pages/AdminReposicaoPedidos.tsx`)
**Tipo:** UI, **100% frontend** — sem migration, sem edge function, sem tocar a RPC. Deploy = **Publish** no Lovable.
**Segunda opinião:** Codex (gpt-5.5, consult) — ver "Não-objetivos" pros riscos que ele levantou e que ficaram pra fase 2.

## Problema

Na aba "Ciclo de hoje" da tela de Pedidos, o mesmo fornecedor aparece **empilhado** em várias linhas terminais (ex.: ACRE CAXIAS = 2× Cancelado + 2× Expirado + 1× Pendente, todas `data_ciclo=hoje`). Causa, confirmada no código:

1. **Dois botões confundem.** "Atualizar" só faz `refetch()` (recarrega a lista). "Rodar geração manual" chama a RPC `gerar_pedidos_sugeridos_ciclo` (recria os pendentes — a mesma RPC do cron das 9h15). O dono clica "Rodar geração manual" achando que é "atualizar".
2. **A geração só apaga `pendente_aprovacao`** antes de recriar ([RPC viva, linha 61](supabase/migrations/20260606120000_reposicao_rpc_account_aware.sql:61)). Tudo que já saiu desse estado — `cancelado`, `cancelado_humano`, `expirado_sem_aprovacao` — fica como fantasma no ciclo de hoje. Cada geração extra deixa mais um.
3. A tela lista `data_ciclo=hoje` em **todos** os status ([AdminReposicaoPedidos.tsx:49](src/pages/AdminReposicaoPedidos.tsx:49)) → os fantasmas ficam visíveis.

## Escopo (Nível 1 — decidido com o founder)

Atacar a **dor visível** (a pilha) e o **gatilho** (clique acidental) **sem tocar no money-path**:

1. A lista mostra só os pedidos **ativos**; os terminais vão pra um **"Histórico de hoje" recolhido**.
2. Os botões ficam **à prova de erro** (rótulos claros + confirmação na geração).

**Por que isto basta:** ao deixar a geração à prova de erro, o dono para de regerar por engano → a geração roda 1×/dia (cron) → o acúmulo deixa de acontecer na origem. A limpeza visual cuida do que já existe.

## Solução

### 1. Helper puro — partição ativos/histórico

Em `src/components/reposicao/pedidos/shared.ts` (junto dos helpers puros existentes `ehPaiSplit`/`pedidosVisiveis`/`pedidoPrecisaAtencao`):

```ts
// Estados TERMINAIS de um pedido no ciclo (sem ação útil): cancelado pelo humano,
// cancelado vazio, ou expirado por falta de aprovação. São o "lixo do dia" que
// poluía a lista — vão pro Histórico de hoje, não somem do banco.
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

Testes vitest: terminais → `historico`; todos os demais (`pendente_aprovacao`, `aprovado_aguardando_disparo`, `bloqueado_guardrail`, `disparado`, `disparado_simulado`, `falha_envio`, `concluido_recebido`) → `ativos`; ordem preservada; lista vazia → ambos vazios.

### 2. `AdminReposicaoPedidos.tsx` — lista limpa + histórico recolhido

- Derivar: `const { ativos, historico } = particionarCicloHoje(pedidosCiclo);` (sobre o `pedidosCiclo` que já é `pedidosVisiveis(pedidos)`).
- A `<Table>` do "Ciclo de hoje" mapeia **`ativos`** (em vez de `pedidosCiclo`). Título: **"Pedidos do dia ({ativos.length})"**.
- **Empty state** da tabela de ativos: se `ativos.length === 0 && historico.length > 0` → "Nenhum pedido ativo hoje — veja o Histórico de hoje abaixo." Se ambos 0 → mantém a mensagem (com o nome novo do botão).
- Abaixo da tabela, **se `historico.length > 0`**, um `<Collapsible>` (shadcn, `@/components/ui/collapsible`) **recolhido por padrão**: gatilho "Histórico de hoje ({historico.length})" → conteúdo = uma `<Table>` com as mesmas colunas, mapeando `historico` via `<PedidoRow>` (reuso; as ações não-aplicáveis a terminais simplesmente não renderizam). É o lixo do dia, fora da vista mas auditável.

> Nomenclatura: "Histórico de hoje" (terminais do dia atual) ≠ aba "Ciclos anteriores" (dias passados, já existente).

### 3. Botões à prova de erro (header)

- **"Atualizar" → "Atualizar lista"** (rótulo). Mantém `onClick={() => refetch()}`.
- **"Rodar geração manual" → "Recalcular sugestões"**:
  - `variant="outline"` (secundário; hoje é primário).
  - Envolto num `<AlertDialog>` (AlertDialogTrigger inline, como em outras telas) — o clique abre a confirmação, e só o `AlertDialogAction` chama `gerarMutation.mutate()`.
  - Texto: **"Recalcular sugestões de hoje?"** / *"Recalcula as sugestões de compra a partir do estoque atual. Não altera pedidos já aprovados, disparados ou cancelados. O sistema já faz isso sozinho 1×/dia — use só se você mudou um parâmetro."*
  - O botão segue desabilitado enquanto `gerarMutation.isPending` (com Loader2).

## Decisões registradas

- **Terminais = só os 3 fantasmas** (`cancelado`, `cancelado_humano`, `expirado_sem_aprovacao`). `disparado`/`disparado_simulado`/`concluido_recebido`/`falha_envio`/`bloqueado_guardrail` ficam na lista principal — são desfechos ou exigem ação, não poluição.
- **Sem cooldown** no botão (YAGNI): a confirmação já barra o clique acidental.
- **Nada é apagado do banco.** Pura organização de UI. Zero risco no money-path.

## Não-objetivos (Nível 2/3 — adiados por decisão do founder)

O Codex levantou e confirmamos no código **dois riscos reais** que NÃO são tratados aqui (ficam pra uma fase futura, que toca a RPC com migration + review + teste PG17):

- **A limpeza da RPC não filtra `tipo_ciclo`** → a geração normal pode apagar pedidos de **oportunidade/promoção** (`tipo_ciclo LIKE 'oportunidade_%'`) pendentes do mesmo dia. ([schema:9425](supabase/schema-snapshot.sql:9425))
- **Cron ≠ manual:** o cron faz RPC **+ `aplicar_promocoes_no_ciclo`** ([gerar-pedidos-diario:277](supabase/functions/gerar-pedidos-diario/index.ts:277)); o botão manual faz só a RPC. Divergem.
- Também adiado: "cancelar = veto do dia" (o item não voltar na próxima geração), versionamento (`substituido_em`/`geracao_id`), orquestrador unificado, advisory lock.

Estes ficam **registrados** aqui pra a fase 2 não redescobrir do zero.

## Gate de acesso

Herdado da rota `/admin/reposicao/pedidos` (comprador/gestor/master). Sem mudança.

## Teste / verificação

- Helper puro com vitest (acima).
- Manual (pós-Publish): com fantasmas no dia, a lista principal mostra só os ativos; "Histórico de hoje (N)" recolhido contém os cancelados/expirados; "Recalcular sugestões" pede confirmação; "Atualizar lista" só recarrega.

## Deploy

**Só Publish do frontend no Lovable.** Sem SQL Editor, sem deploy de edge.
