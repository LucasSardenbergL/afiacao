# Casts que desligam o tipo — módulo farmer-inteligencia (plano v2 · item 4 / I1 · PR 9)

2026-10-21. PR do item 4 do [plano de melhoria v2](../superpowers/plans/2026-10-18-plano-melhoria-v2/README.md) depois de [casts-vendas.md](casts-vendas.md) e de [casts-financeiro.md](casts-financeiro.md) (#3272). Escopo: os arquivos não-teste do módulo ativo `farmer-inteligencia` (manifesto). Eram **96** ocorrências de `as never`/`as unknown as` em 35 arquivos. Resta 1, legítimo: `useVendaPainel` chama `venda_painel` e `venda_repasse_candidatos`, que ainda não estão no `types.ts` (migration da frente venda-cliente aplicada em 2026-10-20; o gerador do Lovable regenera depois). É o uso que o `casts:stale` deixa fora por desenho.

## O que os casts escondiam

Conferido na PROD via `psql-ro` (`pg_get_function_arguments`, `pg_get_functiondef`, CHECKs, `information_schema`, distribuição de chaves dos jsonb) antes de corrigir.

- **`COLUNAS_PLANO_TATICO` era concatenado com `+`**, então o `.select()` virava `string` e a linha caía em `GenericStringError`. Os 13 casts do `useTacticalPlan` existiam para atravessar isso. Agora é literal único.
- **`top_bundle`/`second_bundle`: writer e leitor discordavam da forma.**
  - Os dois writers do plano (o hook e a edge `generate-tactical-plan`) gravam o ARRAY `bundle_products` (`[{id, name, price}]`).
  - O card do copiloto (`nomesDoBundle`) procurava `{bundle_products|products}` dentro de um OBJETO. Com bundle, ele nunca mostraria os produtos.
  - Era latente: os 1.017 planos da prod têm `{}`, porque nenhum plano saiu com bundle até hoje.
  - `BundleSnapshot` passou a ser `Json` e a leitura aceita as duas formas.
- **`signal_modifiers`:** o tipo dizia `ScoreAdjustment | null`, mas os 6.633 scores da prod têm `{}`. Os consumidores sobreviviam por serem defensivos. A borda `src/lib/scoring/borda-ajuste.ts` trata `{}`/NULL como "sem ajuste" e lança com ajuste parcial.
- **Respostas inventadas em `useRegistrarContato`:** resposta ausente virava `{id: '', deduped: false}` e `{deleted: false}`. Agora `lerRegistroComDedupe`/`lerDesfazer` (`src/lib/radar/borda-rpc.ts`) lançam. A mesma borda serve às RPCs do radar.
- **R$ 0,00 fabricado na zona financeira do dashboard:** a projeção de 13 semanas fazia `Number(saldo_projetado ?? 0)`. Saldo NULL agora fica NULL ("—"). O cast escondia o `p_company: null` (DEFAULT NULL na prod, então omitir a chave dá o mesmo NULL).
- **jsonb lido por forma**, com um kit compartilhado novo (`src/lib/json-forma.ts`, plataforma):
  - `get_carteira_saude`, `get_meu_mixgap[_for]` e `get_minha_positivacao[_for]`. Os três corpos vêm de `_carteira_*_for_owner`; `confidence`/`lift` estritos porque a fonte (`farmer_association_rules`) é `NOT NULL`.
  - `radar_kpis` e `get_defasagem_cliente`. Na defasagem de preço, os absolutos role-gated chegam NULL para a vendedora e continuam NULL.
- **CHECK que o gerador entrega como `string`:**
  - Experimentos: `primary_metric`, `status`, `winner`, `group_type`. As métricas são nuláveis com DEFAULT 0 e passam por `exigirColunas` (tabelas vazias na prod).
  - `visitas_agendadas.status` (`visitaDaLinha`) e `cliente_tier_preco.tier` (`ehTier`, do rascunho da sessão do ciclo 2).
  - `farmer_tactical_plans.plan_type` não tem CHECK; o guard aceita os 2 tipos que os writers gravam.
  - `farmer_calls.call_type`/`call_result` são enums: o insert confere contra `Constants` em vez de mandar o texto do diálogo.
- **Nulos que o tipo local negava:** `customer_profile`/`status`/`generated_at` do plano passam por `exigirColunas` (0 nulos em 1.017). `margin_audit_log.created_at` agora é nulável no tipo, e NULL nunca é "formato antigo".
- **NULL semântico em argumento de RPC:**
  - Sem DEFAULT: `comNulo` em `registrar_resultado_plano` (`_plan_followed`/`_actual_margin`/`_call_duration_seconds`) e em `farmer_bundle_recomendacoes_substituir.p_geracao_vista`.
  - Com DEFAULT NULL: `?? undefined` (contato do radar e da rota).
  - O desfecho de recomendação e a contagem por município também usam `comNulo`, mesmo com DEFAULT NULL na prod: os testes fixam o NULL EXPLÍCITO de propósito, para não deixar o default do Postgres decidir.
- **Gate G5 do universo de pedidos:** o vocabulário de status do experimento ('rascunho', 'cancelado') coincide com o de pedido. Por isso o guard é um `switch`, não uma lista literal (o G5 caça cópia da lista, e o teto dele só desce).
- **Paginação:** `fetchAllPages`/`paginarPorId` inferem a linha. Saíram os casts de `.range()`/`.limit()` e os tipos locais mais largos (`number | string`).

## O que ficou

- Testes novos: `src/lib/radar/__tests__/borda-rpc.test.ts` e `src/lib/scoring/__tests__/borda-ajuste.test.ts`.
- Gate `casts:stale`: baseline `{from: 19, rpc: 18}` → `{from: 16, rpc: 12}`; piso `castsLiterais` **37 → 28** = contagem real.
- Residual: `useVendaPainel` (nome ainda não tipado, ver acima). Sai quando o `types.ts` trouxer as duas RPCs.

## Lições

- **Writer e leitor de jsonb divergem em silêncio quando os dois atravessam casts.** O `top_bundle` era gravado como array e lido como objeto. Só a borda tipada, de qualquer um dos lados, teria acusado.
- **Default 0 em coluna nulável parece contrato e não é.** O `{}` de `signal_modifiers` e as métricas de experimento com DEFAULT 0 são "não calculado", e o tipo precisa dizer isso.
