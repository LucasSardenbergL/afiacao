# CI fatia A — os 3 arquivos regenerados param de causar conflito entre PRs (2026-11-09)

> Programa "menor tempo de PR até o merge sem perder qualidade". Fatias: **A (esta)** conflito de
> arquivo regenerado · B parar cedo quando gate rápido reprova · C escopo incremental para push só de
> docs · D balancear pela faixa serial / 3 workers · E regra de push para as sessões.

## O problema (medido 06/11–09/11, API do Actions, run a run)

- 236 runs de CI em PR; **93 cancelados** por push novo = **33% do runner** (7.669 de 23.128 min).
- **51% dos minutos cancelados** (42 runs, 3.942 min) vieram de merge/sync de `origin/main` no branch.
- Mecanismo (provado no #3707: 13 cancelamentos, 5h53 do 1º push ao verde): cada sync veio 1–8 min
  depois de OUTRO PR com migration mergear. Três arquivos eram reescritos por quase todo PR com
  migration ou prova nova; o irmão mergeava, o PR ficava DIRTY, a sessão (ou o Auto-fix) re-mergeava
  a main e o CI recomeçava do zero (~110 runner-min, ~30 min de relógio por volta).
- Frequência na main desde 06/11: `audit-custom-migrations.sql` e `migrations-audit.md` em 25
  commits cada, `nucleo-ci.txt` em 32.
- Evidência ao vivo na própria entrega: o rebase deste branch conflitou no audit porque o pacote L
  do radar (e707a6d4a) mergeou com migration minutos antes.

## Por que conflitavam (o formato)

| Arquivo | Gerador | Quem CONFERE | Por que conflita |
|---|---|---|---|
| `scripts/audit-custom-migrations.sql` | `bun run audit:migrations` | **ninguém** (nenhum gate; `database.md` já dizia) | linha `Total de custom migrations: N` + toda migration nova acrescenta no FIM de cada seção (VALUES ordenado por timestamp; a última linha ganha vírgula) |
| `docs/migrations-audit.md` | idem | **ninguém** | bloco "Resumo" com contagens + inventário que cresce no fim |
| `db/nucleo-ci.txt` | à mão | `db/roda-nucleo-ci.sh` (parse estrito, sha256 nos recibos, união) e `scripts/falsificar-exige-assert-gate.ts` (R3) | prova nova entra no fim → dois PRs inserem no MESMO ponto |

## Opções avaliadas

- **`merge=union`** — descartada. No SQL a vírgula da última linha do VALUES vira lixo; a contagem
  "Total" vira duas linhas; e o próprio `.gitattributes` já registra que no manifesto a duplicata é
  rejeitada pelo runner. Não precisei confirmar se o GitHub honra o driver no `mergeable`: o
  resultado seria errado mesmo se honrasse.
- **Gerar na main por bot depois do merge** — descartada: commit-bot na main × sync bidirecional do
  Lovable, que já reverteu arquivo recém-mergeado (#1445, #1694).
- **Remover só a linha que sempre muda** — não basta: o fim de cada seção continua sendo o mesmo
  ponto de inserção.
- **Escolhidas:** (b) tirar do git o que é derivável e ninguém confere; (a) um arquivo por entrada
  para o que é cadastro.

## O que mudou

### 1. Audit de migrations sai do git

- `git rm` dos dois artefatos; o gerador passa a escrever em `.audit-migrations/` (no `.gitignore`).
  Caminho NOVO de propósito: se o sync do Lovable ressuscitar os arquivos antigos, são cópias mortas
  que ninguém reescreve — não voltam a conflitar (apague por PR).
- Conteúdo idêntico: o SQL gerado é **byte a byte igual** ao último versionado (`cmp` vazio); o md
  muda só as 2 linhas de instrução que diziam onde o arquivo morava.
- Checagem perdida: **nenhuma** — não havia gate; o arquivo é função pura de `supabase/migrations/` +
  do gerador. Quem precisa (SQL Editor, `psql-ro`, conferir que a migration nova foi extraída) roda
  `bun run audit:migrations` na hora. Skill `lovable-db-operator` passo 6, `database.md`, runbook e
  `validation-queries.md` atualizados.

### 2. Manifesto do núcleo em fragmentos

- Manifesto EFETIVO = `db/nucleo-ci.txt` + `db/nucleo-ci.d/*.txt` em ordem `LC_ALL=C`. **Prova nova
  entra num fragmento próprio**; editar linha existente continua no `.txt`. Nenhuma linha existente
  mudou de lugar (o conjunto, a ordem e a partição atuais ficam iguais — ver Validação).
- O runner aplica o MESMO parse estrito a cada fonte, e o erro cita `fonte:linha`. Novos abortos:
  duplicata ENTRE fontes; no diretório, qualquer coisa que não seja `<prova>.txt` regular sem espaço
  no nome (`.md`, symlink, subdiretório) — ignorar em silêncio tiraria uma prova do merge; fragmento
  sem linha de prova (rascunho não é cadastro).
- sha256 dos recibos: sem fragmento, o do arquivo (como antes); com fragmentos, o do fluxo
  `== <fonte>` + conteúdo, na ordem de leitura.
- `MANIFESTO` explícito no ambiente (o `db/falsifica-nucleo-ci.sh`, no espelho) só lê fragmentos se
  `MANIFESTO_D` também vier — os casos antigos do harness seguem determinísticos.
- R3 (`falsificar-exige-assert-gate.ts`): `lerCorpoDoRepo` lê o manifesto efetivo
  (`lerManifestoEfetivo`, mesma ordem de bytes), com marca de fronteira `#== <fonte>`; a violação
  aponta o fragmento e a linha dentro dele.

## Validação (evidência)

- `NUCLEO_PARTE=i/5 bash db/roda-nucleo-ci.sh --lista`, i = 0..4, runner da main × deste branch na
  MESMA base: as 5 partes iguais e a união igual (207 provas).
- Simulação num clone descartável, dois branches da mesma base com uma prova nova cada:
  **antes** → o 2º merge conflita em `db/nucleo-ci.txt`; **depois** → 2º merge limpo, e
  `git merge-tree --write-tree` (o algoritmo do servidor) também limpo.
- `db/falsifica-nucleo-ci.sh`: 10 casos novos de fragmento — 3 controles verdes (a prova do fragmento
  EXECUTA, 2/2; `MANIFESTO` explícito sem `MANIFESTO_D` lê 1/1; a fiação PADRÃO lê `db/nucleo-ci.d`) e
  7 sabotagens com a marca certa (duplicata cruzada, linha malformada citando `b.txt:2`, `.md` no
  diretório, fragmento vazio, symlink, subdiretório, nome com espaço) + a fiação padrão abortando em
  fragmento com prova inexistente.
- vitest do R3: fragmento volta com a fonte e a linha dentro dela; ordem de BYTES (`Z.txt` antes de
  `a.txt`, ao contrário do locale); `.md` não entra; sem o principal é `null`.

## Segunda opinião

Codex não consultado: `scripts/codex-async.sh` saiu **79** (cota 92%, teto 85%, reabre 11/11 07:47).
Não é money-path → **Caminho B**: auto-challenge + revisão independente do diff por subagente antes
do PR. `sem-codex: cota acima do teto (79)`.

## Como medir o efeito (consulta, não máquina)

Janela antes (06/11–09/11) × janela depois (7 dias após o merge): fração dos minutos de runs de PR
cancelados cujo push seguinte foi um merge de `origin/main`.

```bash
gh api --paginate "repos/LucasSardenbergL/afiacao/actions/runs?event=pull_request&created=>=AAAA-MM-DD&per_page=100" \
  --jq '.workflow_runs[] | select(.name=="CI") | [.id,.head_branch,.head_sha,.conclusion,.run_started_at,.updated_at] | @tsv'
```

Para cada run `cancelled`, o run seguinte do mesmo `head_branch`: se o `head_sha` dele é um commit
de merge cujo 2º pai está na main (`gh api repos/…/commits/<sha> --jq '.parents|length'` = 2 e
mensagem `Merge … origin/main`), o cancelamento conta como "por sync". Critério de sucesso: a fração
cai de ~51% dos minutos cancelados; se não cair, o próximo ímã é `db/nucleo-ci-custo.txt` (15
commits no mesmo período, ordenado alfabeticamente — conflita só quando duas provas novas ficam
vizinhas).
