# O template da prova SQL nasce portável — e a CONTROLE que lia o snapshot de DR tinha prazo de validade

**2026-10-08** · `.claude/skills/prove-sql-money-path/references/harness-template.sh` +
`db/test-oportunidade-erro-terminal.sh` → `db/nucleo-ci.txt` (Eixo 6) · continuação do
[prova-otica-canonica-no-nucleo-ci.md](prova-otica-canonica-no-nucleo-ci.md)

## O que mudou

1. **O template da skill nasce portável.** O Passo 2 da `prove-sql-money-path` manda copiar o template
   para criar prova nova, e ele ainda trazia `PGBIN="/opt/homebrew/..."` + sonda `-x` + `cp -Rn` do Cellar:
   toda prova nascida dele nascia FORA do CI. Agora traz o boilerplate do modelo portável
   (`export PGVER=17` + `. "$REPO_ROOT/db/lib/pg-harness.sh"` com o `disable=SC1091`). O SKILL.md dizia
   que "o template contorna o keg-only do brew" — quem faz isso agora é o helper; os 4 trechos foram
   ajustados e os pré-requisitos passaram a citar Linux/PGDG.
2. **A última prova recente presa ao laptop foi portada** (`test-oportunidade-erro-terminal.sh`, nascida
   em 2026-09-24): só o boilerplate, e a porta passou a honrar `PGPORT_TEST`. Com ela, as 5 provas nascidas
   presas desde que o harness existe estão portadas.
3. **E entrou no núcleo** (Eixo 6, `7  falsificar=3`, ao lado da irmã que prova a mesma guarda pelo outro
   lado). O porte não bastava — foram 4 pré-requisitos, medidos um a um (abaixo).

## Evidência

- **Template gerado roda:** cópia para um `db/test-*.sh` descartável, ZONA 1 com uma tabela, ZONA 2 com uma
  "migration" de uma linha, ZONA 4 com um assert → PG17 sobe, `RESULTADO: 1 ok / 0 fail`, exit 0. Na mesma
  invocação, controle verde antes e depois: **F-B** (removida a linha que carrega o `pg-harness`) →
  vermelha, `PGBIN: unbound variable`; **F-A** (`PGBIN_OVERRIDE` num diretório FORA de `/opt/homebrew`,
  o layout do runner Linux) → verde. A linha do harness carrega peso e a prova gerada não depende do brew.
- **Porte sem mudança de comportamento:** log idêntico byte a byte antes × depois nos 2 modos (`diff` exit
  0; sha256 `5fa3d07dc58c` normal, `08c1cd90a427` `--falsificar`; 1.494 e 1.958 bytes). Ficou num commit
  próprio, separado da mudança de saída.
- **Runner com manifesto de 1 linha** (`MANIFESTO=… bash db/roda-nucleo-ci.sh`): exit 0, `asserts=7 (≥7)`,
  `sabotagens=3 (≥3)`, 2 s + 2 s, `SQL_PROOF_OK provas=1/1 falsificacoes=1/1`.
- **Os dois mínimos estão vivos para ESTA entrada** — o runner lê de fato o `RESULTADO` e o `SABOTAGENS`
  dela. Exigir 8 asserts reprova com `executou 7 asserts, o manifesto exige`; exigir 4 sabotagens reprova
  com `3 sabotagens vermelhas, o manifesto exige`. Controle verde antes e depois, em `LC_ALL=C` e
  `pt_BR.UTF-8`: **4 ok / 0 fail** nos dois.
- `bun run lint:shell`: 0 achados em 491 arquivos. O template está FORA desse escopo (o gate cobre
  `.claude/skills/*/scripts|evals`, não `references/`) — lint verde ali seria ausência de dado; o
  `shellcheck` foi rodado nele à parte: 0 achados.

## Os 4 pré-requisitos que o porte não dava

| | o que faltava | o que foi feito |
|---|---|---|
| contagem | o fechamento era `OK …: 6 asserts verdes`, fora dos 3 formatos que o runner lê → "exit 0 sem contagem", reprovado | `ok()` conta; fechamento `RESULTADO: 7 ok / 0 fail` |
| recibo | o `--falsificar` não emitia `SABOTAGENS:` → a linha `falsificar=<n>` reprovaria | `vermelha()` conta; `SABOTAGENS: 3 vermelhas / 0 falhas` (toda falha segue abortando com exit 1 ANTES do recibo) |
| âncora | a CONTROLE lia a função velha do **snapshot de DR** (seção abaixo) | a função pré-fix vem do bloco da `20260611120000`, extraído do arquivo |
| juiz | o gate `falsificar-exige-assert` (R3, roda no vitest) só confia no recibo de uma linha `falsificar=<n>` se a prova usar o idioma `SABOTAGENS="nome:VERMELHOS"` ou tiver JUIZ registrado — esta usa vermelho por valor exato declarado, fora do idioma | juiz em `JUIZES` + `REGISTRO_FECHADO`: 2 blocos de âncora prendendo o apply sabotado (falha nomeada aborta), a medição, a declaração EXATA e o veredito; `mede` = `OUT SAIDA RET HI MED DECL` (toda escrita delas presa) |

