# Selo de preço no disparo — "disparado = aprovado" no OMIE (2026-09-06, v4)

> Money-path de compras. Origem: decisão **§8.4 do PR #2187** (spec
> `2026-09-05-selo-aprovacao-pedido-sayerlack-design.md`, branch `claude/frosty-goodall-f12941`), que
> deixou `preco_unitario`/`valor_linha` **fora** das colunas seladas de propósito — o selo de lá
> protege o que o PORTAL recebe. Esta é a outra metade: o que o **Omie** recebe. O Codex registrou o
> desacordo como P2-13 no challenge do desenho v1 do #2187.
> Contexto vivo: `docs/agent/reposicao.md` §Portal Sayerlack, `docs/agent/money-path.md`,
> `docs/historico/portal-sayerlack-fator-aprovado-vs-vivo.md`.
> **Status: desenho aprovado pelo founder em conversa (2026-09-06); implementação EM FILA atrás do
> #2187, que ainda é DRAFT e do qual esta fatia consome infraestrutura (§2).**
>
> 🔴 **CHALLENGE CODEX: "não aprovar"** (2026-09-06). A 1ª tentativa foi barrada por cota (exit 75);
> a janela resetou e a 2ª rodou. Custo: `gpt-6-astra · max · tentativa 2 · 908s · 165.313 tokens`.
> Dois P1 bloqueantes — e o primeiro eu classifico como **P0**, porque derrota o mecanismo por dentro.
> Achados, verificação e o que mudou nesta v3: **§9**. O Caminho B (auto-challenge) que cobria o
> intervalo virou §9.3 — ele tinha achado B1/B2, mas **subdimensionou os dois**.
>
> Esta v3 acata os cinco achados. **Uma decisão do founder segue aberta (§9.2): escopo da quantidade.**

## 1. A invariante — e por que NÃO é igualdade

O enunciado ingênuo — "o preço no PO é o preço da aprovação" — é **literalmente falso no único fluxo
que existe em produção**, e implementá-lo recusaria todo pedido Sayerlack cuja captura de custo
funcionasse.

`sayerlack_aplicar_custo_portal` (migration `20260905090000`) só grava sob CAS
`omie_pedido_compra_numero IS NULL AND status_envio_portal = 'sucesso_portal'`: **por desenho ela roda
depois da aprovação e antes do PO**, trocando a estimativa do motor pelo custo PROVADO do portal. A
ordem real é `aprovar → portal (async) → sucesso_portal → captura de custo → conciliação →
IncluirPedCompra lendo preço fresco`.

A invariante executável é **procedência**, não igualdade:

> Todo `nValUnit` e todo `nQtde` que chegam ao `IncluirPedCompra` foram escritos por uma porta
> **autorizada naquele momento** — motor (pré-aprovação), humano preenchendo custo de 1ª compra
> (preço ausente), ou captura do portal (pós-`sucesso_portal`, pré-PO). Nunca por um UPDATE sem
> procedência. Divergência é recusa do pedido **antes de qualquer efeito no Omie**.

## 2. Dependência do #2187 (esta fatia NÃO é standalone)

⚠️ **O #2187 está EM RECONSTRUÇÃO** (conferido em 2026-09-06, imediatamente antes de abrir este PR):
o Codex reprovou a M1 dele, e a sessão irmã a refez "sobre a main (guard atômico)", ainda marcada
`NÃO PRONTA`. Os cinco símbolos de que esta fatia depende sobrevivem à reconstrução
(`aprovacao_selo`, `reposicao.selo_bypass`, `reposicao_selar_pedido`, `reposicao_selo_itens`,
`p_itens_vistos`), mas **a FORMA do guard mudou** — e é dentro dele que os ramos `SP006`/`SP007` do
§4.5 se enxertam. **Re-conferir §4.5 contra a versão final do guard antes de implementar**; se o
guard atômico não tiver mais o ponto de enxerto que este spec assume, §4.5 é reescrita, não adaptada.

⚠️ **A classe de SQLSTATE `SA` é do #2187 e está se movendo.** Conferido contra a M1 real em
2026-09-06: `SA001` e `SA003`–`SA008` já estão ocupados, e o `SA008` de lá é *'Pedido % mudou de
estado durante a aprovação'* — a v3 deste spec colidia com ele. Por isso os ramos daqui usam a classe
**`SP`**, mesmo vivendo dentro das funções do #2187. **Ao implementar, re-conferir os códigos livres:
esta lista envelhece a cada commit de lá.**

Consome, sem reimplementar: a RPC `aprovar_pedido_sugerido` de 3 args, o trigger de
`pedido_compra_item`, o GUC de bypass (`reposicao.selo_bypass`, honrado só com
`current_user IN ('postgres','service_role')`), `reposicao_selo_itens`, `aprovacao_selo` e
`reposicao_pedido_e_portal`. Acrescenta um ramo ao trigger existente — **não cria um segundo trigger
na mesma tabela**. Se o #2187 for reprovado ou remodelado, este spec é reescrito, não adaptado.

## 3. O que existe hoje (medido em prod via psql-ro, 2026-09-06)

- **Nada do #2187 está aplicado.** `aprovacao_selo` / `portal_recusa_motivo`: 0 colunas.
  `pedido_compra_item`: **0 triggers**. Os 3 triggers de `pedido_compra_sugerido` são outros
  (`trg_analytics_outbox_pedido_compra`, `trg_po_inexistente_antes_de_guard`,
  `trg_set_status_envio_portal`).
- **A janela é 100% Sayerlack.** Dos pedidos com PO no Omie em 120 dias, **123 de 123** são
  OBEN/Sayerlack. Aprovação → PO: p50 **1 min**, p90 **28 min**, máx **20.032 min (~14 dias)**. Não
  existe disparo não-portal nesse recorte — mas o guard é desenhado no `IncluirPedCompra`, que é
  universal, e não no predicado de portal: escopá-lo a Sayerlack deixaria o buraco aberto no dia em
  que um fornecedor não-portal entrar.
