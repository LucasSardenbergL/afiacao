# Captura de custo do portal Sayerlack: cega desde o nascimento (97/97 envios) — e a fonte que prova

> **A classe (2026-09-05):** um sensor de money-path que **nunca** produziu sinal positivo não é "um
> sensor que falhou às vezes" — é um sensor que nunca existiu. O log dizia "0 atualizados, N pulados"
> em todo envio e ninguém leu isso como zero-desde-sempre. Regra: sensor novo nasce com **denominador**
> e com a query que o mede (`docs/historico/fase-sem-sinal.md`).

## O defeito (medido em prod via `psql-ro`)

`enviar-pedido-portal-sayerlack` raspa `#datatable_itens` após incluir os itens e usa as linhas na
"captura de custo" (`casarLinhasComItens`/`derivarCustos` → `pedido_compra_item.preco_unitario`/`valor_linha`
e `pedido_compra_sugerido.valor_total`; o `disparar-pedidos-aprovados` cria o PO Omie com esse preço como
`nValUnit`). Em **todos** os envios com `sucesso_portal` desde jun/2026 (97), `itens_capturados` vinha com
`sku_portal: ""` e `total_raw: ""` — só `prz_ent_raw: "5"` preenchido.

| mês | envios | com sku | com total |
|---|---|---|---|
| 2026-06 | 14 | 0 | 0 |
| 2026-07 | 39 | 0 | 0 |
| 2026-08 | 40 | 0 | 0 |
| 2026-09 | 12 | 0 | 0 |

