# sku-items: a "família Sayerlack série 1 de 0 itens" era CT-e — o frete saía da fila só por expirar

> 2026-10-05. Pendência do §7 de [sku-items-consumo-redundante-no-ciclo.md](sku-items-consumo-redundante-no-ciclo.md):
> o diário das 07:00 do `sync_sku_items` OBEN gravava quase nenhum item, com ~19 "NFes" pendentes
> por dia girando no backoff. O motivo novo do #2539 respondeu: **`ok_sem_itensRecebimento`** (a
> chave vem AUSENTE). E a causa estava no tipo do documento: **é CT-e (modelo 57), o conhecimento
> de frete**, e não NF-e de produto. Conserto (parte A): o CT-e sai da fila ANTES de qualquer
> consulta à Omie. Regra que fica: **"0 itens" pede o TIPO do documento antes de qualquer
> hipótese de etapa, parâmetro ou chamada.**

## 1. O que se pensava × o que era

- **Pensava-se:** a Omie respondia "0 itens" para NF-e da Sayerlack série 1. Isso seria uma lacuna
  de COBERTURA no dado do motor, talvez de etapa do recebimento (`cEtapa`/`cRecebido`), talvez de
  outra chamada ou parâmetro.
- **Era:** o módulo `recebimentonfe` da Omie traz NF-e E CT-e na mesma lista (`ListarRecebimentos`
  não filtra por modelo). O `omie-sync-nfes-recebidas` gravava o CT-e sem pedido como linha órfã de
  `purchase_orders_tracking`, igual a uma NF-e. O CT-e documenta o SERVIÇO de transporte e não tem
  item de produto. Os produtos estão na NF-e transportada, que já vira leadtime.
- **Não havia lacuna de cobertura de NF-e.** Havia cota da Omie queimada e uma fila que nunca
  esvaziava.

## 2. A evidência (psql-ro, 2026-10-05 ~17h UTC — 11 dias depois do deploy da v1.2)

| medição | valor |
|---|---|
| marcações no controle desde o deploy da v1.2 (2026-09-24 18h) | 24 `ok_sem_itensRecebimento` · 0 `ok_0_itens` · 9 `ok_com_itens` |
| as 57 `ok_0_itens` restantes | todas anteriores ao deploy (última 2026-09-23 07:00): motivo antigo congelado |
| papel das linhas sem itens | 100% órfãs (`omie_codigo_pedido < 0`), gravadas pelo `omie-sync-nfes-recebidas` |
| modelo do documento (chave pos. 21–22 **e** `cabec.cModeloNFe`) | órfãs 120d: **57 (CT-e) → 59/59 sem `itensRecebimento`** · 55 (NF-e) → 33/33 com |
| outros marcadores das 59 | `infoCadastro.cOperacao = 15` em 100% · chave `cteCfopEntrada` em 47 |
| a etapa discrimina? | **não**: NF-e com `cEtapa=40`/`cRecebido=N` tem itens (24); CT-e com `cEtapa=80`/`cRecebido=S` não tem (42) |
| tracking inteiro (só OBEN) | 55 → 413 linhas, 399 com leadtime · 57 → 135 linhas (102 Sayerlack série 1 desde 2026-01-19), **0** com leadtime |
| cobertura de NF-e | 30d **45/45** · 120d **206/206** com leadtime |
| fila do diário das 07:00 | 17 linhas, **100% modelo 57**; zero NF-e pendente |
| custo nos 11 runs das 07:00 pós-deploy | 55 consultas → 5 itens; ~4 NF-e marcadas ⇒ **~51/55 (≈93%) em CT-e**; 19–44s, 1 timeout (09-27) |
| sync de NFes (84 runs, 7d) | 4,0 consultas/run; ~2,2 CT-e na janela de emissão de 3 dias (estimativa) ⇒ ~55% das chamadas de detalhe dele também em CT-e |
| casamento de frete (sync de CT-e) | 82 casamentos: 69 → NF-e 55 · **11 → a PRÓPRIA linha do CT-e** · 2 → outro CT-e ⇒ 13 fretes (16%) não chegaram à NF-e |
| `nIdReceb` com chaves de modelos diferentes | **0** grupos (o filtro antes do dedup é seguro) |

A doc oficial da Omie (`/api/v1/produtos/recebimentonfe/`) confirma o desenho. `ListarRecebimentos`
filtra só por período, fornecedor e `cEtapa`. O campo `cteCfopEntrada` tem "Preenchimento válido
para recebimentos de CT-e". Nenhuma chamada dá "itens" de um CT-e. O `omie-sync-ctes-recebidos` já
filtrava a mesma lista por `cModeloNFe === "57"` (`index.ts:410`). O `omie-sync-nfes-recebidas` não
filtrava nada.

