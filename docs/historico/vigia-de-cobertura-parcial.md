# O vigia que cobria METADE do que vigiava (`test:hooks`, 2026-08-22)

**Classe:** um gate anti-órfão pode ele mesmo ser parcial. Quando a superfície vigiada tem **duas
formas** e o gate só conhece **uma**, a metade não-vigiada acumula órfãos em silêncio — e a
existência do gate é justamente o que impede alguém de desconfiar.

## O que era

`scripts/hooks-guard-cobertura.test.ts` (criado após 2 suítes de guard passarem despercebidas)
cobrava que todo `scripts/test-<x>-guard.sh` estivesse no `for t in ...` do `test:hooks`. O
comentário dele é a doutrina certa: *"teste que existe e não roda é AUSÊNCIA DE DADO, não
aprovação — o guard pode regredir sem nada ficar vermelho"*.

Só que o `test:hooks` tem **DOIS laços**:

```
for t in <8 alvos>; do bash scripts/test-$t-guard.sh || exit 1; done;
for t in <10 alvos>; do bash scripts/test-$t.sh      || exit 1; done
```

O parser era `/for\s+t\s+in\s+([^;]+);/` — **`exec`, não `matchAll`**: casava só a PRIMEIRA
ocorrência. O 2º laço (o das suítes sem sufixo `-guard`) não era coberto por ninguém, e o
`alvosNoDisco` só enxergava arquivos `-guard.sh`. Descoberto no #1891, ao acrescentar
`claude-md-budget` ao 2º laço e notar que nada cobrava aquela metade.

**Saldo: 9 suítes órfãs** — existiam, passavam, e nenhum workflow as rodava.

## A órfã que parecia coberta

`test-lovable-revert-scan.sh` foi inicialmente descartada da lista porque o
`.github/workflows/lovable-watch.yml` cita o nome dela. Mas a citação está num **COMENTÁRIO**
(linha 57, *"Lógica testável fora do CI: …"*); o passo executável roda
`scripts/lovable-revert-scan.sh` — **o script de produção, não a suíte**. Corolário: `grep <nome>`
num workflow prova MENÇÃO, não EXECUÇÃO — a prova é o `run:`.

## Órfã ≠ órfã: a triagem antes de catalogar

Rodar as 9 uma a uma mudou a decisão (órfã VERMELHA se conserta, não se cataloga):

- **7 verdes, herméticas e baratas (~53s somados)** → entraram no 2º laço, que é o remédio de
  verdade: `hooks-sessionstart` (12s), `pr-watch` (12s), `preflight-migration` (3s),
  `tokens-report` (6s), `verify-edge-pat` (1s), `wt-reap` (0s), `lovable-revert-scan` (19s).
  Todas montam o próprio mundo (mktemp, `git init`, stub de `curl`/`gh` no PATH,
  `AFIACAO_HEAVY_DEST`) — imunes inclusive ao checkout raso (`fetch-depth: 1`) do runner.
- **2 macOS-only** → baseline explícita com motivo, em `scripts/hooks-suites-baseline.ts`:
  `test-heavy.sh` (semáforo de RAM real com N processos em disputa; `sysctl`/`stat -f`; ~50s — era
  também flaky, ver a seção abaixo) e `test-heavy-install.sh`
  (compara inode com `stat -f %i`, **BSD**: no GNU do ubuntu `-f` é *outra* flag — status do
  filesystem — então não falharia, passaria **medindo a coisa errada**, que é pior que vermelho).

## O que ficou no lugar

O vigia não extrai mais `<x>`: **expande cada laço para os ARQUIVOS que executa** e compara
conjunto-a-conjunto com o disco, tirando o molde do nome do **corpo** do laço. Um 3º laço com outro
padrão passa a ser coberto sozinho, sem editar o vigia. Cobra nos dois sentidos (órfã e fantasma)
e faz **burn-down** da baseline: entrada que voltou a rodar, ou que sumiu do disco, fica VERMELHA —
baseline que não encolhe vira álibi. Isenção sem motivo escrito também reprova.

## O flaky do `test-heavy.sh`: medir primeiro, depois consertar (2026-08-23)

A 1ª rodada de triagem viu 1 vermelho em 3 e o registro saiu como *"2 verdes e 1 vermelho em 3"* —
número que lê como **33%** de flaky. Medindo direito (10 execuções seguidas, capturando **qual
asserção** falha e a carga da máquina, não só o exit code): **11 verdes em 13, ~15%**, e **sempre a
mesma** asserção — `--status explica a sobrecarga em palavras`.

