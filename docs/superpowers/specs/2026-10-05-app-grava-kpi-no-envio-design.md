# A venda empurrada entra no universo canônico no ENVIO — o trigger deriva o kpi da linha do app

> Money-path (positivação/receita/ranking). Medido na prod via `psql-ro` em 2026-10-05. Decisões do
> founder na sessão de 2026-10-05. Antecedente: [spec dos gêmeos](2026-10-01-gemeos-push-pull-contagem-unica-design.md)
> §8 e [histórico](../../historico/gemeos-push-pull-contagem-unica.md) ("O que o PR do kpi do app precisa").

## 1. O problema

Desde `20261001100001` (aplicada em 2026-10-05) os gêmeos push/pull de `sales_orders` contam 1× no
universo canônico (só `order_date_kpi`): a linha IMPORTADA é a autoridade e a linha do APP vira recibo
(`order_date_kpi` NULL + `gemeo_importado_id`). Mas nenhum escritor do app grava `order_date_kpi`: a
venda que o app empurra ao Omie só entra no universo quando o importador traz a gêmea (~2 h, cron por
conta) — e a que nunca volta fica fora para sempre. Esta entrega faz a linha do app nascer com o kpi
no envio, sem reabrir a contagem dupla (a trava do índice único continua valendo).

## 2. Medição (prod, 2026-10-05)

| | valor |
|---|---|
| linhas do app (hash nulo) | 28: 25 `enviado` com pid+ponteiro e **sem** kpi · 1 `cancelado` com pid e kpi (`4c19af2a`) · 1 `orcamento` · 1 `rascunho` |
| linhas com hash não-`omie_` | **0** |
| empurradas por mês (criação, SP) | 23 abr · 2 jun · 1 ago — **nenhuma desde 08/08** |
| linhas do app com pid, sem gêmeo e sem kpi (candidatas a backfill) | **0** |
| `created_by` da linha do app | employee 13 · master 13 (1 delas é o próprio cliente: o `4c19af2a`) |
| `created_by` da importada gêmea | employee 25; igual ao do app em 7/25 |
| importadas válidas de set+out por `created_by` | **100% numa farmer** (589 pedidos, R$ 592.547,12) — `LIMIT 1` do importador |
| pares de mesmo cliente / total diverge | 22 / 5 (app R$ 12.592,16 × importada R$ 13.896,16; maior diferença R$ 640,90) |
| dia de SP da criação do app = kpi (dInc) da importada | **25/25** |
| corpo vivo dos 3 triggers dos gêmeos | md5 = repo (`cc036077…`, `8ad53e39…`, `b510c447…`) |
| corpo vivo de `_data_health_compute` | md5 `5ae67f7e…` = o "depois" da `20261005150000` |
| servidor | PG 17.6 · `TimeZone=UTC` · READ COMMITTED |
| SELECT de `authenticated` em `sales_orders` | `hash_payload`, `created_by`, `status`, kpi e pid: sim · `gemeo_importado_id`, `omie_payload`, `omie_response`, `omie_reconciliado_em`: **não** |

## 3. Premissas da tarefa que mudaram

1. **O `4c19af2a` já está `cancelado`** (desde 01/10 08:02 UTC, provavelmente pelo `how_to_fix` do
   sensor). Tem kpi do backfill de 25/05 e sai pelo status. Não há backfill a fazer.
2. **O write-back é UM só** — `omie-vendas-sync` `criarPedidoVenda` (`index.ts:2259-2270`): UPDATE
   `{omie_pedido_id, omie_numero_pedido, omie_payload, omie_response, status:'enviado'}` por id+conta,
   exigindo 1 linha. Os 4 caminhos convergem nele: balcão oben/colacor (`submitOrder.ts`), conversão de
   orçamento (`SalesQuotes.tsx:145`), pedido programado (`pedido-programado-enviar`). Nenhum escritor
   de `src/` grava pid, hash ou kpi.
