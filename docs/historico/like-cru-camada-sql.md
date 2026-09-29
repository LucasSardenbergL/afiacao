# pattern-like-cru na camada SQL — o helper, as 7 RPCs e o gate das migrations (2026-09-29)

> Fecha a classe `pattern-like-cru` (B2 da [varredura semgrep de 2026-09-27](varredura-semgrep-2026-09-27.md))
> na camada que o semgrep não lê e o ESLint não vê: as funções SQL. A camada supabase-js de `src/`
> fechou no #2627. Migration `20260929000234_padrao_like_contem_escapa_curinga.sql`, prova
> `db/test-padrao-like-contem.sh`, gate `scripts/like-cru-em-migrations-gate.ts`.

## A classe

O pattern de `LIKE`/`ILIKE` é INTERPRETADO: `%` e `_` do termo viram curinga, `\` vira escape, e o
termo vazio vira `%%`, que casa tudo. Quando o valor devia casar LITERAL (código de fornecedor, termo
de busca, texto-alvo de tarefa), `AB_12` casa `AB-12` e `ABX12`, e o termo `%` devolve a tabela.

## O censo (PROD, psql-ro, 2026-09-28)

A assinatura herdada do #2627 (`prosrc ~* '\mi?like\s+[^\n;]{0,90}?(\|\||concat\s*\()'`, em
`public`/`private`) devolveu 9 funções, e **não discriminava**: casava também o `buscar_skus_candidatos`,
que era o "já-correto". Foi ampliada antes de virar veredito:

- **lado direito não-literal** em vez de "tem `||` perto": achou `reposicao_alerta_pedido_minimo_tick`
  (`ILIKE v_fornecedor`, sem concatenação), que a assinatura original não via;
- **todo schema não-sistema** e o operador `~~`/`~~*`/`SIMILAR TO`: só apareceu código da plataforma
  (`storage.*`, `realtime.*`);
- **o que não é função**: views, matviews, policies, `cron.job`, CHECK e índices. Deu 0, salvo as 4
  policies de `farmer_algorithm_config` com `LIKE 'margem!_faixa!_%' ESCAPE '!'`, que são literal
  constante. O `pg_get_expr` deparseia o `ESCAPE` como `like_escape(...)`.

| site | origem do valor | o que o LIKE decide | veredito |
|---|---|---|---|
| `listar_skus_por_codigo_fornecedor` | parâmetro (código do fornecedor) | quais SKUs são variantes do código | **afetado** |
| `resolver_sku_por_codigo_fornecedor` (3×) | parâmetro, vindo da IA da `promocao-extrair-via-vision` | único / ambíguo / não encontrado | **afetado** |
| `expandir_promocao_item(bigint,numeric)` | coluna `sku_codigo_fornecedor` | qual SKU é AUTO-CONFIRMADO no item | **afetado** (mesma classe: a intenção é literal) |
| `melhoria_clientes_por_produto`, `melhoria_produtos_relacionados` (2× cada) | parâmetro, vindo da LLM da triagem | os 5 produtos "casados" | **afetado**: `%%%` passa no piso de 3 caracteres |
| `tarefas_matcher_tick` | coluna `target_texto` | a EVIDÊNCIA da sugestão ("Mencionou na ligação: X") | **afetado**: `target_texto = ''` inventa menção |
| `buscar_skus_candidatos` | parâmetro (array de termos) | candidatos a SKU do boletim | **afetado no degenerado**: escapava o curinga, mas o termo `''`/`' '` virava `%%`/`% %` |
| `radar_atribuir_tarefa` | parâmetro | dedupe da tarefa por CNPJ | falso-positivo: `p_cnpj !~ '^[0-9]{14}$'` → RAISE antes |
| `radar_contagem_por_municipio` | parâmetro | prefixo de CNAE | falso-positivo: `!~ '^[0-9]{1,7}$'` → RAISE antes (a premissa "a RPC não se defende" era do repo antigo) |
| `reposicao_alerta_pedido_minimo_tick` | `company_config` chave `…_fornecedor_ilike` | fornecedor do alerta | falso-positivo: é pattern POR CONTRATO (`%SAYERLACK%`, só master escreve) |
| `_data_health_compute` | — | — | falso-positivo: LIKE em comentário e num literal de rótulo |

Dado vivo: 0 códigos de fornecedor com `%`/`_`/`\` (151 itens), 0 tarefas com `target_texto`, 0
chamadas registradas da tool de dados da triagem. Era brecha latente, e o conserto não muda nenhum
resultado atual. A RLS de `omie_products` (staff) e a falta de SELECT para `anon` fazem o curinga não
escalar acesso nas RPCs *invoker*: o dano é de correção (SKU errado confirmado), não de vazamento.

## O idioma: helper, não a cadeia de `replace()`

`private.padrao_like_contem(text)` devolve `'%' || <termo com \, % e _ escapados> || '%'`, ou **NULL**
quando o termo não tem conteúdo útil: nulo, vazio, só espaço/tab/quebra, só curinga. `x ILIKE NULL`
é NULL e o WHERE descarta a linha. O degenerado vira "nenhum resultado" por construção, o espelho
exato do `ilikeContainsPattern` (`null` ⇒ sem busca). Uso:
`col ILIKE private.padrao_like_contem(t) ESCAPE '\'`.

