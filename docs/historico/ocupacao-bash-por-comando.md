# A ocupação de Bash, por COMANDO — e o remédio que custava 4,1% da doença

**Medido em 2026-09-08** · **760 sessões** (`*afiacao*` em `~/.claude/projects`), **69.737
chamadas Bash**, 62,6 MB de saída. Régua:
[`scripts/ocupacao-contexto.sh --por-comando`](../../scripts/ocupacao-contexto.sh).
Antecedentes: [`ocupacao-por-arquivo-linha-de-base.md`](ocupacao-por-arquivo-linha-de-base.md)
(Bash = 77,1% da ocupação) e [`piso-de-contexto.md`](piso-de-contexto.md).

## 1. A pergunta, e por que a resposta fácil está errada

A linha de base apontou para Bash e parou lá: comando não tem `file_path`, então os 65.754
chamados viraram **uma linha só**. A pergunta seguinte — *qual* comando — tem uma resposta
barata e ruim: a primeira palavra. Ela é ruim porque a primeira palavra quase nunca produziu
os bytes:

```
echo "--- worktrees ---" && git worktree list | head -40
```

classifica como `echo` (20 chars) em vez de `git worktree` (40 kB). O `piso-de-contexto.md` já
tinha registrado o preço: por prefixo, **46,5% das chamadas caem em "outros"**.

A régua usa outra regra — **o produtor é o head-word do 1º estágio de cada PIPELINE**
(segmenta em `;` `&&` `||` e *newline*; dentro do pipeline só o 1º estágio produz, o resto é
filtro; `command`/`sudo` e prefixo `FOO=bar` são descascados; palavra de sintaxe é removida e o
segmento reprocessado, enquanto `echo`/`cd` pulam o segmento inteiro).

| método | não classificado (chamadas) | da ocupação |
|---|---:|---:|
| por prefixo (1ª palavra) | 46,5% | — |
| **por produtor de pipeline** | **0,3%** | **0,1%** |

O percentual é **impresso junto da tabela** (`TAXONOMIA-NAO-CLASSIFICADO`), e acima de 25% a
régua declara `TAXONOMIA-FRACA`. Um ranking de 54% do volume passa por ranking do volume se o
número não aparecer ao lado — é `ausente ≠ zero` aplicado a taxonomia.

## 2. A resposta

% da ocupação **total** (todas as ferramentas, 692 sessões / 30d):

| produtor | n | chars tot | % ocupação |
|---|---:|---:|---:|
| `sed` | 5.443 | 13.511.231 | **20,2%** |
| `(Read - sem comando)` | 1.595 | 12.022.172 | 17,2% |
| `grep` | 10.716 | 9.877.075 | **12,9%** |
| `cat` | 5.286 | 7.099.938 | **11,3%** |
| `ls` | 1.632 | 1.929.001 | 2,6% |
| `wc` | 879 | 1.455.547 | 2,5% |
| `psql-ro` | 4.049 | 2.334.941 | 2,4% |
| `git show` | 1.786 | 2.399.274 | 2,2% |
| `head` | 1.091 | 1.633.031 | 2,0% |

> **`sed` + `cat` + `head` + `tail` ≈ 35% de TODA a ocupação de contexto é leitura de arquivo
> feita por shell** — oito vezes o `docs/agent` inteiro (4,2%).

E isto **não é desleixo**: o modo auto deste harness instrui explicitamente a ler arquivo com
`cat`/`head`/`sed -n` em vez da tool `Read`. A alavanca não é "pare de usar `cat`" — é o teto.

## 3. Correção à linha de base: metade do balde "sem arquivo" TEM arquivo

`--ver-shell` extrai o argumento-caminho de `sed -n X,Yp F` / `cat F` / `head -n F` / `tail F` e
atribui ao arquivo. Resultado: **1.101,6M de 2.180,6M tok×req (50,5%) da ocupação de Bash tem
nome de arquivo** — e estava inteira dentro de `(Bash - sem arquivo)`.

