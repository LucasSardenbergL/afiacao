# Quem vendeu cada pedido importado do Omie (venda por cliente · rodada 2 · Entrega 2)

**Data:** 2026-11-12 · **Spec:** `docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md`
**Arquivos:** `supabase/migrations/20261113120000_vendedor_pedido_omie.sql` ·
`supabase/functions/omie-vendas-sync/vendedor-pedido.ts` (+ `_test.ts`) · `db/2026-11-13-desfabricar-autor-importado.sql` ·
prova `db/test-vendedor-pedido-omie.sh` (26 asserts, 2 locales, 12 sabotagens).

## O defeito

Todo pedido nasce no Omie e chega pelo `omie-vendas-sync`. O sync gravava em `created_by` o 1º
`profiles.is_employee` que o PostgREST devolvesse (`limit(1).single()` sem `ORDER BY`). Medido em prod
(psql-ro, 2026-11-12), os 32.310 importados (`hash_payload LIKE 'omie\_%'`) tinham só 2 autores:

| conta | Tatyana | Lucas |
|---|---|---|
| colacor | 19.079 | 880 |
| oben | 11.368 | 983 |

Era a assinatura do sync, não autoria. Medir oferta ou conversão por farmer em cima disso fabrica o número.

## Medições que definiram o desenho

- **`omie_payload` não serve de fonte:** só 25 de 32.336 pedidos têm o payload gravado. O import nunca o
  guardou, então o backfill **relê o Omie**.
- **`fin_contas_receber.vendedor_id` está 100% NULL** (45.799 títulos). Não serve de fonte.
- **`codVend` no `ListarPedidos`:** o campo veio em 997 de 997 pedidos Oben desde 01/09/2026, lidos com a
  credencial local `omie-oben.env`. A distribuição foi REGINA 983, LUCAS 12 e TATYANA 2.
- **`codVend` ≠ vendedor do cadastro do cliente:** dos 926 pedidos casados em `sales_orders`, 285 (78
  clientes) têm um `codVend` diferente do `omie_customer_account_map.omie_codigo_vendedor`. Em 286 pedidos o
  cliente está cadastrado com a TATYANA e o pedido traz a REGINA. Logo o campo é informação do PRÓPRIO
  pedido (quem digitou ou comissiona), não herança do cadastro. A Colacor não foi medida antes do deploy,
  porque não há credencial local; a cobertura dela sai da RPC depois do backfill.
- **O mapa já existia:** `omie_vendedor_map(omie_account, omie_codigo_vendedor → user_id)`, com 18 linhas
  desde 2026-05-24, `UNIQUE(account, código)` e escrita só por master. A entrega o reaproveita; não criou
  tabela nova.

## Decisões

1. **`created_by` vira NULL nos importados**, em vez de um "usuário de sistema". O subagente mapeou os
   leitores, e nenhuma RLS, view, ranking, comissão ou `get_*` da carteira lê `sales_orders.created_by`.
   O único leitor SQL é `venda_prazo_decisao_registrar` (gate "pedido é meu"), que tem 0 linhas em prod e
   é chamado no fluxo do app, onde o autor é real. Para importado ele fica fail-closed: só passa quem vê a
   carteira completa. `useTeamKpis` já excluía importados (`hash_payload IS NULL`). A coluna não tem FK.
   A migration faz `DROP NOT NULL`; a RPC `criar_pedidos_com_itens` já aceitava NULL e **não foi tocada**.
2. **Três colunas dedicadas e um escritor só** (`sales_orders_registrar_vendedor_omie`, `service_role`):
   - `vendedor_omie_codigo` guarda o `codVend` (o fato);
   - `vendedor_user_id` guarda o código resolvido pelo mapa da conta. NULL quer dizer sem mapa ou não lido;
   - `vendedor_lido_em` separa "não lido" (NULL) de "lido, Omie sem vendedor".

   CHECK `sales_orders_vendedor_coerente`: usuário só existe com código, e código só existe com leitura.
   `codVend` null nunca apaga um código conhecido. O escritor só grava o que mudou, então reler a cada 2h
   não toca a linha nem o `updated_at`.