Com a assinatura na mão, a causa apareceu no setup do caso, não no alvo:

```bash
AFIACAO_MAX_HEAVY=2 "$HEAVY" sleep 30 &   # ocupante A
sleep 1
AFIACAO_MAX_HEAVY=2 "$HEAVY" sleep 30 &   # ocupante B
sleep 2                                   # ← sincroniza por DURAÇÃO
st=$(AFIACAO_MAX_HEAVY=1 "$HEAVY" --status | grep "em uso")
```

O teste tratava *"passaram 2 segundos"* como prova de *"os 2 ocupantes registraram slot"*. Sob a
carga real da máquina (load 30–79 com ~36 sessões) o 2º às vezes não chegava a tempo, e a asserção
media um mundo **meio-montado**: acusava o `--status` de um defeito que era do próprio setup.

Consertado com espera por **CONDIÇÃO** (`esperar_slots`, que faz poll no `n_slots` já existente),
**fail-closed**: se a condição não chega no timeout, o teste reporta falha de **SETUP** por escrito.
Esperar-e-seguir teria trocado um vermelho confuso por um verde mentiroso.

Duas lições de método:

- **Exit code não é diagnóstico.** Enquanto eu só colhia `exit=1`, o flaky parecia aleatório e o
  remédio óbvio era "isolar/tolerar". Capturar a MARCA da asserção transformou 30 minutos de
  medição num conserto de 4 linhas.
- **Número apressado vira dívida.** "1 em 3" (n=3) e "1 em 7" (n=13) levam a decisões diferentes, e
  o primeiro já estava commitado. Amostra pequena merece o `n` explícito ao lado.

## Lições

1. **Gate anti-órfão é código como outro qualquer — pergunte de que ele é cego.** O sintoma é
   sempre o mesmo: gate verde sobre superfície que ele nunca leu.
2. **`exec` casa UMA vez; `matchAll` casa todas.** Um regex de gate sem `/g` (ou com `exec` fora de
   laço) é um gate que lê o primeiro item e declara o resto em dia.
3. **Prefira o conjunto-alvo ao identificador.** Comparar *arquivos executados* × *arquivos em
   disco* é robusto a mudança de convenção; comparar `<x>` extraído presume o sufixo de hoje.
4. **Menção num workflow não é execução.** Só o `run:` conta.
5. **Antes de catalogar dívida, RODE.** Órfã vermelha ou flaky não vira linha de baseline: vira
   conserto, remoção, ou isenção com o motivo técnico escrito por extenso.

## O 2º eixo: a mesma classe em `.ts` (2026-08-23)

A nota de "fora de escopo" acima era, ela mesma, dívida — e envelheceu bem: `scripts/test-migration-objects.ts`
existia desde o #922, **verde**, com 13 asserções, e ninguém a rodava. Não casava o
`scripts/**/*.test.ts` do vitest (`vitest.config.ts:11`) — é `test-*.ts`, não `*.test.ts` — nem os
laços do `test:hooks`, nem nenhum `run:` de workflow.

**O que ela guardava:** as ÚNICAS asserções do repo sobre `view`, `function` (identidade por
assinatura/overload), `table`, `index`, `trigger`, `cron_job` e `enum_value` do extrator do
preflight de migration. O gêmeo que roda no CI (`scripts/lib/migration-objects.test.ts`) cobre
`CREATE POLICY`, DDL dinâmica e comentário — **zero** ocorrência dos outros sete kinds. As duas
eram complementares, não duplicadas: ligar a órfã não era formalidade, era recuperar cobertura
real do gap que motivou o #922 (as views `v_grupo_*` ficavam cegas no audit).

**O detalhe que fecha o círculo.** O helper do gêmeo dizia, em comentário:
*"só as policies — o resto do extrator tem cobertura própria via corpus"*. Tinha cobertura — na
órfã. O teste de corpus só varre `CREATE POLICY`. **O comentário AFIRMAVA uma cobertura que
existia e não rodava**, que é exatamente como a classe se esconde: não é o teste que falta, é o
teste que ninguém executa sendo contado como se executasse.