- **Escritores de `preco_unitario` / `valor_linha`, auditados:**

  | Writer | Quando | Papel | Freio hoje |
  |---|---|---|---|
  | motor (`gerar_pedidos_sugeridos_ciclo`, `gerar_pedidos_oportunidade_ciclo`, `aplicar_promocoes_no_ciclo`) | INSERT; pedido nasce `pendente_aprovacao` | invoker | pré-aprovação |
  | UI de 1ª compra (`preco-edit.ts` → PostgREST cru) | `pendente_aprovacao` / `bloqueado_guardrail` / `falha_envio`, só se preço ≤ 0 | `authenticated` + `cap_compras_ler` | **só o cliente** |
  | `sayerlack_aplicar_custo_portal` | pós-`sucesso_portal`, pré-PO | `service_role`, CAS no banco | ok, sem rastro selável |
  | `reposicao_persistir_qtde_inteira` | **no disparo, em produção** | SECDEF | reescreve **só `valor_linha`** (`ceil(qtde_final) * preco_unitario`) |

- **Policies de `pedido_compra_item`:** `staff_pedido_compra_item_{select,insert,update,delete}` são
  `cap_compras_ler` por linha, em qualquer status do pai. Qualquer staff de compras altera item por
  `id`. Aba velha fura.
- **`falha_envio` é caminho vivo, não hipótese.** A edge grava em qualquer throw de `processarPedido`
  (`index.ts:1163`), inclusive no guard "SKU(s) sem custo"; o reprocesso aceita
  `["aprovado_aguardando_disparo","falha_envio"]` (`index.ts:1578`). Zero linhas nesse status **hoje**
  é medida de status atual, não de histórico — é estado transitório. **152 itens sem custo em 72
  pedidos** nos últimos 120d: a 1ª compra é comum.
- **A captura de custo está sem sinal.** Deployada em 05/09. Denominador ~10 `sucesso_portal`/semana;
  **1 pedido** com `captura_custo`, e nele `atualizados = 0`. **Não existe tabela de auditoria de
  `pedido_compra_item` nem coluna `atualizado_em`** — não dá para medir retroativamente se algum preço
  já mudou pós-aprovação. Ausência de dado, não aprovação.
- **Um único call site chega ao Omie:** `IncluirPedCompra` em `index.ts:1057`. O segundo `select` de
  itens (`index.ts:1761`) é só o e-mail de notificação, pós-PO.

## 4. Forma

### 4.1 `valor_linha` fica FORA do selo — e por quê

`reposicao_persistir_qtde_inteira` reescreve `valor_linha` no disparo, em produção, pós-aprovação.
Selá-lo criaria uma **quarta porta** e quebraria o selo em todo disparo, ou exigiria um bypass novo
para uma função que não move dinheiro.

E `valor_linha` **nunca chega ao Omie**: o payload é `nValUnit: Number(it.preco_unitario)` e
`nQtde: Math.ceil(Number(it.qtde_final))` (`index.ts:984-985`). É derivado, alimenta `valor_total`
(display + guardrail).

**Decisão: o selo e o ramo do trigger cobrem `preco_unitario` apenas.** O sensor (§4.6) calcula total
por `sum(qtde_final * preco_unitario)`, que não depende de `valor_linha`. Custo aceito: uma escrita
solta em `valor_linha` desloca `valor_total` sem quebrar o selo — é desvio de relatório, não dinheiro
saindo, e o disparo o recomputa.

### 4.2 Estado novo

Em `pedido_compra_sugerido`: `preco_selo text`, `preco_selo_em timestamptz`, `preco_selo_origem text`,
`preco_recusa_motivo text`.

Tabela append-only `reposicao_preco_selo_log(id bigserial, pedido_id bigint, selo text, origem text,
selado_em timestamptz default now(), total_anterior numeric, total_novo numeric, itens_mudados int,
precos jsonb)`.

`precos` guarda o **vetor** `{item_id: preco}` que gerou o selo, não só o hash — sem ele
`itens_mudados` seria indecidível (não se faz diff contra um sha256). É o vetor da linha anterior deste
mesmo pedido que dá o "de → para" por item ao sensor.

**Um escritor só** (`reposicao_selar_preco`) — sinal de money-path não mora em jsonb multi-writer; aqui
o jsonb é aceitável exatamente porque o escritor é único e a tabela é append-only. RLS ligada desde o
nascimento; SELECT para staff de compras; **nenhum** INSERT/UPDATE/DELETE para `anon`/`authenticated`
(REVOKE **por nome** — `REVOKE FROM PUBLIC` não os tira).

Classes de SQLSTATE, cada uma do dono da função: `SA00x` = #2187 (selo do portal), `CP00x` =
`sayerlack_aplicar_custo_portal`, **`SP00x` = este spec**. Os ramos novos dos triggers do #2187 usam
`SP006` (item) e `SP007` (pedido) porque vivem dentro das funções de lá.

### 4.3 `reposicao_selar_preco(p_pedido_id bigint, p_origem text)` — o ÚNICO escritor do selo

**`private.reposicao_selar_preco`** — `SECURITY DEFINER`, `search_path` fixo, **no schema `private`,
que o PostgREST não expõe**. `REVOKE EXECUTE` de `PUBLIC`, `anon`, `authenticated` **e**
`service_role`, por nome. Só o OWNER a executa — ou seja, só as funções-porta (SECDEF, mesmo owner)
do §4.4.

⚠️ **Isto é a correção do P0 do §9.1, e é o coração da v3.** Na v2 ela era chamável por
`authenticated` com `p_origem` livre, o que permitia:
`falha_envio → UPDATE preço 10→100 → reposicao_selar_preco(id,'portal_captura') → reprocessar` —
hash correspondente a 100, recusa limpa, origem falsa, **os dois selos e a comparação do payload
passando**. O selo era forjável pela própria porta que deveria protegê-lo.

Por isso, duas mudanças acopladas — nenhuma das duas basta sozinha:

1. **`p_origem` deixa de ser parâmetro do chamador.** Cada porta passa uma constante que ela própria
   possui. Como só as portas chamam, a origem não é forjável.
2. **Selar e escrever deixam de ser atos separáveis.** Não existe "selar o que já está lá": toda
   porta escreve e sela na MESMA função, na MESMA transação. É o que fecha a variante do Codex
   "`UPDATE preço 10→NULL` e chamar a RPC de 1ª compra com 100" — sem escrita crua não há NULL
   fabricado (§4.5).