## 3. O conserto (parte A) — `omie-sync-sku-items` `v1.3-cte-fora-da-fila`

- [`escopo.ts`](../../supabase/functions/omie-sync-sku-items/escopo.ts) — decisão pura:
  `modeloDaChave` (posições 21–22, parser ESTRITO de 44 dígitos ASCII, sem trim nem `Number`),
  `ehCte` e `separarCtes` (preserva a ordem e a identidade das linhas).
- **Denylist, não allowlist.** Sai só o 57 legível. Chave ilegível, ausente ou de modelo
  desconhecido fica na fila (incerteza vira tentativa, nunca exclusão silenciosa). O 67 (CT-e OS)
  fica de fora: não existe na população medida.
- **A posição é contrato.** O fluxo é pendentes brutos → filtro → backoff e ordenação → dedup →
  consulta. Com isso o CT-e não conta em `fila_em_backoff` nem no sensor `fila_parada_48h`, e
  nunca é eleito no dedup no lugar de uma NF-e.
- **Contador `ctes_fora_da_fila`** no `results`. Os pendentes brutos são `fila_pendente` +
  `ctes_fora_da_fila`. O contador conta linhas, não requests economizados.
- **Sem escrita no controle.** As 81 linhas de CT-e em `sku_items_sync_controle` ficam como
  histórico, e o motivo antigo fica congelado. Sem retorno antecipado: o recompute e o fechamento
  do log rodam mesmo num run só de CT-e.
- **Prova:** Deno (`escopo_test.ts`, 5 testes) e invariante vitest de fronteira e POSIÇÃO em
  `edge-money-path-invariants.test.ts`.

## 4. Codex no desenho — gpt-6-astra · max · 388s · 125.645 tokens: sem P0/P1

| achado do Codex (todos P2) | decisão |
|---|---|
| A em um PR; B (fonte) e a defesa do `buscarCandidatas` em outro | aceito |
| B sozinho não protege o casamento: o sync de CT-e reprocessa 30 dias | aceito, vai para o PR B |
| o matcher pode re-associar um CT-e já usado em runs seguintes | aceito: medir antes de mexer (PR B) |
| em B, classificar na resposta do `ListarRecebimentos`, antes do sleep, da consulta e do `updateLinhasDoPedido` | aceito (PR B) |
| denylist 57, parser estrito, sem o 67 | aceito |
| a ordem do fluxo e a definição do contador | aceito, e virou invariante posicional |
| medir `nIdReceb` com várias chaves | medido: 0 mistura 55/57. Os 9 grupos 55 viram observação aberta (§7) |
| 45/45 é prova vazia do caminho de gravação | aceito: pós-deploy, acompanhar 1 NF-e nova até os itens |
| critério pós-deploy: CT-e com `tentativas`/`ultima_tentativa` INTOCADOS | aceito: baseline no deploy (§8) |

## 5. Codex no código

Sem Codex: a cota estava em 88% (teto 85%), e a janela reabre em 09/10 19:30. **Caminho B**: revisor adversarial
independente, **sem P0/P1**, com 4 achados P3, todos incorporados.

| achado (P3) | decisão |
|---|---|
| vitest cego a 3 mutantes (`pendentes.concat(ctesForaDaFila)`, `pendentes && pendentesBrutos`, a linha certa comentada com `pendentes = pendentesBrutos`); o `vereditoFronteira` não enxerga desestruturação | aceito: asserts sobre `removerComentarios(src)` e âncora `= pendentes\s*\.map\(` |
| a fixture do Deno não fixava a POSIÇÃO do modelo (o mutante `includes("57")` passava) | aceito: NF-e com `57` no nNF |
| CNPJ alfanumérico: o writer arranca letras da chave | radar no §7 (direção segura; raiz no writer) |
| o SQL de revalidação media `substr = '57'` sem o predicado estrito da edge | aceito: `~ '^[0-9]{44}$'` |

## 6. Falsificação — uma camada por vez, controle verde na mesma invocação

| sabotagem | resultado |
|---|---|
| allowlist (`!== "55"`) no lugar da denylist | vermelho (Deno) |
| parser leniente (aceita espaço no fim) | vermelho (Deno) |
| filtro removido (fila nasce dos brutos) | vermelho (vitest) |
| retorno do filtro descartado | vermelho (vitest, fronteira) |
| filtro DEPOIS do dedup (texto todo presente, só a ordem muda) | vermelho na asserção de ORDEM: `"separarCtes" tem de vir ANTES de "backoff"` |
| contador some do `results` | vermelho (vitest) |

## 7. O que fica descoberto

