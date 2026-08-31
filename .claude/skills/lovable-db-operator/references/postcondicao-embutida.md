# Postcondição embutida — a migration que se recusa a terminar em silêncio

A **query de validação** (Passo 4) só funciona se alguém *lembrar* de rodá-la. A **postcondição
embutida** é um bloco `DO $post$` no fim do próprio SQL que relê o catálogo e dá `RAISE EXCEPTION`
se o objeto não existir — ou existir em estado insuficiente. Ela roda no mesmo Run de quem colou,
então **uma migration que não pegou não tem como terminar em silêncio**: ela aborta na cara do
founder, com o motivo escrito.

É defesa em profundidade contra exatamente a falha que esta skill existe para pegar, e custa
algumas linhas no fim do arquivo. **Migration custom de objeto que importa sai com postcondição.**

Já em uso no repo (9 migrations). O exemplo mais didático é
`supabase/migrations/20260829081556_sales_orders_hash_omie_canonico.sql`.

---

## 1. A moldura transacional — o que a postcondição garante, e sob qual condição

Duas propriedades diferentes, que se costuma confundir:

- **Alarde (incondicional).** O erro sobe, o Run fica vermelho, o exit é ≠ 0. Vale em qualquer
  moldura. *É o valor principal, e ele nunca depende de configuração.*
- **Atomicidade (condicional).** O DDL anterior ser desfeito depende de como o script foi enviado.

Medido em PG17.10 local, mesma migration (constraint criada `NOT VALID` + postcondição que exige
`convalidated`):

| Moldura do arquivo | exit | O DDL sobrevive à falha? |
|---|---|---|
| `psql -f`, **sem** `BEGIN;/COMMIT;` | 3 | **SIM — estado parcial fica no banco** |
| uma única string (simple-query), sem `BEGIN;` | 1 | não (transação implícita desfaz) |
| **`BEGIN; … COMMIT;` explícito** | 3 | não |

> **Regra:** envolva a migration em `BEGIN; … COMMIT;` explícito. É a única forma de o **arquivo**
> garantir a atomicidade por si — sem depender de o cliente mandar tudo numa string só. Sem o
> wrapper, a postcondição continua gritando (o que já é a maior parte do ganho), mas pode gritar
> **sobre um estado meio-aplicado**.
>
> O exemplo canônico (`20260829081556`) **não** tem o wrapper — copie dele a lógica do assert,
> não a moldura. As outras (`…_b_cleanup_dups_oben`, `…_fecha_product_costs`,
> `…_afinidade_colunas_reaplica`) trazem `BEGIN;/COMMIT;` e são o modelo da moldura.

**A exceção que não tem conserto:** `CREATE INDEX CONCURRENTLY` **não roda dentro de bloco de
transação** (medido: `ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block`).
Nesse caso a atomicidade é impossível por construção — a postcondição só pode gritar. É justamente
por isso que o índice concorrente precisa do assert de `indisvalid` (§3): um build que falha
**deixa o índice inválido para trás**, existindo e não servindo para nada.

---

## 2. A forma invariante

O que não varia nas 9 migrations:

1. **Vem por último**, depois de todo o DDL.
2. **Relê o catálogo** (`pg_constraint`, `pg_policies`, `pg_class`, `information_schema`) — não
   confia no DDL que acabou de rodar. É testemunha independente dentro da transação.
3. **Assert numerado** (`A1`, `A2`, …) — quando o founder cola o erro no chat, o número diz
   exatamente qual invariante caiu.
4. **A mensagem diz a CONSEQUÊNCIA, não só o fato.** `'A3 FALHOU: authenticated ainda tem TRUNCATE
   (nao passa por RLS — apagaria os 7.966 SKUs)'` — quem lê entende o risco sem abrir o arquivo.
5. **Checa existência E suficiência.** Nunca só `EXISTS`.
6. **`RAISE NOTICE` de sucesso** no fim, resumindo o estado provado.

```sql
DO $post$
DECLARE v_n int;
BEGIN
  -- A1: <invariante em uma linha>
  SELECT count(*) INTO v_n FROM <catálogo> WHERE <predicado de suficiência>;
  IF v_n <> <esperado> THEN
    RAISE EXCEPTION 'A1 FALHOU: <o que está errado> — <a consequência real>';
  END IF;

  RAISE NOTICE '<resumo do estado provado>';
END
$post$;
```

---

## 3. Templates por tipo de objeto — **reaproveite o catálogo, não duplique**

> **A conversão é mecânica:** o predicado da postcondição é **o mesmo** da query de validação de
> `references/validation-queries.md`, invertido. Onde a validação faz
> `CASE WHEN EXISTS (…) THEN '✅' ELSE '❌' END`, a postcondição faz
> `IF NOT EXISTS (…) THEN RAISE EXCEPTION …`. Pegue o predicado de lá; aqui fica só o que a
> validação read-only **não** cobre: o critério de *suficiência* de cada tipo.

