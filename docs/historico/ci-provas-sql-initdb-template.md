# Provas SQL: `initdb` por template de cluster no shim (2026-11-12)

> Programa "push→merge mais rápido sem perder qualidade". O ponto de partida é a fatia 1 de
> [ci-provas-sql-medicao-preparacao.md](ci-provas-sql-medicao-preparacao.md): a parte barata e
> genérica, sem tocar prova, é trocar o `initdb` por cópia de um PGDATA vazio. Já estavam
> descartados o snapshot carregado (empatou) e o template de DATABASE (não isola roles, que são
> globais ao cluster). Por isso aqui o template é de CLUSTER.

## O que mudou

- **`db/lib/initdb-template.sh`** é o novo `initdb` do shim do `ci.yml` (o mesmo shim do fsync=off).
  - Na 1ª chamada de uma **chave**, roda o initdb real no `-D` pedido e guarda uma cópia parada. A
    chave é: os argumentos normalizados (sem o `-D`), `LANG`/`LC_*`/`TZ`/`PGTZ`, a versão do binário
    e "diretório vazio já existente ou não".
  - Nas chamadas seguintes, faz `cp -a` do template e repete a saída gravada, trocando o `-D`.
  - **Fail-safe**: estes casos vão ao initdb real, com os argumentos intactos:
    - argumento fora da lista, ou `-c` além de `fsync=off`/`full_page_writes=off`;
    - `-D` ausente, symlink ou não-vazio, ou `ls` dele com erro;
    - pai ausente;
    - cópia que falha;
    - `INITDB_TEMPLATE=0`.
  - A corrida dos 3 workers na 1ª chamada usa `mktemp` + `mv -T` atômico: o 1º rename vence e o
    template nunca é publicado pela metade.
- **`db/test-initdb-template.sh`** entra no núcleo com 15 asserts e `falsificar=9`. Ele sobe cada
  cluster e confere:
  - que o locale, o `-U` e o `TZ` são chave;
  - que a saída repetida cita o `-D` da chamada;
  - os casos de recusa: diretório não-vazio, argumento desconhecido, `-D` symlink e `INITDB_TEMPLATE=0`;
  - o isolamento: uma role criada no 1º cluster não aparece na cópia;
  - que o template da corrida fica utilizável.
- O `--falsificar` sabota uma CÓPIA do shim, uma camada por vez, e passou com
  **9 vermelhas / 0 falhas, controle verde**, em `LC_ALL=C` e em `pt_BR.UTF-8`.
  - A 1ª versão tinha um assert teatral, que a falsificação acusou: o A7 ficava verde com a guarda do
    não-vazio sabotada, porque a chave "vazio existente" ainda não estava quente.

## Medição no runner (mesmo PR, 2 braços)

O shim gravou 1 linha por chamada (modo, ms) e um step temporário somou por parte. A instrumentação
saiu antes do merge.

| | run | chamadas de cluster | custo do `initdb` (Σ 16 partes) | por chamada | pior parte (Σ initdb) |
|---|---|---|---|---|---|
| **A** template desligado | 43150145823 | ~1.824 + ~1.834 `--version` | **941 s** | ~510 ms real | 112,7 s (parte 13) |
| **B** template ligado | 43152319543 | 1.803 cópias + 31 gera + 1.834 `--version` | **172 s** | 80 ms a cópia | 18,9 s (parte 10) |

- **Ganho: −769 s ≈ −12,8 job-min por run** de `provas-sql` (16 partes).
- No caminho crítico, a parte mais cara em initdb perdia ~113 s divididos por 3 workers, **~25–35 s
  na pior parte**. Isso passa dos dois limiares da tarefa (15 s no caminho crítico e 3 job-min).
- Com 3 workers no mesmo runner, o initdb real custa ~510 ms, contra ~200 ms no bench serial antigo. A
  cópia custa 80 ms, contra 40–70 ms no bench.
- O tempo de job dos dois runs (Σ 80,8 → 70,7 min, pior parte 6,87 → 5,98) vai na mesma direção, mas
  é RUÍDO. 5 runs verdes de PR na main variaram de 69,9 a 81,3 min Σ e de 5,3 a 7,2 de pior parte. O
  número que vale é o do log por chamada.

## Nada mudou de comportamento

- **CI:** as 16 partes deram `success` nos dois braços. O conjunto `(prova, modo, asserts|sabotagens)`
  ficou idêntico entre A e B: 329 unidades. As exceções são as 2 linhas novas da própria prova do
  shim e o `fin-consolidado-ic --falsificar`, que no B veio em 2 faixas de 35 (#3860 entrou na main
  no meio) com as mesmas 70 sabotagens.
- **Local (macOS, PG 17.10), `LC_ALL=pt_BR.UTF-8`, template ligado, núcleo inteiro com W=3:** 343
  unidades ✅. A única ❌ foi o `--falsificar` da prova nova, rodando no meio de uma edição dela (o
  regex do A8 casava a linha nova do `-c`). Foi corrigido e re-rodado, com 9/0 nos dois locales.
- **2ª opinião Codex** (gpt-6-astra, high): **nenhum achado bloqueante** para o CI atual. Os 4 P2
  foram todos aplicados:
  - `-D` symlink publicaria um template que segue as mutações do 1º cluster;
  - erro do `ls` lido como "vazio";
  - ambiente fora da chave escapava da prova;
  - o template da corrida não era exercitado.
  - Aceito e documentado no cabeçalho do shim: o `system_identifier` é igual entre as cópias de uma
    chave (nenhuma prova replica), e mudar o `/etc/localtime` no meio do job não muda a chave.
