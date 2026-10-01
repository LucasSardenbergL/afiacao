# Coluna inexistente passa no typecheck — o `insert`/`update` genérico do postgrest-js

> 2026-09-26. Achado ao confirmar dois bugs do recebimento anotados na spec da baixa de pedido de
> compra (§11). A conferência de NF-e (`/recebimento/:id`) **nunca funcionou em produção** — e três
> dos quatro defeitos eram nome de coluna errado que o `bun run typecheck` deixou passar.

## O que estava quebrado (medido em prod, read-only)

| Sítio | Defeito | Efeito em runtime |
|---|---|---|
| `reportDivergencia` (`src/services/recebimento-divergencia.ts`) | `update({ status_item, observacao })` — a tabela só tem `observacao_divergencia` | PGRST204: a divergência não grava; offline, o item fica preso na fila |
| `confirmUnit` (`src/services/recebimento-confirm.ts`) | `insert` em `nfe_lotes_escaneados` com `nfe_recebimento_id` — a tabela não tem essa coluna (o lote liga ao **item**) | PGRST204 em **toda** unidade confirmada |
| leitura de lotes da conferência (agora `listarLotesEscaneados`, `src/services/recebimento-lotes.ts`) | `.eq('nfe_recebimento_id', …)` — mesma coluna inexistente, atrás de um `as unknown as` | 42703: a tela fica sem lotes |
| itens da NF-e (edge `omie-nfe-recebimento-sync`) | NCM do Omie vem pontuado (`2909.60.90`) e a coluna é `varchar(8)` | 22001: **0 itens** em `nfe_recebimento_itens` desde sempre (conserto em PR próprio) |

Contexto de uso: 0 pageviews em `/recebimento*` no PostHog desde 2026-05-15 (438 no total), e as 47
NF-es de prod foram todas reconciliadas (o humano conclui no Omie). Ninguém viu os erros porque
ninguém chegou até eles — sem itens, não há unidade para confirmar nem divergência para registrar.

## Por que o typecheck não pegou (a classe)

`@supabase/postgrest-js` 2.95.3 declara as escritas como **genéricas**:

```ts
update<Row extends (Relation extends { Update: unknown } ? Relation['Update'] : never)>(values: Row, …)
insert<Row extends (Relation extends { Insert: unknown } ? Relation['Insert'] : never)>(values: Row | Row[], …)
```

O `Row` é inferido do PRÓPRIO literal, e checagem de propriedade excedente só existe quando um
literal é atribuído a um tipo-alvo **não genérico**. Resta a checagem da restrição (`Row extends
Update`), que passa: todas as colunas de `Update` são opcionais, e a detecção de "tipo fraco" só
reprova literal com **zero** colunas em comum. Provado com `tsc` sobre o `Database` gerado:

| Caso | Literal passado ao `update` | tsc |
|---|---|---|
| A (o código de prod) | `{ status_item, observacao }` | **passa** |
| B | `{ observacao }` sozinho | TS2353 |
| C | A com `satisfies TablesUpdate<'nfe_recebimento_itens'>` | TS2353 |
| D (conserto) | `{ status_item, observacao_divergencia } satisfies …` | passa |

No `insert` é igual, depois que as colunas obrigatórias estão presentes.

**Idioma do conserto:** `satisfies TablesInsert<'tabela'>` / `TablesUpdate<'tabela'>` no literal —
o `satisfies` dá o tipo-alvo não genérico e devolve a checagem de propriedade excedente sem mudar o
tipo inferido.

## Assinatura e varredura (calibradas com controle)

**Assinatura estrutural:** o próprio `tsc`, com as 5 assinaturas de escrita (`insert` ×2,
`upsert` ×2, `update`) trocadas por tipo-alvo exato numa CÓPIA do postgrest-js (fora do
`node_modules`, mapeada por `paths`). Cada TS2353/TS2769 "known properties" é um sítio. **Controle
na mesma invocação:** um arquivo com o caso A tem de errar — senão o patch não pegou e o "zero" é
cegueira.

O controle pegou **duas** cegueiras durante a própria medição:

1. `String.replace` com a substituição `(Relation$1 extends …)`: o `$1` é expandido como grupo de
   captura e o `.d.ts` sai com erro de sintaxe. Use função de substituição.
2. **TS2688** (`Cannot find type definition file for 'vitest/globals'`, porque o tsconfig temporário
   mora fora do repo): é diagnóstico **global**, e o `tsc` **pula o semântico inteiro** quando há
   erro global — saiu "0 erros no `src`" com o patch ativo. Resolvido com `typeRoots` absoluto.

**Resultado (main `99b206a77`, 2026-09-26):**

- `src/` → **2 afetados**: `reportDivergencia` e `confirmUnit` — ambos corrigidos no mesmo PR.
- `scripts/` + `db/` → **0** (controle disparou na mesma rodada).
- `supabase/functions/` → **fora do alcance**: 0 das 89 edges usam `createClient<Database>`, então
  lá o cliente não conhece coluna nenhuma. E defeito de VALOR (o NCM) nenhum tipo pega.

## O que esta assinatura NÃO cobre

- **Leitura/filtro:** `.eq('coluna', v)` aceita qualquer string (precisa aceitar caminho de embed,
  `'rel.coluna'`). A leitura de lotes só apareceu lendo o código — e estava calada por um
  `as unknown as` que curto-circuitava o tipo.
- **Edges Deno** (cliente não tipado) e **payload montado fora do literal** (variável tipada como
  `Record<string, unknown>`).

## Gate

**Desenhado, não construído.** Os 2 sítios medidos ficaram com `satisfies`, e o pedido era registrar
a classe. O desenho, para quando ela reincidir: um check de CI que rode a assinatura acima (cópia do
postgrest-js com as 5 assinaturas exatas + canário que TEM de errar + reprovação em qualquer
diagnóstico global), falsificado reintroduzindo o caso A. Sem chip — meta de passagem não vira chip
([loop-de-chips.md](loop-de-chips.md)).
