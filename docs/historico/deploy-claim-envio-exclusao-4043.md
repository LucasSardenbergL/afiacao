# Deploy da disputa atômica envio × exclusão (#4043) — 2026-11-21

Frente: exclusão de pedido de venda sem PV órfão no Omie (#4034 front → #4037 edge v1.41 → #4043
migration + edge v1.43 + front). Este registro é só o DEPLOY das 3 camadas do #4043.

## O que foi ao ar, na ordem, com a prova de cada camada

1. **Migration `20261120230001_sales_orders_claim_envio_omie.sql`** — aplicada pela sessão via MCP
   (`query_database`), a pedido do founder ("cole você"; tem `DROP POLICY` + `REVOKE`, que o
   envelope deixaria com ele).
   - Pré-voo `psql-ro`: coluna/RPCs ausentes, `authenticated=ad`, policy presente ⇒ A1–A7 passariam.
   - Trava de transcrição: `md5(prosrc)` das 2 RPCs calculado num PG17 local a partir do arquivo
     (`check_function_bodies=off`) e exigido num `DO $md5$` antes do `COMMIT`.
   - Ensaio com `RAISE EXCEPTION 'ENSAIO_OK …'` → rollback conferido por fora; depois o real.
   - 2ª testemunha (`psql-ro`): coluna ✅ · 2 RPCs ✅ (md5 = arquivo) · DELETE de
     `authenticated`/`anon` = false · policy ausente · EXECUTE só `service_role` · UPDATE da coluna
     pelo cliente = false.
2. **Pré-requisito descoberto: migration `20261121120000` (#4041).** A v1.43 embute a v1.42 do
   #4041, que **segura TODA venda** sem essa migration (fail-closed). Ela também estava ausente;
   a sessão do #4046 não a aplicou em 45 min, e o founder autorizou: `bun run db:aplicar`
   (`--ensaio` ok → tentativa #1249 virou recibo) + conferência `psql-ro`.
3. **Edge `omie-vendas-sync` v1.43-claim-envio-exclusao** — colagem do `pendencias:prompt`
   (37 arquivos, sha256 de `8b108b85b`), 37/37 hashes, 1,4 crédito. Sonda pelo relé
   (`deploy_sonda_disparar`) → ledger "v1.43 visto via sonda". Sensor de edição: `SEM_EDICAO`
   (só `types.ts` tolerado).
4. **Publish** — segurado até o #4052 (extrato bancário, mergeado no meio) aplicar a migration e
   atestar a edge dele (decisão do founder: o Publish leva TODO o front da main). Depois
   `deriva:corpo:prod` exit 0, workspace = `ef72d9df2` = main, `deploy_project name=steu`.
   Bundle `index-BUhNuW6M.js` → `index-mpu1ZzKl.js`; chunk `SalesQuotes-CqRyxNKY.js` com
   `somente_orcamento` e sem `from("sales_orders").delete`. Bytes = disponibilidade, não adoção (SW).

## Sinal de PRODUTO ainda AUSENTE (fase N+1 não liberada)

Nenhum pedido enviado desde 2026-11-19 (fim de semana). O sinal positivo, com denominador, é a query:

```sql
SELECT count(*) AS enviados,
       count(*) FILTER (WHERE envio_omie_reivindicado_em IS NOT NULL) AS com_claim
  FROM public.sales_orders
 WHERE omie_pedido_id IS NOT NULL AND created_at > '2026-11-21T15:37:00Z';
```

Esperado no 1º dia útil: `com_claim = enviados > 0`. `enviados > 0` com `com_claim = 0` ⇒ a edge
servida não é a v1.43; `enviados = 0` com pedidos criados e travados ⇒ investigar o claim (fail-closed).

## Medição de 2026-11-24 (1º dia útil passou) — a query acima dá FALSO ALARME

A query acima conta também os **importados** do Omie (`hash_payload LIKE 'omie_%'`), que nunca passam
pelo claim. Em 24/11 ela deu `25 | 1`, o padrão que o texto lê como "a edge servida não é a v1.43",
mas os 24 sem claim são importados (13 `importado`, 9 `faturado`, 2 `cancelado`). Use a versão só com
os pedidos que o APP enviou:

```sql
SELECT count(*) AS enviados_pelo_app,
       count(*) FILTER (WHERE envio_omie_reivindicado_em IS NOT NULL) AS com_claim
  FROM public.sales_orders
 WHERE omie_pedido_id IS NOT NULL AND hash_payload IS NULL
   AND created_at > '2026-11-21T15:37:00Z';
```

Resultado em 24/11: **`1 | 1`**. Esse único envio é o pedido de TESTE do checkout (`1a3c47e6`, PV 13693,
R$ 1,70), depois excluído no Omie e limpo por `db/2026-11-21-limpeza-pedido-teste-pv13693.sql`. Não
há nenhum pedido criado pelo app sem PV desde o deploy, ou seja, nada travado no claim. **Sinal positivo,
mas com denominador 1 e de teste.** O sinal de produto continua sendo o 1º envio de uma vendedora.

`deleted_at` preso (o caso ⏸️ da aba fechada no meio do lote, P2 do #4034): 12 linhas em 24/11, todas
explicadas e todas gravadas por SQL (`deleted_at = updated_at` até o microssegundo; o front grava com
precisão de milissegundo): 1 é o teste acima e 11 vêm da limpeza "10 PVs da Oben excluídos no Omie"
(`9cf5f8d44`, 22/11 00:06Z). Assinatura do caso do front: `deleted_at IS NOT NULL AND
extract(microseconds FROM deleted_at)::int % 1000 = 0`. **0 ocorrências.**

## Lições

- **Edge que embute versão de OUTRO PR herda as pré-condições de banco dele.** O handoff falava só
  da migration do #4043; o título do #4041 ("migration … PENDENTE") revelou a 2ª. Leia o PR de cada
  versão intermediária entre a prod e a main.
- **O Publish leva a main inteira:** entre o merge e o Publish, outro PR (#4052) entrou com banco
  não aplicado. `deriva:corpo:prod` exit 1 foi o que mostrou — rode-a imediatamente antes.
