# Selo de preço no disparo — "disparado = aprovado" no OMIE (2026-09-06, v2)

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
> 🔴 **REVISÃO INDEPENDENTE PENDENTE.** O challenge do Codex sobre este spec foi disparado em
> 2026-09-06 e **não rodou**: `scripts/codex-async.sh` saiu com **exit 75 — cota esgotada** (plano
> declarado `prolite`, que BATE com o ping registrado no cabeçalho do próprio script em 2026-09-05 ⇒
> limite real, não token velho). Custo do consult: `gpt-6-astra · max · tentativa 1 · —s · tokens ?`
> (ausente, não zero — o codex não emitiu rodapé). Acionado o **Caminho B** (`money-path.md` §230):
> validação adversária própria, registrada em §9. **Auto-revisão NÃO substitui revisão
> independente** — ela cobre o intervalo. **Rodar o Codex retroativamente quando a janela resetar,
> ANTES de implementar.**

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
`SA008` (item) e `SA009` (pedido) porque vivem dentro das funções de lá.

### 4.3 `reposicao_selar_preco(p_pedido_id bigint, p_origem text)` — o ÚNICO escritor do selo

**`SECURITY DEFINER`**, `search_path` fixo. Definer e não invoker por uma razão concreta: o log é
fechado a `authenticated` (§4.2), então uma função invoker chamada pela aprovação humana não
conseguiria inserir nele. Definer + EXECUTE gateado é o que mantém "um escritor só" com a tabela
trancada para escrita direta.

Gate de papel na entrada, espelhando `sayerlack_aplicar_custo_portal`:
`auth.uid() IS NOT NULL AND NOT staff` → `42501` (com `service_role` o uid é NULL e passa). O fecho
REAL é o privilégio: `REVOKE EXECUTE` de `anon` **por nome**; `authenticated` mantém EXECUTE (a
aprovação humana precisa), `service_role` também.

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

`SECURITY INVOKER` (a escrita vai sob a RLS do operador, `cap_compras_ler`), `search_path` fixo.
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

### 4.5 Trava — ramo `SA008` no trigger do #2187

**Em `pedido_compra_item`** — o trigger `BEFORE INSERT/UPDATE/DELETE` do #2187 hoje deixa preço passar
de propósito (§3.2 de lá). Ganha um segundo ramo: pai **fora** de
`('pendente_aprovacao','bloqueado_guardrail','falha_envio')` e o UPDATE toca `preco_unitario` →
`SA008`, **salvo** sob o bypass `reposicao.selo_bypass` já previsto (GUC **e**
`current_user IN ('postgres','service_role')` — nunca para `authenticated`).

O GUC `reposicao.selando_preco` **não** aparece aqui, e isso é desenho: `reposicao_selar_preco` escreve
só em `pedido_compra_sugerido`, nunca em `pedido_compra_item`. Uma exceção para ele no trigger de item
seria porta aberta sem dono.

`falha_envio` fica na lista permissiva porque a RPC de 1ª compra é quem escreve lá — e ela sela.
`reposicao_persistir_qtde_inteira` não toca `preco_unitario`, então não interage com este ramo.

**Em `pedido_compra_sugerido`** — o trigger `BEFORE UPDATE` do #2187 (§3.3 de lá) ganha um ramo:
`preco_selo` / `preco_selo_em` / `preco_selo_origem` só mudam quando
`reposicao.selando_preco = NEW.id`, senão `SA009`. É **aqui** que o GUC trabalha. Note a diferença
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
| `aprovacao_selo_ausente` | `aprovacao_selo IS NULL` |
| `preco_selo_divergente` | hash recomputado de `preco_unitario` ≠ `preco_selo` |
| `aprovacao_selo_divergente` | `reposicao_selo_itens(p_pedido_id)` ≠ `aprovacao_selo` |
| `payload_divergente` | conjunto de `item_id` ≠ itens do pedido, ou `n_val_unit IS DISTINCT FROM preco_unitario`, ou `n_qtde IS DISTINCT FROM qtde_final` |

`divergencias` traz o recorte por item, para o log e para o operador.

Três coisas numa chamada:

1. **Procedência do preço** (`preco_selo`) — o que esta fatia acrescenta.
2. **Procedência da quantidade** (`aprovacao_selo`) — o #2187 sela `qtde_final`, mas quem confere é a
   edge do **portal**, pré-Browserless. O lado Omie mandava `nQtde` sem conferir nada. Custa ~5 linhas
   de SQL aqui e nenhuma chamada extra.