**Remédio escolhido — nem renomear nem chamar explicitamente.** As duas opções óbvias eram
renomear para `scripts/migration-objects.test.ts` (entra no vitest sozinha) ou chamá-la num script
do `package.json`. Achar o gêmeo mudou a conta: as 12 asserções únicas foram **migradas para o
gêmeo** (a 13ª, `ignora CREATE comentado`, já estava lá e mais forte) e a órfã foi apagada. Ganho
decisivo no gate: o critério de "coberta" vira só *"casa o glob do vitest"*, **sem lista de
exceção**. A alternativa obrigaria o vigia a aceitar "é citada num script do package.json" como
prova — que é a fraqueza *menção ≠ execução* que este mesmo doc denuncia na seção anterior.

**O gate.** `scripts/hooks-guard-cobertura.test.ts` passou a ter DOIS eixos com critérios
deliberadamente diferentes, porque o runner de cada extensão é outro:

| eixo | superfície | "coberta" significa |
|---|---|---|
| 1 (`.sh`) | `scripts/test-*.sh` | roda num laço do `test:hooks` |
| 2 (`.ts`) | suíte `.ts` em `scripts/` + `db/` | casa um glob do `test.include` do `vitest.config.ts` |

O eixo 2 **lê o glob da fonte do `vitest.config.ts`** em vez de repetir a string: trocar o include
faz o gate acompanhar, não mentir. É a lição 3 (*prefira o conjunto-alvo ao identificador*)
aplicada ao outro eixo. E o detector de "é suíte" tem dois sentidos — por NOME (`test-x.ts`,
`x.test.ts`, `x.spec.ts`) **ou** por CONTEÚDO (importa `vitest`) — porque cada um pega o que o
outro perde: a órfã de 2026 não importava vitest (tinha `check()` próprio), e uma suíte futura
pode importar vitest com nome fora de qualquer convenção.

**Falsificação de graça.** O gate foi escrito com a órfã ainda em disco e rodado ANTES de apagá-la:
reprovou nomeando `scripts/test-migration-objects.ts` na mensagem. Só então o arquivo saiu, e o
gate ficou verde. Vermelho→verde pelo movimento certo, sem sabotagem inventada.

**Custo no CI: ~3ms — e o caminho até o número é a lição.** O diff óbvio (rodar os 2 arquivos
antes×depois no vitest) **não enxerga o efeito**. Com n=5 por braço, sob load ~40–50 e ~30
worktrees, o `tests` deu ANTES `200·221·226·289·318`ms (mediana 226) e DEPOIS
`218·250·266·332·357`ms (mediana 266) — faixas sobrepostas quase inteiras — e a mediana de
wall-clock ficou *menor* no DEPOIS (1,43s × 1,84s) **com 25 testes a mais**. O piso de ruído da
máquina (±100ms) é maior que o efeito; ler "+40ms" ali seria inventar sinal.

O número real veio de medir o custo **isolado**: dos 25 testes novos, 22 são regex em memória
(sub-ms) e 3 compartilham UMA varredura de disco. Cronometrada direto, n=50, lendo os 52 `.ts` de
`scripts/`+`db/`: **2,76ms por rodada**. Daí o ~3ms — e daí, também, o motivo de o diff ser cego.

*Método, para a próxima:* quando o efeito esperado for menor que o ruído do harness, **não meça
pelo diff do harness** — meça o trabalho acrescentado, isolado, com n alto. O diff só serve para
mostrar que o efeito é pequeno; ele não sabe dizer *quanto*.

**Calibração, medida:** dos 53 `.ts` de `scripts/`+`db/`, o detector marca 17 — 16 já cobertos pelo
glob e a órfã. Zero falso-positivo.

**Fora do eixo 2 DE PROPÓSITO:** as ~250 `db/test-*.sh`. Não são órfãs por descuido — são harnesses
"PROVA PG17" que exigem um PostgreSQL 17 vivo (ritual `prove-sql-money-path`, rodado à mão antes
de entregar migration). Cobrá-las geraria ~250 isenções de baseline no dia 1, e gate que nasce com
250 falsos-positivos ninguém lê.

**Lição 6.** *Uma nota de "fora de escopo" num doc é dívida com data de validade.* A desta página
sobreviveu um dia e só fechou porque estava **escrita**. Deixar o eixo de fora foi certo (não
inchar o #1902); não escrevê-lo teria sido a falha.