Espelha o idioma do `reposicao_selo_itens` do #2187, sobre vetor **disjunto** do dele:

```
encode(sha256(convert_to(jsonb_agg(jsonb_build_array(
  id, trim_scale(preco_unitario)::text
) ORDER BY id)::text, 'UTF8')), 'hex')
```

`jsonb_agg` remove ambiguidade de separador; `NULL` vira `null`; `trim_scale` faz `0,20 ≡ 0,2`.
**Uma implementação, em SQL** — nenhum espelho TS do hash.

Em ordem, numa transação:

1. `p_origem` ∈ `('aprovacao','primeira_compra','portal_captura','backfill_m1','manual_sql')`, senão
   `SP001`.
2. Pedido existe e tem ≥ 1 item, senão `SP002`.
3. Calcula `total_novo = sum(qtde_final * preco_unitario)` e lê `total_anterior` da última linha do log
   (NULL na primeira vez — **ausente ≠ zero**, e o sensor filtra `total_anterior > 0`).
4. `itens_mudados` = itens cujo `trim_scale(preco_unitario)` difere do `precos` da **última linha do
   log deste pedido**; `NULL` quando não há linha anterior (ausente ≠ zero: `NULL` diz "não havia com
   o que comparar", `0` diria "comparei e nada mudou").
5. Grava `preco_selo`, `preco_selo_em = now()`, `preco_selo_origem = p_origem`, e
   **`preco_recusa_motivo = NULL`** (§5.3), sob `SET LOCAL reposicao.selando_preco = <pedido_id>`.
6. `INSERT` no log, com `precos` = o vetor recém-selado.

### 4.4 As três portas — cada uma re-sela na PRÓPRIA transação

| Porta | Quando | Como |
|---|---|---|
| `aprovar_pedido_sugerido` (3 args, do #2187) | aprovação | `PERFORM reposicao_selar_preco(id,'aprovacao')` logo após `reposicao_selar_pedido` |
| `reposicao_definir_custo_primeira_compra(p_pedido_id bigint, p_itens jsonb)` **nova** | `pendente_aprovacao` / `bloqueado_guardrail` / `falha_envio` | valida **no servidor**; re-sela com `'primeira_compra'` |
| `sayerlack_aplicar_custo_portal` | pós-`sucesso_portal`, pré-PO | `SET LOCAL reposicao.selo_bypass='on'` no topo (ela escreve item com o pai em `aprovado_aguardando_disparo`, fora da lista permissiva do §4.5 — e o bypass do #2187 exige o GUC **além** do papel), e `reposicao_selar_preco(id,'portal_captura')` antes do `RETURN`, dentro do CAS que já existe |

`pedido_compra_split` sela os filhos com `reposicao_selar_preco(filho,'aprovacao')` sob o bypass,
junto do que o #2187 §3.5 já faz.

**A 4ª via — founder consertando pelo SQL Editor — não ganha função.** Roda como `postgres`, que o
bypass do #2187 §3.2 já honra, e chama `reposicao_selar_preco(id,'manual_sql')` explicitamente.
Fica no runbook `docs/runbooks/lovable-supabase.md`, não no código.

#### 4.4.1 `reposicao_definir_custo_primeira_compra`

**`SECURITY DEFINER`**, `search_path` fixo, e **põe `SET LOCAL reposicao.selo_bypass='on'` ela
mesma** — porque depois da v3 `authenticated` não escreve preço em NENHUM status pós-aprovação
(§4.5), nem em `falha_envio`. Definer com gate de papel na entrada (`auth.uid() IS NOT NULL AND NOT
staff` → `42501`) substitui a RLS que o invoker daria.
`p_itens = [{item_id, preco_unitario}]`.

1. Pedido `FOR UPDATE`; status ∈ `('pendente_aprovacao','bloqueado_guardrail','falha_envio')`, senão
   `SP003`.
2. Payload: array não vazio, `item_id` inteiro, `preco_unitario` **NOT NULL**, `<> 'NaN'::numeric`,
   `> 0` e `< 'Infinity'::numeric` — os três lados (`'NaN'::numeric` e `'Infinity'::numeric` **passam**
   em `> 0`). Senão `SP004`.
3. Cada item pertence ao pedido **e tem `coalesce(preco_unitario,0) <= 0` agora** — só PREENCHE, nunca
   troca preço bom. `ROW_COUNT <> n` → `SP005` e ROLLBACK de tudo.
4. `valor_linha = ceil(qtde_final) * preco_unitario` para as linhas tocadas, e `valor_total` recomputado.
5. `PERFORM reposicao_selar_preco(p_pedido_id, 'primeira_compra')`.

**Mais estrito que a tela de hoje**, de propósito: hoje uma aba velha em `falha_envio` reescreve
*qualquer* preço; a RPC só deixa preencher ausente. O founder confirmou (2026-09-06) que nunca
precisou corrigir preço válido em `falha_envio`; se precisar, é SQL Editor + `'manual_sql'`.

**UI:** `useDetalhesModal` troca o `update` PostgREST de preço pela RPC.
`podeEditarPrecoPedido`/`precoEditavelDaLinha` continuam como UX, mas deixam de ser o freio.

### 4.5 Trava — ramo `SP006` no trigger do #2187

**Em `pedido_compra_item`** — o trigger `BEFORE INSERT/UPDATE/DELETE` do #2187 hoje deixa preço passar
de propósito (§3.2 de lá). Ganha um segundo ramo: pai **fora** de
`('pendente_aprovacao','bloqueado_guardrail')` e o UPDATE toca `preco_unitario` → `SP006`, **salvo**
sob o bypass `reposicao.selo_bypass` já previsto (GUC **e**
`current_user IN ('postgres','service_role')` — nunca para `authenticated`).

⚠️ **`falha_envio` SAIU da lista permissiva** (era o buraco do §9.1). A lista agora é só
pré-aprovação: depois da aprovação, `authenticated` **não escreve `preco_unitario` em estado nenhum**.
Quem escreve em `falha_envio` é a RPC de 1ª compra, que é SECDEF (§4.4.1).

⚠️ **O ramo de preço autoriza por ESTADO + `current_user`, NÃO por GUC** (mudança da v4). A M1 do
#2187 declara que *"a M2 autoriza por ESTADO, que é mais forte que um GUC"*, e a v3 daqui dependia do
`reposicao.selo_bypass`. Alinhar é melhor por si só: para o P0 do §9.1 o que importa é que
`authenticated` não escreva preço pós-aprovação, e as portas são SECDEF — logo o `current_user` delas
já é o owner. Um GUC a mais seria uma chave a mais para vazar, e ficaria refém do redesenho do #2187.
Efeito colateral desejado: a aba velha do §9.4 tem a escrita **recusada no banco** em vez de aceita
sem selo — o preço continua ≤ 0 e a RPC nova ainda funciona, sem virar intervenção SQL.

O GUC `reposicao.selando_preco` **não** aparece aqui, e isso é desenho: `reposicao_selar_preco` escreve
só em `pedido_compra_sugerido`, nunca em `pedido_compra_item`. Uma exceção para ele no trigger de item
seria porta aberta sem dono.

`falha_envio` fica na lista permissiva porque a RPC de 1ª compra é quem escreve lá — e ela sela.
`reposicao_persistir_qtde_inteira` não toca `preco_unitario`, então não interage com este ramo.

**Em `pedido_compra_sugerido`** — o trigger `BEFORE UPDATE` do #2187 (§3.3 de lá) ganha um ramo:
`preco_selo` / `preco_selo_em` / `preco_selo_origem` só mudam quando
`reposicao.selando_preco = NEW.id`, senão `SP007`. É **aqui** que o GUC trabalha. Note a diferença
para o `aprovacao_selo`, que é imutável depois de gravado: `preco_selo` é *mutável, porém só por uma
porta*.

`preco_recusa_motivo` fica sem guard: quem o grava é a edge (`service_role`) e quem o limpa é
`reposicao_selar_preco`. Um guard ali só criaria uma trava a mais para o mesmo efeito.

**O trigger continua guardando, nunca escrevendo** — a forma que a v2 do #2187 adotou depois do P0 do
Codex.

### 4.6 O sensor — é ele que decide o teto depois

O founder decidiu (2026-09-06): **procedência agora, teto depois, com número medido.** Um limiar hoje
seria chutado — a captura tem 1 pedido de sinal.

```sql
SELECT origem,
       count(*) AS reselos,
       count(*) FILTER (WHERE itens_mudados > 0) AS mudou,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (total_novo-total_anterior)/total_anterior*100)::numeric, 2) AS p50_delta_perc,
       round(max((total_novo-total_anterior)/total_anterior*100)::numeric, 2) AS max_delta_perc
  FROM reposicao_preco_selo_log
 WHERE selado_em > now() - interval '30 days' AND total_anterior > 0
 GROUP BY 1;
```

Denominador ao lado: `sucesso_portal` por semana (hoje ~10). A fatia seguinte ("teto de valor
aprovado") **só nasce com esse número na mão**, com ≥ 4 semanas de `origem='portal_captura'` e
`mudou > 0` — "está no ar e ninguém reclamou" é ausência de dado.

## 5. A fronteira: asserção antes do `IncluirPedCompra`

### 5.1 `reposicao_conferir_disparo_omie(p_pedido_id bigint, p_itens jsonb)`

`RETURNS TABLE(ok boolean, motivo text, divergencias jsonb)`. `STABLE`, `SECURITY INVOKER`,
`search_path` fixo. EXECUTE só para `service_role` (a edge).

Recebe **exatamente o que a edge está prestes a mandar** — `[{item_id, n_val_unit, n_qtde}]`, derivado
do próprio `produtos_incluir`, **não de uma releitura** — e compara em SQL com `IS DISTINCT FROM` sobre
`numeric`. Motivos, em ordem de avaliação (o primeiro que casa vence):

| motivo | condição |
|---|---|
| `preco_selo_ausente` | `preco_selo IS NULL` |

| `preco_selo_divergente` | hash recomputado de `preco_unitario` ≠ `preco_selo` |

| `payload_divergente` | correspondência um-para-um quebrada (abaixo), ou `n_val_unit IS DISTINCT FROM preco_unitario`, ou `n_qtde IS DISTINCT FROM qtde_final` |

⚠️ **A conferência do `aprovacao_selo` SAIU na v4** (decisão §9.2 aplicada). O que fica de quantidade é
só **transporte** — `n_qtde` contra a linha do banco — e isso não tem o beco do §9.2: um transporte
divergente é bug de código da edge, corrigível e reprocessável, não um estado de "fornecedor recebeu e
não há como voltar". A **prevenção** de quantidade continua sendo do #2187 (selo imutável + trigger);
o que fica pendente é só a conferência de fronteira dela, agora chip bloqueado (§10).

**Correspondência um-para-um, não igualdade de conjuntos** (§9.5): `p_itens` tem de ser array válido,
com `item_id` **únicos**, e a **cardinalidade** tem de bater com a contagem de itens do pedido —
`count(*) = count(DISTINCT item_id) = (SELECT count(*) FROM pedido_compra_item WHERE pedido_id = ...)`.
Sem isso, um payload que repete `{id:7, preço:10, qtde:2}` duas vezes mantém o mesmo CONJUNTO de ids,
satisfaz toda comparação individual, e passaria com **quantidade total dobrada**. Não há produtor
dessas duplicatas hoje (o `.map` parte das linhas do banco) — é defeito do CONTRATO da proteção de
transporte, e é o contrato que tem de fechar.

`divergencias` traz o recorte por item, para o log e para o operador.

Três coisas numa chamada:

1. **Procedência do preço** (`preco_selo`) — o que esta fatia acrescenta.
2. **Transporte** — o `Number()` do TS colapsa decimais distintos (P2-12 do Codex no #2187). Comparar o
   valor **enviado** contra o banco é mais estrito que comparar banco-com-banco: se o `Number()`
   deturpar o preço, o PO sairia deturpado e nós saberíamos.

Sobre `n_qtde`: sob o #2187 a `qtde_final` já é canônica (inteira) na aprovação, então
`Math.ceil(Number(qtde_final))` é no-op e a comparação estrita `IS DISTINCT FROM qtde_final` é a certa.
Se **não** for no-op, a recusa é a resposta correta — algo aprovou fração. Isto é conferência de
TRANSPORTE (payload × banco), não de selo: não depende do `aprovacao_selo` e não herda o beco do §9.2.

### 5.2 Onde entra na edge

Colada no único call site (`index.ts:1057`), depois de montar `produtos_incluir`, ao lado do
`lerMarcoPreOmie` que já tem essa disciplina — **com o sinal invertido, e o comentário tem que dizer
por quê**: `lerMarcoPreOmie` é fail-**open** de propósito (perder o marco é melhor que perder o PO);
esta é fail-**closed** — erro da RPC, `ok=false`, ou resposta sem forma esperada = recusa. Degradar é
certo no sensor, errado no que move dinheiro.

O `select` de itens (`index.ts:842`) passa a trazer `id`, para o `item_id` do payload.

**Roda nos DOIS modos.** `dry_run` chama `IncluirPedCompra` incondicionalmente e **cria PO real no
Omie** (`index.ts:454-457`); pular a conferência lá seria o mesmo furo com outro nome.

### 5.3 Na recusa

`throw` com o motivo → o `catch` que já existe grava `falha_envio` (`index.ts:1163`). **Nenhum estado
terminal novo, nenhuma máquina de estados nova.** `preco_recusa_motivo` guarda o motivo.

**Assimetria deliberada em relação ao `portal_recusa_motivo` do #2187, que é imutável:**
`preco_recusa_motivo` é **limpo pelo `reposicao_selar_preco`** (§4.3 passo 5). Divergência de selo do
portal é terminal ("cancele e aguarde o ciclo"); divergência de preço é **recuperável** — o operador
corrige por uma porta autorizada, que re-sela e limpa o motivo, e o reprocesso segue. Sem isso o guard
brickaria o pedido.

**Mas os dois motivos de selo não têm o mesmo desfecho, e a mensagem tem de dizer qual é qual:**

| motivo | recuperação |
|---|---|
| `preco_selo_ausente` / `preco_selo_divergente` / `payload_divergente` (preço) | porta autorizada re-sela e limpa o motivo → reprocessa |
| `payload_divergente` (transporte: `n_qtde` ou `n_val_unit` ≠ banco) | bug de código da edge — corrigir, deployar, reprocessar. Nada a re-selar |

⚠️ **Por que a conferência do `aprovacao_selo` NÃO está aqui (§9.2, decidido na v4).** Ela criaria uma
recusa **sem recuperação**, e essa é a razão de ter saído do escopo. Registrado para quem retomar:
`cancelar_pedido_sugerido` (na própria M1 do #2187) recusa quando
`status_envio_portal IN ('enviando_portal','enviado_portal','sucesso_portal','aceito_portal_sem_protocolo','indeterminado_requer_conciliacao')`
— e `sucesso_portal` é exatamente o estado onde a recusa aconteceria. Resultado: **fornecedor
recebeu, Omie não recebeu, reprocessar repete a recusa, cancelar é negado.** A conciliação também não
reconstrói o selo.

E afrouxar o cancelamento local **seria pior**: ele não cancela a ordem no fornecedor, e um ciclo novo
geraria uma segunda compra com outro identificador — compra em dobro, que é o dano que este spec
existe para evitar. Uma recuperação de verdade precisa tratar a **ordem externa** (cancelamento
confirmado no fornecedor antes de gerar substituto). Preservar a imutabilidade do `aprovacao_selo` é
compatível com isso; **mudar só a mensagem não é.**

Por isso a conferência de selo de quantidade **saiu desta fatia** e virou chip bloqueado (§10). A
prevenção do #2187 (selo imutável + trigger) continua cobrindo quantidade; o que falta é a conferência
de fronteira, e ela não nasce antes da recuperação de ordem externa.

A recuperação do lado do PREÇO também ficou mais estreita na v3, e é honesto dizer: como
`authenticated` não escreve preço pós-aprovação (§4.5), a RPC de 1ª compra só resolve o caso "preço
ausente". Preço válido adulterado só se corrige pelo **SQL Editor** (`postgres`, com o re-selo
explícito). É recuperável pelo founder, não pelo operador.

Para Sayerlack a recusa acontece **depois** de o portal já ter recebido o pedido: o fornecedor tem a
ordem e o Omie não tem o PO. É estado operacional real, e é o **correto** — PO faltando é recuperável
por conciliação; PO com preço errado é dinheiro saindo errado.

## 6. Rollout expandir → ativar (3 camadas manuais; a ordem é a diferença entre nada quebrar e fila presa)

1. **M1 — expandir (nada recusa escrita).** Colunas, `reposicao_preco_selo_log` + RLS,
   `reposicao_selar_preco`, `reposicao_conferir_disparo_omie`,
   `reposicao_definir_custo_primeira_compra`, re-selo dentro de `sayerlack_aplicar_custo_portal`, da
   RPC de aprovação do #2187 e do split. `NOTIFY pgrst, 'reload schema'`; regenerar
   `src/integrations/supabase/types.ts`. `DO $post$` relê o catálogo (existência, SECDEF onde previsto,
   `search_path` preso, `anon`/`authenticated` sem EXECUTE onde previsto).
   **Backfill** de `preco_selo` para pedidos em estado não-terminal, com `origem='backfill_m1'` — hoje
   1 pedido em `aprovado_aguardando_disparo`. Sela o preço que estiver lá: não há como saber se foi
   adulterado, e recusar toda a fila em voo seria pior. A origem `backfill_m1` deixa isso visível no
   log. **Depois do backfill, `NULL` significa "alguém zerou" — e recusar é correto.**
   Pré-voo `pg_get_functiondef` da PROD para toda função recriada (apply manual diverge do repo; a
   última a recriar vence). `CREATE OR REPLACE` preserva ACL; `REVOKE`/`GRANT` reafirmados por nome.
2. **Publish (UI migra para a RPC) + deploy da edge** `disparar-pedidos-aprovados` com a conferência já
   fail-closed. Com M1 aplicada, a edge nova encontra as colunas e a RPC. Com a edge velha ainda no ar
   e M1 aplicada: nada quebra (M1 não recusa nada).
3. **M2 — ativar.** Ramos `SP006` (item) **e `SP007`** (pedido) nos triggers do #2187 — a v2 agendava
   só o `SP006` (§9.4). Pré-condição **medida por query**: zero pedidos em `enviando_portal` e a sonda
   da edge respondendo a versão nova.

   ⚠️ **A ordem mudou na v3, e "Publish" não é o marco.** Publish não fecha aba velha — o SW só troca
   de build quando o cliente clica (CLAUDE.md, 4ª camada). Uma aba antiga em `falha_envio` preencheria
   o custo por PostgREST cru, **sem selar**, e a edge nova recusaria; pior, atualizar a UI depois não
   salvaria — o preço já seria positivo e a RPC nova responderia `SP005` (§9.4). Por isso o ramo
   `SP006` **precisa estar ativo junto com o deploy da edge, não depois dele**: com ele, a escrita da
   aba velha é **recusada no banco** (o preço fica ≤ 0 e a RPC nova ainda resolve) em vez de aceita e
   silenciosamente sem selo. Fail-closed contra cliente velho é o ponto — "zero `enviando_portal` +
   sonda nova" não diz nada sobre abas antigas.
4. **Sensor da fase seguinte:** §4.6.

Deploy da edge decidido por `bun run pendencias:deploy` (ledger `deploy_atestacoes`), não pelo diff do
PR.

## 7. Prova

- **PG17 `db/test-reposicao-preco-selo.sh`** (padrão dos harnesses; `-v ON_ERROR_STOP=1` + marcador
  positivo de fim; asserts negativos casam a **SQLSTATE exata** e re-lançam o resto; cenários humanos
  sob `SET ROLE authenticated` + GUC do JWT). Cobre:
  🔴 **o teste decisivo do §9.1 — `adulterar → tentar legitimar → conferir disparo`:** como
  `authenticated`, (a) UPDATE de preço em `falha_envio` → `SP006`; (b) UPDATE de preço → NULL em
  qualquer status pós-aprovação → `SP006` (fecha a ausência fabricada); (c) chamada direta a
  `private.reposicao_selar_preco` → erro de privilégio; (d) adulterar item A + preencher item B pela
  RPC → a RPC recusa (A não estava ≤ 0) e **nada** é selado; (e) em todos, o disparo seguinte recusa.
  Negar INSERT direto no log NÃO é este teste ·
  aprovação sela · captura do portal re-sela e loga o delta · 1ª compra preenche e re-sela · 1ª compra
  **recusa** item com preço > 0 (`SP005`) · payload com NaN/Infinity/≤0 → `SP004` · status fora da
  lista → `SP003` · origem inválida → `SP001` · UPDATE de `preco_unitario` pós-aprovação por
  `authenticated` → `SP006` · o mesmo UPDATE com `reposicao.selando_preco` posto por `authenticated`
  **não** passa · `reposicao_persistir_qtde_inteira` no disparo **não** quebra o selo (é o teste que
  prova a decisão §4.1) · conferência: `n_val_unit` deturpado → `payload_divergente` · `n_qtde` ≠
  `qtde_final` → `payload_divergente` · preço alterado sem selar → `preco_selo_divergente` ·
  **payload com `item_id` repetido → `payload_divergente`** (o furo de multiplicidade do §9.5, que a
  igualdade de conjuntos deixava passar com quantidade dobrada) · `preco_selo` NULL →
  `preco_selo_ausente` ·
  `preco_recusa_motivo` limpo pelo re-selo · split sela os filhos · hash: ordem por `id`,
  `0,20 ≡ 0,2`, NULL ≠ vazio · UPDATE direto de `preco_selo` sem o GUC → `SP007` ·
  `itens_mudados` é `NULL` no primeiro selo e `0` quando o re-selo não muda preço nenhum (é o par que
  prova "ausente ≠ zero" no sensor) · `authenticated` **não** consegue INSERT direto em
  `reposicao_preco_selo_log`, mas a aprovação humana grava lá pela função.
- **Falsificação uma camada por vez**, com **controle verde na MESMA invocação do laço** (senão a
  suíte sempre-vermelha aprova tudo) e **commit antes** (o `restaurar()` é `git checkout --`):
  remover o ramo `SP006` → o teste do `authenticated` fica vermelho; neutralizar a comparação de
  `n_val_unit` → o teste de transporte fica vermelho; tirar o re-selo de
  `sayerlack_aplicar_custo_portal` → a conferência acusa divergência num caminho **legítimo**;
  devolver `p_origem` ao chamador (ou reconceder EXECUTE a `authenticated` no selador) → o cenário
  (c) do teste decisivo fica vermelho; repor `falha_envio` na lista permissiva → (a) fica vermelho;
  afrouxar o `<= 0` da 1ª compra → o teste de "não troca preço bom" fica vermelho; remover o
  `SET LOCAL reposicao.selo_bypass='on'` de `sayerlack_aplicar_custo_portal` → a captura legítima toma
  `SP006` (prova que o bypass do §4.4 é necessário, não decorativo).
- **Gate da edge — a v2 afirmava um FATO FALSO aqui, corrigido (§9.5).** Eu escrevi que
  `_shared/marco-pre-omie_test.ts` já assere "exatamente 1 call site de `IncluirPedCompra`". **Não
  assere.** O `G3` conta `atribuicoesDaColuna` — atribuições de `omie_po_inexistente_antes_de` —, e o
  Codex executou os 7 testes com um segundo call site inserido: **7/7 verde nos dois casos**. Eu
  afirmei sobre um arquivo que só tinha visto por `grep`. O harness é bom **modelo de estilo** (o `G2`
  tem falsificação embutida), não uma garantia pronta.

  Então o gate **é novo**, e forma sozinha não basta: presença + ordem + ausência de
  `if (modo === 'producao')` são satisfeitas por uma chamada **cuja resposta é ignorada**. O que prova
  a asserção é COMPORTAMENTO:

  - **zero chamadas ao Omie** quando a RPC (a) erra, (b) devolve `ok=false`, (c) devolve vazio,
    (d) devolve formato inválido — **nos DOIS modos** (`producao` e `dry_run`), 8 casos;
  - assert de **contagem** de call sites de `IncluirPedCompra` (que não existia) — é ele, e só ele,
    que sustenta "inescapável";
  - **falsificação removendo a DECISÃO de recusar** (manter a chamada, ignorar o resultado): tem de
    ficar vermelho. Sem essa falsificação o gate é decorativo — é exatamente o defeito que o Codex
    demonstrou executando.

  Onde o gate lê a edge como TEXTO, limpa comentário com o stripper COMPARTILHADO
  (`removerComentarios` de `@/lib/gates/limpeza-fonte`), nunca regex local — a edge tem
  `IncluirPedCompra` em 6 comentários e 1 chamada; um stripper local mediria os comentários.
- **Deno `test:edges`** (`--no-remote`, sem afrouxar o flag), **`edges:typecheck`**, **`sonda:bump`**
  (`VERSAO`) + **`sonda:fingerprint -- --write`** em `disparar-pedidos-aprovados`. Os 5 gates de edge
  não se cobrem.
- **Manifesto de módulos:** arquivo novo em `src/` ganha dono em `src/lib/modulos/manifesto.ts`.
- **`bun run psql:errorstop`**, **`shellcheck`** no harness novo.
- **Codex challenge** (`scripts/codex-async.sh`, background) sobre este spec **antes** de implementar,
  e sobre o PR depois. 🔴 **Tentado em 2026-09-06 e barrado por cota (exit 75)** — ver o bloco de
  status no topo e o Caminho B em §9. É pré-condição da implementação, não do merge deste spec.

## 8. Decisões do founder (2026-09-06, nesta ordem)

1. **Selo próprio + re-selo por porta**, não o selo do #2187 estendido. O selo de lá é imutável por
   construção; este precisa ser reescrito legitimamente até 2x. Fundi-los tornaria mutável o selo cuja
   propriedade central é a imutabilidade. **A §8.4 do #2187 fica intacta — não foi reaberta.**
2. **Procedência agora, teto depois**, com o sensor do §4.6 produzindo o número. Evita a armadilha
   "fase N+1 sem sinal da fase N".
3. **RPC dedicada para a 1ª compra + UI migra** — o gate sai do cliente, e a regra "só preenche
   ausente" passa a ser servidor.
4. **Em fila atrás do #2187.** Não standalone (§2).
5. ~~**Quantidade entra no escopo**~~ → **REVERTIDA na v4 (§9.2).** Entrou porque parecia "quase de
   graça"; o Codex mostrou que a recusa de quantidade **não tem recuperação** (cancelar é negado em
   `sucesso_portal`). Sai a conferência de **selo** de quantidade — vira chip bloqueado no desenho de
   recuperação de ordem externa (§10); fica a de **transporte**, que não tem o beco.
   ⚠️ Aplicado por recomendação minha, na ausência de decisão contrária: a decisão original foi do
   founder, e a reversão é trivial (repor os dois motivos de `aprovacao_selo` na tabela do §5.1) —
   mas então o §9.2 exige desenhar a recuperação de ordem externa junto.

## 9. Revisão independente — challenge Codex (2026-09-06): **não aprovar**

`gpt-6-astra · reasoning max · tentativa 2 · 908s · 165.313 tokens`. A 1ª tentativa saiu com exit 75
(cota); a janela resetou e a 2ª rodou. **Toda alegação factual do parecer foi conferida contra o
código antes de entrar aqui** — parecer de agente não vira spec sem verificação. As cinco estão
acatadas no corpo.

### 9.1 [P0 — eu subo de P1] O re-selo legitimava uma alteração proibida

Como staff `authenticated`:
`falha_envio → UPDATE preço 10→100 → reposicao_selar_preco(id,'portal_captura') → reprocessar`.
O UPDATE passava pela lista permissiva; o selador aceitava chamador e origem sem exigir o CAS da
captura; gravava o hash de 100, limpava a recusa e registrava origem falsa. A quantidade ficava
intacta ⇒ **os dois selos e a comparação do payload passavam**.

Classifico como **P0, não P1**: o mecanismo não era contornado por fora, era **derrotado pela própria
porta que deveria protegê-lo**. Um guard que o atacante pode re-selar não é guard.

E o Codex antecipou a correção incompleta: revogar só a chamada direta não bastaria — sobraria
`UPDATE preço → NULL` + RPC de 1ª compra com o valor novo, porque o `<= 0` validaria a **ausência
fabricada**; e adulterar o item A enquanto se preenche legitimamente o item B faria o re-selo do
pedido inteiro incorporar A.

**Acatado** em §4.3 (selador vai para `private`, sem EXECUTE para ninguém além do owner; `p_origem`
deixa de ser do chamador), §4.4.1 (RPC de 1ª compra vira SECDEF e põe o bypass ela mesma) e §4.5
(`falha_envio` **sai** da lista permissiva — pós-aprovação `authenticated` não escreve preço em estado
nenhum). As três são acopladas; nenhuma resolve sozinha.

**Teste decisivo** (§7): *adulterar → tentar legitimar → conferir disparo*. Negar INSERT direto no log
não prova nada.

### 9.2 [P1] O beco da quantidade — e a decisão que volta para o founder

**Verificado no código:** `cancelar_pedido_sugerido`, na própria M1 do #2187, recusa quando
`status_envio_portal IN ('enviando_portal','enviado_portal','sucesso_portal','aceito_portal_sem_protocolo','indeterminado_requer_conciliacao')`.
A recuperação que a v2 prescrevia ("cancelar + o ciclo regrava") está **bloqueada exatamente no
estado onde seria necessária**.

Meu B1 (§9.3) tinha achado o problema e prescrito a cura errada: **band-aid**. Mudar a mensagem não é
recuperação.

✅ **DECIDIDO na v4: a conferência de selo de quantidade SAI desta fatia.** A quantidade entrou porque
parecia "quase de graça" — cinco linhas de SQL numa RPC que já ia existir. **Não é de graça**: uma
recusa sem recuperação transforma "fornecedor recebeu e Omie não" num estado sem saída.

O que sai: a recomputação de `reposicao_selo_itens` contra `aprovacao_selo` (motivos
`aprovacao_selo_ausente` / `aprovacao_selo_divergente`). **O que FICA: a conferência de transporte**
`n_qtde` contra a linha do banco — ela não tem o beco, porque divergência ali é bug da edge
(corrigir → deployar → reprocessar), não estado externo irreversível.

Descartadas: (b) manter e desenhar a recuperação de ordem externa junto — é outra fatia inteira dentro
desta; (c) manter como alerta não-bloqueante — guard que não recusa, em money-path, é teatro.

### 9.3 O Caminho B (auto-challenge) — e o que ele subdimensionou

Enquanto a cota estava esgotada, auto-desafiei o desenho. Achei **B1** (quantidade sem recuperação) e
**B2** (`valor_total` provado sobrescrito). **Subdimensionei os dois**, e o registro importa mais que
o acerto:

- **B1** eu prescrevi "distinguir na mensagem" — band-aid, porque não conferi se o cancelamento era
  possível (§9.2).
- **B2** eu chamei de "desvio de relatório, não dinheiro". **Errado, e verificado:** o gate de valor
  mínimo lê `pedido.valor_total` (`disparar-pedidos-aprovados/index.ts:358`) **antes** de
  `processarPedido` recomputar. Total adulterado **flipa um gate de dinheiro**. Continua fora de
  escopo — mas pelo motivo CERTO (separação de efeitos: não afeta `nValUnit`/`nQtde`, e não exige
  `valor_linha` no hash), não pelo motivo errado que eu tinha dado. Vira chip com essa nota.
- **B3** (meus descartes) o Codex confirmou: um call site atual, promoção pré-aprovação, sem reenvio
  com protocolo. Mas registrou o que eu não tinha visto: **descarte correto não é recuperação** — nada
  disso destrava o §9.2.

Isto é a evidência de que **auto-revisão não substitui revisão independente**: ela encontrou os dois
sintomas certos e errou o tamanho dos dois.

### 9.4 [P2] O rollout deixava a aba velha de fora, e agendava só metade dos ramos

Publish não fecha aba antiga (o SW só troca de build quando o cliente clica). Sequência furada:
pedido selado com custo ausente → `falha_envio` → **aba velha preenche o custo corretamente** por
PostgREST cru (`useDetalhesModal.ts:170`, verificado) → nenhum re-selo → edge nova recusa. E atualizar
a UI depois **não salvava**: preço já positivo ⇒ a RPC nova responde `SP005`, e a recuperação normal
vira intervenção SQL.

E a §6 agendava só o `SP006`; o `SP007` não estava em etapa nenhuma.

**Acatado** em §6: o `SP006` passa a entrar **junto com o deploy da edge**, não depois — assim a
escrita da aba velha é recusada no banco, o preço fica ≤ 0 e a RPC nova ainda resolve. `SP007`
agendado explicitamente.

### 9.5 [P2] Contrato do payload e uma alegação FALSA minha sobre a prova

**Multiplicidade.** A §5.1 comparava conjuntos de `item_id`. Um payload que repete
`{id:7, preço:10, qtde:2}` mantém o mesmo conjunto e satisfaz toda comparação individual — passaria com
**quantidade total dobrada**. Não há produtor hoje (o `.map` parte das linhas do banco), mas é defeito
do **contrato**, e contrato se fecha no contrato. Acatado em §5.1: array válido, ids únicos,
cardinalidade igual, correspondência um-para-um.

**A alegação falsa.** A v2 dizia que `_shared/marco-pre-omie_test.ts` já asserta "exatamente 1 call
site de `IncluirPedCompra`", e eu usei isso para sustentar que a asserção seria "inescapável".
**Verificado: é falso.** O `G3` conta `atribuicoesDaColuna` — atribuições de
`omie_po_inexistente_antes_de`. O Codex executou os 7 testes com um segundo call site inserido:
**7/7 verde nos dois casos**. Eu afirmei sobre um arquivo que só tinha lido por `grep` — a armadilha
de sempre: recorte não é leitura.

E mesmo com a contagem acrescentada, presença + ordem + ausência de `if (modo === 'producao')` são
satisfeitas por **uma chamada cuja resposta é ignorada**. Acatado em §7: testes comportamentais
exigindo **zero chamadas ao Omie** em erro/`ok=false`/vazio/formato inválido, **nos dois modos**, mais
falsificação que remove a DECISÃO de recusar.

### 9.6 O que o Codex NÃO transformou em achado

- **Hash:** sem colisão estrutural. JSON preserva fronteiras, `ORDER BY id` estabiliza, `trim_scale`
  normaliza escala, NULL ≠ zero, inserção/remoção mudam o vetor. *"O furo principal está em quem pode
  autenticar esse vetor"* — que é o §9.1.
- Ressalva do próprio parecer: a análise das RPCs novas é **de desenho** (elas não existem), e a
  consulta SQL read-only dele falhou por DNS — ele manteve as medições do prompt como fatos. As
  medições são minhas, via `psql-ro`, e estão na §3.

## 10. Fora de escopo (dito, não esquecido)

- 🚧 **Conferência de selo de QUANTIDADE no disparo** — tirada na v4 (§9.2). Bloqueada no desenho de
  **recuperação de ordem externa** (cancelamento confirmado no fornecedor antes de gerar substituto);
  sem ela, a recusa não tem saída. A prevenção do #2187 segue cobrindo quantidade, e a conferência de
  transporte (`n_qtde` × banco) fica nesta fatia.
- **Teto de valor aprovado** ("o portal cobrou mais do que aprovamos"). É a fatia seguinte, e §4.6 diz
  exatamente qual número a destrava.
- **`valor_linha` e `valor_total`** — §4.1 explica por que ficam fora do hash (separação de efeitos:
  não alcançam `nValUnit`/`nQtde`). ⚠️ **Mas o desvio NÃO é "só relatório"**, como a v2 dizia: o gate
  de valor mínimo lê `pedido.valor_total` (`index.ts:358`) antes da recomputação, então total
  adulterado flipa um gate de dinheiro (§9.3). Vira chip próprio, com essa nota — e o chip **não**
  precisa de `valor_linha` no hash.
- **Auditoria de `pedido_compra_item`** (não há `atualizado_em` nem tabela de histórico). O log do selo
  cobre o que importa para esta invariante; auditoria geral da tabela é outra decisão.
- **`conciliar-pedido-portal`** — o #2187 já mexe nela; esta fatia não acrescenta nada lá.