O motivo de ser helper, e não a cadeia inline do modelo: **a cadeia fecha um dos dois modos da classe
e deixa o outro aberto.** O `buscar_skus_candidatos` escapava o curinga com perfeição e, com um termo
`''` no array, devolvia 100 produtos arbitrários. Caller que usa o helper não tem como esquecer a
guarda do vazio. `IMMUTABLE STRICT`, `search_path` vazio, e EXECUTE para PUBLIC de propósito: é função
pura, e as 3 invoker que o chamam são executáveis por PUBLIC em prod (inclusive o papel
`sandbox_exec` do Lovable). ACL mais estreita quebraria quem hoje as chama.

## A migration

O corpo de cada uma das 7 é o `pg_get_functiondef` de PROD, com só a linha do LIKE trocada. Foi gerado
por script com contagem exata por troca e **autocalibrado**: o texto extraído reproduz o md5 de prod
medido antes da troca. PRE e POS seguem a `20260927195430`:

- **PRE:** função a função, trava a linha (`ALTER … SET search_path = <o mesmo>`) e exige que a trava
  tenha sido no-op (config antes = depois = esperada). Depois exige md5 EXATO ∈ {prod medido, este
  corpo}. Ausente aborta.
- **POS:** o helper é EXECUTADO (degenerado → NULL, escape exato, casa o literal e não o curinga,
  EXECUTE para PUBLIC). Depois, por função: nº exato de sítios helper+`ESCAPE`, nenhum pattern cru, md5
  novo e, por fim, SECURITY/volatilidade/`search_path`/dono e o ACL (fechada sem `anon`,
  `authenticated`/`service_role` com EXECUTE), que é a marca de um DROP+CREATE no caminho.

`listar_skus` e os dois `expandir_promocao_item` **nunca tiveram CREATE commitado**: só existiam em
prod e no `schema-snapshot`. Esta migration é a primeira definição versionada de `listar_skus` e do
overload `(bigint,numeric)`, e a partir dela o `deriva:corpo:prod` passa a vigiá-los.

**Coordenação multi-sessão.** A sessão da classe "hoje da sessão UTC" recriava
`melhoria_clientes_por_produto` na `20260929001651`, e o `wt:preflight` acusou 🔴. As PREs de md5 dos
dois lados fariam a segunda a aplicar abortar (fail-closed), mas uma das duas ficaria bloqueada.
Acordo: a outra sessão tirou a função da leva dela, e esta migration leva também as 3 trocas de fuso
(`so.created_at::date` ×2 e `current_date` ×1, agora no fuso de SP), com o dente na prova (A8/F26).

## A prova (`db/test-padrao-like-contem.sh`, PG17)

Sobe o `schema-snapshot` com os corpos de PROD como predecessores. 6 dos 7 vêm do snapshot, que bate
md5 a md5 com prod; `melhoria_clientes` vem da `20260905225613`, aplicada depois do dump. O ACL é o de
prod, nos papéis que a POS confere. **59 asserts**:

- **C1-C7:** cada predecessor = prod, md5 exato.
- **A1-A8:** anti-vacuidade. Nos predecessores a semente REPRODUZ o bug (curinga, degenerado e fuso),
  senão os negativos depois do fix passariam por vacuidade.
- **M1-M10:** a migration em transação única, como o `db:aplicar`. Recusa corpo estranho (e o
  preserva), função ausente e trava não-no-op. Trava a linha (2 conexões, barreira observada, com
  controle). A POS pega DROP+CREATE, corpo editado sem o md5, helper sem o degenerado e helper sem
  escape. Aplica e é idempotente.
- **H1-H5:** o helper, inclusive a propriedade "todo termo útil casa o próprio texto" sobre 300
  strings aleatórias de um alfabeto com os 3 metacaracteres.
- **F1-F26:** as 7 funções depois do fix: o literal casa, o curinga não, o degenerado não casa nada, o
  gate de staff continua, e `ultima_compra` sob sessão UTC sai com a data de SP.

