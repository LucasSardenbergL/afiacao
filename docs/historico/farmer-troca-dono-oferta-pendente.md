# A oferta pendente que não seguia o cliente na troca de dono (Farmer, fatia 2 do #escopo-orfao)

> Diário de PR. Fatia seguinte do #1850. A regra durável está na §Armadilhas do `CLAUDE.md`;
> o detalhe de domínio em `docs/agent/money-path.md`. Aqui ficam o caso e os números.

## O que o #1850 fechou, e o que sobrou

O #1850 fechou **gravar sob quem não é dono**: o fallback "carteira vazia ⇒ carregue TODOS"
saiu dos motores, e o gate `FG009` passou a recusar, no servidor, o lote cujo cliente tenha
`farmer_client_scores.farmer_id` diferente de `p_farmer_id`.

Sobrou o outro sentido do mesmo eixo: **o cliente que troca de dono depois de a oferta já
estar gravada**. A pendente fica sob o dono ANTIGO, e o UPDATE de expiração das RPCs filtra
`WHERE farmer_id = p_farmer_id` — então o recálculo do dono NOVO não a alcança. Não é
vazamento permanente (ela morre no próximo recálculo do dono antigo), mas a janela dura o
quanto ele demorar: no lote de abril/2026, meses.

## A medição de ANTES, com denominador

`psql-ro`, 2026-08-21:

| tabela | pendentes fora de escopo | pendentes (denominador) |
|---|---|---|
| `farmer_recommendations` | 0 | 1.083 |
| `farmer_bundle_recommendations` | 0 | 1 |

E o ponto cego que o INNER JOIN da query de baseline não vê — pendente de cliente **sem**
linha de score — também 0 nas duas.

**Logo: esta fatia é PREVENTIVA, e vale dizer isso em vez de fabricar urgência.** O zero aqui
julga desenho porque vem com denominador: há 1.083 pendentes vivas, o mecanismo que as
protege existe, e o buraco é o mesmo que o #1850 mediu em 2.676 linhas pelo outro caminho.
O saneamento único entrou mesmo assim, idempotente e no-op nesta data, porque é a única
forma de alcançar uma órfã anterior à trigger — a trigger só age no momento da troca.

## O achado que mudou o lugar da correção

A tarefa foi escrita — e o consenso do challenge anterior apontava — para a edge
`calculate-scores`, "que faz `upsert(onConflict:'customer_user_id')` em
`farmer_client_scores` e é quem efetivamente reatribui o dono".

**Não é.** Medido no repo e em prod:

- o upsert dessa edge só roda sobre a lista `missing` — os clientes **ausentes** de
  `farmer_client_scores`. Cliente já existente nunca passa por ali;
- `apply_score_updates` não toca `farmer_id`
  (`pg_get_functiondef(oid) ~* 'farmer_id\s*='` devolve `false`);
- quem reatribui o dono de um cliente existente é uma **trigger**:
  `trg_carteira_reconcile_score_owner AFTER INSERT OR UPDATE OF owner_user_id ON
  carteira_assignments` → `reconcile_score_owner_from_carteira()`, alimentada pela edge
  `carteira-rebuild` (upsert em `carteira_assignments`).

Corrigir em `calculate-scores` seria **inerte** — e inerte é pior que ausente, porque parece
feito. A decisão que o Codex tomou no #1850 seguiu valendo ("corrija na origem, não na RLS");
o que mudou foi **qual** é a origem.

O guard entrou na fronteira `farmer_client_scores` — a mesma tabela que o `FG009` consulta
para decidir o dono. Gate e invariante passam a olhar a mesma fonte, o guard cobre todos os
caminhos de escrita (a trigger de carteira, o upsert da edge, um backfill colado no SQL
Editor) em vez de N escritores, e **nenhuma policy muda**: trocar `farmer_id` já exige
`cap_carteira_escrever` pelo WITH CHECK de `fcs_update_own_or_gestor`.