3. **O ranking não atribui por vendedor:** o importador grava `created_by` = o primeiro
   `profiles.is_employee` (`LIMIT 1` sem ordem, `index.ts:1116-1124`). A linha do app tem o `created_by`
   correto pela régua do card ("quem lançou"); a importada carrega o artefato. A "migração" que se
   temia é de uma atribuição certa para uma fabricada.
4. **O `'rascunho'` do `SalesQuotes` esconde a venda:** `'rascunho'` está em `STATUS_NAO_VENDA`, e o
   sensor de órfã também o ignora. A lista de orçamentos já filtra `status='orcamento'` (`:64`), então
   o `'enviado'` da edge basta para tirar a linha dela.

## 4. Decisões

| # | decisão | escolha |
|---|---|---|
| D1 | atribuição no ranking enquanto a importada não chega | **"Sem vendedor atribuído"** — o ranking por vendedor não muda, o total do card bate com a receita MTD, nenhuma venda pula entre dois vendedores com nome. A atribuição real vira chip ("Corrigir atribuição de vendas importadas (LIMIT 1 do importador)") (founder) |
| D2 | quem grava o kpi | **o trigger deriva no envio** (abordagem A; B = a edge grava; C = view canônica) (founder) |
| D3 | detalhes técnicos (§5) | delegados à sessão (founder: "decida você") |
| D4 | 2ª opinião | cota do Codex em **89%** (teto 85%) até **09/10 19:30** → Caminho B no desenho (§7) + PR **DRAFT** até o adversarial no diff |
| D5 | aplicação | a sessão aplica via `bun run db:aplicar` depois do Codex, e valida por `psql-ro` |

## 5. Desenho

### 5.1 Migration A — o trigger deriva o kpi no envio

`sales_orders_gemeo_app_derivar()` (o trigger `BEFORE INSERT OR UPDATE OF omie_pedido_id, account,
hash_payload, order_date_kpi, gemeo_importado_id … WHEN (NEW.hash_payload IS NULL)`, que hoje só zera o
kpi quando a importada existe) ganha um ramo. Os triggers em si não mudam.

```sql
  NEW.gemeo_importado_id := v_gemeo;
  IF v_gemeo IS NOT NULL THEN
    NEW.order_date_kpi := NULL;                          -- como hoje: a importada é a venda
  ELSIF NEW.order_date_kpi IS NULL THEN
    -- ENVIO = a linha que não tinha pedido Omie e passa a ter (write-back), ou que já nasce com ele
    IF TG_OP = 'INSERT' THEN v_envio := true; ELSE v_envio := OLD.omie_pedido_id IS NULL; END IF;
    IF v_envio AND NOT EXISTS (SELECT 1 FROM public.sales_orders o
                                WHERE o.account = NEW.account AND o.omie_pedido_id = NEW.omie_pedido_id
                                  AND o.order_date_kpi IS NOT NULL AND o.id <> NEW.id) THEN
      NEW.order_date_kpi := (public.sales_orders_instante_envio() AT TIME ZONE 'America/Sao_Paulo')::date;
    END IF;
  END IF;
```

- **Regra 1 por construção:** o write-back atual já lista `omie_pedido_id`; o kpi nasce no MESMO UPDATE.
  Nenhum escritor TS/edge muda para o kpi.
- **Só no envio:** o UPDATE do `_importada_antes` (que zera o kpi do app antes de a importada entrar) não
  é envio (`OLD.omie_pedido_id` não é nulo) e não re-deriva — se re-derivasse, o índice único barraria a
  importada (23505, spike S9).
- **Preenche só se vazio:** kpi explícito (restauração, SQL manual) é respeitado.
- **Outra linha do mesmo pedido com kpi → não deriva:** uma 2ª linha do app no mesmo `(account, pid)`
  (só por SQL manual: o `cCodIntPed = 'PV_<id>'` é por linha) faria o write-back cair em 23505 depois de
  o Omie aceitar. Sob o advisory lock da chave, sem corrida.