| pasta | ocupação lida via shell | a linha de base reportava (só `Read`) |
|---|---:|---:|
| `src/` | 209,0M | 1,6% |
| `scripts/` + `db/` | 179,3M | 1,4% |
| `supabase/` | 170,1M | 0,9% |
| `docs/agent/` | 108,8M | 4,2% |

O flag é **opt-in**: a linha de base de 2026-09-07 foi medida sem ele e continua reproduzindo.

## 4. O nudge: ensinou, mas não corrige por evento — e cobra por isso

`bash-contexto-nudge.sh` entrou em **2026-07-31**. A comparação antes/depois é favorável
(média 1.103 → 886 chars; `≥4.000` de 5,33% → 3,74% das chamadas) e **não prova nada**: mudou o
mês, o volume (4.356 vs 64.453 chamadas) e a mistura de tarefas. Este repo já refutou três
hipóteses plausíveis assim.

O teste que separa nudge de reversão à média é a **descontinuidade no gatilho**: comparar a
chamada seguinte a um disparo (`≥4.000`) com a seguinte a um quase-disparo (3.000–3.999, que
não dispara nada), nas duas eras. O confundidor óbvio — "os gatilhos da era B são maiores" — foi
medido e **descartado**: mediana 5.821 vs 5.933, p90 14.026 vs 13.885. É o mesmo objeto.

| | após disparo | após quase-disparo | razão |
|---|---:|---:|---:|
| era A (sem hook) — mediana da seguinte | 1.208 | 1.326 | 0,91 |
| era B (com hook) — mediana da seguinte | 1.282 | 1.140 | **1,12** |

A descontinuidade aponta para o lado **errado**. E o teste mais justo — o hook pede uma sintaxe
específica, ela foi adotada? — dá a resposta precisa:

| grupo | `head -c`/`cut -c` na chamada seguinte |
|---|---:|
| era A, após disparo (n=231) | **0,0%** |
| era A, após quase-disparo (n=122) | **0,0%** |
| era B, após disparo (n=2.407) | 46,1% |
| era B, após quase-disparo (n=1.354) | **51,4%** |

**O hook ensinou** — a sintaxe não existia no comportamento anterior, em nenhum dos dois grupos.
**Mas o disparo individual não faz nada**: a adoção depois de um disparo é igual (ligeiramente
menor) que depois de um quase-disparo que não emitiu texto nenhum. O efeito é de **ambiente**,
não de evento.

### O preço do remédio

O `additionalContext` do hook entrou **2.726 vezes**, 2,18 MB, **88,7M tok×req = 4,1% da
ocupação do próprio Bash** que ele existe para reduzir — ≈3,1% da ocupação total, ou **três
quartos de todo o `docs/agent`**. Média de 5,0 disparos por sessão; só o 1º de cada sessão vale
17,3% desse custo.

> Uma medição intermediária deu 16,4% e estava **errada**: cada disparo grava **três**
> `attachment` (registro de execução com `stdout`/`exitCode`, `systemMessage` em string, e
> `additionalContext` em **array**) e só o terceiro chega ao modelo. Contar os três inflou 4×.

## 5. Os cortes, com número

| corte | economia | estado |
|---|---:|---|
| **1º disparo ensina, repetições só lembram** (886 → 95 chars) | **65,4M tok×req = 72,9% do custo do hook ≈ 3,0% da ocupação de Bash** | ✅ aplicado |
| deduplicar comando idêntico repetido na mesma sessão | 20,9M = **1,0%** | ❌ refutado — não paga |
| baixar o teto de saída para 8.000 chars | 171,3M = 7,9% da ocupação de Bash | 🧭 decisão do founder |
| … para 4.000 | 404,1M = 18,5% | 🧭 |
| … para 3.000 | 537,1M = 24,6% | 🧭 |
| … para 2.000 | 757,8M = **34,8%** (≈26,8% da ocupação TOTAL) | 🧭 |