### "Existe" não é "vale" — o critério por tipo

| Objeto | Existir não basta; exija também | Por que |
|---|---|---|
| **Constraint** | `convalidated` | `NOT VALID` "existe" sem provar nada sobre o acervo: vale só para escrita nova, com o passivo invisível |
| **Índice** | `indisvalid` (e `indisready`) | build concorrente que falhou deixa índice inválido: existe, não é usado pelo planner, e ainda pesa na escrita |
| **View** | `security_invoker=on` em `reloptions` | `CREATE OR REPLACE VIEW` **sem repetir** a opção a **RESETA** (medido) → a view passa a ler como OWNER e bypassa RLS. Falha ABERTA que o CI não vê |
| **Função** | corpo novo presente (`pg_get_functiondef`) | `CREATE OR REPLACE` numa função que já existia: `EXISTS` passa mesmo que nada tenha sido aplicado |
| **Policy** | as **antigas sumiram** + contagem exata | policies permissivas combinam com `OR`: sobrando a antiga, o gate não fechou |
| **Privilégio** | `has_table_privilege` nos dois sentidos | `TRUNCATE` **não passa por RLS**; e tirar o `SELECT` demais faz o gate virar tautologia |
| **Coluna** | tipo certo **e `column_default IS NULL`** | default constante vira "valor medido" para toda linha histórica — é fabricar dado (`ausente ≠ zero`) |
| **RLS** | `pg_class.relrowsecurity` | policy escrita numa tabela com RLS desligada é decoração |

### Constraint — `convalidated` (o canônico)

```sql
DO $post$
DECLARE v_existe boolean; v_validada boolean;
BEGIN
  SELECT true, convalidated INTO v_existe, v_validada
  FROM pg_constraint
  WHERE conrelid = 'public.<tabela>'::regclass AND conname = '<constraint>';

  IF NOT coalesce(v_existe, false) THEN
    RAISE EXCEPTION 'postcondicao: <constraint> NAO foi criada';
  END IF;
  IF NOT coalesce(v_validada, false) THEN
    RAISE EXCEPTION 'postcondicao: <constraint> existe mas NAO esta validada';
  END IF;
END
$post$;
```

### View — a opção que o `REPLACE` apaga

```sql
IF NOT EXISTS (
  SELECT 1 FROM pg_class WHERE relname = '<view>' AND relkind = 'v'
    AND 'security_invoker=on' = ANY(coalesce(reloptions, '{}'))
) THEN
  RAISE EXCEPTION 'A1 FALHOU: <view> perdeu security_invoker=on (leria como OWNER, bypassando RLS)';
END IF;
```

⚠️ `security_invoker=off` **também é desenho** em algumas views (view-gate `selfservice_*`) — ver
`docs/agent/database.md` §4. Asserte o valor que **aquela** view deve ter, não `on` por reflexo.

### Índice — `indisvalid`

```sql
IF NOT EXISTS (
  SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE c.relname = '<indice>' AND i.indisvalid
) THEN
  RAISE EXCEPTION 'A1 FALHOU: <indice> ausente ou INVALIDO (build concorrente falhou)';
END IF;
```

### Função — corpo novo, ancorado no que o fix INTRODUZIU

```sql
v_src := pg_get_functiondef(to_regprocedure('private.<funcao>()'));
IF v_src NOT LIKE '%<identificador que só o corpo novo tem>%' THEN
  RAISE EXCEPTION 'A1 FALHOU: <funcao> sem o corpo novo — o REPLACE nao pegou';
END IF;
```

