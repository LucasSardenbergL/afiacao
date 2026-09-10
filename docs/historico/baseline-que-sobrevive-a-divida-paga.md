# A baseline que sobrevive à dívida paga — e a máquina que não percebe

> **A classe (2026-09-07):** uma exceção registrada (`baseline`, `allowlist`, `known-issues`) é
> criada com uma **condição de validade** — aqui, *"a Parte A não consegue medir esta função"*.
> A condição morre sozinha; a entrada, não. Quando duas máquinas leem a mesma baseline e **só uma**
> sabe reconhecer que ela foi superada, o resultado não é um alarme a menos: é um alarme **que
> aponta o arquivo errado** e sobrevive a toda tentativa de regravar o carimbo.
>
> A regra que fica: **toda entrada de exceção declara o que a mataria, e alguma máquina cobra a
> poda.** Exceção sem gatilho de expiração é dívida que rende juros na direção do diagnóstico.

## O achado, como ele chegou

O `bun run authz:carimbo` reportava, resistindo a toda regravação:

```
MD5_DIVERGIU: public.get_defasagem_cliente (20260718190000_authz_capability_matrix_e2.sql):
  esperado 037ede84a229d5798214511433afb65d, prod tem 7856c3052596d66a6f5ac8eb0a06c1c0
  (aberto desde 2026-09-06)
```

A mensagem manda investigar a `20260718190000_authz_capability_matrix_e2.sql`. Ela é **inocente**.
Quem redefiniu a função foi a `20260905225613_preco_ausente_nao_e_zero.sql`, de 05/09 — e não por
reescrita da definição viva, mas com um `CREATE OR REPLACE FUNCTION` **literal** (linha 848).

Prod não derivou. Quem envelheceu foi a **referência**.

## Por que o achado era imortal

`AUTHZ_REESCRITAS_CONHECIDAS` (`scripts/authz-reescritas-conhecidas.ts`) existe para declarar o que
a Parte A do `authz:check` **não mede**: migrations que recriam uma função lendo
`pg_get_functiondef()`, transformando por regexp e devolvendo por `EXECUTE`. Sem `CREATE` no texto,
o last-writer que a Parte A enxerga não é a última definição. A entrada ancora um `md5ProdEsperado`
para que a desculpa vire asserção verificável.

Duas máquinas leem essa lista, e é aqui que o desenho tinha um buraco:

| máquina | o que faz quando um `CREATE` parseável POSTERIOR aparece |
|---|---|
| `scripts/authz-gate-check.ts` (Parte D) | `if (mention && mig.file.localeCompare(mention.file) <= 0) continue;` — **emudece**, e com razão: a Parte A voltou a medir a definição real |
| `db/audit-authz-reescritas-prod.ts` (asserção B) | itera `AUTHZ_REESCRITAS_CONHECIDAS` **cegamente** e cobra o md5 registrado |

O silêncio da primeira é o que torna a segunda perigosa. O gate estático não reclama *justamente
porque a dívida foi paga* — então nada no CI diz que a entrada virou zumbi. E o auditor de prod,
que não conhece a regra de posterioridade, segue exigindo o md5 de um corpo que não existe mais,
**imprimindo `r.arquivo`**: o arquivo da baseline, não o da migration que mudou a função.

Regravar o carimbo não resolvia porque o carimbo grava a **medição**, e a medição estava certa: prod
tinha mesmo `7856c…`. O errado era o valor **esperado**.

## A varredura: eram duas, não uma

O reflexo — corrigir o caso relatado — teria deixado a metade. Cruzando cada entrada da baseline com
o last-writer textual real (`extractObjects` de `scripts/lib/migration-objects.ts`, a receita
canônica de `bodyMd5` do repo):

| função | baseline aponta | last-writer REAL | md5 do repo | md5 de prod | veredito |
|---|---|---|---|---|---|
| `public.get_preco_cockpit` | 20260718190000 | **20260906164001** | `4f3fb7df…` | `4f3fb7df…` | superada |
| `public.get_defasagem_cliente` | 20260718190000 | **20260905225613** | `7856c305…` | `7856c305…` | superada |
| `public.reposicao_pos_candidatos` | 20260814022626 | 20260814000125 (anterior) | `2439966a…` | `632964445…` | **vigente** |

A `get_preco_cockpit` estava a um dia de produzir o mesmo alarme: a migration que a superou é de
06/09 e ainda não tinha divergido só porque congelou no repo exatamente o corpo que roda.

**O md5 novo foi DERIVADO do repo, não copiado de prod.** A diferença é o que separa correção de
absorção de drift: copiar o corpo vivo tornaria o gate incapaz de ver a próxima deriva. Aqui o md5
do corpo da migration bateu com prod — e essa igualdade **é a asserção**, não a fonte.

## O que mudou