## A metade que a trigger sozinha não cobre (challenge Codex desta fatia)

O parecer (gpt-5.6-terra, xhigh) confirmou o lugar e **refutou a suficiência**:

```
T1 RPC do farmer A              T2 reatribuição do cliente C para B
FG009 lê score de C = A
                                UPDATE fcs: C -> B
                                trigger expira as pendentes que EXISTIAM
INSERT da oferta C sob A        (a linha nova nasce depois da varredura)
COMMIT                          COMMIT
```

A oferta nova sobrevive fora de escopo. O advisory lock das RPCs é por **farmer**, e quem
reatribui não o toma. Fechado com `FOR SHARE` nas linhas de score do lote, antes do gate:
se a troca chega antes, ela espera e a trigger alcança a linha nova; se chega depois, a RPC
já lê o dono novo e o `FG009` recusa.

**`FOR SHARE`, não `FOR KEY SHARE`:** um UPDATE que não mexe em chave toma
`FOR NO KEY UPDATE`, que **não** conflita com `FOR KEY SHARE`. O lock mais fraco deixaria a
corrida exatamente como estava — e o teste do caminho feliz seguiria verde.

## Onde a falsificação pagou: o assert que passava pelo motivo errado

O teste de concorrência da zona G nasceu usando o cliente `C1`, que o seed já povoa com
pendentes sob o dono antigo. Ele passava — **e passava também com a sabotagem aplicada**
(Z4 vermelho). O motivo: a RPC de A já tinha dado `UPDATE` nas pendentes de `C1`, e a trigger
da troca esbarrava **nesse row lock das recomendações**, não no lock de score. O assert
media contenção, mas não a contenção que dizia medir.

A correção foi dar à zona G um cliente **sem nenhuma recomendação** (`C4`): aí o único lock
possível é o do score, e a sabotagem passou a ficar vermelha (`TROCA_PASSOU`).

Generalizando — e é a lição que sobrevive a este PR: **falsificar não prova só que o assert
tem dente; prova que ele tem o dente CERTO.** Um assert pode passar dos dois lados por um
efeito colateral do cenário. Sem a falsificação, "a troca esperou" teria sido lido como "o
lock funciona" por tempo indefinido.

Na mesma linha, a própria sabotagem do Z4 começou **sem sabotar**: a extração por regex
terminava em `/^\$function\$;$/`, mas o corpo gerado tem `$function$` e o `;` na linha
seguinte — o range ia até o fim do arquivo e recriava a função **verdadeira**. A falsificação
pintava verde por não ter acontecido. Hoje o harness **prova que removeu** antes de confiar
no resultado (`grep -c` do bloco, e falha explícita se restar).

## Três decisões explícitas, para não virarem descoberta futura

- **A pendente preexistente do dono NOVO sobrevive.** A regra implementada é a fraca ("toda
  pendente é do dono atual"), não a forte ("toda troca invalida toda oferta anterior").
  Precisão > recall: expirar oferta do dono ATUAL destrói trabalho válido, e ela é alcançável
  pelo recálculo dele. A do dono ANTIGO é que não tinha quem a alcançasse.
- **`expired_reason` é coluna, não assinatura inferida.** A primeira versão inferia "foi a
  trigger" de `expired_by_run IS NULL` — verdadeiro hoje (todos os 16.233 expirados de reco e
  os 12 do bundle têm `expired_by_run` preenchido), mas isso é coincidência de dados, não
  contrato: o primeiro outro caminho que expire sem run torna o sensor errado sem nada falhar.
  O `CHECK` fecha o vocabulário — um typo viraria categoria nova e silenciosa.
