# A prova da ótica canônica entra no núcleo do CI — e a fábrica de provas presas ao laptop virou resíduo

**2026-10-07** · `db/test-v-titulo-baixas-otica-canonica.sh` → `db/nucleo-ci.txt` (Eixo 6) · money-path ·
continuação do [fin-movimentacoes-duas-oticas-do-mesmo-pagamento.md](fin-movimentacoes-duas-oticas-do-mesmo-pagamento.md)

## O que mudou

A prova da `v_titulo_baixas` (21 asserts, nascida no #2423) é quem garante a escolha de ótica que impede
a dupla contagem do mesmo pagamento em `fin_movimentacoes`. Ela trazia `PGBIN="/opt/homebrew/..."`,
`brew --prefix` e `cp -Rn` do Cellar: só rodava no macOS. Pelo critério do repo, prova fora do CI é
ausência de dado — quem editasse a view e reintroduzisse a dobra passaria verde no merge.

Troca só do boilerplate pelo `db/lib/pg-harness.sh` (PGBIN por plataforma, com conferência POSITIVA da
major — `-x` sozinho aceita um initdb de outra versão; fail-closed, PG ausente é ERRO e nunca skip).
Nenhum assert, seed ou migration mudou. Entrou no Eixo 6 com mínimo **21**.

## Evidência (laptop, PG 17.10)

- O log da prova é **idêntico byte a byte** antes e depois do porte (`diff` exit 0, mesmo caminho nas
  duas rodadas para os caminhos absolutos não mascararem a comparação): `RESULTADO: 21 ok / 0 fail`.
- Runner com manifesto de uma linha (`MANIFESTO=… bash db/roda-nucleo-ci.sh`): exit 0,
  `asserts=21 (≥21)`, 2 s e 6 s em duas rodadas, `SQL_PROOF_OK provas=1/1`.
- `bun run lint:shell`: 0 achados.

## Sabotagem inline entra no mínimo do manifesto de graça

A ZONA 5 roda em toda invocação, então o **21 conta com as 6 sabotagens (F1-F6), a A9 e os dois asserts
de restauração**. Tirar uma sabotagem derruba a contagem para 20 e reprova o CI — é o R1 abaixo. Um modo
separado de falsificação só roda no CI se a linha do manifesto o declarar (3º campo), e esquecer a
declaração é ausência de dado. Quando o custo cabe na invocação normal, inline é o desenho que não
depende de ninguém lembrar.

## Falsificação externa: a migration REAL sabotada, o runner reprovando

O dente da ZONA 5 é contra uma view furada construída no próprio teste. Falta provar que o caminho
VERMELHO sobreviveu ao porte de ponta a ponta — então as sabotagens aqui são na **migration real**, num
ESPELHO em tmpdir (nunca em `supabase/migrations/`, que é DR), e quem tem de reprovar é o **runner do
núcleo**, o que o CI executa. Controle verde antes da 1ª sabotagem e depois da última, na mesma
invocação. Rodado em `LC_ALL=C` e em `pt_BR.UTF-8`: **6 ok / 0 fail** nos dois.

| sabotagem na migration real | quem pega | marca exigida |
|---|---|---|
| S1 sem `DISTINCT ON` | A3 (o resumo cumulativo volta a somar) | `veio [1400\|2026-07-31\|2\|24\|titulo]` |
| S2 sem a allowlist positiva | A5 (previsão entra como baixa) | `veio [700\|2026-07-05\|1\|4\|conta_corrente]` |
| S3 sem `WITH (security_invoker = on)` | a postcondição da própria migration aborta o apply | `v_titulo_baixas FALHOU: security_invoker` |
| R1 manifesto exigindo 22 | o mínimo do runner (a prova encolheu) | `executou 21 asserts, o manifesto exige` |

Cada sabotagem confere antes que **aplicou**: arquivo diferente do original, número esperado de linhas
alteradas e nenhuma delas comentário — sabotar comentário não é sabotar.

## O custo no CI, medido

O job `provas-sql` é uma matriz de 3 partes (teto de 20 min; as partes mediram 4m36s–6m52s em
2026-10-01). A prova cai na **parte 2/3** (`NUCLEO_PARTE=2/3 … --lista`) e custa **2-6 s** (2 medições) — folga de
sobra. Detalhe da partição: ela é por POSIÇÃO (`k mod N`), então inserir uma linha no meio do manifesto
redistribui as provas seguintes entre as partes. Não abre buraco (o `provas-sql-uniao` exige o conjunto
inteiro), mas muda o balanço de custo entre elas.

## A classe, medida hoje — e o que ela NÃO é mais

Classificação pela versão de **nascimento** de cada arquivo (2026-10-07):

| | provas |
|---|--:|
| acervo total `db/test-*.sh` | 326 |
| no `pg-harness` | 76 |
| ainda com PGBIN do Homebrew fixo | 234 |
| nascidas desde que o harness existe (2026-09-07) | 40 |
| … dessas, nascidas **portáveis** | 33 |
| … dessas, nascidas presas ao laptop | 5 (4 já portadas; falta `test-oportunidade-erro-terminal.sh`, de 2026-09-24) |

Em setembro esta mesma medição dava **4 de 9** nascendo presas (44%); hoje são 5 de 40 (12,5%). A prática
virou sozinha. O template da skill `prove-sql-money-path` — que o Passo 2 manda copiar — **segue com o
PGBIN fixo**, e foi tocado em 2026-10-01 pela varredura do `-X` sem que ninguém trocasse o boilerplate.
Ele é risco **residual**, não a causa ativa: a conclusão de setembro ("o conserto da classe é o
template") envelheceu, e o que sobra é um resíduo barato de fechar.

## Duas lições de método desta entrega

**Sonda cega não é veredito.** A 1ª rodada da falsificação externa deu `3 ok / 3 fail`, e o motivo não era
a prova: o runner nomeia o log por unidade (`<nome>.<modo>.log`) e o meu verificador procurava
`<nome>.log`. Não achando o arquivo, ele reprovou — fail-closed, como devia — mas a mensagem dizia "marca
ausente", que culpa o alvo errado. Sonda que não consegue ler tem de dizer *"não consegui ler"*, nunca
*"o alvo falhou"*.

**Evidência de base velha não vale, e "sincronize antes de medir" vale para a PRÓPRIA entrega.** Esta
tarefa começou com a main 355 commits atrás. Nesse intervalo a prova ganhou o `-X` (#2696) e a A9 passou
a **extrair** o bloco `DO $post$` da migration em vez de usar uma cópia escrita no teste (#2640,
2026-09-27 — a fraqueza que eu havia anotado como achado já estava fechada); o manifesto ganhou o 3º
campo e saltou de 19 para 74 provas; e o job virou matriz com teto. Três das afirmações já escritas
morreram na re-medição. O porte foi refeito sobre a main de hoje e toda a evidência recolhida de novo.