⚠️ **Ancore na PRESENÇA do código novo, nunca na AUSÊNCIA do texto antigo** — `pg_get_functiondef`
devolve o corpo **com os comentários**, e um fix bem documentado costuma citar o nome errado ao
explicar o bug (mordeu no #1357). Detalhe em `validation-queries.md` §"`CREATE OR REPLACE` de
função: 'existe' não é validação", que também explica por que **a validação forte de função é por
EXECUÇÃO**. O grep no corpo prova que *o REPLACE pegou*; ele **não** prova que a função *funciona*.
São coisas diferentes e a postcondição só entrega a primeira.

### Policy + privilégio — o gate fechou dos dois lados

```sql
-- A1: as antigas sumiram (permissivas combinam com OR)
IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
           AND tablename='<tabela>' AND policyname IN ('<antiga 1>','<antiga 2>')) THEN
  RAISE EXCEPTION 'A1 FALHOU: policy antiga sobreviveu — o gate nao fechou';
END IF;

-- A2: TRUNCATE não passa por RLS
IF has_table_privilege('authenticated','public.<tabela>','TRUNCATE') THEN
  RAISE EXCEPTION 'A2 FALHOU: authenticated ainda tem TRUNCATE (nao passa por RLS)';
END IF;

-- A3: controle POSITIVO — sem SELECT, a policy nunca é exercida e o gate vira tautologia
IF NOT has_table_privilege('authenticated','public.<tabela>','SELECT') THEN
  RAISE EXCEPTION 'A3 FALHOU: authenticated perdeu SELECT — o gate viraria tautologia';
END IF;

-- A4: o writer legítimo não pode ter sido atingido
IF NOT has_table_privilege('service_role','public.<tabela>','INSERT') THEN
  RAISE EXCEPTION 'A4 FALHOU: service_role perdeu INSERT — o sync quebraria';
END IF;
```

### Dado (cleanup / backfill) — o invariante, não a contagem de linhas tocadas

```sql
SELECT count(*) INTO d FROM ( <a consulta que acha o que NÃO pode mais existir> ) x;
IF d > 0 THEN
  RAISE EXCEPTION 'Cleanup postcondition FALHOU: % grupo(s) ainda duplicado(s)', d;
END IF;
RAISE NOTICE 'Cleanup postcondition OK: 0 residuais';
```

---

## 4. Assert por EXECUÇÃO — e as três formas de virar teatro

Ler o catálogo prova a *forma*. Quando o que importa é o **comportamento**, execute — mas
`CHECK (x > 0)` se lê como proteção e **aceita `NaN`** (`'NaN' > 0` é TRUE em `numeric`). Só
executando se sabe:

```sql
BEGIN
  UPDATE public.<tabela> SET <coluna> = 'NaN'::numeric WHERE id = v_id;
  RAISE EXCEPTION 'A7 FALHOU: o CHECK aceitou NaN (lideraria todo ORDER BY DESC)';
EXCEPTION
  WHEN check_violation THEN NULL;  -- 23514: exatamente o esperado
END;
```

1. **Capture a SQLSTATE esperada, nunca `WHEN OTHERS`.** `WHEN OTHERS THEN NULL` engole justamente
   o erro que revelaria o defeito — vira teatro (regra da skill `prove-sql-money-path`).
2. **O assert precisa ALCANÇAR a constraint sob teste.** A v1 da migration de afinidade
   (`20260725121000`) **morreu em produção** por isso: o `INSERT` mínimo bateu em `23502`
   (`NOT NULL` de `farmer_id`/`customer_user_id`) **antes** de chegar ao CHECK, o handler só
   capturava `check_violation`, e o `23502` derrubou a migration inteira. A v2 trocou por `UPDATE`
   de linha existente; a reaplicação (`20260814160441`) preencheu as colunas obrigatórias
   explicitamente. Falhar pelo motivo errado esconde o defeito real.
3. **Ponha um controle POSITIVO.** Um CHECK que recusasse **tudo** passaria em todos os asserts
   negativos e mataria a gravação do motor. Prove que um valor **válido** ainda entra:

```sql
UPDATE public.<tabela> SET <coluna> = 0.0094 WHERE id = v_id;
IF NOT EXISTS (SELECT 1 FROM public.<tabela> WHERE id = v_id AND <coluna> = 0.0094) THEN
  RAISE EXCEPTION 'A9 FALHOU: o CHECK recusou um valor VALIDO — o motor nao gravaria';
END IF;
UPDATE public.<tabela> SET <coluna> = NULL WHERE id = v_id;  -- não inventa dado
```

Assert que muta **restaura o estado** no fim (a migration não fabrica dado), e trata a tabela vazia
com `RAISE NOTICE '… PULADO: tabela vazia'` em vez de falhar.

---

## 5. O que a postcondição NÃO substitui

Ela prova **o estado ao fim da transação do apply**. Só isso. Ela **não** prova:

- **Que o founder colou o bloco certo.** Um paste parcial que corte o `DO $post$` roda o DDL e
  não assere nada — e o Run fica verde. A postcondição não pode se auto-verificar.
- **Que o objeto continua lá depois.** Um `DROP` posterior, um "Changes" do sync bidirecional do
  Lovable, ou outra migration paralela recriando por cima (a última a recriar **vence**) desfazem
  o estado provado. A prova tem validade no instante do commit, não daí em diante.
- **Que a mudança está em PRODUÇÃO.** Prova o banco, e banco é só **uma** das 3 camadas manuais do
  Lovable — Publish e edge continuam pendentes (`docs/agent/deploy.md`).
- **Que a lógica está certa.** `pg_get_functiondef` casando o corpo novo prova que o REPLACE pegou,
  não que a função devolve o número certo. Isso é `prove-sql-money-path` / execução com dado real.
- **Nada, se ninguém ler o vermelho.** Ela converte falha silenciosa em falha ruidosa; alguém ainda
  precisa reagir ao ruído.

> **A validação por `psql-ro` do Passo 4 continua obrigatória.** Ela é a **segunda testemunha,
> independente**: outra conexão, outra sessão, depois do commit, rodada por mim e não pelo founder.
> A postcondição fecha a janela "rodou e não pegou"; a validação fecha "não rodou", "rodou pela
> metade" e "pegou e alguém desfez". Uma não substitui a outra — e a postcondição, por estar
> **dentro** do que se quer verificar, é a mais fácil de enganar.