3. **`origem` não recebe `'omie_sync'`.** O `fin-valor-cockpit` (e o espelho
   `valor-cockpit-helpers.ts:479`) classifica `origem IS NULL` como `erp_direto` e todo valor desconhecido
   como `outro`. Marcar mudaria o cockpit. O marcador canônico de importado continua sendo
   `hash_payload LIKE 'omie\_%'`.
4. **O vendedor fica só na linha importada.** A linha do app (`hash_payload IS NULL`) tem o autor real em
   `created_by`. A gêmea importada (`gemeo_importado_id`) é a que carrega `order_date_kpi` e o vendedor.
5. **Falha do escritor não derruba o import.** O pedido é dinheiro; o vendedor é atribuição. A falha
   conta em `vendedor_falhas`, vai para a resposta e o `fin_sync_log`, e é logada com a marca
   `VENDEDOR_REGISTRO_FALHOU`.

## Contrato para a Entrega 1 (resumo por e-mail / painel `/admin/venda-cliente`)

- **Por pedido:** `sales_orders.vendedor_user_id`, lido por `service_role` (edge) ou dentro de RPC. Não há GRANT de coluna para `authenticated`: o `authz:check` trata isso como reabertura da tabela fechada, e `gemeo_importado_id` é o precedente. Universo:
  `hash_payload LIKE 'omie\_%'`. NULL não é zero.
- **Cobertura:** `public.venda_cobertura_vendedor(p_de date, p_ate date) → jsonb`. Gate: master ou
  `service_role`. Período de no máximo 400 dias, no eixo `order_date_kpi`, excluindo apagados e
  cancelados. A resposta traz
  `{ total:{pedidos,lidos,com_codigo,com_vendedor,pct_com_vendedor}, por_conta:[…, codigos_sem_mapa], por_vendedor:[{account,vendedor_user_id,nome,pedidos,valor}] }`.
  `pct_com_vendedor` vem NULL quando não há pedido.

## Ordem de deploy (a ordem importa)

1. **Migration** `20261113120000`, que é aditiva e compatível com a edge velha. Comando:
   `bun run db:aplicar supabase/migrations/20261113120000_vendedor_pedido_omie.sql`. O ensaio na prod
   passou (sha `1cf0994d…`, ROLLBACK). O apply real é do founder: o classificador de permissão da sessão
   negou o `db:aplicar`.
2. **Edge** `omie-vendas-sync` (no ar: v1.39), depois da migration. Com `created_by NOT NULL` o import novo seria
   recusado.
3. **Acervo:** `bun run db:aplicar db/2026-11-13-desfabricar-autor-importado.sql`, depois do deploy
   atestado. Antes disso, a edge velha re-fabricaria. O valor antigo fica em
   `private.bkp_sales_orders_created_by_20261113`.
4. **Backfill do vendedor:** action `backfill_vendedor`, só via cron-secret. Ela pagina o `ListarPedidos`
   inteiro da conta, 100 pedidos por página, sem `ConsultarCliente`, com orçamento de 100s, e responde
   `proxima_pagina`. Repita com `start_page` até `completo:true`. **Uma invocação por vez, no total**
   (duas em paralelo, mesmo de contas diferentes, voltaram 502 do gateway em ~20 s, sem gravar nada),
   porque chamadas concorrentes na mesma conta Omie batem no rate-limit (sync.md); fuja dos minutos :05 e
   :20 das horas pares. Disparo (SQL Editor):

   ```sql
   SELECT net.http_post(
     url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-vendas-sync',
     headers := jsonb_build_object('Content-Type','application/json',
       'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
     body := jsonb_build_object('action','backfill_vendedor','account','oben','start_page',1,'max_pages',80),
     timeout_milliseconds := 150000);
   ```

   Para ler a resposta (psql-ro): `SELECT id, status_code, left(content,600) FROM net._http_response ORDER BY id DESC LIMIT 3;`

## Postcondição do backfill (psql-ro)