`--falsificar`: controle verde na mesma invocação e **19 sabotagens**, cada uma exigindo vermelho por
RESULTADO nos asserts declarados e verde nos declarados. Nos 2 locales (`HARNESS_LC=C` e
`pt_BR.UTF-8`). Entra no núcleo de CI (`db/nucleo-ci.txt`).

## O gate (`scripts/like-cru-em-migrations-gate.ts`)

O lexer é o compartilhado `tokensSql` (scan.l do PG17): literal é token opaco, então um `LIKE` dentro
de `'…'` não conta, e o dollar-quote é re-tokenizado por dentro. O operando da direita é lido como o
parser o lê: cadeia ligada por operador que não é de comparação, com casts de várias palavras, grupos,
chamadas e `ANY/ALL`. Passa só **literal constante** ou **`private.padrao_like_contem(…) ESCAPE '\'`**.
`~~` e `SIMILAR TO` só aceitam literal.

Dois universos: (1) o TEXTO de toda migration, com baseline EXATA de 16 trechos/22 ocorrências das
definições que o repo não pode reescrever (só encolhe: novo reprova, sumido reprova); (2) os CORPOS
VIVOS (`modelarRepo`), onde nenhum sítio passa, salvo 3 falso-positivos com **âncora**: a validação a
montante que os torna seguros tem de continuar no corpo, senão reprova. Calibração nos arquivos
reais: sem a `20260929000234`, os 5 corpos vivos do repo voltam a ser os crus e acusam os 9 sítios; com
ela, 0. Os corpos de prod de `listar_skus`/`expandir` (do snapshot) acusam. 25 mutações em
`scripts/mutcheck.d/like-cru-em-migrations.mut`.

**Limites declarados** (a detecção manual é a query de censo do §5 do `database.md`): função que só
existe em prod (criada pelo SQL Editor), SQL montado em string (`EXECUTE '…'`), corpo vivo fora de
`public`, e o pattern montado antes, numa variável (reprova no LIKE, mas a baseline guarda o LIKE).

## Achados laterais (fora desta classe — reportados, não corrigidos)

- **`tarefas_matcher_tick`:** SECURITY DEFINER com EXECUTE para `authenticated` e **sem gate** no
  corpo. Qualquer usuário logado, cliente inclusive, dispara o tick via `/rpc`: fecha tarefas,
  cria/expira sugestões e roda a varredura pesada. Hoje só o cron chama (0 callers em `src/` e nas
  edges), então `REVOKE EXECUTE … FROM authenticated` seria seguro.
- **`expandir_promocao_item` está quebrado em prod por 2 defeitos independentes.** (1) A chamada de 1
  argumento, que é a que o front faz em `AdminReposicaoPromocaoDetail.tsx`, é **ambígua**: `42725 is
  not unique`, porque existem `(bigint)` e `(bigint, numeric DEFAULT 0.5)`. As expansões automáticas
  param em 2026-05-13, e depois só há `manual_confirmado`. (2) O overload `(bigint,numeric)` chama
  `similarity()` sem qualificar, com `search_path = public, pg_temp`, e o `pg_trgm` mora em
  `extensions`: **42883 no PARSE**. Isso quebra o ramo de similaridade (0 variantes) **e o laço de
  expansão** (≥2 variantes), porque o `CASE` do laço cita `similarity()` na mesma consulta e o parse
  resolve a chamada até no ramo não tomado. Medido em prod:
  `SET search_path = public, pg_temp; EXPLAIN SELECT CASE WHEN false THEN similarity('a','b') > 0.5 ELSE true END`
  → 42883. Só o caminho "único" roda. Por isso F11/F13 da prova medem o LIKE do laço numa transação
  com um `public.similarity` que delega a `extensions` (o conserto simulado), desfeita no fim.
- As 3 invoker têm EXECUTE para `anon`/PUBLIC; sem SELECT de `anon` em `omie_products`, a chamada
  anônima dá 42501 na tabela. Não vaza, mas é superfície desnecessária.

## Lições

- **Assinatura que casa o "já-correto" não discrimina.** A do censo casava o modelo; a ampliada (lado
  direito não-literal) achou o falso-negativo `ILIKE v_fornecedor`.
- **O modelo pode estar certo num eixo e errado no outro.** "Escapa o curinga" não é "fecha a classe":
  a classe tem dois modos, e o termo degenerado é o segundo.
- **Valor de coluna é a mesma classe quando a intenção é literal.** O transporte (parâmetro ou coluna)
  não muda nada; o que decide é se o valor devia ser pattern (a chave `_ilike` do config) ou literal
  (o código do fornecedor).