O diff do log contra o commit do porte é **só** o declarado: os rótulos da CONTROLE, a linha da âncora,
o `RESULTADO` e o `SABOTAGENS`. Nenhum assert, seed ou medição mudou.

**A contagem escrita à mão já nasceu errada.** O "6 asserts verdes" e a A3b nasceram no mesmo commit
(`8afe45492`), e o modo normal executa **7** (controle, A1, A2, A3, A3b, A4, A5). Contagem que não conta
não sabe quando encolhe — e o 2º campo do manifesto é exatamente o ratchet contra a prova que encolhe.

## "Autocontida" não basta: a CONTROLE lia um artefato que MUDA

Pelo critério do manifesto a prova é autocontida — só lê arquivos do repo (snapshot, prelude, stubs, duas
migrations) e usa `python3`, que tem mais de 10 precedentes no núcleo. Mas a CONTROLE (a função velha
precisa EXIBIR o defeito antes do fix) lia essa função do `schema-snapshot.sql`, e o snapshot é do repo sem
ser **imutável**: é o dump de DR, re-gerado da PROD a cada 1-3 semanas (15 re-dumps; o último em
2026-09-05).

Medido nos corpos da função (`gerar_pedidos_oportunidade_ciclo`), por tag de dollar-quote casada:

| fonte | linhas | guarda `erro_nao_retentavel` | sha256 do corpo |
|---|--:|--:|---|
| `schema-snapshot.sql` (re-dump de 2026-09-05) | 163 | 0 | `02c42e4232` |
| `20260611120000` (pré-fix) | 163 | 0 | `02c42e4232` |
| `20260922225449` (o fix sob prova) | 195 | 2 | `6ca81ef623` |
| `20261001023000` (a versão da PROD — md5 conferido pela prova irmã) | 195 | 2 | `ce8b0396de` |

A PROD já roda a versão COM a guarda. O próximo re-dump a leva para o snapshot e a CONTROLE fica vermelha
**sem defeito nenhum** — e vermelho por ambiente é o que ensina a tratar o job do núcleo como flaky (o
próprio cabeçalho do manifesto avisa). A âncora troca a fonte pela migration pré-fix, imutável. Hoje os dois
corpos são byte-idênticos, então ela não muda nada; depois do re-dump, é ela que segura a CONTROLE. A irmã do
Eixo 6 (`test-oportunidade-antidup-disparado-simulado.sh`) já ancorava a mesma função assim, por md5.

**Falsificação num ESPELHO em tmpdir** (o `supabase/` real nunca é tocado), com um re-dump simulado —
o corpo da função no snapshot trocado pelo COM guarda —, controle verde antes e depois, em `LC_ALL=C` e
`pt_BR.UTF-8`: **6 ok / 0 fail** nos dois.

| caso | snapshot | resultado exigido |
|---|---|---|
| CTL-1 prova nova | real | verde |
| CTL-2 prova SEM âncora (commit do porte) | real | verde |
| S1 prova SEM âncora | re-dump | vermelha NA CONTROLE: `veio '6001'` (o FANTASMA ofertado pela função já corrigida) |
| S2 prova nova | re-dump | verde — a âncora segura |
| S3 linha da âncora removida (1 linha, conferida) | re-dump | vermelha NA CONTROLE, mesma marca |
| CTL-3 prova nova | re-dump | verde |

O S1 é a bomba-relógio provada, não suposta. O S3 mostra que a âncora é a camada que segura (sabotada só
ela, o vermelho volta).

**Regra que fica:** CONTROLE que exige o DEFEITO no snapshot tem prazo de validade — vence no 1º re-dump
depois que o fix chega à PROD. A versão velha vem de um artefato imutável: bloco de migration pré-fix,
ou md5 da PROD.

## O custo, medido no CI real — e quem domina é a redistribuição