- **Parte B, na fonte (PR seguinte).** O `omie-sync-nfes-recebidas` deve pular o modelo 57 já na
  resposta do `ListarRecebimentos` (quando a chave E o `cModeloNFe` dizem 57; divergência e ausência
  são contadas à parte). Isso economiza a consulta de detalhe por CT-e em todo ciclo de 2h. O
  `buscarCandidatas` do `omie-sync-ctes-recebidos` deve excluir o 57 das candidatas: hoje 13 dos 82
  casamentos (16%) caíram numa linha CT-e, e a NF-e transportada ficou sem `t3_data_cte`. O `t3` não
  entra nos `lt_*` do motor, então o dano é na decomposição logística e nas telas. Antes de mexer
  no matcher, medir a re-associação de um CT-e já usado (achado do Codex).
- **As 135 linhas de CT-e no tracking e os 13 fretes desviados.** Limpar ou re-casar é decisão do
  founder: tem efeito em dado, e o redeploy não desfaz vínculo gravado. As views
  `v_leadtime_por_grupo` (conta CT-e como "pedido": 33 de 39) e `v_pedidos_em_aberto` (29 CT-e como
  AGUARDANDO_CTE) não têm leitor no repo.
- **Integridade do `nIdReceb` (pré-existente).** 9 grupos com o mesmo `nIdReceb` em chaves de NF-e
  distintas: 42 linhas, todas modelo 55 com pedido casado, todas com leadtime. Cobertura documental
  OK, mas a completude por par (tracking, SKU) não está provada.
- **Radar: CNPJ alfanumérico (inscrições novas desde jul/2026).** O writer do sync de NFes normaliza a chave com
  `replace(/\D/g, "")` (`omie-sync-nfes-recebidas/index.ts:281`) e arrancaria as letras. A chave ficaria com menos de
  44 caracteres, o parser estrito devolveria `null` e o CT-e voltaria à fila. A direção é segura (tentativa, não
  perda), mas a chave gravada estaria corrompida para qualquer casamento por chave. A raiz é o writer; tratar na
  parte B (revisão adversarial, P3).
- **14 NF-e sem leadtime (mar–abr/2026).** São anteriores ao controle (07/2026), já fora da janela, e
  nunca foram tentadas. Com o CT-e fora da fila, um run avulso com `dias` largo custaria ~14
  consultas para recuperá-las. É decisão do founder (dado histórico).

## 8. Deploy e revalidação

1. PR mergeado ⇒ `bun run pendencias:deploy` decide ⇒ deploy da `omie-sync-sku-items` pelo MCP. O eco
   `v1.3-cte-fora-da-fila` aparece no próximo tick do :35 (jobid 186).
2. **Baseline no momento do deploy** (read-only): as linhas de controle de CT-e, com contagem, soma de
   `tentativas` e `max(ultima_tentativa)`. Depois do deploy elas têm de ficar IDÊNTICAS, e nenhuma
   linha nova de controle pode aparecer em modelo 57.
3. Revalidação no 1º run das 07:00 pós-deploy (`psql-ro -v ON_ERROR_STOP=1`):

```sql
-- CT-e intocados: nenhuma tentativa nova depois do deploy (:deploy = instante do deploy)
select count(*) from sku_items_sync_controle c join purchase_orders_tracking t on t.id = c.tracking_id
where t.nfe_chave_acesso ~ '^[0-9]{44}$' and substr(t.nfe_chave_acesso, 21, 2) = '57'
  and c.ultima_tentativa > :deploy;
-- o diário enxerga os CT-e e não os consulta
select started_at, status, (results->>'ctes_fora_da_fila')::int ctes_fora,
       (results->>'fila_pendente')::int pend, (results->>'consultas_detalhadas')::int det,
       (results->>'requisicoes_omie')::int req, round(duracao_ms/1000.0,1) dur_s
from fin_sync_log where action = 'sync_sku_items' and started_at > :deploy order by started_at;
-- cobertura de NF-e intacta
select count(*), count(*) filter (where exists (select 1 from sku_leadtime_history h where h.tracking_id = t.id))
from purchase_orders_tracking t
where t.empresa = 'OBEN' and t.t2_data_faturamento >= now() - interval '30 days'
  and substr(t.nfe_chave_acesso, 21, 2) = '55';
```

Esperado: 0 CT-e com tentativa nova; no diário, `ctes_fora_da_fila` igual aos CT-e pendentes da
janela de 30 dias (17 no dia 05/10, caindo conforme expiram) e `requisicoes_omie` só de NF-e; a
cobertura de NF-e segue completa. **E 1 NF-e nova acompanhada até os itens gravados**, porque 45/45
com zero pendente não exercita o caminho de gravação.