Causa no código (PR #627): (a) o sku só era atribuído se **uma célula fosse IGUAL** ao código — a célula
não é texto puro igual ao sku; (b) `total_raw` = **última célula** da linha = coluna de **ações** (botões,
`innerText` vazio). A tabela **não tem coluna Total**: colunas reais (spec 2026-07-14, observadas pelo
founder) são UN · Cap Emb · Qtd Fat · Qtd UN · Preço Fat · Preço UN · Prz Ent · % Desconto · Preço Venda.

## A fonte que prova: o JSON do "Efetivar"

`POST /order-creation/form/add` responde JSON (na `evidence.network` das tentativas):

```json
{"data":{"itens":[{"item":"WP06.3900QT","value":153.203},{"item":"TEH.3505.00BB","value":124.9005}],
         "value":"1605.67","ordernum":2126906,"deliverydate":"15/09/2026"},"nr_pedido":2126906}
```

Semântica **provada** (pedido #2443 ↔ portal 2126906): `value` do item = **Preço UN de TABELA por
embalagem**, ANTES do desconto por embalagem e da taxa −2% do cliente; `data.value` = **total LÍQUIDO** do
pedido. Prova a 4 casas: `153.203 × (1 − 0.138678) × 0.98 = 129.318` = exatamente o líquido de WP06.3900QT
registrado em jul/2026; idem WP53.3900QT (`264.021 → 222.859`). Ou seja: **`value` NUNCA é custo** — o
custo de linha só nasce do total do pedido (1 item = 50% dos envios) ou do DOM (Preço Venda × Qtd UN)
quando a soma FECHA com `data.value`.

## O que mudou (PR desta entrega)

- `captura-custo.ts` (Deno, puro, `deno test` com falsificação) — `consolidarLinhasPortal(dom, json, esperados)`
  com cadeia de prova (challenge do Codex): conjunto **local ↔ JSON ↔ DOM** idêntico (sem extra/ausência/
  duplicata); `Qtd UN` do DOM **== quantidade digitada** pela edge; `Preço UN` do DOM **== `value`** do JSON;
  1 item ⇒ `total_linha = data.value`; N itens ⇒ `Σ(Preço Venda × Qtd UN) == data.value` com tolerância
  **absoluta** derivada do arredondamento exibido. Qualquer elo faltando ⇒ `total_linha = null` em TODAS
  (null é **terminal** — não existe mais fallback textual: `parseBRL("Ação 2")` fabricava R$ 2).
- Browser: scrape por header-matching (índice **único** por coluna), identidade do sku por **token exato**
  (`WP06.3900QT - DESC` casa; `WP06.3900QTX` não), `input.value` em célula com input visível, placeholder
  do DataTables filtrado, `scrape_debug` (headers + 2 linhas × 20 células × 30 chars) no envelope para o
  próximo envio real diagnosticar o DOM sem adivinhar.
- Escrita só com o **pedido inteiro provado** (nunca custo novo + custo antigo no mesmo PO); `.select('id')`
  confere linha afetada; `valor_total` = total provado (`data.value`) só se todo item planejado persistiu.
- **Sensor:** `[SENSOR_CAPTURA_CUSTO_CEGA]` (warn estruturado) + `portal_resposta.captura_custo` (auditoria
  não autoritativa, CAS por `status_envio_portal='sucesso_portal'`) + trace step `captura_custo`.
- Espelho src ↔ Deno comparado **byte a byte** no vitest; call-site da edge provado por texto.

## Como medir (query do sensor — rode com `psql-ro`)

```sql
select id, enviado_portal_em::date, portal_resposta->'captura_custo'->>'fonte' fonte,
       portal_resposta->'captura_custo'->>'motivo' motivo,
       (portal_resposta->'captura_custo'->>'atualizados')::int atualizados,
       (portal_resposta->'captura_custo'->>'cego')::bool cego
  from pedido_compra_sugerido
 where status_envio_portal = 'sucesso_portal' and enviado_portal_em > now() - interval '30 days'
 order by enviado_portal_em desc;
```

Sinal positivo esperado após o deploy: `fonte='json_total_unico'` nos pedidos de 1 item. Se TODOS vierem
`cego=true` com `motivo='dom_incompleto'`/`qtd_diverge`/`preco_un_diverge`, o DOM ainda não está mapeado —
`portal_resposta->'scrape_debug'` (headers/idx/amostra) diz qual coluna faltou. **Bundle pré-deploy responde
sem `captura_custo`** (ausência = versão velha, não "nenhuma captura").

## Fecho do CAS (2ª fatia, 2026-09-05): a escrita virou UMA RPC transacional

O challenge do Codex apontou dois buracos na escrita da 1ª fatia: (a) escrita **parcial** entre itens
(virava sensor `escrita_parcial`, mas o custo MISTO ficava persistido e podia virar `nValUnit` do PO) e
(b) **corrida** com a criação do PO no Omie entre a leitura de `jaTemOmie` (snapshot em memória) e a
escrita. `sayerlack_aplicar_custo_portal(p_pedido_id, p_itens jsonb, p_valor_total)`
(`20260905090000_sayerlack_custo_portal_cas.sql`, SECURITY DEFINER, EXECUTE só de `service_role`) faz numa
transação: **compare-and-set no próprio UPDATE** do pedido (`omie_pedido_compra_numero IS NULL AND
status_envio_portal = 'sucesso_portal'` — o row-lock serializa contra o `disparar-pedidos-aprovados`, que
grava o nº do PO na mesma linha; sob READ COMMITTED o predicado é re-avaliado depois do commit
concorrente), **todos os itens num UPDATE só** exigindo pertencimento ao pedido e `ROW_COUNT == n`, e
`valor_total` = total provado. Recusa = SQLSTATE própria + ROLLBACK de tudo:

| SQLSTATE | motivo no resumo | cega? |
|---|---|---|
| `CP001` | `payload_invalido` (array vazio, preço/valor/total não finitos ou ≤ 0 — `'NaN'::numeric` PASSA em `> 0`) | sim |
| `CP002` | `ja_tem_omie` (PO Omie já existe no BANCO — idempotência provada, não silêncio) | **não** |
| `CP003` | `pedido_nao_elegivel` (inexistente ou `status_envio_portal` ≠ `sucesso_portal`) | sim |
| `CP004` | `itens_divergentes` (id repetido, item de OUTRO pedido, id inexistente) | sim |
| outro/ausente | `erro_rpc` (transiente; **migration não aplicada** cai aqui em TODO envio) | sim |

A edge casa a **MARCA** (`classificarErroRpcCusto(code)` no bloco espelhado de `captura-custo.ts`), nunca
"lançou algo"; `atualizados ∈ {0, planejados}` e o resumo ganha `sqlstate_rpc`. Prova:
`db/test-sayerlack-custo-portal-cas.sh` (PG17, 43 asserts, 7 falsificações — cada defesa sabotada exige
vermelho — e a corrida C1: sessão A segura o row-lock gravando o nº do PO, a RPC bloqueia e recusa CP002).

**Medir após o deploy** (mesma query do sensor acima): `sqlstate_rpc` e `motivo`. Se TODOS os envios vierem
`motivo='erro_rpc'` e `sqlstate_rpc` nulo/`42883`, a **migration não foi colada** — bundle novo sem RPC é
cegueira total, não parcial.

## Risco residual (chips)

- ~~`jaTemOmie` é snapshot em memória; a invariante "custo só antes do PO Omie" pede CAS no banco~~ →
  fechado pela RPC acima. O que **sobra**: o `disparar-pedidos-aprovados` lê `preco_unitario` ANTES de
  criar o PO no Omie e grava o número DEPOIS — se a RPC gravar nessa janela, o PO nasce com o preço velho
  e o banco fica com o novo. Nesta edge a captura roda ANTES de `registrarPedidoOmieAposPortal` (sequencial);
  a janela só existe com um disparo concorrente por outra via. Fecho seria o `disparar` reler o custo sob o
  mesmo lock — fatia própria.
- Preço do portal é **líquido pré-imposto**; o `preco_unitario` do Omie hoje mistura origens (WP06:
  R$ 172,20 no Omie vs R$ 129,32 líquido no portal). Decisão de produto do #627 mantida; o PO Omie
  passa a nascer com o preço que o fornecedor de fato cobrou.