- **A policy de DELETE de `farmer_client_scores` NÃO foi mexida.** O parecer nota, com razão,
  que `fcs_delete_own_or_gestor` deixa o farmer apagar o próprio score, e que com a trigger
  isso vira autoridade **indireta** de expirar as pendentes daquele cliente. É autoridade por
  efeito, não caminho para ofertar sob outro farmer. Restringir aquela policy é mexer em RLS —
  exatamente o que foi recusado no #1850 — e é outra fatia. Fica dito, não mudado às escondidas.

## O sensor, e por que a validação pós-apply NÃO o usa

`public.farmer_escopo_invariante()` publica, por tabela: `pendentes_total` (denominador
honesto — toda pendente, com ou sem score), `pendentes_dono_divergente`, `pendentes_sem_dono`
(o ponto cego), `violacoes` (a soma), `pct_violacao` e a contagem por motivo de expiração.
O SLO é `violacoes = 0`, não um percentual — uma oferta inválida importa no money-path. E
`pct_violacao` é **NULL** quando não há universo, nunca 0: "não medido" e "medido e limpo"
são estados diferentes.

A validação pós-apply do arquivo, porém, é a **query direta**, não a função. Descoberto
executando: o SQL Editor do Lovable roda **sem JWT**, então `auth.role()`/`auth.uid()` são
NULL ali e o gate fail-closed da função nega — a primeira versão abortava o próprio Run no
último statement, depois de já ter aplicado tudo. A função é para o app (`authenticated` com
`cap_carteira_ler`); para o SQL Editor e para o `psql-ro`, vale a query.

## A prova

`db/test-farmer-troca-dono.sh` — PG17 descartável, migração real aplicada,
**34 asserts** e **4 falsificações**, todas com dente:

| falsificação | o que fica vermelho |
|---|---|
| dropar a trigger de UPDATE | a pendente do dono antigo sobrevive |
| `<>` no lugar de `IS DISTINCT FROM` | o ramo do DELETE não expira **nada** (NULL some no WHERE) |
| tirar o `AND status='pendente'` | o desfecho `aceito` é destruído |
| tirar o `FOR SHARE` das RPCs | a troca não espera — a corrida reabre |

Cobre também o que **não** deve disparar: UPDATE de outra coluna e UPDATE de `farmer_id`
para o mesmo valor. Esse último não é hipótese — `UPDATE OF coluna` dispara **mesmo quando o
valor não muda**, bastando a coluna estar no SET (medido). Sem o `WHEN`, todo re-upsert de
carteira varreria as pendentes de cada cliente à toa.

Dois fatos de PG17 medidos por spike, antes de escrever:

- `WHEN (OLD.x IS DISTINCT FROM NEW.x)` numa trigger `UPDATE OR DELETE` combinada é
  **recusada na criação** ("DELETE trigger's WHEN condition cannot reference NEW values") —
  por isso são duas triggers com uma função;
- em trigger `DELETE`, `NEW.campo` devolve **NULL e não estoura** — ao contrário do que o
  parecer afirmou. O código ramifica por `TG_OP` mesmo assim: depender de detalhe
  não-documentado é apostar, e a aposta valeria "expira tudo" contra "não expira nada".

## Quem responde pela invariante

Esta entrega. O mecanismo é a trigger `trg_fcs_troca_dono_expira_pendentes` /
`trg_fcs_perda_dono_expira_pendentes` mais o `FOR SHARE` das RPCs; o sinal é
`farmer_escopo_invariante()`; a regressão executável é `db/test-farmer-troca-dono.sh`.
Como o sensor é sob demanda (não há cron — `_data_health_compute` é um conjunto acoplado e
ampliá-lo custaria mais do que esta fatia justifica), quem propuser a fase seguinte roda:

```sql
SELECT * FROM public.farmer_escopo_invariante();   -- no app, autenticado com cap_carteira_ler
-- no SQL Editor / psql-ro, a query direta da §8 de db/farmer-troca-dono-expira-pendentes.sql
```

Baseline a bater: `violacoes = 0` nas duas tabelas, com `pendentes_total` > 0 — sem o
denominador, o zero não julga nada.