- **Status não entra:** quem decide se conta é o filtro dos consumidores (4 status).
- **Nenhum lock novo:** a ordem é a de hoje — o S9 segue sendo o único deadlock, e nenhum escritor novo
  faz UPDATE posterior nas colunas observadas.
- **Sem backfill:** §2 (0 candidatas).

### 5.2 A costura do relógio

`public.sales_orders_instante_envio()` = `SELECT pg_catalog.statement_timestamp()` (SQL, `STABLE`,
INVOKER). É a chegada do UPDATE do write-back, antes de qualquer espera de lock; `now()` seria o início
da transação e `clock_timestamp()` incluiria a espera. A função existe para a prova trocá-la por um
instante fixo: só assim "SP, nunca UTC" é provado em qualquer hora (com o relógio real, um `'UTC'` por
engano só apareceria entre 21h e 0h — e a prod roda com `TimeZone=UTC`, então `::date` puro erraria
3 h por dia). `REVOKE` de `PUBLIC`/`anon`/`authenticated` nas duas funções.

**Forma da migration (sem `BEGIN/COMMIT`; o `db:aplicar` fornece a transação):** PRE com identidade por
md5 (corpo vivo = o da `20261001100001`, `cc036077…`, ou o desta; outro aborta; `ALTER FUNCTION … SET
search_path` com o mesmo valor trava a linha de `pg_proc` antes de ler) → costura → `CREATE OR REPLACE`
da função → `REVOKE` → postcondição (`RAISE EXCEPTION`): 0 pedido com 2 kpi; ponteiro ⇔ gêmeo; 0
ponteiro com kpi; 3 triggers ligados + 3 índices + 2 CHECKs; md5 dos corpos = os desta; ACL medido
(`has_function_privilege`, 4 funções × 3 papéis = 0).

### 5.3 Front

- **Ranking (D1):** `fetchPedidosMTD` passa a selecionar `hash_payload`; `montarRanking` só credita
  `created_by` em linha com hash `omie_` (a importada); linha do app → "Sem vendedor atribuído". Inerte
  até o apply (hoje 0 linhas do app com kpi e status de venda).
  **Atualização 2026-10-06:** saiu desta entrega — o founder decidiu que o ranking atribui pelo dono da
  carteira do cliente (entrega `claude/atribuicao-vendas-importadas`), o que dá à linha do app e à
  importada o mesmo dono. Ver [o diário](../../historico/app-grava-kpi-no-envio.md).
- **`SalesQuotes.convertToOrder`:** sai o `.update({ status: 'rascunho' })` pós-sucesso; ficam o
  `invalidateQueries` e o toast. O `GRANT UPDATE (status)` de `authenticated` fica: bundle antigo ainda
  o usa, e sem ele o cliente antigo veria erro depois de um envio que deu certo.

### 5.4 Migration B — o texto do sensor

O `probable_cause` de `vendas_empurradas_sem_gemeo` diz que, enquanto o gêmeo não chega, "a venda fica
fora da positivação … que a linha do app criada desde 25/05 não tem" — falso depois da A. E o comentário
do bloco no corpo diz o mesmo. Migration B = o corpo da `20261005150000` com **exatamente essas 2
trocas** (`CREATE OR REPLACE` completo, idioma das migrations de data health): PRE (md5 vivo = `5ae67f7e…`
ou o desta), `REVOKE` nomeado como na v2, POS (md5 = o desta; ACL). A detecção não muda (a prova exige que
desfazer as 2 trocas devolva o md5 da v2). Arquivo separado: falha independente da A.

Texto novo do `probable_cause` (fim): "Enquanto o gêmeo não chega a venda conta pela linha do app (valor e
cliente do app, sem a confirmação do Omie), na positivação ao vivo e no congelado se o mês fechar assim;
cancelada no Omie, ela segue contando até a linha do app ser marcada cancelado."

