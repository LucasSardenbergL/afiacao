# Assert principal verde por AUSÊNCIA — `IF v <> x` com `v` NULL passa

**2026-09-30.** Em PL/pgSQL, `IF <cond> THEN RAISE` só dispara com a condição TRUE — NULL não dispara.
O assert `SELECT col INTO v … WHERE …; IF v <> 12.5 THEN RAISE …` com a linha SUMIDA (v NULL) avalia
`NULL <> 12.5` = NULL e PASSA: aprova sem medir nada. É o "ausente ≠ zero" do CLAUDE.md no lado do
TESTE. Caso de origem: o C1.2 de `db/test-tint-promote.sh` (`IF q900 <> 12.5`), achado pela série das
falsificações de `db/` ([falsificacao-exit-nao-e-dente.md](falsificacao-exit-nao-e-dente.md), "fora da
classe") e registrado lá como tarefa com as duas assinaturas calibradas.

## Passo 0 — instância única ou classe? **Classe.**

A assinatura do briefing (`IF <var> <> ` nu) casava 277 linhas em 30 provas. A forma real é maior —
**a assinatura bruta via ~60% dela**. Um detector estrutural (condição de IF/ELSIF-ASSERT em bloco
DO, `<>`/`!=` em nível booleano, fora de string/comentário/subconsulta/argumento de função) achou
**448 asserts / 521 operadores / 42 provas** (+ 1 no harness `db/lib/`, achado depois pelo gate).

| forma | exemplo real | por que passa com a ausência |
|---|---|---|
| `SELECT col INTO v` sem linha garantida | C1.2 `IF q900 <> 12.5` | sem linha, `v` é NULL |
| campo de record | `SELECT * INTO r …; IF r.status <> 'x'` | sem linha, todo campo é NULL |
| chave JSON do retorno | `IF r->>'faixa' <> 'verde'` | chave sumida → NULL |
| subconsulta escalar | `(SELECT COALESCE(csv::text,'-') … WHERE k) <> '300'` | o COALESCE cobre a COLUNA NULL, **não a linha ausente** |
| agregado de zero linhas | `max()`, `string_agg`, `bool_or` | zero linhas → NULL (só `count` é 0) |
| retorno de função sob teste | `SELECT f(…) INTO n; IF n <> 1` | a função devolveu NULL |
| `INSERT … RETURNING … INTO` | `IF v_norm <> 'FO20…'` | coluna calculada NULL |

Irmãs de **expectativa positiva**, mesmo mecanismo, operador diferente: `IF NOT flag` (flag de
`SELECT … INTO`, 23), ordem (`IF v >= 0`, `IF t2 <= t1`, 7), `NOT LIKE` (`IF msg NOT LIKE '%x%'`, 5),
`= 'null'::jsonb` (`IF r->'cmc' = 'null'::jsonb` — "o gestor não viu o custo" só dispara com a chave
PRESENTE e JSON null; **com a chave sumida passava**, 8), `NOT ('x' = ANY(arr))` (1).

A forma bash (2): `eq "…" "$(leitura)" ""` — a leitura que ERRA dá `""` = o esperado (a substituição
vai como argumento, o status se perde). 13 sites em 6 provas; e 8 deles tinham uma 2ª face: `""`
confundia "campo NULL" com "linha/elemento AUSENTE".

## A varredura (matar-classe)

Assinaturas calibradas (casam o site pré-fix, não casam o pós-fix):
`grep -nE '^[[:space:]]*IF [a-z_][a-z_0-9]* <> ' db/*.sh | grep -vE 'IS NULL OR|IS DISTINCT'` e
`grep -nE '"\$\([^"]*\)"[[:space:]]+""[[:space:]]*$' db/*.sh | grep -v '\$(medir '` — mais o detector
estrutural (hoje o gate). Triagem por **procedência de cada operando** (script) + **leitura** de todo
site afetado. Veredito por operador: **307 afetados / 212 não-afetados / 2 lidos à mão**.

**Fora da classe, por desenho (lidos):** 9 condicionais em **corpo de CREATE FUNCTION** (fixture ou
código sob teste — `criar_plano_tatico`, `resolver_outlier`, `confirmar_vinculo_boletim`,
`auto_assign_user_role`, depara…): trocar ali mudaria o produto simulado; os asserts **negativos**
(`IF has_p4 THEN RAISE 'não pode estar'`, `IF msg LIKE …`, `= ANY(ids)` da fila) — ausência é o
resultado esperado; a **maquinaria de falsificação** (`SABOTAGEM_PASSOU`, `sabotagem no-op`, `FALSO`);
`has_table_privilege`/`has_function_privilege`/`pg_get_functiondef(…::regprocedure)` — com o objeto
ausente eles ERRAM (vermelho alto), nunca devolvem NULL.

**Os falsos-positivos do meu analisador** (cada um derrubado lendo o código — "varredura é hipótese"):
tag de `DO $c1$` com dígito e `DO \$\$` de heredoc não citado (o IF "herdava" a função de cima);
guarda `X IS NULL OR` na mesma condição (14) e `IF X IS NULL THEN RAISE` na linha anterior (1);
`SELECT EXISTS(SELECT 1 …) INTO v` lido pelo SELECT de dentro; `_dif_count()` = soma de dois `count`.

## Os consertos (idioma)

- `<>`/`!=` → `IS DISTINCT FROM` em **todo** assert de bloco DO — inclusive os que vêm de `count`
  (idioma único: arquivo misto ensina o padrão errado a quem copia; neutro com operandos não-NULL).
  Drop-in: precedência mais fraca que aritmética/`::`/`->>`/`||`, mais forte que NOT/AND/OR. A caixa
  segue a do arquivo (`is distinct from` onde o PL/pgSQL é minúsculo).
- `IF NOT flag` → `IF flag IS NOT TRUE`; esperado false → `IF flag IS NOT FALSE`;
  `IF NOT (a AND b)` → `IF (a AND b) IS NOT TRUE`.
- ordem → `(t2 > t1) IS NOT TRUE` ou `v IS NULL OR v >= 0` (o idioma do vizinho, quando havia).
- `NOT LIKE` / `= 'null'::jsonb` → guarda `X IS NULL OR`.
- bash → `medir()` (erro vira `ERRO_rc=<n>`) e, onde `""` significava "campo NULL", a sentinela
  `'(null)'` (`coalesce(…, '(null)')`), deixando `""` só para a linha ausente.
- As mensagens passam a dizer o valor lido — com NULL, "a fórmula sumiu" em vez de "achei NULL
  (esperado NULL)".

Critério **por assert**: se o próprio valor medido pode vir NULL por ausência, conserta — mesmo quando
um assert VIZINHO já pegaria (C7.6 é coberto pelo C7.7 `count`; o A1 do tombstone pela A2 da mesma
leitura). Cobertura por vizinho é acaso: atualizar o esperado do vizinho reabre o furo.

## Fases (≤10 arquivos, por domínio)

| fase | PR | provas | notas |
|---|---|---|---|
| 1 tint (núcleo) | LucasSardenbergL/afiacao#2681 | tint-promote, tint-fase5-desativacao, tint-gate-revalida, tint-promote-tombstone-fase5, tint-canonica | C1.2 (origem), C2.2/C12.1 (`NOT p_is_null`: a fórmula SUMIDA passava "preço NULL honesto"/"não vazou"), V1/V2/V6 (COALESCE na coluna, não na linha), G19 (`bloqueios` ausente), C38.5/C38.7/C39.4 (`msg NOT LIKE`) |
| 2 preço/promo | LucasSardenbergL/afiacao#2686 | cockpit-preco, defasagem, fix/hardening-aplicar-promocoes, promo-forward-buying-min, minimo-forcado, get-ultimos-precos-cliente, regua-preco-customer360 | A4b/D9a/D13 (`= 'null'::jsonb`: chave de custo SUMIDA passava "o gestor viu"), A7c (custo tint), régua (`""` = campo NULL **ou** elemento ausente) |
| 3a compras | LucasSardenbergL/afiacao#2692 | auto-aprovacao-piloto/v2, claim-disparo-cenario-b (núcleo), alerta-pedido-minimo, rpc-intraday, po-inexistente-antes-de, pos-candidatos-guard-temporal, pos-frescor-marcador | BLOQUEADOR do claim (`claimed` ausente: a corrida "não mediria nada" e passava), I8 (`cron.job` sem o job passava), fail-closed "VAZIO" que lia o erro |
| 3b reposição | LucasSardenbergL/afiacao#2693 | embalagem-auto-cadastro-wp, fixes-codex-711, qtde-inteira(-persist), reposicao-consolidacao-demanda, rpc-account-aware, oportunidade-erro-terminal, fornecedores-classificacao | `bloq <> 0` cego (o vizinho já tinha um `IS DISTINCT FROM` no 3º termo); retorno de função NULL |
| 4 KB/farmer/CRM | LucasSardenbergL/afiacao#2688 | kb-0c-aprovacao, kb-extraction-drafts, kb-fundacao-casamento, kb-hardening-codex, kb-spec-versions, melhorias-rpcs, order-feed-view, crm-carteira, tool-spec-custom-option, data-health-customer-metrics | `max`/`bool_or` de zero linhas, `RETURNING`, `ANY(NULL)`, `t2 <= t1` |
| 5 radar/whatsapp | LucasSardenbergL/afiacao#2689 | radar-fatia3, radar-rpcs, radar-fundacao, radar-rls-perf, roteirizador-prospects, geocoding-cep, whatsapp-funil/hsm/pendentes/proposta | `NOT (r->>'deduped')::boolean`, `string_agg` vazio, marcador sumido |
| gate | LucasSardenbergL/afiacao#2690 | `scripts/assert-verde-por-ausencia-gate.ts` | ver abaixo |

**Provas QUEBRADAS na main** (fora do núcleo — nenhum CI as roda; a versão de antes quebra igual): `fornecedores-classificacao` e `melhorias-rpcs` (seed viola constraint nova), `whatsapp-funil/hsm/proposta` (`policy "wt_staff_read" … already exists`: a migration reaplicada já está no schema-snapshot). Nelas só entrou a conversão MECÂNICA do `<>` (drop-in); os consertos manuais ficam registrados, não executáveis.

## O controle É a descoberta

A 1ª ideia era uma rodada de "descoberta" (tudo convertido numa sombra; vermelho lá e verde no original =
verde-falso VIVO). Ela ficou redundante: o CONTROLE de cada meta é a versão consertada inteira, nos dois
locales. **Nenhum controle ficou vermelho por um NULL escondido** — todo vermelho de controle foi
pré-existente e provado igual no antes (as 5 provas quebradas; o acoplamento ao texto inglês, abaixo).
A classe era cegueira LATENTE: ~340 asserts que não veriam a ausência, nenhum mascarando um defeito hoje.

## A meta-falsificação

Por prova: controle (depois) VERDE · a reprodução da ausência no depois VERMELHA pelo rótulo DECLARADO
(todo erro novo — `ERROR:`/`ERRO:` ou o `✗`/`❌` do bad() — nomeia o assert; erro alheio ≠ dente) · a
mesma reprodução no ANTES verde, com o mesmo conjunto de erros e a mesma última linha do controle (o
furo reproduzido). Nos dois locales — cliente `LC_ALL=C`/`pt_BR.UTF-8`, servidor
`--lc-messages=pt_BR.UTF-8` com sonda POSITIVA no log (`pronto para aceitar conex`) — versões lidas por
`git show` (a árvore nunca sabotada), cada rodada no seu diretório, edição exata 1× (≠1 = erro da META).
Reproduções: "anula a leitura" (`v := NULL`, `r := r - 'chave'`, `WHERE false` no snapshot) ou ausência
real no nível da consulta (`'AX_SUMIU'`, `'COR12_SUMIU'`, `proname` inexistente); na forma bash, a
leitura que ERRA (UUID inválido, função inexistente, coluna inexistente) — o erro injetado DECLARADO e
descontado nas duas versões.

Resultado por fase, no corpo de cada PR (tabela gerada do `resultado.txt` da v3).
### O harness também mentia — a revisão adversarial (Caminho B)

Sem cota de Codex (86% > teto 85%), a 2ª opinião foi um revisor independente, só-leitura. Nenhum P0; dos
8 P1, dois invalidavam evidência:
- **o locale pt não pegava em 7 provas**: elas forçam `ALTER DATABASE … SET lc_messages='${HARNESS_LC:-C}'`, e
  a sonda só lia o log do POSTMASTER (pt) — a SESSÃO seguia em C, e o `claim-disparo` "passou em pt" sendo C
  (a própria prova imprimiu `lc_messages=C`). v3: `HARNESS_LC` exportado e **sonda de SESSÃO** (nenhuma tag
  de severidade do outro idioma: `ERROR:␣␣` numa rodada pt invalida a rodada);
- **editei o juiz com lotes rodando**: o bash lê o script aos poucos, e o rabo de dois lotes executou
  fragmentos da versão nova (as rodadas, parseadas no início do laço, ficaram íntegras — auditado: cada
  resultado tem exatamente as linhas esperadas). v3: juiz IMUTÁVEL por versão, hash do harness no resultado
  e manifesto por rodada (revisão, sha1 da reprodução, locale), sombra por `git archive` da revisão (não o
  worktree vivo), controle APROVADO antes de julgar depois/antes (o antes "igual a um controle quebrado"
  passava), plano com 6 colunas validadas e alternativas de rótulo ≥ 4 caracteres.

**Acoplamento ao texto do servidor** (vizinha, fora da classe — vermelho FALSO em pt, não verde falso): 21 provas
casam `permission denied` ou a mensagem inglesa depois da SQLSTATE (A9b2, D10b, B1b, Ab2, G16a/d, C11d…).
Como toda prova faz `initdb --locale=C`, o texto inglês é garantido no uso normal; só o 2º locale do servidor
o expõe. Declaradas como falha CONHECIDA, com a PROVA no antes; alvo depois de um desses asserts fail-fast = N/A em pt.

## O gate — `scripts/assert-verde-por-ausencia-gate.ts`

Teste que lê fonte (vitest), sobre o stripper COMPARTILHADO `removerComentariosShell`: em `db/*.sh`,
IF/ELSIF-assert de bloco DO (ou helper `pg_temp.*`) com `<>`/`!=` em nível booleano reprova. Regra ABSOLUTA
— sem isenção por "vem de count" (idioma único, nenhuma análise de fluxo). PISOS: provas (309), linhas de
código (80.707) e **asserts reconhecidos (887)**, o sensor de cegueira do próprio detector. Detector TS ≡
conversor Python das fases (381/381 sites), 17/17 casos sintéticos, 27/27 mutações cirúrgicas no seco. Como
gate, achou o site que a varredura por `db/test-*.sh` não cobria (`db/lib/data-health-vivo.sh`).

**Máquina-meta — decisão do founder (2026-10-01).** A regra das máquinas-meta exige incidente, e
nenhum controle mostrou verde-falso VIVO (ver "O controle É a descoberta"). O founder aceitou a
cegueira provada por REPRODUÇÃO — inclusive em money-path (o C1.2 do tint-promote) — como o incidente;
o gate entrou depois das cinco fases, porque o teste do corpo real só fica limpo com elas (o CI dele,
antes disso, reprovou exatamente os 3 testes do corpo real: 448 violações). O que ele não cobre está na
continuação (abaixo).

## Lições

- **A assinatura do briefing via ~60% da forma.** `IF <var> <> ` nu não pega campo de record, chave
  JSON, subconsulta, `round()`, ELSIF, `!=`, var à direita, PL/pgSQL minúsculo. O detector estrutural
  é o que fecha o denominador — e ele mesmo achou, como gate, o site de `db/lib/` que a varredura por
  `db/test-*.sh` não cobria.
- **COALESCE na coluna não cobre a linha.** `(SELECT COALESCE(col::text,'-') … WHERE k)` devolve NULL
  quando a LINHA falta — o `'-'` só aparece com a linha presente e a coluna NULL.
- **Zero linhas é NULL para todo agregado menos `count`.** `bool_or`, `max`, `string_agg` de conjunto
  vazio → NULL; "a família está vazia" passava "P2 está na família".
- **Chave ausente ≠ JSON null.** `r->'k' = 'null'::jsonb` só vê a chave PRESENTE com null; a chave que
  sumiu do retorno é SQL NULL e passa.
- **`""` esperado é duas perguntas.** "Leitura errou" e "linha ausente" produzem o mesmo `""` que
  "campo NULL"; `medir()` separa o erro, a sentinela `'(null)'` separa a ausência.
- **O harness de meta é código e mente como código.** Locale do servidor ≠ locale da sessão; juiz editado
  com lote rodando; "antes igual ao controle" com o controle quebrado; rótulo por substring sem âncora. Quem
  achou foi um revisor independente — a própria meta passava.
- **O `heavy` de 1 vaga é fila da máquina inteira.** Rodada por prova (41 × fila) não anda; UM job de
  lote sequencial anda. E a versão coberta tem de ser a entregue: a F2 rebaseada sobre a série dos
  temporários teve a meta re-enfileirada no SHA novo.

## O que ficou de fora, com dono

- **Formas residuais da classe** — feitas na fase 2 (abaixo), com o gate v2.
- **As 5 provas quebradas na main** — revividas em 2026-10-01 por outras sessões (#2703, #2727, #2733),
  que reescreveram os asserts (o espelho do `whatsapp-proposta:175` e os 103/104 deixaram de existir).
  O **acoplamento ao texto inglês** (21 provas) segue registrado aqui; não é esta classe.
- `HAS_EXT` do `seg-onda2e5`: o C4 é PULADO (verde) quando o `pg_trgm` falta — "pular = passar", vizinha.
- `<>` NULL-cego em corpo de FUNÇÃO sob teste (`criar_plano_tatico`: `_owner <> _expected_owner`) — é
  código de produto copiado na prova; se a cópia espelha a função real, a pergunta é da função, não da prova.

## Fase 2 — as formas residuais (2026-10-01)

**Passo 0 — instância única ou classe? Classe** (continuação: as formas que a fase 1 e o gate v1 não viam).
O handoff listava ~20 sítios de uma revisão adversarial; a varredura de `db/` inteiro pelos detectores
por forma (extrator do gate + procedência por operando da fase 1, ferramentas fora do repo) achou mais.

| forma | o que passa com a ausência | candidatos → afetados | conserto (idioma) |
|---|---|---|---|
| (a) espelho | `IF (r->>'deduped')::boolean THEN RAISE` (esperado false) | 13 átomos nus → 2 + 1 de contenção (`opts @> …`) | `IS NOT FALSE` · `NOT FOUND OR` |
| (b) contagem universal | `count(*) … WHERE col <> x` = 0: a linha com col NULL sai do filtro; o universo vazio também dá 0 | 125 → 16 (subagente) − 1 revertido por leitura | `(col = x) IS NOT TRUE` no FILTER + denominador (bash `"0\|t"`) |
| (c) ok por omissão | `case "$R" in *denied*) bad;; *) ok` — todo outro erro (e a negação em pt) "executou" | 23 `*) ok` + ~40 `else ok` → 9 + `hasnt()` ×2 | marca POSITIVA: `executa()` (EXECUTOU no fim + ON_ERROR_STOP + SQLSTATE, o idioma do `acl_probe`) |
| (d) esperado NULL sem a linha | `SELECT … INTO r; IF r.x IS NOT NULL THEN RAISE` | 15 `IS NOT NULL` + 6 `ASSERT … IS NULL` → 14 | `IF NOT FOUND OR …` · `ASSERT FOUND AND …` · `coalesce(col,'(null)')` DENTRO da subconsulta |
| (e) coalesce fabrica o esperado | `COALESCE(cap(NULL), false)` = 'f' | 69 → 2 (o resto é o sentinela correto da fase 1) | `'ERA_NULL'` · denominador |
| (f) dois medidos | `IS DISTINCT FROM` com NULL × NULL; seletor dentro de laço | 28 → 3 + 1 seletor | guarda do lado de referência · `NOT FOUND OR` · contagem de acertos |
| bash `""` (fase 1) | `eq … "$(como … "SELECT …")" ""` | parser: 6 resíduos que a assinatura grep NÃO via (aspas aninhadas no `$(…)`) → 5 | sentinela `'(null)'` · colchetes `'[' \|\| … \|\| ']'` · `count(*)` = "0" |

Critério, como na fase 1: **por assert** — conserta mesmo quando um vizinho já pegaria. Ficaram fora, lidos:
negativos legítimos (fila `= ANY(ids)`, privacidade "não devolve", `hasnt` com controle positivo na MESMA
medição), `has_*_privilege`/`EXISTS`/`pg_get_functiondef(…::regprocedure)` (nunca NULL), o `COALESCE(Σ,0)`
do `rpc-account-aware` E (é o CONTRATO do SUT: `valor_total NOT NULL`, preço ausente vira 0 no cabeçalho),
corpo de CREATE FUNCTION pública e maquinaria de falsificação.

**Fases (≤10 arquivos, por domínio), 33 provas:** F1 radar/whatsapp/kb/CRM (8) · F2 tint 💰 (2) · F3
preço/authz/desconto/pedido 💰 (7) · F4 reposição/compras 💰 (6 — o J2 do `demanda-insumos-bom` saiu) · F5 "ok por omissão" (7) · F6
farmer/universo/recência (3 — o `reparo` saiu, abaixo).

**Fora da entrega, com o conserto registrado (não executável):**
- `db/test-reparo-passivo-coerencia.sh` (C6/C8/F8/F13, forma b): exige `FIXTURE=` com dados REAIS de prod.
- `db/test-reposicao-demanda-insumos-bom.sh` J2 (forma e): a prova está **vermelha na main** — o H1
  (`explosao sem fan-out`) falha antes, e o `assert_eq` aborta. Achado pela linha de base do lote 0.
- `db/*.sql` (36 sítios `<>` em 11 arquivos): scripts APLICADOS pelo `db:aplicar`, que guarda o sha256 dos
  bytes no ledger — reescrevê-los quebraria "recibo = bytes do repo". Congelados pela catraca do gate v2.

**A meta (juiz v4 → v5, cópias imutáveis do v3).** v4 = v3 + as marcas de `bad()` `XX ` e `FALHA—` (o v3 só
lia ✗/❌/FAIL), o `prepara.py` aceitando porta dinâmica (`PGPORT_TEST`), `export LC_ALL` sem `LANG` e o
`PORT=` citado em comentário. O lote 0 (controle do ANTES, 2 locales) usou o v4: 56 OK; as falhas eram
todas pré-existentes e explicadas — acoplamento ao inglês em pt (viraram CONHECIDAS com prova), o
`city-norm` reprovado pela SOMBRA (roda `bun scripts/city-norm-print.ts`, e a sombra só trazia `db/` e
`supabase/`), o fixture do `reparo` e o H1 do `demanda-insumos-bom`. v5 = v4 + sombra com `scripts/` e
`src/`. Reproduções (52): ausência real no nível da consulta (chave trocada para inexistente) quando
nenhum vizinho a pega primeiro; quando pega, isolamento — `PERFORM 1 WHERE false` antes do assert
(FOUND falso, campos intactos) ou anular só a leitura (`r := r - 'deduped'`); na forma bash, a leitura que
ERRA com o erro DECLARADO no plano. Lote 1 (278 rodadas): 248 OK; os 17 FAIL foram 4 defeitos MEUS que o
controle pegou antes de julgar a reprodução — F2 do self-service esperava 0 (no caminho feliz A vê 1
linha), o W1 contava 11 checagens (a seção 4 do validador devolve uma linha POR cor e o fixture não as
tem: são 10), o W1 abortava sob `pipefail` antes do próprio `bad`, e o D4a nem era cego (com `set -euo
pipefail` a leitura que erra ABORTA a prova: o ANTES também ficou vermelho; hunk revertido) — mais 3 do
harness/plano (cache, erro injetado, cascata declarada). Lotes 1b/1c/1d refeitos só nesses arquivos:
todas as 33 provas com controle verde e cada reprodução vermelha no depois pelo rótulo, verde no antes.
Resultado por fase no corpo de cada PR (F1 LucasSardenbergL/afiacao#2754 · F5 LucasSardenbergL/afiacao#2755 ·
F6 LucasSardenbergL/afiacao#2753 · F2 LucasSardenbergL/afiacao#2759 · F3 LucasSardenbergL/afiacao#2760 ·
F4 LucasSardenbergL/afiacao#2761 — as três 💰 por Caminho B: Codex sem cota (86% > 85% até 03/10 19:11),
revisor independente só-leitura; a revisão retroativa saiu pelo Fable em 05/10 — ver "Revisão retroativa").

## O gate v2

Só o que tem forma canônica MECÂNICA (`scripts/assert-verde-por-ausencia-gate.ts`):
1. **o extrator** passa a ver `ELSEIF`, comentário SQL entre o THEN e o RAISE, `RAISE 'msg'`/`USING`/
   `SQLSTATE`/`<condição>;` e o acumulador com `=` — formas que escondiam um `<>` do v1 (0 hoje);
2. **`json-bool`**: átomo `(r->>'k')::boolean` nu, com NOT, `IS TRUE`/`IS FALSE`/`= bool` — calibrado:
   casa os 2 sítios do radar na main e nada depois do conserto;
3. **`coalesce`**: `coalesce(v, L) IS DISTINCT FROM L` (ou `<>` L) — o remédio do v1 aplicado a
   `coalesce(v,L) <> L` aprovaria um assert ainda cego (0 hoje);
4. **`db/*.sql`** lidos (limpador SQL próprio: não há stripper SQL compartilhado) com CATRACA por arquivo —
   `.sql` novo nasce limpo; a contagem de um listado não sobe nem desce sem atualizar a catraca.
Pisos novos: `.sql` lidos (110 → 90) e asserts reconhecidos nos `.sql` (136 → 100). Mutações: 52, todas
cirúrgicas no `mutcheck --seco`. Sem forma canônica, seguem manuais (assinaturas acima): (b), (c), (d), (f)
e a forma bash `""`.

## Lições da fase 2

- **A assinatura grep da forma bash era cega a aspas aninhadas** (`"$(como $A … "SELECT …")"` quebra o
  `[^"]*`): 6 resíduos que só um parser de argumentos achou. Assinatura de varredura também se calibra
  com controle que tenha a forma mais feia, não a mais comum.
- **`IS DISTINCT FROM` não salva quando os dois lados vêm do MESMO NULL** (`qtde <> trunc(qtde)`,
  `valor <> qtde * 10`): `NULL IS DISTINCT FROM NULL` é falso. Ali o idioma é `(x = y) IS NOT TRUE`.
- **"Não achei o erro" não é "executou"**: o positivo se mede com marca de FIM que só sai se tudo rodou
  (`SELECT 'EXECUTOU'` + `ON_ERROR_STOP`), e o negativo pela SQLSTATE — os dois à prova de locale.
- **Linha de base do ANTES antes da meta**: o lote 0 achou uma prova vermelha na main, duas que não rodam
  autocontidas e uma que o próprio juiz não sabia montar — sem ele, cada uma viraria um FAIL "meu".
- **O juiz tem de ler a marca de falha de CADA prova** (`XX`, `FALHA—`): o plano do v3 recusaria as
  duas — melhor que julgá-las verdes por não reconhecer o vermelho.
- **Cache do juiz por SHA não basta quando o CONJUNTO de árvores muda**: o v5 passou a arquivar
  `scripts/` e `src/`, mas o cache do ANTES vinha do v4 (só `db/`+`supabase/`) e o `city-norm` reprovou
  no antes por ambiente. A chave do cache é (SHA, árvores), ou o cache se apaga ao trocar de versão.
- **A revisão independente acha a ausência que a reprodução não imaginou.** A meta reproduz a ausência
  que EU modelei; o revisor (Caminho B, Codex sem cota) achou outras duas lendo o seed: o A5b aprovava
  `'NULL'` — que ali não é "NULL honesto", é o JOIN do fallback do fornecedor quebrado (o valor certo é
  1.60) — e o C12 aprovava com o pedido INEXISTENTE. Os dois viraram assert exato, com reprodução própria.
- **Marca positiva que conta saída tem de saber o que o fixture imprime**: "11 checagens ✅" era o
  número do validador de PROD; no banco da prova uma seção devolve zero linhas. E o `grep -o | wc -l`
  numa atribuição sob `pipefail` ABORTA quando não há casamento — o vermelho deixa de ser do assert.

## Revisão retroativa — o Fable no lugar do Codex (2026-10-05)

A revisão independente que ficou PENDENTE (as três 💰 da fase 2 e os 4 PRs de dinheiro da fase 1) saiu
pelo **Fable**, por decisão do founder em 05/10, em vez de esperar a cota do Codex: subagente
só-leitura, **outro modelo da mesma casa** — não é a 2ª opinião de outro fornecedor que o Codex dá, e o
registro fica com esse nome. Mesmos briefings + diffs montados para o Codex, um revisor por PR, lendo a
main já mergeada (`72e2cecf5`); cada achado foi verificado no código antes de virar conserto.

| revisão | PRs | veredito | virou conserto |
|---|---|---|---|
| fase 2 💰 | LucasSardenbergL/afiacao#2759 · LucasSardenbergL/afiacao#2760 · LucasSardenbergL/afiacao#2761 | sem P0 | split de estoque A4/A6 |
| fase 1 tint | LucasSardenbergL/afiacao#2681 | sem P0 | — |
| fase 1 preço/promo | LucasSardenbergL/afiacao#2686 | sem P0 | — |
| fase 1 compras | LucasSardenbergL/afiacao#2692 | sem P0 | — |
| fase 1 reposição | LucasSardenbergL/afiacao#2693 | sem P0 | consolidação D |

**O conserto da F4 tinha ficado pela metade num eixo.** No split de estoque, o `IS NOT TRUE` +
denominador fechou o `a_caminho`/efetivo NULL, mas o recorte `AND i.estoque_fisico IS NOT NULL` ficou no
WHERE: o item novo com físico NULL saía do universo e o `"0|t"` seguia verde. O motor grava
`COALESCE(fisico,0)` em todo item novo — o NULL é regressão, não escopo. É uma subforma da (b): o
**recorte NULL-cego no UNIVERSO, sobre a coluna medida** (o FILTER já era NULL-seguro). A varredura dela
(12 candidatos de `count(*) … WHERE … IS NOT NULL`, classificados por um Fable e conferidos) achou 1
irmão — o H3 de `padrao-like-contem`, cujo universo era `p IS NOT NULL`, o resultado do próprio helper:
anular só os termos de barra deixava ~310 não-nulos, acima do piso de 250, e o H3 seguia verde —, 1
já-correto (recência colacor: o recorte é a coluna FONTE, escopo da própria migration, e o seed tem o
NULL de propósito) e 8 falso-positivos (função de referência, perf, predicado positivo). Sem gate:
separar o recorte cego do escopo legítimo exige saber se o NULL é estado válido — é julgamento, não
forma; fica a assinatura no `money-path.md`. O pulo com aviso também tinha uma ocorrência: o D da
consolidação (`IF n = 0 THEN RAISE WARNING`), o único `RAISE WARNING` de assert positivo nas provas (o
outro, no selo de aprovação, é marca positiva). Medido em 05/10: no seed o 4080 passa o filtro de
`v_sku_parametros_sugeridos` e o WARNING nunca disparava — o pulo só aprovaria a cadeia quebrada nos
sugeridos; virou `RAISE EXCEPTION`.

Falsificação, com controle verde na MESMA invocação: split — o físico do SKU2 anulado logo antes da
medição deixa o ANTES verde (o bug) e o DEPOIS vermelho, no A4 e no A6; H3 — o helper recriado tratando
`\` como curinga (os 5 termos só de barra viram NULL) deixa o ANTES em `0`, verde, e o DEPOIS vermelho;
D — `v_sku_parametros_sugeridos` trocada por uma view de mesmo nome sem o 4080 dá, no ANTES, só o
WARNING e o `✓ D`, e no DEPOIS `FAIL D` (rc 3). Uma execução por variante — as três provas fixam
`LC_ALL=C` por dentro, rodar de novo com o shell em pt repetiria a mesma execução — e o JUIZ (strings
fixas) em C e em pt_BR.UTF-8, os dois sem falha.

P2 registrados sem conserto (verificados; nenhum é verde por ausência):
- régua customer360 A1c — `eq` com os dois lados lidos do banco: só empatam (`""` = `""`) com o banco
  INTEIRO fora, e aí A1a/A1b (esperado literal) derrubam a prova; a chave sumida sozinha já dá vermelho.
- tint gate G35 — um 2º overload de `tint_gate_revalida` daria "more than one row": vermelho por
  infraestrutura, nunca verde.
- cockpit/defasagem A5/A11/D9b/D11 e auto-aprovação (piloto/v2) — o vermelho é certo, a mensagem do
  RAISE desvia ("viu o número" quando a resposta SUMIU; rótulo sem `%`).
- régua A1g (`fnulo`) — chave omitida ≡ JSON null para o consumidor TS (`== null`); A5b/A10c/A10d
  PRECISAM dessa equivalência.
- po-inexistente A1 — negativo legítimo ("VAZIO"), com controle positivo no mesmo estado antes e depois.
- fixes-codex-711 F2b — `SELECT INTO` sem `STRICT` com 2 cabeçalhos: seleção ambígua, outra classe.
- rpc-account-aware E e qtde-inteira-persist E/F — cenário impossível no schema (`NOT NULL`) / coberto
  no mesmo bloco por A/A2/C.
- cobertura — dos 8 de compras, só o `claim-disparo-cenario-b` está no núcleo do CI.
- `supabase/migrations/20260906190615_reposicao_claim_disparo_cenario_b.sql:344` — o autoteste da
  migration compara `(v_ret ->> 'claimed') <> 'false'`, NULL-cego; corpo de migration, fora do escopo
  (e `supabase/migrations/` não se toca).