**O teto já existe**, e a evidência é a forma da distribuição: entre 20k e 29k a frequência é um
platô achatado (11·26·18·12·9·12·10·10·13 por faixa de 1k) e acima de 29.000 há **zero** em
69.737 chamadas. Saídas que seriam de 50k ou 1 MB foram todas grampeadas para dentro da faixa.
Baixar esse teto é uma chave, não um refactor — a lição "procure a chave" do `piso-de-contexto.md`.
É mudança de raio grande (trunca toda sessão do repo), por isso fica como proposta com número.

Baixar o **gatilho** do nudge não é alternativa: ele já vê 38,7% da ocupação e é cego aos outros
61,3%, que estão em chamadas pequenas — **77,9% das chamadas ficam abaixo de 1.000 chars e ainda
somam 22% da ocupação**. Avisar nelas seria ruído em 4 de cada 5 comandos.

## 6. Quatro armadilhas que este levantamento pagou

1. **`awk -f prog.awk '{programa inline}' dado.tsv`** — com `-f`, o awk trata o programa inline
   como **nome de arquivo**. Programa vazio, nenhuma saída, **exit 0**. A tabela vazia quase
   virou "não há o que classificar". Dois `-f` resolvem. Família da armadilha #17 de
   [`evidencia-positiva-shell.md`](evidencia-positiva-shell.md).
2. **`read` com `IFS=tab` colapsa delimitadores consecutivos** (tab é whitespace): um campo do
   meio vazio desloca todos os seguintes, e o *comando* escorregou para dentro de `$sessao`.
   Pego pela suíte existente do hook. Corrigido com placeholder `-`, nunca campo vazio.
3. **Filtro que engoliu o próprio alvo**: para evitar que o script do `sed` virasse "arquivo", eu
   descartava o 1º não-flag — mas em `sed -n '1,120p' arquivo` o range já saía pela regra
   numérica, então o descartado era **o arquivo**. A atribuição saiu 50% subcontada até a
   conferência contra o total.
4. **`sed 's|...\|...|'`** — delimitador `|` colidindo com `\|` no padrão. O arnês de falsificação
   recusou como *"sabotagem vazia"* em vez de contar como cobertura: uma sabotagem que não
   sabota aprova o invariante que deveria testar.

## 7. Como re-medir

```bash
bash scripts/ocupacao-contexto.sh --por-comando --dias 30
bash scripts/ocupacao-contexto.sh --por-arquivo --ver-shell --dias 30
```

Termina em `OCUPACAO-CONTEXTO-OK`; **sem esse marcador, a tabela na tela não é um resultado**.
Provas: `scripts/test-ocupacao-por-comando.sh` (17 casos, 11 sabotagens) e
`scripts/test-bash-contexto-nudge.sh` (o corte por sessão, 3 sabotagens) — ambas com controle
verde na mesma invocação antes do 1º `sed` e nos dois locales.

## 8. Lição transferível

> **Meça o preço do remédio na MESMA unidade da doença.** O nudge foi entregue para reduzir a
> ocupação de Bash e passou a ser 4,1% dela. Isso não estava escondido: a régua só não olhava
> para lá, porque contava `tool_result` e o hook escreve `attachment`.
>
> **"Funcionou" tem duas versões e elas se separam.** Aqui o hook ENSINOU (0% → 48% de adoção de
> `head -c`) e o disparo individual não fez nada (46,1% vs 51,4% contra o controle). Quem mede só
> antes/depois vê a primeira e paga a segunda para sempre. O que separa as duas é um controle
> que sofre o mesmo viés sem receber o tratamento — aqui, a saída de 3.000–3.999 chars.
>
> **Antes de rankear, meça quanto o seu classificador NÃO classifica — e imprima.** Por prefixo
> eram 46,5%; a régua com 0,3% responde a mesma pergunta. A diferença entre "o resto é pequeno" e
> "o resto eu não sei ler" nunca está na tabela.
