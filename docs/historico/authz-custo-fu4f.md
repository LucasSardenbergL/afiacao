# FU4-F — leitura de custo sai do role `employee`

Programa que implementa a decisão do dono (2026-07-19): **"vendedor NÃO deve ver custo"**, fechada no
BANCO e faseada. Ele recusou explicitamente a opção "esconder na UI" — o dado continuaria trafegando e
visível no DevTools.

Ancora em `private.cap_custo_ler` / `private.cap_compras_ler`, criadas pelo
[#1434](https://github.com/LucasSardenbergL/afiacao/pull/1434) (E2/FU4, contrato v2).

## Estado em produção (2026-07-21)

| superfície | estado | PR |
|---|---|---|
| `inventory_position` (2 policies) + view operacional | ✅ fechada | [#1473](https://github.com/LucasSardenbergL/afiacao/pull/1473) |
| `cmc_snapshot` | ✅ fechada | [#1465](https://github.com/LucasSardenbergL/afiacao/pull/1465) |
| `get_tint_price` / `get_tint_prices` | ✅ gate em `cap_custo_ler` | #1465 |
| `pedido_compra_item` (4 policies) | ✅ fechada em `cap_compras_ler` | [#1485](https://github.com/LucasSardenbergL/afiacao/pull/1485) |
| `regua_preco_log` | ⚠️ ABERTA **por decisão** — mesmo subsistema da régua | — |
| `product_costs` | ⚠️ ABERTA — espelho do CMC, fase 3 | #1495/#1498 (margem no servidor) |
| `get_regua_preco` / `_customer360` | ⚠️ devolve `cmc` cru | sem dono |

**O custo NÃO está fechado.** O programa reduziu superfície: tirou o número das telas e fechou as
portas diretas. Quem quiser reconstruir ainda consegue (espelho + oráculo, abaixo).

## População real (o que dimensiona tudo)

| app_role | commercial_role | pessoas |
|---|---|---|
| customer | — | 5.664 |
| **employee** | **farmer** | **2** |
| master | — / master | 2 |

`cap_custo_ler` = `master OR (employee AND commercial_role IN ('estrategico','super_admin'))`.
Como **ninguém tem** `estrategico`/`super_admin`, ela concede a **0 employees** — é master-only *por
coincidência da população*, não por desenho. ⚠️ **Dívida aberta:** se a regra "vendedor não vê custo" é
permanente, a função não a codifica — basta alguém ganhar `estrategico` para reabrir.

## Lições

### 1. Fechar a tabela-fonte não fecha o dado quando existe ESPELHO

`product_costs.cmc` é uma **cópia** de `inventory_position.cmc`, escrita pela edge
`omie-analytics-sync/index.ts:1227` — **2.987 linhas casavam exatamente** em prod. Com `product_id` na
view operacional, o contorno é um JOIN de uma linha:

```sql
SELECT o.omie_codigo_produto, c.cmc
  FROM inventory_position_operacional o
  JOIN product_costs c ON c.product_id = o.product_id;
```

O fechamento do #1473 foi apresentado como "o farmer não lê custo por QUALQUER porta" até a revisão
adversária do Codex apontar o espelho. A alegação era **falsa** e o PR foi reescrito como hardening.

⇒ **Antes de alegar que um dado está fechado, procure as CÓPIAS** — `grep` pela coluna no
`supabase/functions/` (quem ESCREVE o espelho) + `information_schema.columns` por nome de coluna
similar. Fechar a origem enquanto a réplica segue aberta é teatro com custo de regressão real.

### 2. Policies permissivas combinam com **OR** — fechar uma não fecha nada

`inventory_position` tinha DUAS: `Staff can manage inventory` (**FOR ALL**, cobre SELECT) e
`staff_inventory_position_select`. Trocar só a `_select` deixaria o vendedor lendo pela outra —
**fechamento fantasma**, que passa em qualquer teste que só exercite a policy trocada.

⇒ `SELECT count(*) FROM pg_policies WHERE tablename='X'` **antes** de escrever, e o assert de catálogo
tem de checar o **total** (`= N`), não só quantas têm a expressão nova: uma 3ª policy `USING (true)`
futura conviveria com o pós-check verde.

### 3. Tabela OPERACIONAL fecha as 4 policies; tabela de LOG basta o SELECT

As 9 irmãs de compras do #1434 são `reposicao_*_log` (só leitura). `pedido_compra_item` é operacional —
o frontend apaga itens. Fechar só o SELECT produziria um employee que **não pode ver** o preço mas
**ainda pode apagar** o item. A falsificação F2 do harness prova isso executando.

### 4. `pedido_compra_item` escapou por NOME, não por decisão

O #1434 varreu o domínio pelo padrão `reposicao_*_log` e fechou 9 tabelas. A 10ª, do mesmo domínio e com
`preco_unitario`, não casa com o padrão de nome e ficou aberta — sem registro de decisão em lugar nenhum.

⇒ **Varredura por padrão de nome tem ponto cego estrutural.** Feche por DOMÍNIO (as colunas sensíveis:
`ILIKE '%custo%' OR '%cmc%' OR '%preco%'` em `information_schema.columns`), depois confira contra a lista
de nomes — não o contrário.

### 5. Assert com `ok` nos dois ramos — a variante do teste sem dente

O F3 do harness da fase 2 era:

```sh
if [ "$F3" = "0" ] || [ "$F3" = "2" ]; then ok "..."
else ok "anon barrado por outro motivo"; fi     # ← AMBOS chamam ok
```

Erro/timeout/resposta inesperada pintavam verde. **O assert nunca podia falhar.** Achado do Codex;
passou pela minha própria revisão. Corrigido ancorando em `has_table_privilege` (booleano, não confunde
"negado" com "deu ruim").

⇒ Irmã da lição já registrada em `money-path.md` ("o ALVO mente"): aqui não é a sentinela que casa
sozinha, é o **ramo de fallback que também aprova**. Reler todo `if/else` de assert procurando `ok` nos
dois lados.

### 6. `CREATE OR REPLACE VIEW` NÃO remove coluna — refutação medida de uma sugestão do Codex

Ele sugeriu trocar `DROP`+`CREATE` por `CREATE OR REPLACE` (o DROP falha se surgir dependente). Testado
no PG17: quebra com **`cannot drop columns from view`** — um REPLACE só *acrescenta* coluna no fim.

⇒ Numa view cuja propriedade crítica é a **projeção exata** (allowlist sem custo), o REPLACE é PIOR: se
alguém adicionasse `cmc`, a migration perderia a capacidade de removê-la ao reaplicar e o vazamento
sobreviveria ao próprio conserto. O DROP falha **alto e visível**; o REPLACE falharia **baixo**.
Parecer adversário é insumo, não veredito — medir ainda decide.

### 7. `FOUND` mente após `PERFORM`; use `GET DIAGNOSTICS ROW_COUNT`

Assert de "o farmer não escreve" acusou escrita indevida. Causa: o `PERFORM set_config(...)` anterior
seta `FOUND=true`, e um `EXECUTE` dinâmico não o redefine de forma confiável — o teste lia o `FOUND` do
`PERFORM`, não o do `UPDATE`.

### 8. Comparar prod contra o diff de um PR **draft** produz diagnóstico falso

Afirmei que a fase 1 tinha sido "aplicada pela metade" porque prod não batia com o que li do #1465. O
diff que eu tinha lido era o do **draft**, às 12:26; entre aquilo e o merge, a outra sessão **encolheu o
escopo** (tirou `regua_preco_log`, que é do subsistema da régua). A migration foi aplicada inteira e
correta.

⇒ Ao validar prod contra um PR, reler **o que mergeou** (`gh pr view --json files`, `git show
origin/main:<arquivo>`), nunca o diff lido horas antes. O nome do arquivo também muda: eu procurei
`20260723120000_..._fase1.sql` e o mergeado era `20260723140000_..._fase1.sql`.

### 9. Colisão de timestamp entre sessões paralelas

A fase 1 e a 2b mergearam com **`20260723140000` idêntico** — o aviso clássico de migrations paralelas.
Não quebrou (objetos disjuntos e desempate alfabético determinístico), mas se colidirem em timestamp
**e** objeto, a última a rodar vence em silêncio. `bun run wt:preflight` pega o caso de objeto; o de
timestamp só aparece olhando `git ls-tree origin/main supabase/migrations/`.

### 10. `information_schema` mente sob `claude_ro` — e o grep de policy também

`role_table_grants` retornou zero linhas para uma tabela com ACL normal (a view filtra pelo privilégio de
quem pergunta — já em `database.md` §5). A variante nova: **grep de policy pela capability errada**.
`reposicao_param_auto_log` pareceu aberta porque filtrei por `cap_custo_ler` e ela usa `cap_compras_ler`
— falso alarme desfeito ao ler o `qual` real. Case por `%cap\_%`, ou leia a expressão.

## Limite honesto herdado do #1465

`get_preco_cockpit` mascara o número mas continua sendo **oráculo por bisseção**: o caller escolhe o
preço e lê a faixa; ~20 chamadas reconstroem um CMC entre R$ 0 e R$ 10 mil com precisão de centavos, e o
limite de 200 itens permite atacar 200 SKUs em paralelo. Foi **conscientemente aceito** — fechar o
oráculo custaria o sinal, que é a ferramenta de venda. Barreira de conveniência, não de segurança;
contra alguém competente e mal-intencionado a barreira real é contrato e offboarding.

## Por que a régua não fecha como o resto

| | recebe o preço? | quem calcula o sinal | mascarar `cmc` mata o sinal? |
|---|---|---|---|
| `get_preco_cockpit(jsonb)` | ✅ | **servidor** (manda `faixa` pronta) | ❌ não |
| `get_regua_preco(customer, product, qty)` | ❌ | **cliente** (`calcPisoMC`) | ✅ **sim** |

`calcPisoMC(null, …)` devolve `null` corretamente (sem fabricar zero — `regua-preco-helpers.ts:27`), mas
então `abaixoPiso = false` e o sinal `'piso'` **nunca dispara**. Replicar o `v_pode_num` do cockpit —
como o #1465 previu — mataria o SINAL junto com o NÚMERO, contrariando "o número fecha, o sinal fica".

⇒ Preservar o sinal exige mudar a **assinatura** da RPC (receber o preço) e o contrato com o motor do
cliente. PR próprio, ainda sem dono.

## Provas executáveis

- `db/test-authz-custo-fu4f-fase1.sh` (#1465)
- `db/test-authz-custo-fu4f-fase2.sh` — 27 asserts, 4 falsificações. O assert **`L1` falha de propósito
  quando `product_costs` for fechada**: é o lembrete executável do limite. Ao fechar a fase 3, **corrija
  o assert** (não reverta o fix) e atualize a seção "limite honesto" da migration `20260723130000`.
- `db/test-authz-pedido-compra-item.sh` — 15 asserts, 3 falsificações.
