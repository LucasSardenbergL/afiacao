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
| gate | LucasSardenbergL/afiacao#2690 (DRAFT) | `scripts/assert-verde-por-ausencia-gate.ts` | ver abaixo |

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

**DRAFT, por desenho**: a regra das máquinas-meta exige incidente — e nenhum controle mostrou verde-falso
VIVO (ver "O controle É a descoberta"). A cegueira está provada por reprodução, inclusive em money-path; se o
founder aceitar isso como incidente, o PR sai de DRAFT rebaseado sobre as fases. O que ele não cobre está na
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

- **Formas residuais da classe** (revisão adversarial, com sítios): o ESPELHO `IF flag THEN RAISE` com
  esperado false sobre linha que deveria existir (`whatsapp-proposta:175`, `radar-rpcs:57`,
  `radar-fatia3:122`); contagem universal com filtro NULL-cego (`count(*) … WHERE col <> x` = 0 —
  `qtde-inteira:181`, money-path; `COALESCE(col,0) <> 0` = 0 em `aplicar-snapshot-pendente:200`);
  "ok por omissão" em bash (`case "$R" in *denied*) bad;; *) ok` — `refresh-ranking-gate-cron:77`,
  `reposicao-fase2-badge-mv:135/147`); esperado NULL lido de record sem prova de que a linha existe
  (`tint-canonica:558` K9, `hardening-aplicar-promocoes:150`, `whatsapp-proposta:159/165`); coalesce que
  FABRICA o esperado (`authz-capability-matrix:424`); `IS DISTINCT FROM` entre dois valores medidos
  (`radar-fundacao:85`). → continuação, com o gate v2 (espelho, `count … WHERE <>` = 0, `ELSEIF`,
  `RAISE 'msg'`, comentário entre THEN e RAISE, `db/*.sql`).
- **As 5 provas quebradas na main** e o **acoplamento ao texto inglês** (21 provas) — achados de passagem,
  registrados aqui; não são esta classe.
- `HAS_EXT` do `seg-onda2e5`: o C4 é PULADO (verde) quando o `pg_trgm` falta — "pular = passar", vizinha.
- `<>` NULL-cego em corpo de FUNÇÃO sob teste (`criar_plano_tatico`: `_owner <> _expected_owner`) — é
  código de produto copiado na prova; se a cópia espelha a função real, a pergunta é da função, não da prova.