O #2855 citou partes de 4m36s–6m52s (2026-10-01). **Envelheceu:** nos 4 últimos runs verdes da main, a
parte 2 da matriz mede **13m45s–14m41s** (teto 20 min). A prova nova é a 50ª de 75 e cai nessa parte
(`NUCLEO_PARTE=1/3`, `job-index` 1). Como a partição é por POSIÇÃO (`k mod 3`), as 25 provas depois dela
andam uma casa, e 8-9 provas trocam de parte em cada uma.

Modelo: duração de cada prova lida do log do runner na run `37765469327` (main `07c62959a`, mesmo
manifesto da base deste PR) e somada por parte. Antes de usar, ele foi validado: reproduz o medido
**exatamente** nas 3 partes (484 / 844 / 605 s), sem nenhuma identidade sem dado. O custo da prova nova no
CI vem do fator laptop→CI de 3 provas do núcleo que também carregam o snapshot (0,4×–1,1×, mediana 0,5×:
o runner é MAIS rápido que o M2 com dezenas de sessões vivas) — ~3 s; o pior fator dá ~7 s.

| parte (job) | main: provas → job | com a nova: provas → job estimado | Δ |
|---|---|---|--:|
| 0/3 (1) | 484 s → 9m24s | 537 s → ~10m17s | +53 s |
| 1/3 (2) | 844 s → 14m41s | 699 s → ~12m16s | −145 s |
| 2/3 (3) | 605 s → 10m39s | 704 s → ~12m18s | +99 s |

O pior job da matriz cai de 14m41s para ~12m18s — a folga para o teto sobe de 5m19s para ~7m42s. O custo
da prova (3-7 s) é ruído perto da redistribuição (±145 s). **Para a próxima prova que entrar:** o custo
dela é o menor dos números; meça a redistribuição (`--lista` antes × depois + as durações do último run),
porque é ela que pode empurrar uma parte para o teto — ou, como aqui, aliviar a mais pesada.

## Onde mais

**A mesma bomba em outra prova do núcleo.** Das 18 provas do núcleo que carregam o snapshot, 6 citam md5
e 12 (todas do tintométrico) não. A varredura dessas 12 (subagente, só leitura; a (A) conferida por mim nas
linhas citadas) deu: 6 com a versão velha vinda de migration do repo, 5 sem controle dependente do snapshot
(2 delas nem o carregam) — e **1 bomba: `db/test-tint-promote-tombstone-fase5.sh`**. A pré-condição dela
exige que o snapshot PURO traga a v6 de `tint_promote_sync_run` (marca `_fl_culpa`, linhas 52-55) e a T0
exige que, sem a migration, o promote morra com 23514 (linhas 126-127): o snapshot TEM de ser o estado do
incidente. A 5b#1 (`20260924120000`) consta ✅ em `docs/agent/tintometrico.md`; quando o re-dump levá-la ao
snapshot, a T0 fica vermelha sem defeito — e as sabotagens F1/F2 caem no guard "já aplicada" da própria
migration. **Não corrigida aqui** (outra prova, outro domínio): o conserto tem a forma desta — aplicar a v6
de um artefato imutável por cima do snapshot antes da T0.

**O acervo legado** segue com 233 provas de PGBIN fixo (`^PGBIN="/opt/homebrew/opt/postgresql`; eram 234 no
#2855, menos esta). Nenhuma nasceu depois do harness: portá-las é trabalho de quem precisar delas no CI, não
resíduo da classe "nasce presa". A FÁBRICA (o template) é portável a partir deste PR.

## Lições de método

**O runner verde não é o único consumidor do manifesto.** Com o manifesto de 1 linha, o runner deu
`SQL_PROOF_OK` — e o vitest reprovaria o PR: o gate `falsificar-exige-assert` lê o MESMO `db/nucleo-ci.txt`
e exige juiz para toda linha `falsificar=<n>`. Antes de pôr uma linha no manifesto, procure quem mais o lê
(`git grep -l nucleo-ci -- '*.test.ts'`) e rode esses testes também.

**Modelo de custo só vale depois de reproduzir o medido.** As duas primeiras extrações erraram em
silêncio: um `grep 'db/\S+'` contou o caminho `…/db/nucleo-ci.txt` do cabeçalho da listagem como prova
("entram 9", eram 8), e um regex sem `_` deixou de ler 1 das 108 linhas
(`test-sales_orders_omie_hash_unique`). Nenhuma das duas gritou. Quem pegou foi conferir a contagem
extraída contra um total conhecido (33 linhas ✅/❌ no log contra 32 lidas) e exigir que o modelo
reproduzisse a soma medida, parte a parte, antes de simular a partição nova.