### 5.5 Ordem de deploy

Publish do front (founder) → o cliente do founder atualiza (o card do ranking é do Master) → apply A
(`--ensaio`, depois real) → validação por fora → apply B → validação por fora. Nenhuma edge.

## 6. Prova (`prove-sql-money-path`)

**A** — `db/test-sales-orders-kpi-no-envio.sh` (PG17 descartável, migrations REAIS `20261001100001` + A,
RPC real `criar_pedidos_com_itens`, trigger de coerência da prod):
write-back sem gêmeo deriva o dia de SP (costura em 06/10 01:30Z → 05/10; bordas 02:59:59Z/03:00Z) ·
import depois do push (RPC real: inserted, app sem kpi + ponteiro, receita canônica = total da importada,
1 linha) · push depois do import (não deriva) · INSERT já com pid (deriva; com gêmeo, ponteiro) · kpi
explícito respeitado · UPDATE sem transição não deriva · 2ª linha do mesmo pedido (sem 23505) · DELETE da
importada não re-deriva; reimport refaz o ponteiro · orçamento/rascunho intactos · mesmo pid em contas
diferentes · a costura de prod é `statement_timestamp()` (DO com `pg_sleep`; > `now()` em transação de
vários comandos) · corrida nos 2 sentidos (bandeira + `pg_stat_activity`) · invariante final · ACL ·
reaplicar = no-op · PRE recusa corpo desconhecido · POS com dente.
Sabotagens (uma camada por vez, cada uma declarando o assert que a acusa): sem derivação · fuso UTC · sem
condição de envio · sobrescreve kpi explícito · sem guarda da outra linha · costura com `clock_timestamp()`
· PRE sem identidade · POS sem dente · sem REVOKE. Rodada em `LC_ALL=C` e `pt_BR.UTF-8`.

**B** — `db/test-data-health-venda-empurrada-conta-pelo-app.sh`: instala o corpo da v2 (bloco extraído do
arquivo; plpgsql é late-bound) e aplica B: md5 esperado · desfazer as 2 trocas = md5 da v2 · texto novo
presente e velho ausente · PRE recusa corpo desconhecido · reaplicar = no-op · ACL. Sabotagens: troca
extra (limiar) · PRE sem identidade · POS sem dente · sem REVOKE.

As duas entram em `db/nucleo-ci.txt` com `falsificar=<n>`. **TS (vitest):** `montarRanking` (linha do app
→ não atribuído; importada → vendedor; hash não-`omie_` → não atribuído), falsificado; `SalesQuotes` sem a
regravação.

## 7. Caminho B — auto-revisão adversária (REVISÃO INDEPENDENTE PENDENTE)

O Codex não foi consultado no desenho (`SALDO_ALTO` 89%). Esta seção é a validação própria, com o que
foi EXECUTADO num PG17 descartável (spike S1–S9, fora do repo) — não substitui o adversarial no diff.

**RÉGUA:**
- *Unidade decisória:* a VENDA = pedido Omie `(account, omie_pedido_id)`; data = `order_date_kpi` (dia
  de SP do envio na linha do app; dInc na importada); valor = `total` da ÚNICA linha do pedido com kpi.
- *Onde o sistema a expõe:* positivação ao vivo (`get_minha_positivacao`), congelado
  (`carteira-positivacao-snapshot`), MTD e ranking (`fetchPedidosMTD` → `useTeamKpis`/`useTeamRanking`),
  vendas do dia (`useVendasZone`), Customer 360 12m, histórico de compras, recência/score, último pedido,
  sensor `vendas_empurradas_sem_gemeo`.
- *Denominador:* 26 empurradas (25 com gêmeo, 1 cancelada); 0 candidatas a backfill; push ~0/mês desde
  08/08; ranking: 2 vendedores reconhecidos, 100% da importada numa farmer.
