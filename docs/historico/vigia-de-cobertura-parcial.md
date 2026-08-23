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
  `test-heavy.sh` (semáforo de RAM real com N processos em disputa; `sysctl`/`stat -f`; **flaky** —
  2 verdes e 1 vermelho em 3 execuções na M2 com 36 sessões vivas; ~50s) e `test-heavy-install.sh`
  (compara inode com `stat -f %i`, **BSD**: no GNU do ubuntu `-f` é *outra* flag — status do
  filesystem — então não falharia, passaria **medindo a coisa errada**, que é pior que vermelho).

## O que ficou no lugar

O vigia não extrai mais `<x>`: **expande cada laço para os ARQUIVOS que executa** e compara
conjunto-a-conjunto com o disco, tirando o molde do nome do **corpo** do laço. Um 3º laço com outro
padrão passa a ser coberto sozinho, sem editar o vigia. Cobra nos dois sentidos (órfã e fantasma)
e faz **burn-down** da baseline: entrada que voltou a rodar, ou que sumiu do disco, fica VERMELHA —
baseline que não encolhe vira álibi. Isenção sem motivo escrito também reprova.

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

**Fora de escopo, fica registrado:** `scripts/test-migration-objects.ts` também não é rodado por
ninguém (não casa o `scripts/**/*.test.ts` do vitest nem os laços do `test:hooks`) — mesma classe,
outra extensão.
