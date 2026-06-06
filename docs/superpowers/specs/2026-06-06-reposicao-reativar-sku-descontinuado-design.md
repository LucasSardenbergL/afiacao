# Reposição — Reativar SKU descontinuado (filtro na Revisão)

**Data:** 2026-06-06
**Empresa-alvo:** OBEN (mas o mecanismo é por-empresa, agnóstico)
**Tipo:** feature de UI, **100% frontend** — sem migration, sem edge function, sem deploy de backend (só Publish do front)

## Problema

Na tela de Pedidos (`/admin/reposicao/pedidos`), o botão 🚫 **"Remover linha + descontinuar SKU"** (`descontinuarMutation` em `src/components/reposicao/pedidos/useDetalhesModal.ts:277`) marca o SKU como descontinuado:

```sql
UPDATE sku_parametros
SET tipo_reposicao = 'descontinuado',
    habilitado_reposicao_automatica = false
WHERE empresa = <emp> AND sku_codigo_omie = <sku>;
-- + DELETE da linha do pedido atual
```

A ação é **mão única**: não há nenhum lugar na interface para ver os SKUs descontinuados nem para religá-los. Hoje a única forma de voltar a comprar é um `UPDATE` manual no SQL Editor do Lovable.

**Caso de uso do founder:** descontinuar itens cujo **preço deixou de ser competitivo**; quando o preço voltar, **reativar** para o motor de reposição voltar a sugeri-los.

**Bug correlato encontrado:** descontinuar só toca `tipo_reposicao` e `habilitado_reposicao_automatica` — **não** mexe em `ativo` nem `estoque_minimo`. O branch default ("Todos") da Revisão filtra por `ativo=true` + `estoque_minimo IS NOT NULL` + `.or("tipo_reposicao.is.null,tipo_reposicao.neq.produto_acabado")` — e `'descontinuado'` passa nesse `.or()`. Logo **os descontinuados vazam hoje na lista "Todos"** sem nenhum indicativo de estado. Corrigir junto.

## Objetivo

Um lugar na tela de **Revisão** (`/admin/reposicao/revisao`) para (a) **listar** os SKUs descontinuados de propósito e (b) **reativá-los** com um toque. Decisão de produto já tomada: mora como **filtro na Revisão** (não tela dedicada).

## Por que "filtro na Revisão" é o encaixe natural

A Revisão já troca a fonte de dados por valor de `statusFilter` (branches `aguardando_fornecedor` e `primeira_compra` em `useRevisaoParametros.ts`), e já tem uma ação inline no `SkuRow` que **habilita** um SKU ("Promover" candidato → `promoverMutation`). "Descontinuados" é mais um branch de fonte; "Reativar" é o espelho de "Promover".

`tipo_reposicao='descontinuado'` é exatamente o marcador que distingue **"descontinuei de propósito pelo botão"** de desligado por outros motivos (ex.: `produto_acabado`, desligado pelo Sentinela). É a chave de listagem.

## Solução (abordagem escolhida)

100% frontend, reusando o padrão da tela. Reativar = a mesma escrita PostgREST que a Revisão **já** usa para editar parâmetros money-path (ponto de pedido, mínimo forçado via `updateMutation`). Descartada a alternativa de RPC `SECURITY DEFINER` dedicada: seria inconsistente (a edição de parâmetros já é PostgREST direto) e custaria o ritual de migration manual do Lovable sem ganho real de segurança.

### Mudanças

1. **`StatusFilterValue`** (`src/lib/reposicao/sku-param.ts`): adicionar `'descontinuados'` à união
   (`'pendente' | 'aprovado' | 'aguardando_fornecedor' | 'primeira_compra' | 'todos' | 'descontinuados'`).

2. **`FiltrosCard.tsx`**: nova opção **"Descontinuados"** no seletor de status.

3. **`useRevisaoParametros.ts` — branch novo** `if (statusFilter === 'descontinuados')`:
   - Query: `sku_parametros` da empresa com `tipo_reposicao = 'descontinuado'` (sem `habilitado`/`ativo` no filtro — mostra tudo que o humano descontinuou).
   - Busca + classes reaproveitam o mesmo padrão dos outros branches.
   - **Enriquecer com preço de compra atual** (`preco_compra_real` / `preco_venda_medio` via `v_sku_parametros_sugeridos.in(codes)`, igual ao branch default) — o gatilho de reativar é "o preço voltou a ser competitivo", então o preço precisa estar visível. Se a view não tiver linha para o SKU desligado, degrada para `—` (não bloqueia).
   - Linhas marcadas com flag de estado para o `SkuRow` decidir renderizar "Reativar".