- *Como a prova falsifica:* §6 — cada camada sabotada sozinha avermelha o assert que declara.
- *Ordem irreversível:* §5.5. Nenhum DELETE, nenhum backfill, congelados intocados.

**Premissas atacadas e o que as sustenta (spike):**

| premissa | evidência |
|---|---|
| o corpo vivo é o do repo (o PRE por md5 não barra o apply legítimo) | S1: md5 dos 3 triggers no PG17 = prod |
| o dia é o de SP, e o `::date` puro erraria na prod | S2: 06/10 01:30Z → 05/10; `'UTC'` e `::date` (sessão UTC) → 06/10 |
| o import depois do push não re-deriva | S3: RPC real `inserted=1`; app `nulo|ptr`; importada com o dInc |
| a condição de envio é a camada que segura o import | S9: sem ela, `failed=1`/23505 e o app segue contando |
| push depois do import não deriva | S4: `nulo|ptr` |
| INSERT com pid deriva; kpi explícito fica | S5 |
| UPDATE sem transição não deriva | S6 |
| a 2ª linha do mesmo pedido não quebra o write-back | S7: OK, só a 1ª com kpi |
| a costura é fixa no statement | S8 (o psql manda vários comandos de um `-c` numa mensagem só — a prova usa arquivo) |
| o dia de SP do envio é a régua do Omie | §2: 25/25 |

## 8. Riscos aceitos e limites

1. **Órfã conta pelo app.** A venda que nunca volta (cancelada/excluída direto no Omie, cliente não
   resolvido) passa a contar com o valor e o cliente do app até alguém agir — antes não contava. É o
   pedido do founder; a defesa é o sensor (stale em 6 h, broken em 6 dias), cujo texto a B corrige.
2. **Valor da janela:** até a importada chegar conta o `total` do app (5/22 pares divergem, até R$ 640,90).
3. **Meia-noite:** envio que cruza a meia-noite de SP entre o `IncluirPedido` e o write-back (segundos)
   dá ao app o dia seguinte ao dInc; o import corrige.
4. **DELETE de importada** deixa a linha do app sem kpi (não re-deriva) até o reimport. Nenhum caminho de
   prod apaga importada.
5. **Empurrada antes do apply** não ganha kpi (hoje 0).
6. **Bundle velho:** o `SalesQuotes` antigo segue regravando `'rascunho'` (= o comportamento de hoje: a
   venda conta quando a importada chega); o ranking antigo creditaria a linha do app ao `created_by` —
   por isso Publish e atualização do cliente do founder antes do apply.
7. Herdados da `20261001100001`: S9 (UPDATE posterior nas colunas observadas × import → 40P01, sem
   duplicata), REPEATABLE READ, triggers da importada só de INSERT.
8. **Congelado:** venda na janela no fechamento do mês entra no snapshot pelo app.

## 9. Fora do escopo

- A atribuição real do ranking (chip "Corrigir atribuição de vendas importadas (LIMIT 1 do importador)").
- Fase 2 (uma linha por venda) e a erradicação dos 12 consumidores por `created_at`/`COALESCE` (chips existentes).
- Revogar o `GRANT UPDATE (status)` de `authenticated`.
- Reconciliar órfã automaticamente.

## 10. Pronto quando

- [ ] spec e plano revisados;
- [ ] migrations A e B + provas (verdes, falsificadas nos 2 locales) + front + docs no PR **DRAFT**;
- [ ] Codex adversarial no diff (≥ 09/10 19:30), achados tratados; revisão final com contexto novo;
- [ ] Publish do front (founder) e o cliente do founder atualizado;
- [ ] apply A e B via `db:aplicar`, postcondição verde; validação externa `psql-ro`;
- [ ] histórico em `docs/historico/` e bullet do `database.md` §5 atualizados.

Camadas de deploy: **2 migrations** (a sessão) + **Publish** do front (founder). Nenhuma edge.