3. **Transporte** — o `Number()` do TS colapsa decimais distintos (P2-12 do Codex no #2187). Comparar o
   valor **enviado** contra o banco é mais estrito que comparar banco-com-banco: se o `Number()`
   deturpar o preço, o PO sairia deturpado e nós saberíamos.

Sobre `n_qtde`: sob o #2187 a `qtde_final` já é canônica (inteira) na aprovação, então
`Math.ceil(Number(qtde_final))` é no-op e a comparação estrita `IS DISTINCT FROM qtde_final` é a certa.
Se **não** for no-op, a recusa é a resposta correta — algo aprovou fração.

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
| `aprovacao_selo_ausente` / `aprovacao_selo_divergente` / `payload_divergente` (qtde) | **não há porta** — o `aprovacao_selo` é imutável por construção no #2187, e assim deve ser. Só sai por **cancelar + o ciclo regravar** |

Sem essa distinção na mensagem o operador reprocessa em círculo achando que é transitório (achado
B1 do §9).

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
3. **M2 — ativar.** Ramo `SA008` no trigger do #2187. Pré-condição **medida por query**: zero pedidos
   em `enviando_portal` e a sonda da edge respondendo a versão nova. M2 é a última — aplicá-la com a
   edge velha no ar poria um pedido em `falha_envio` sem motivo legível.
4. **Sensor da fase seguinte:** §4.6.

Deploy da edge decidido por `bun run pendencias:deploy` (ledger `deploy_atestacoes`), não pelo diff do
PR.

## 7. Prova

- **PG17 `db/test-reposicao-preco-selo.sh`** (padrão dos harnesses; `-v ON_ERROR_STOP=1` + marcador
  positivo de fim; asserts negativos casam a **SQLSTATE exata** e re-lançam o resto; cenários humanos
  sob `SET ROLE authenticated` + GUC do JWT). Cobre:
  aprovação sela · captura do portal re-sela e loga o delta · 1ª compra preenche e re-sela · 1ª compra
  **recusa** item com preço > 0 (`SP005`) · payload com NaN/Infinity/≤0 → `SP004` · status fora da
  lista → `SP003` · origem inválida → `SP001` · UPDATE de `preco_unitario` pós-aprovação por
  `authenticated` → `SA008` · o mesmo UPDATE com `reposicao.selando_preco` posto por `authenticated`
  **não** passa · `reposicao_persistir_qtde_inteira` no disparo **não** quebra o selo (é o teste que
  prova a decisão §4.1) · conferência: `n_val_unit` deturpado → `payload_divergente` · `n_qtde` ≠
  `qtde_final` → `payload_divergente` · preço alterado sem selar → `preco_selo_divergente` · qtde
  alterada sem selar → `aprovacao_selo_divergente` · `preco_selo` NULL → `preco_selo_ausente` ·
  `preco_recusa_motivo` limpo pelo re-selo · split sela os filhos · hash: ordem por `id`,
  `0,20 ≡ 0,2`, NULL ≠ vazio · UPDATE direto de `preco_selo` sem o GUC → `SA009` ·
  `itens_mudados` é `NULL` no primeiro selo e `0` quando o re-selo não muda preço nenhum (é o par que
  prova "ausente ≠ zero" no sensor) · `authenticated` **não** consegue INSERT direto em
  `reposicao_preco_selo_log`, mas a aprovação humana grava lá pela função.
- **Falsificação uma camada por vez**, com **controle verde na MESMA invocação do laço** (senão a
  suíte sempre-vermelha aprova tudo) e **commit antes** (o `restaurar()` é `git checkout --`):
  remover o ramo `SA008` → o teste do `authenticated` fica vermelho; neutralizar a comparação de
  `n_val_unit` → o teste de transporte fica vermelho; tirar o re-selo de
  `sayerlack_aplicar_custo_portal` → a conferência acusa divergência num caminho **legítimo**;
  afrouxar o `<= 0` da 1ª compra → o teste de "não troca preço bom" fica vermelho; remover o
  `SET LOCAL reposicao.selo_bypass='on'` de `sayerlack_aplicar_custo_portal` → a captura legítima toma
  `SA008` (prova que o bypass do §4.4 é necessário, não decorativo).
- **Gate de forma da edge — REUSA o harness que já existe.**
  `supabase/functions/_shared/marco-pre-omie_test.ts` já faz exatamente esta forma para o
  `lerMarcoPreOmie`: assere que a leitura vem **antes** do `IncluirPedCompra`, que existe
  **exatamente 1** call site, e traz a falsificação embutida (monta a fonte `invertido` e exige
  vermelho). O novo gate é o **irmão** dele para `reposicao_conferir_disparo_omie`, no mesmo arquivo
  ou ao lado, com a mesma mecânica — não inventar harness novo.
  É o assert "exatamente 1 call site" que sustenta a alegação de que a asserção é **inescapável**:
  sem ele, um segundo `IncluirPedCompra` futuro passaria por fora e nada ficaria vermelho.
  Acrescenta o assert **negativo** "a conferência não está dentro de um ramo `modo === 'producao'`",
  **com falsificação própria** (envolver a chamada em `if (modo === 'producao')` e exigir vermelho) —
  é ele que trava o furo do `dry_run`, e sem falsificar ele é decorativo.
  O gate lê a edge como TEXTO e limpa comentário com o stripper COMPARTILHADO (`removerComentarios` de
  `@/lib/gates/limpeza-fonte`), nunca regex local — a edge tem `IncluirPedCompra` em 6 comentários e
  1 chamada; um stripper local mediria os comentários.
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
5. **Quantidade entra no escopo** (§5.1 item 2): a conferência do disparo cobre os dois selos.

## 9. Caminho B — auto-challenge adversário (2026-09-06)

Substitui NADA; cobre o intervalo até o Codex rodar. Os achados abaixo são meus, contra meu próprio
desenho, e **já estão incorporados no corpo do spec**.

### B1 [P1] Divergência de QUANTIDADE não tem porta de recuperação — e o operador entraria em loop

`preco_selo_divergente` é recuperável: o operador corrige por porta autorizada, que re-sela e limpa o
motivo (§5.3). **`aprovacao_selo_divergente` não é.** O `aprovacao_selo` é imutável por construção no
#2187 — não existe, nem deve existir, porta que o re-sele. Um pedido que caia nesse motivo fica em
`falha_envio` e **nenhuma** ação da tela o destrava; o reprocesso o traz de volta ao mesmo ponto.

Incorporado: §5.3 passa a distinguir os dois desfechos, e a mensagem de recusa tem de dizer qual é
qual — senão o operador reprocessa em círculo achando que é transitório.

### B2 [P2] `persistir_qtde_inteira` sobrescreve o `valor_total` PROVADO do portal

`sayerlack_aplicar_custo_portal` grava `valor_total` = total provado do Efetivar. Na invocação
seguinte do disparo, `reposicao_persistir_qtde_inteira` recomputa
`valor_total = sum(valor_linha)` — descartando o número provado em favor de um derivado. Se o total do
portal incluir qualquer coisa que não seja `Σ preço×qtde` (frete, arredondamento do fornecedor), o
provado é perdido em silêncio.

**Fora do escopo desta fatia** (é bug pré-existente, não regressão do selo, e não afeta o `nValUnit`
que vai ao Omie). Registrado aqui para virar chip. Reforça a §4.1: `valor_linha` e `valor_total` já
são território de um escritor que os trata como derivados.

### B3 — o que investiguei e NÃO virou achado (medido, não presumido)

- **Outro caminho até o Omie?** Não. `grep -rn IncluirPedCompra supabase/functions/` dá **um** call
  site executável (`disparar-pedidos-aprovados/index.ts:1057`); o resto é comentário e teste.
- **Reconciliação cria PO sem passar pela asserção?** Não. Ela **adota** um PO que o Omie diz já
  existir, via `ConsultarPedCompra` — o PO nasceu de uma invocação anterior que passou pela asserção.
- **`aplicar_promocoes_no_ciclo` é porta de preço não coberta?** Não. Filtra
  `status = 'pendente_aprovacao'` (e `IN ('pendente_aprovacao','bloqueado_guardrail')` na reavaliação)
  — é pré-aprovação.
- **Duplo envio ao portal na recusa?** Não. Na 1ª invocação o portal devolve `queued` e
  `processarPedido` retorna **antes** de montar o payload; a asserção só roda na invocação que cria o
  PO, quando o protocolo já existe.

## 10. Fora de escopo (dito, não esquecido)

- **Teto de valor aprovado** ("o portal cobrou mais do que aprovamos"). É a fatia seguinte, e §4.6 diz
  exatamente qual número a destrava.
- **`valor_linha`** — §4.1 explica por que fica fora e qual desvio isso aceita.
- **Auditoria de `pedido_compra_item`** (não há `atualizado_em` nem tabela de histórico). O log do selo
  cobre o que importa para esta invariante; auditoria geral da tabela é outra decisão.
- **`conciliar-pedido-portal`** — o #2187 já mexe nela; esta fatia não acrescenta nada lá.
