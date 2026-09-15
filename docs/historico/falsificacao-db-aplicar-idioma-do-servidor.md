# A falsificação do db-aplicar no caminho obrigatório — o 2º locale era o 1º, porque ERRO×ERROR é do servidor

**2026-09-14 (#2488).** `db/test-db-aplicar.sh` prova, executando num PG17, o `scripts/db-aplicar.sh`
— o caminho pelo qual toda mudança de banco entra em PRODUÇÃO. O modo normal rodava no núcleo do CI
desde 2026-09-10; o `--falsificar` (9 sabotagens) ficou `falsificar=fora-do-ci` no #2472 com este
motivo: o executor separa falha-limpa (4) de desconhecido (5) casando ERRO×ERROR do psql, então o 2º
locale tem de ser pt_BR — e o runner ubuntu não tem pt_BR. O pedido: provisionar o locale, provar
`ERRO` numa falha real, rodar os dois locales numa invocação, falsificar o próprio caminho no CI e
medir o custo.

## A premissa caiu na primeira medição

A tradução "depende de pacote e de `lc_messages`", dizia o pedido. Medido (PG 17.10, `psql -f` com
`BEGIN; SELECT 1/0; COMMIT;`, o mesmo caminho do executor):

| servidor (`lc_messages`) | cliente `LC_ALL=C` | cliente `LC_ALL=pt_BR.UTF-8` |
|---|---|---|
| `C` | `ERROR:  division by zero` | `ERROR:  division by zero` |
| `pt_BR.UTF-8` | `ERRO:  divisão por zero` | `ERRO:  divisão por zero` |

**A palavra que o executor casa é do SERVIDOR.** O cliente traduz só o que ele mesmo gera
(`psql: erro: a conexão com o servidor…`) e os rótulos da libpq (`CONTEXTO:`). A prova subia o cluster
com `initdb --locale=C`, e o `LC_TESTE=pt_BR.UTF-8` trocava só o cliente: **a rodada pt_BR produzia as
mesmas linhas de erro da rodada C.** Executado sobre a prova da `main`, sob `LC_TESTE=pt_BR.UTF-8`, com
uma sabotagem nova que tira `ERRO` da regex: `S10 rc=4` — verde, igual à rodada C. Provisionar o
locale e ligar a falsificação como estava teria entregado **dois locales que eram um só**: a
falsificação-em-um-ambiente do #1483, agora com cara de dois.

Produção (via `psql-ro`): PG 17.6, `lc_messages = en_US.UTF-8` — a severidade que chega ao executor é
sempre `ERROR`; o pt_BR que importa lá é o do CLIENTE, no terminal do founder (`AppleLocale=pt_BR`).

## O desenho

**Três combinações servidor×cliente sobre dois clusters, numa invocação:** `c_c` (C/C), `c_pt`
(servidor em inglês + cliente pt_BR — o par de produção) e `pt_pt` (a única em que a severidade diz
`ERRO`).

- **Sondas fail-closed, resposta positiva, antes de tudo:** major do psql do shim;
  `LC_ALL=pt_BR.UTF-8 locale charmap` = UTF-8 (`LOCALE_PT_BR_AUSENTE`); `SHOW lc_messages` pela
  sessão do `claude_rw` (`IDIOMA_DO_SERVIDOR`); `psql: erro:` numa conexão recusada
  (`IDIOMA_DO_CLIENTE`).
- **Controle verde nas três antes da 1ª sabotagem**, pelo mesmo caminho delas: A1→0; A3→4 dizendo a
  severidade do SERVIDOR e o rótulo do CLIENTE; A10→2; A12→0 com o corpo intacto.
- **Juiz:** rc EXATO + marca ASCII de caixa fixa lida da saída real — o texto do próprio script (não
  muda com locale) e, quando o motivo é "o banco recusou", a mensagem do banco NO idioma, com o
  prefixo `ERROR:  ` de dois espaços. Nunca texto de fixture: num erro dentro do `EXECUTE` o psql ecoa
  o corpo inteiro — a S6 chegou a ter `RECUSA_FORA_DE_TRANSACAO` no log com o guard DESLIGADO, e a
  fixture do envelope cita a mensagem inglesa num comentário. Palavra positiva (`CERTO`) **com status 0**.
- **Expectativas fixadas pelo NOME da combinação.** A 1ª versão as calculava de `LOC_SRV`/`LOC_CLI` —
  as variáveis sob teste. Trocar o cluster do `pt_pt` para C mudaria resultado e expectativa juntos, e
  as três combinações sairiam em inglês, todas verdes (o oráculo imitando a implementação,
  [prova-que-imitava-o-oraculo.md](prova-que-imitava-o-oraculo.md)).
- **O locale do cliente conferido no log do EXECUTOR.** A sonda do cliente prova o psql, não que
  `aplicar()` encaminha o locale (P1 da 2ª rodada do Codex): sem o `LC_ALL` na chamada, `c_pt` rodaria
  como C/C e tudo seguiria verde. Medido: todo log do executor com erro do banco traz exatamente um
  rótulo da libpq — `CONTEXT:` com cliente C, `CONTEXTO:` com cliente pt_BR —, e os logs sem erro do
  banco, nenhum. O c_pt produz a linha mista que nenhum par homogêneo produz:
  `CONTEXTO:  SQL statement "…"` (rótulo do cliente em pt_BR, conteúdo do servidor em inglês); o
  `pt_pt`, `CONTEXTO:  comando SQL`. O A3 e as sete sabotagens com erro do banco exigem o rótulo.
- **Gêmeo verde por sabotagem:** antes de sabotar, o mesmo cenário na cópia intacta, nas três
  combinações, tem de terminar dizendo algo que NÃO seja `CERTO` — a regra 6 do #2487 ("marca que
  também sai no verde não é marca") medida aqui: S4 e S9 terminam com o MESMO rc do verde (0).
- **Agregação:** desfecho previsto por posição — `IGUAL` (não mudou, e era para não mudar) só na S10
  em `c_c`/`c_pt` e na S11 em `pt_pt`, `CERTO` em todas as outras; ≥1 vermelha por sabotagem; as três
  combinações exatamente uma vez cada, conferidas no laço **e** pelo disco (um log por sabotagem e
  combinação); identidade das 11 sabotagens, independente do `registra`.
- **Controles negativos:** 7 do juiz (rc certo sem a marca, marca com rc errado, severidade e rótulo
  de um idioma na saída do outro, log ausente) e 8 da agregação (morte calada, palavra seguida de
  morte, silêncio numa combinação, IGUAL nas três, IGUAL fora do previsto, CERTO sem a sabotagem, gêmeo
  que fala e morre, gêmeo calado), cada um atacando uma camada só.
- Controle de saída (cópia e bootstrap conferidos por md5 do `prosrc`, verde de volta nas três) e
  **um** recibo `SABOTAGENS:`.

**S10/S11, as sabotagens que só um idioma pega:** tirar `ERRO` da regex só o `pt_pt` pega; deixar só
`ERRO:` só as combinações em inglês pegam. São a prova de que as combinações não são cópia uma da
outra — sem elas, "rodou em três" é contagem, não cobertura.

**S3, descrita como é:** "sem a checagem de 'já aplicada', o re-apply aplica duas vezes" era falso. O
2º apply chega ao banco e o índice único `db_aplicacoes_sha_aplicada_uniq` barra o 2º recibo (4). A
checagem do script decide o exit (3 × 4); quem impede a dupla aplicação é o índice.

## As rodadas do Codex

| rodada | alvo | custo (`codex-async.sh`) | achados | o que virou |
|---|---|---|---|---|
| 1 | o DESENHO, antes do código | gpt-6-astra · max · 433s · 119.330 tokens | 0 P0 · 6 P1 · 3 P2 · +1 P1 fora de escopo | marca do ramo **e** da causa; S3 com preparo e o índice como causa; S9 com leitura estrita, transformação esperada e restauração por md5 nos dois clusters; palavra **com** status; uma unidade do recibo por sabotagem, com identidade; contexto por cluster; o `c_pt`; a gêmea S11; `LANGUAGE` fora e sonda do cliente dentro da prova |
| 2 | o código de `f419fa8e2` | gpt-6-astra · max · 10.259s de parede (2h39m de hibernação do Mac no meio) · 128.063 tokens | 1 P1 · 5 P2 | P1: o locale do cliente não era conferido no caminho do executor → o rótulo da libpq no log dele; três julgamentos ≠ três combinações; IGUAL fora do previsto; `registra` aceitando duplicata quando a here-string falha (bash 3.2 sem arquivo temporário); a promessa "byte a byte" do A12b; a descrição da S1 |
| 3 | o delta que respondeu à 2ª | — | `COTA_ESGOTADA` (plano no token: `prolite`; a janela reabre em 2026-09-19 13:21) | Caminho B: meta-falsificação por execução (abaixo) + **REVISÃO INDEPENDENTE PENDENTE**, com tarefa para a rodada retroativa |

Achados meus entre as rodadas, fora dos pareceres: as expectativas CALCULADAS das variáveis sob teste;
o gêmeo verde; `grep -q` sob `pipefail` no `registra` e no step do CI (SIGPIPE → 141, fail-open num e
vermelho falso no outro); e o shellcheck 0.11 acusando SC2329 (a `cleanup` do `trap` "nunca invocada")
quando os dois ramos do script terminam em `exit` — falso positivo, resolvido com o veredito como
última instrução.

## A prova por execução

No M2 (bash 3.2.57, PG 17.10), versão final: modo normal `PASS=36 FAIL=0`; `--falsificar`
`SABOTAGENS: 11 vermelhas / 0 falhas`; o runner real, com um manifesto de uma linha, aprova os dois
modos (`asserts=36`, `sabotagens=11`).

**Meta-falsificação** — a PRÓPRIA prova sabotada, uma camada por vez, numa cópia do HEAD commitado,
julgada pelo runner real (`db/roda-nucleo-ci.sh`), exigindo o vermelho com a marca certa no log do
`--falsificar`, com a cópia intacta verde antes (controle) e o modo normal da cópia verde (senão a
sabotagem vazou para fora da falsificação):

- v1, sobre `f419fa8e2`: **20/20** — ambiente (locale ausente; sem a sonda; servidor do `pt_pt` em C;
  sem essa sonda; sem a marca de idioma no A3; sem o controle negativo; cliente do `c_pt` em C), juiz e
  agregação (juiz sempre CERTO; status ignorado; silêncio; `pt_pt` pulado; guardas de 3 e de ≥1
  vermelha), restauração (bootstrap sabotado reaplicado; sem md5 na restauração; sem md5 na saída),
  inércia (S3 que não casa; inércia aceita) e identidade (S11 trocada por S1 duplicada; `registra`
  aceitando).
- v3, sobre a versão final (`994e380a4`): **32/32**. As camadas da v1 reescritas para o código novo,
  mais: `aplicar()` sem encaminhar o locale → o A3 do `c_pt` sem `CONTEXTO:  SQL statement`; sem essa
  marca no A3 → o controle negativo do rótulo; sem ele → `S2 S3 S5 S6 S8 S10 S11` sem o vermelho
  certo; desfecho fora do previsto aceito; sem a guarda de ≥1 vermelha; `c_c` trocada por uma 2ª
  `c_pt` → `combinacoes julgadas [ c_c=0 c_pt=2 ]`; sem essa conferência no laço →
  `sem log da combinacao c_c` (a 2ª camada, pelo disco); o gêmeo sem combinação nenhuma, sem conferir
  combinações, sem status, aceitando silêncio ou CERTO; a S9 com padrão que não casa e sem conferir a
  função instalada; a S11 com a expressão da S10. Todas as marcas previstas antes da execução bateram
  com a saída real — inclusive as listas exatas de sabotagens que cada camada derruba.

As camadas cumulativas são a lição de método: **a camada de fora esconde a de dentro.** A M05 (A3 sem
a marca de idioma) não chega às sabotagens — o controle negativo do juiz a pega antes; só a M20, que
também tira esse controle, mede o que as sabotagens sozinhas pegam.

## No CI

**O step de locale** (run 34874419894, `f419fa8e2`):

    antes: C C.utf8 POSIX en_US.utf8
    pt_BR.UTF-8... done
    servidor (lc_messages=pt_BR.UTF-8): ERRO:  divisão por zero
    cliente  (socket inexistente):      psql: erro: a conexão com o servidor no soquete "…" falhou
    LOCALE_PT_BR_OK

e, no núcleo, `test-db-aplicar --falsificar sabotagens=11 (≥11)` e
`SQL_PROOF_OK … falsificacoes=2/2 fora_do_ci=0` — era `fora_do_ci=1`.

**A falsificação do próprio caminho** (run 34914984884, commit `905874dd1`, revertido em `07d5b16e8`):
o step de provisionamento trocado por um que só registra a imagem e reprova se ela já tiver pt_BR.

O `provas-sql` saiu **vermelho pelo motivo certo** — e só ele: `testes`, `typecheck`, `edges-e-build`,
`gates-e-falsificacao` e `mutation-check` verdes; o `validate` vermelho por consequência.

    antes: C C.utf8 POSIX en_US.utf8
    PT_BR_AUSENTE_NA_IMAGEM: o núcleo abaixo TEM de reprovar com LOCALE_PT_BR_AUSENTE
    ✅ test-db-aplicar                              asserts=36   (≥36) 2s
    ❌ test-db-aplicar --falsificar                 exit=3 (0s)
       🛑 LOCALE_PT_BR_AUSENTE — abortando: nada abaixo daqui seria veredito.
          LC_ALL=pt_BR.UTF-8 nao resolve para UTF-8 (veio 'ANSI_X3.4-1968').
       FIM_FALSIFICACAO_ABORTADA LOCALE_PT_BR_AUSENTE
    ✅ test-canaria-veredito --falsificar           sabotagens=18   (≥18) 34s
    PROVAS-SQL REPROVADO

O modo normal da prova segue verde sem pt_BR (ele não precisa do locale), a falsificação aborta na
sonda sem emitir recibo, e a canária — que cai para qualquer locale UTF-8 — continua passando: o
vermelho mora exatamente onde o 2º idioma é exigido.

Um detalhe de mecânica que custaria a evidência: os pushes da v3.1 (`994e380a4`) e do experimento
saíram com 3 segundos de diferença, e o GitHub criou run só para o segundo — **push em sequência não
garante um run por push**. O run do revert (`07d5b16e8`, conteúdo idêntico ao da v3.1) é a evidência
verde da versão final; o do experimento só existe porque a meta-falsificação, rodando entre os dois
pushes, os espaçou em 12 minutos.

**O custo.** O número que dimensiona é o do runner, e a atribuição sai das linhas por prova que o
próprio runner imprime — no meio tempo a `main` ganhou outra falsificação no núcleo
(`test-pedido-total-liquido-acervo`), então o job inteiro mede as duas entregas juntas.

| | `provas-sql` | step de locale | `test-db-aplicar --falsificar` |
|---|---|---|---|
| antes (main após o #2472, 10 runs verdes) | mediana 129,5s | — | fora do CI |
| run 34874419894 (`f419fa8e2`, 1ª versão) | 141s | 3s | 8s |
| run 34915825083 (`07d5b16e8`, versão final) | 154s | 3s | 12s |

**A entrega custa ~15s por run** (3s do locale + 12s da falsificação); o resto da diferença do job é a
prova nova da `main` (3s normal + 4s falsificação) e a variação do runner (só a instalação do PG17 vai
de 13s a 23s). O `provas-sql` segue longe do caminho crítico — no mesmo run, `gates-e-falsificacao`
levou 678s e `mutation-check` 1023s —, então o custo no wall-clock do PR é **zero**. E, de novo, o M2
não dimensiona: a mesma falsificação levou 18–34s lá, contra 8–12s no runner.

## Fora desta entrega

- **O executor classifica conexão perdida como falha limpa** (confirmado pelo Codex nas duas rodadas,
  ainda não reproduzido): erro gerado pelo CLIENTE (`psql: erro: conexão com servidor foi perdida`,
  rc 2) casa a regex, e com a reconciliação sem resposta o script anuncia exit 4 "rollback limpo" —
  o COMMIT pode ter chegado. O ledger impede a dupla aplicação (recibo na mesma transação + índice
  único), mas o veredito é fabricado. Nenhuma fixture desta prova gera erro de cliente. Tarefa
  separada: "Classificar conexão perdida do db-aplicar como desconhecido".
- **A 3ª rodada do Codex** (o delta final) — **REVISÃO INDEPENDENTE PENDENTE** até a cota reabrir
  (2026-09-19 13:21). Tarefa separada: "Rodar a 3ª rodada do Codex no delta do #2488".
- **A12b compara com normalização, não byte a byte**: `norm_corpo` tira toda linha em branco. A
  fixture não tem linha em branco no corpo, então a comparação exata só ganha dente mudando a fixture
  junto. A promessa foi corrigida; a comparação, não.
- **A mesma classe do `registra`, na canária:** `printf | grep -qxF` sob `pipefail`
  (`db/test-canaria-veredito.sh`) — latente com dados pequenos, mas é guard que falha aceitando.

## As regras

1. **Antes de provisionar o ambiente que falta, meça QUEM produz o texto que o gate casa.** A premissa
   "o psql diz ERRO em pt_BR" estava certa pela metade: diz, se o SERVIDOR estiver em pt_BR.
   Provisionar o locale e ligar a falsificação como estava entregaria dois locales idênticos — o #1483
   com cara de dois, e verde.
2. **Sabotagem que só um ambiente pega é a prova de que os ambientes diferem.** Sem S10/S11, "rodou em
   três combinações" é contagem, não cobertura: trocar `pt_BR` por `C.UTF-8` deixaria tudo verde.
3. **Expectativa calculada da variável sob teste é o oráculo imitando a implementação.** Fixe o que
   cada caso TEM de mostrar pelo nome dele — nunca pelo que se está testando.
4. **Sonda ao lado não prova o caminho.** O psql traduzir numa conexão recusada não prova que o
   EXECUTOR recebeu o locale; a marca tem de estar no log do executor.
5. **Três julgamentos não são três combinações, e IGUAL em qualquer posição dispensa uma inteira.**
   Desfecho previsto por posição e conjunto exato — conferido também pelo disco, fora da conta do laço.
6. **Guard que falha para o lado de aceitar não é guard.** `grep -q` sob `pipefail` (SIGPIPE → 141) e
   here-string sem arquivo temporário (bash 3.2) viravam "expressão inédita"; compare no próprio shell.
7. **A camada de fora esconde a de dentro.** Sabotar uma camada que outra já cobre só mede a de fora;
   a meta-falsificação é cumulativa, e cada degrau precisa do controle próprio da camada que sobrou.

**Ver também:** [falsificacao-da-canaria-no-caminho-obrigatorio.md](falsificacao-da-canaria-no-caminho-obrigatorio.md)
(o 3º campo do manifesto e a regra 6, que virou o gêmeo verde aqui),
[falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md) (o controle verde),
[prova-que-imitava-o-oraculo.md](prova-que-imitava-o-oraculo.md) (a expectativa calculada).