1. **Poda.** As duas entradas superadas saíram de `AUTHZ_REESCRITAS_CONHECIDAS`. Não foram
   *reapontadas* para a migration nova: reapontar declararia que a `20260905225613` reescreve a
   definição viva, e ela não faz isso — usa `CREATE OR REPLACE` literal. A entrada teria virado uma
   afirmação falsa, e ainda manteria a função sob regime de exceção (aviso) sem necessidade.
2. **`REESCRITA_BASELINE_OBSOLETA`** (`scripts/authz-gate-check.ts`, Parte D): erro que bloqueia PR
   quando uma entrada da baseline foi superada por um `CREATE` **parseável** posterior. É o `else`
   exato do desempate que já existia — nenhuma heurística nova — e nomeia a migration que pagou a
   dívida, que era o dado ausente no diagnóstico. Fail-closed no `parsed`: menção não-parseável não
   devolveu medição à Parte A, e ali a entrada continua justificada.
3. Dois testes em `scripts/authz-gate-check.test.ts`: o sintético da regra, e o canário que roda
   `auditCompleto` sobre o repo real e cai quando a baseline precisa de poda.

O gate roda **no CI, sem banco** — é o ponto certo, porque a poda é acionável por PR. Na prática o
PR que mergeia a migration nova passa a falhar até podar a baseline: a poda vira parte da entrega,
em vez de dívida descoberta dois dias depois por um alarme que culpa outra migration.

## O que generaliza

- **A condição de validade de uma exceção é um fato mutável, e alguém precisa vigiá-la.** Prazo aqui
  não é data: é a chegada de um `CREATE` parseável posterior.
- **Duas máquinas lendo a mesma baseline com regras diferentes é o defeito**, não a redundância. A
  que sabe mais (o gate estático conhecia a posterioridade) tem de *contar* o que sabe, não só usar
  para se calar.
- **Mensagem de alarme que imprime o campo registrado em vez do fato medido acusa o inocente.** O
  `MD5_DIVERGIU` nomeava `r.arquivo` — a baseline —, nunca o `CREATE` posterior que era a causa.
- **Regravar a evidência não conserta a referência.** Quando um achado sobrevive à regravação do
  carimbo, a suspeita certa é que o valor *esperado* apodreceu, não que a medição falhou.

## A mesma classe em PROSA — a limitação que sobrevive à capacidade (2026-09-10, #2455)

A entrada não precisa ser `baseline` para ter condição de validade. Texto IMPRESSO por ferramenta
também tem, só que implícita — e nenhuma máquina a cobra.

- **O caso.** O `sonda:sql` imprimia no PASSO 1 *"É o bloco do FOUNDER: lê o vault e faz INSERT"*,
  e o `pendencias:deploy` mandava *"founder cola no SQL Editor"*. A condição de validade, nunca
  escrita, era *enquanto a sessão só tiver o `psql-ro`*. Ela morreu em 2026-09-08 com o
  `bun run db:aplicar` (o envelope); o texto, não. A skill `/fecho` e o `docs/agent/database.md`
  repetiam a mesma ideia (*"**Toda** DDL/DML é colada"*, *"eu **nunca** aplico escrita"*).
- **O custo é multiplicado pelo leitor.** Prosa impressa por ferramenta é lida como instrução por
  TODO agente que a roda: cada um herdava a limitação e devolvia ao founder um passo que deveria
  executar. Nenhum teste pega — os testes casam o texto (que ele é impresso), não a verdade dele.
- **E ela se propagava para artefato.** `db/sonda-pos-deploy-desconto-backfill.sql`, gerado em
  2026-09-09 (#2452), nasceu com *"É o bloco do FOUNDER"* — e o ledger `db_aplicacoes` o registra
  como `aplicada`, **pela sessão**. A frase que dizia "só o founder consegue" estava dentro de um
  arquivo que a sessão executou.

O que generaliza daqui:

- **Capacidade nova exige varrer, na MESMA entrega, a prosa que a nega.** `git grep` das frases de
  impossibilidade (*"founder cola"*, *"eu nunca"*, *"só o founder"*) no texto impresso por script,
  nas skills e em `docs/agent/`. É a poda da baseline, só que sem máquina para cobrar.
- **Reescrever é nomear o caminho real COM a condição que o torna válido — sem apagar a ressalva
  que continua verdadeira.** O `psql-ro` segue recusando escrita, e é isso que explica por que o
  envelope existe; o texto novo diz as duas coisas.
- **Limitação ≠ guardrail.** Limitação é fato sobre capacidade e envelhece quando ela muda;
  guardrail é decisão de desenho e não envelhece com ela (a skill `bi-colacor` diz *"Escrita é
  sempre do founder"* por escolha do money-path, e ficou). **Recibo também não se reescreve:** os
  `db/sonda-*.sql` aplicados têm o `sha256` dos bytes no ledger.