```sql
SELECT public.venda_cobertura_vendedor('2026-09-01', current_date);  -- como service_role/master
-- ou direto:
SELECT account, count(*) pedidos, count(vendedor_lido_em) lidos, count(vendedor_user_id) com_vendedor
  FROM sales_orders WHERE hash_payload LIKE 'omie\_%' AND deleted_at IS NULL GROUP BY 1;
```

## Estado na entrega (2026-11-14, medido por psql-ro)

**Sequência executada:**

- migration `20261113120000` (recibo #1107);
- #3872 mergeado, e depois o #3880. O #3880 deixa o nome da RPC literal em `vendedor-pedido.ts`: o wrapper
  `(fn,args)=>rpc(fn,args)` era indireção, o `preflight:rpcs` saía com exit 3 e o `pendencias:pacote` não emitia a
  colagem;
- deploy da edge v1.39 pelo agente do Lovable: 36/36 hashes conferidos, sensor `SEM_EDICAO`, atestado pela sonda
  (relé) no `pendencias:deploy`;
- acervo `db/2026-11-13-desfabricar-autor-importado.sql` (recibo #1115);
- `backfill_vendedor`: Oben com 7 invocações e 135 páginas; Colacor com 11 invocações e 223 páginas. Zero
  `vendedor_falhas` e zero `vendedor_ambiguos` em todas.

**Antes e depois** (importados não apagados; antes = 2026-11-14 00:27Z, depois = 01:08Z):

| conta | pedidos | com autor (antes → depois) | lidos (antes → depois) | com vendedor (antes → depois) |
|---|---|---|---|---|
| colacor | 19.964 | 19.964 → **0** | 38 → 19.953 | 38 → **14.987 (75,1%)** |
| oben | 12.367 | 12.367 → **0** | 88 → 12.350 | 88 → **12.333 (99,7%)** |
| total | 32.331 | 32.331 → 0 | 126 → 32.303 | 126 → 27.320 (84,5%) |

O backup `private.bkp_sales_orders_created_by_20261113` tem 32.331 linhas. Os 126 lidos do "antes" vieram do
sync de 2h da edge nova, que já rodou antes do backfill.

**No eixo que a Entrega 1 lê** (universo canônico, `order_date_kpi ≥ 2026-09-01`): 1.212 pedidos, dos quais
1.198 têm vendedor (98,8%). Colacor 275/282, Oben 923/930. Por vendedor: REGINA 262 + 911 e Lucas 13 + 12.

**O que fica NULL, e por quê** (ausente ≠ zero):

- **Códigos sem mapa** em `omie_vendedor_map`. São 4.685 pedidos, quase todos HISTÓRICOS:
  - Colacor `400071282`: 4.603 pedidos, de 2020-04 a 2025-06;
  - Colacor `3710549150`: 70 pedidos, de 2020 a 2021;
  - Colacor `403955513`: 3 pedidos;
  - Oben `8689670844`: 8 pedidos, de 2024-10 a 2024-11;
  - Oben `12172845668`: 1 pedido, de 2026-08-31.

  Consultados no Omie (`ConsultarVendedor`, 2026-11-14), **nenhum é um vendedor com usuário no sistema**:
  - `400071282` e `8689670844` = "COLACOR", o vendedor-casa das duas contas;
  - `3710549150` = "JARDEL", inativo e sem `profiles` de funcionário;
  - `403955513` = "Devi PDV_01", inativo;
  - `12172845668` = "ZEKI TESTE", inativo.

  Por isso ficam NULL de propósito: atribuir a uma pessoa seria fabricar. Se um dia algum for mapeado no
  `omie_vendedor_map`, basta reler a conta com `backfill_vendedor`; o escritor resolve o usuário de novo,
  porque `vendedor_user_id` difere.
- **Lidos sem código** (o Omie não traz vendedor no pedido): Colacor 290, Oben 8.
- **Não lidos:** 28 pedidos, quase todos `importado`, que o `ListarPedidos` não devolveu. O sync de 2h os pega
  se reaparecerem.