4. **`useRevisaoParametros.ts` — branch default ("Todos") deixa de vazar descontinuados:**
   - Estender o filtro para excluir `'descontinuado'` **preservando os NULL**:
     `.or("tipo_reposicao.is.null,and(tipo_reposicao.neq.produto_acabado,tipo_reposicao.neq.descontinuado)")`.
   - **String estática** (sem interpolação) → não dispara a regra ESLint `no-restricted-syntax` do `.or()`.

5. **`reativarMutation`** no hook (espelha `promoverMutation`):
   - `UPDATE sku_parametros SET habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica' WHERE id = <id>`.
   - `onSuccess`: toast `"SKU reativado — volta a ser sugerido no próximo ciclo"` + `invalidateQueries(['sku_parametros_revisao'])` (o SKU sai da lista de descontinuados).
   - O payload e a predicate de estado saem de um **helper puro** (testável), não inline.

6. **`SkuRow.tsx`**: botão **"Reativar"** inline (espelha o "Promover" do candidato) quando `tipo_reposicao === 'descontinuado'`, com `AlertDialog` de confirmação → chama `onReativar(row)`.

### Helper puro (testável, vitest)

Em `src/lib/reposicao/sku-param.ts` (ou módulo irmão):
- `isDescontinuado(row): boolean` — `row.tipo_reposicao === 'descontinuado'`.
- `reativarPayload(): { habilitado_reposicao_automatica: true; tipo_reposicao: 'automatica' }`.

Testes: `isDescontinuado` distingue `'descontinuado'` de `'automatica'`/`null`/`'produto_acabado'`; `reativarPayload` retorna exatamente os 2 campos esperados (trava contra alguém "religar" só uma metade).

## Comportamento de "Reativar" (e ressalvas)

- **Não recria** a linha no pedido de onde o SKU foi removido (ela já foi apagada). O SKU volta a ser **sugerido no próximo ciclo** (cron `gerar-pedidos-diario` ~9h15) e **só se** `estoque_efetivo <= ponto_pedido`. Para comprar na hora, é compra manual no Omie.
- **Parâmetros preservados:** descontinuar não apagou `ponto_pedido`/`estoque_maximo`/`estoque_minimo`/`minimo_forcado_manual` → reativar não precisa reconfigurar nada.
- **`tipo_reposicao='automatica'` é seguro universalmente:** se o SKU for, por engano, um fabricado `'04'` (Produto Acabado), a guarda do motor (`metadata->>'tipo_produto' <> '04'` na RPC `gerar_pedidos_sugeridos_ciclo`, #527/#529) o barra independentemente. Por isso não é preciso preservar/repor o `tipo_reposicao` original (que o descontinuar sobrescreveu e não guardou).

## Não-objetivos (YAGNI)

- **Não** recriar a sugestão no ciclo de hoje (só religa; o cron diário resolve).
- **Não** preservar o `tipo_reposicao` anterior (sempre `'automatica'`; a guarda do '04' cobre o único caso de risco).
- **Não** criar RPC nem migration (a escrita já é PostgREST direto, coberta pela RLS de `sku_parametros`).
- **Não** criar permissão nova: herda o gate da tela de Revisão (gestor comercial / master).
- **Não** mexer no botão de descontinuar (continua como está) nem no fluxo de Pedidos.

## Gate de acesso

Herdado da tela de Revisão (`/admin/reposicao/revisao`), já restrita a comprador/gestor/master. A escrita reusa a RLS de `sku_parametros` (mesma que autoriza editar ponto de pedido hoje).

## Teste / verificação

- Helper puro com vitest (acima).
- Sem backend para validar; o critério de pronto é o fluxo manual: descontinuar um SKU de teste em Pedidos → ele some de "Todos" e aparece em "Descontinuados" com preço → "Reativar" → some de "Descontinuados" e volta a `habilitado=true`/`tipo='automatica'`.

## Deploy

- **Só Publish do frontend no Lovable.** Sem SQL Editor, sem deploy de edge function.
