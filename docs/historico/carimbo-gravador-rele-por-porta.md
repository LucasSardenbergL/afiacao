# O gravador do carimbo relia o anterior com cast — a trava de cluster seria pulada calada (2026-10-01)

> Classe: **artefato JSON commitado, gerado por script e relido com `JSON.parse(...) as <Tipo>`, sem
> conferir `schemaVersion` nem a forma** — calibrada em 2026-09-25 na matriz do `exclusividade`
> ([base](exclusividade-media-outra-coisa.md), #2575). Esta entrega fecha o último site afetado que
> aquela varredura deixou em chip: o GRAVADOR do carimbo de authz (`db/authz-carimbo-gravar.ts`).
> Domínio: [`carimbo-evidencia-authz-prod.md`](carimbo-evidencia-authz-prod.md) · `docs/agent/database.md` §1.
>
> **Atualização de 2026-10-05:** a revisão independente (Fable, no lugar do Codex) achou que a trava
> morava no arquivo que ela protege. Ela passou para o CÓDIGO (`PROJETO_HASH_PROD`), cobrada no gravador
> e no gate. Até §"Codex" este registro descreve o desenho de 2026-10-01/03; o que mudou está em
> §"Revisão independente".

## O defeito

O gravador é o único escritor de `db/authz-carimbo-prod.json` e relê o carimbo ANTERIOR para duas coisas:

- **a TRAVA de cluster** — não sobrescrever evidência de prod com a medição de outro banco
  (`alvo.projetoHash` = sha256 do `system_identifier`, truncado);
- **a herança de `primeiraVez`** — a idade de um achado nunca é resetada por re-execução.

A releitura era `JSON.parse(readFileSync(CARIMBO_PATH, 'utf8')) as Carimbo`, e a trava,
`if (anterior && anterior.alvo?.projetoHash && anterior.alvo.projetoHash !== alvo.projetoHash)`.
Quatro modos de falha, todos calados:

| entrada | o que acontecia |
|---|---|
| carimbo de outro formato, `projetoHash` fora do lugar | o curto-circuito lia "campo ausente" como "sem trava": a medição de OUTRO cluster sobrescreveria a de prod |
| achados fora do lugar | `primeiraVez` regredia para a semente/hoje — a sentinela passava a dizer "aberto desde" errado |
| arquivo contendo `null` | `anterior = null` = NASCIMENTO: trava pulada |
| JSON inválido | `SyntaxError` não tratado, **exit 1** — fora do contrato do runner (0 gravou · 2 não gravou) |

O GATE (`scripts/authz-carimbo-gate.ts` → `avaliarCarimbo`) já conferia a versão; o buraco era só no gravador.

## A decisão de desenho (RÉGUA — o Codex não rodou, ver abaixo)

**Por que o gravador não pode ser estrito como o gate.** O gate recusa carimbo de versão ≠
`SCHEMA_VERSION` e **bloqueia PR**; logo o PR que faz o bump tem de regravar o carimbo nele mesmo — e
o gravador desse PR lê o carimbo da versão ANTERIOR. É a migração legítima: a 1→2 (`rls`) e a 2→3
(`corpo`) passaram por este gravador. Abortar em toda versão diferente travaria todo bump.

**Fatos medidos antes de decidir** (não deduzidos):

- as 36 versões commitadas do carimbo: v1 ×2 (4 chaves), v2 ×24 (5: +`rls`), v3 ×10 (6: +`corpo`);
  em TODAS, `alvo.projetoHash` no mesmo lugar e todo achado com `id` + `primeiraVez`;
- `idFinding` e o cálculo de `projetoHash` não mudaram desde o nascimento (#2044, `git log -L`);
- todo bump até hoje só ACRESCENTOU uma chave.

**O escolhido — janela explícita + forma mínima da versão lida:**

1. `CHAVES_RELIDAS_POR_VERSAO = {2: [5 chaves], 3: [6 chaves]}` — a versão de hoje e a
   **imediatamente anterior**, com as chaves que cada uma TEM. Fora dela, `CARIMBO_ANTERIOR_SCHEMA_INCOMPATIVEL`:
   - **futura** = código desatualizado (p.ex. `git checkout origin/main -- db/authz-carimbo-prod.json`
     numa worktree velha). Lê-la "porque a forma bate" seria um DOWNGRADE: o código velho regravaria
     no formato velho e jogaria fora a `primeiraVez` das chaves que ele não conhece;
   - **duas versões atrás** não é migração (na main o carimbo está sempre em `SCHEMA_VERSION` — o gate
     garante) — é arquivo velho restaurado.
2. **Versão ANTES da forma** (o desenho do `lerMatriz`): carimbo de outro schema tem, legitimamente,
   outra forma — chamá-lo de SEM_ALVO mandaria o operador consertar o arquivo em vez do código.
3. Forma conferida = a que o gravador USA, para a versão LIDA: `alvo.projetoHash` texto não vazio
   (senão `CARIMBO_ANTERIOR_SEM_ALVO` — **a trava nunca é pulada por ausência**); `audits` com as chaves
   EXATAS da versão (faltando = dívida que sumiria; sobrando = dívida jogada fora), cada achado com
   `id` e `primeiraVez` `AAAA-MM-DD` (senão `CARIMBO_ANTERIOR_MALFORMADO`). Raiz não-objeto — `null`
   inclusive — é MALFORMADO: o nascimento é o arquivo AUSENTE, e só ele.
4. A porta devolve a PROJEÇÃO (`CarimboAnterior`), nunca o JSON cru; a trava (`conferirCluster`) não
   tem mais curto-circuito, e a herança (`montarAchados`) saiu do runner para o núcleo puro, testável.
5. O gravador lê o anterior **antes** da guarda de env e da sonda de prod: anterior recusado = nada
   será gravado, então nem se sonda. Recusa = `CARIMBO-ANTERIOR-RECUSADO <CODIGO> - <motivo ASCII>`, exit 2.

**Descartados:**

- *Abortar em toda versão ≠ N, com flag `--aceitar-anterior`*: todo bump legítimo exige o flag (vira
  reflexo — inclusive no caso errado), e o flag ainda precisa do leitor de N-1. Fricção sem segurança.
- *Só forma, qualquer versão*: não protege do DOWNGRADE acima.

**Forçamento no bump** (`scripts/authz-carimbo.test.ts`, "CHAVES_RELIDAS_POR_VERSAO"): a janela é
exatamente `[N-1, N]`; as chaves de N são exatamente as de `AUDITS` (audit novo sem bump fica vermelho);
a fixture da versão anterior é escrita À MÃO com a forma medida — derivá-la da tabela tornaria o
teste circular — e o teste cobra que ela ande junto com o bump.

## Achado adjacente, consertado junto: a env de teste do `claudeRo` passava

`envDeTesteSetadas` (a invariante 2 do runner: não carimbar contrato sintético) casava
`^AUTHZ_[A-Z0-9_]*_TEST_JSON$`. O audit de `claudeRo` lê **`CLAUDE_RO_BASELINE_TEST_JSON`** — fora do
prefixo. Provado por execução: `envDeTesteSetadas({CLAUDE_RO_BASELINE_TEST_JSON: '{}'})` → `[]`. Com
ela exportada no shell, o gravador mediria `claudeRo` contra a baseline de TESTE e carimbaria como
prod (o fingerprint do auditor não muda: o arquivo é o mesmo). E o teste que "provava" a cobertura
calculava um nome canônico (`AUTHZ_CLAUDE_RO_TEST_JSON`) que auditor nenhum lê — verde por teatro.
Exposição real baixa (o harness seta a env por comando, não exporta), mas é a 2ª reincidência da mesma
falha (a 1ª foi a lista literal de 2 nomes que não conhecia `AUTHZ_RLS_TEST_JSON`, #2064).

Conserto: o padrão vira o SUFIXO `*_TEST_JSON`, e o teste tira os nomes da **fonte** dos arquivos de
auditor de `AUDITS` (sentinela: o scan tem de enxergar `CLAUDE_RO_BASELINE_TEST_JSON`,
`AUTHZ_GRANTS_TEST_JSON` e `PSQL_RO`). Auditor novo com env de teste nasce coberto, com qualquer nome.

## Um terceiro caminho para o mesmo dano: o `id` do achado

A herança casa por `id`. Se `idFinding` mudar, todo `id` commitado deixa de casar e a próxima gravação
regride TODA `primeiraVez` — sem mudar forma nem versão, invisível à porta. Teste DOURADO e
não-circular: o único achado já gravado num carimbo commitado (`f1154aa75`, schema 2, 2026-09-05,
`funcoes`) tem `id` `ef43258a5a7946e8`, escrito pelo gravador da época; o algoritmo de hoje tem de
reproduzi-lo.

## O teste do BINÁRIO é hermético por dois cintos

O gravador mede prod; um teste que o executa não pode ter caminho até lá, nem no Mac do founder (onde
o `psql-ro` existe). Os dois cintos são independentes:

1. a costura `AUTHZ_CARIMBO_ANTERIOR_TEST_JSON` (texto que substitui o arquivo) casa `*_TEST_JSON` — a
   guarda SEGUINTE à leitura do anterior aborta o runner, por construção: a costura nunca chega à sonda
   nem à escrita;
2. `HOME` num tmp: o wrapper `psql-ro` mora em `~/.config/afiacao/`, e com HOME falso ele nem existe
   (medido: `homedir()` do bun segue `$HOME`).

O CONTROLE (anterior válido) prova que a porta aceita e o runner segue até a guarda de env; os
negativos (futura, sem alvo, ilegível, `null`) provam exit 2 com o código; nenhum caso imprime
`sonda de alvo` nem `read-only=` (nunca chegou à sonda).

## Varredura da classe (2026-10-01)

`rg -n "JSON\.parse\([^;]*\)\s*as\s+[A-Z]" scripts/ db/ src/ supabase/functions/ --glob '!*.test.ts' --glob '!*.test.tsx'`
→ **33 casamentos** (eram 32 em 25/09). Veredito por site, inclusive os limpos:

| site | veredito |
|---|---|
| `db/authz-carimbo-gravar.ts` (o anterior) | **afetado — consertado aqui** |
| `scripts/authz-carimbo-gate.ts` | já-correto: `avaliarCarimbo` confere `schemaVersion` antes de ler campo; desvio de forma na mesma versão vira exit 2 ou vermelho, nunca verde |
| `scripts/sonda-cron-prova.ts:493` | fora da classe: veredito da saída de um processo filho, não artefato commitado |
| `scripts/lib/exclusividade.ts:866` | falso-positivo: é COMENTÁRIO (o cabeçalho do `lerMatriz`) |
| `scripts/lib/authz-carimbo.ts` (o cabeçalho de `lerCarimboAnterior`, depois do conserto) | falso-positivo: é COMENTÁRIO — o casamento do gravador "muda" para cá; a contagem segue 33 |
| `scripts/falsificar-exige-assert-gate.ts:863` | falso-positivo: string literal (fonte sintética de um falsificador) |
| `db/audit-grants-funcoes-fechadas.ts`, `db/audit-grants-tabelas-fechadas.ts`, `db/audit-claude-ro-hardening.ts` | fora da classe: JSON de env de TESTE (e o do `claudeRo` confere a forma logo depois) — foi aqui que o achado adjacente apareceu |
| `src/` ×15 (offline-queue, impersonation, route-tracker, useGlobalSearch, NfeReceipt, useTintRecentsFavorites, useDashboardLayout, useUnifiedOrder, useOrderDraft, useCustomerSegments, ColumnConfig, TintReconciliation ×4) | fora da classe: `localStorage` ou coluna do banco, não artefato commitado |
| `supabase/functions/` ×10 (omie-sync-* ×5, enviar-pedido-portal-sayerlack ×2, sayerlack-captura-precos, omie-malha-sync, disparar-pedidos-aprovados) | fora da classe: resposta HTTP (Omie, Browserless) |

**Zero afetado** depois desta entrega.

**Gate da classe** (`scripts/authz-carimbo.test.ts`, bloco "a CLASSE"): nenhum `as Carimbo` em
`scripts/`+`db/` fora do gate; todo arquivo que nomeia o carimbo commitado (`CARIMBO_PATH` ou
`authz-carimbo-prod.json`) passa o texto por `lerCarimboAnterior` ou `avaliarCarimbo`; sentinela de
que o scan enxerga o gravador e o gate, e de que a exceção do gate é real (se ele deixar de fazer cast,
a exceção vira letra morta e o teste manda tirá-la). Irmão do bloco de `scripts/exclusividade-gate.test.ts`.

## A revisão adversarial (2026-10-03): dois furos que o próprio desenho abriu

A 1ª revisão independente (subagente read-only) travou no watchdog sem entregar — a suspeita é a fila
do `heavy`; a 2ª, proibida de rodar comando pesado, entregou 4 achados. Todos procedentes, todos
consertados aqui:

| achado | o que era | conserto |
|---|---|---|
| **A (alta)** arquivo ausente = nascimento | eu tinha escrito "o único caso sem trava, porque não há evidência a proteger" — falso desde o 1º commit (36 versões no git). Apagar o arquivo e regravar pulava a trava E zerava a dívida; e o conserto, por recusar mais, dava mais motivo para apagar | o carimbo da **origin/main** vira a REFERÊNCIA, relido pela mesma porta (`lerReferenciaDaMain`, git injetado). Local ausente + main presente ⇒ a trava compara com a MAIN. Nascimento só com a main confirmando que não há carimbo (`ls-tree` vazio, rc 0). Git sem resposta ⇒ `CARIMBO_ANTERIOR_SEM_REFERENCIA`: ausência de resposta não é ausência de carimbo |
| **B (média)** anterior velho aceito | a janela {N-1, N} vale a vida toda da versão N: um local velho (conflito resolvido com `--ours`) regredia a `primeiraVez` do que a main já tinha visto | a herança fica com a data MAIS ANTIGA entre o local e o da main (`montarAchados` recebe a lista) |
| **C (baixa)** scan cego a cast implícito | `const c: Carimbo = JSON.parse(t)` compila (`JSON.parse` devolve `any`) e a regex `as Carimbo` não vê | quem nomeia o carimbo não chama `JSON.parse` — só a porta (o núcleo) e o gate |
| **D (baixa)** exit 1 em erro de leitura | `readFileSync` sem tratamento: EISDIR, EACCES ou a corrida viravam exceção solta, fora do contrato 0/2 | `lerArquivoDoCarimbo` ⇒ `CARIMBO_ANTERIOR_ILEGIVEL`, exit 2 |

**Por que a trava compara com o LOCAL quando ele existe** (e não com a main também): é o local que
será sobrescrito, e é nele que mora a saída CONSCIENTE para uma troca legítima de cluster (restore ou
upgrade do projeto): trocar `alvo.projetoHash` no carimbo local, o que fica no diff do PR. A mensagem
de `OUTRO_CLUSTER` agora diz isso; antes não oferecia saída nenhuma — e a única saída era, justamente,
apagar o arquivo.

**Ramo inalcançável também falha fechado.** `referenciaDoTexto` com texto não nulo nunca recebe
anterior nulo da porta; o ramo existe pelo tipo, e a 1ª redação dele devolvia `ausente` — o que
liberaria o nascimento se um dia ele fosse alcançado. Devolve `nao-consultada`.

**Lição de processo:** limite declarado que é consequência do PRÓPRIO desenho não é limite, é furo
com nome. O B estava escrito nos limites abaixo como "fora desta classe" — e a janela que o abria era
minha.

## Falsificação

Laço com CONTROLE verde na mesma invocação (aborta se não for), uma camada por vez, restauração por
`git checkout --` sobre o commit, vermelho exigido NOS TESTES CERTOS (pelo nome, reporter JSON do
vitest), nos dois locales. Duas rodadas: a do 1º conserto (10 sabotagens + 2 do dourado, controle
97/97 e 98/98) e a da versão final, depois da revisão adversarial:

| sabotagem (versão final) | vermelho exigido em | `LC_ALL=C` | `pt_BR.UTF-8` |
|---|---|---|---|
| S1 porta aceita anterior sem `projetoHash` | SEM_ALVO (porta) + binário "sem alvo" | 4 falhos | 4 falhos |
| S2 porta não confere a versão (cai nas chaves de hoje) | SCHEMA_INCOMPATIVEL + ordem versão→forma + binário "futura" | 6 | 6 |
| S3 gravador volta ao cast | os dois scans da classe + sentinela + binário | 8 | 8 |
| S4 gravador lê os anteriores DEPOIS da guarda de env | binário "futura", "null" e "main futura" | 6 | 6 |
| S5 herança ignora os anteriores | migração + anterior vence a semente + local velho | 3 | 3 |
| S6 trava sempre passa | OUTRO_CLUSTER + ponta a ponta + local apagado | 3 | 3 |
| S7 env volta ao prefixo `AUTHZ_` | env do `claudeRo` + nomes da fonte | 2 | 2 |
| S8 forma aceita chave faltando/sobrando | FALTANDO ou SOBRANDO | 2 | 2 |
| S9 `null` vira nascimento | raiz não-objeto + binário "null" | 4 | 4 |
| S10 leitor novo do carimbo sem porta | porta ausente + `JSON.parse` proibido | 2 | 2 |
| S11 **(A)** local apagado: a trava não cai na main | "local AUSENTE e main presente" | 1 | 1 |
| S12 **(B)** herança só do 1º anterior | "local VELHO e main mais nova" | 1 | 1 |
| S13 **(B)** herança fica com a data mais NOVA | "local VELHO e main mais nova" | 1 | 1 |
| S14 git que falha vira `ausente` | "git que FALHA" | 1 | 1 |
| S15 main não consultada vira nascimento | "main NÃO CONSULTADA" | 1 | 1 |
| S16 gravador não lê a main | binário "main futura" e "main sem alvo" | 2 | 2 |
| S17 **(D)** leitura do arquivo lança | "(EISDIR)" | 1 | 1 |
| S18 **(C)** leitor com anotação `: Carimbo` em vez de cast | `JSON.parse` proibido | 2 | 2 |
| G1/G2 `idFinding` com 15 hex / outra ordem | DOURADO | 1 / 1 | 1 / 1 |

`FALSIFICACAO-OK 40 sabotagens (20 x 2 locales)`, controle 113/113 verde em cada locale, árvore
restaurada. Cada sabotagem nova da revisão derruba EXATAMENTE os testes que a cobrem — nenhuma camada
ficou verde (redundante ou inalcançada).

## Codex: não rodou (Caminho B)

`scripts/codex-async.sh -r max` saiu **79** sem gastar a chamada: cota em 86% (teto 85%), janela de 7
dias reabre em 2026-10-03 19:11. Seguiu por Caminho B — a RÉGUA acima, falsificação nos dois locales,
auto-challenge no binário real e a revisão adversarial independente (subagente read-only), cujos 4
achados estão consertados. A revisão independente ficou PENDENTE, com as 5 perguntas abaixo — e foi
feita em 2026-10-05 por Fable, no lugar do Codex, por decisão do founder (seção seguinte):

1. Janela {N-1, N} + a origin/main como referência: há modo de falha não visto?
2. Exigir EXATAMENTE as chaves da versão lida é certo, ou rígido demais?
3. As costuras `AUTHZ_CARIMBO_ANTERIOR_TEST_JSON` e `AUTHZ_CARIMBO_MAIN_TEST_JSON` no escritor de
   evidência de prod abrem alguma superfície?
4. A trava no LOCAL (não na main) quando ele existe — a saída consciente de troca de cluster — é o
   desenho certo, ou o hash de prod deveria ser fixado no código e no gate?
5. Outra via pela qual a trava seria pulada ou a `primeiraVez` regrediria calada?

## Revisão independente (2026-10-05): Fable, no lugar do Codex

Decisão do founder (2026-10-03): a revisão independente com Fable, não com o Codex retroativo. Dois
revisores em paralelo, somente leitura, sobre o squash `18affb758` (#2765): um no DESENHO (perguntas 1,
2 e 4, mais os limites declarados), outro no CÓDIGO e nos TESTES (3 e 5, ramo a ramo, com sondas `bun`
sobre o núcleo puro). O conserto é o PR seguinte, que traz este registro.

**O furo que os dois acharam, cada um por conta própria: a trava morava no arquivo que ela protege.**
A trava comparava a sonda com o carimbo ANTERIOR — o arquivo que o operador edita —, a recusa
`OUTRO_CLUSTER` ensinava a editá-lo ("troque `alvo.projetoHash` no carimbo local … a troca fica no diff
do PR, revisável"), e `avaliarCarimbo` nunca lia `alvo` (provado: carimbo com hash `deadbeef` → zero
veredito). Num repo que auto-mergeia sem revisão humana, "fica no diff" não protege nada: sessão no
banco errado → recusa → o agente obedece à mensagem → grava → `validate` verde → a main atesta prod
com a evidência de outro banco. O meu limite declarado de "local de outro cluster copiado à mão =
adulteração, fora do modelo de ameaça" era furo com nome: a própria mensagem tornava o contorno um ERRO
honesto. As 36 versões commitadas têm o mesmo hash (`a0010e4a9b3b3e6b`): fixá-lo custa uma constante.

| achado | revisor · sev. | disposição |
|---|---|---|
| trava no arquivo editável, gate cego ao `alvo`, recusa = receita do contorno | desenho A1 (+ nota do código) · **alta** | **consertado**: `PROJETO_HASH_PROD` no código. O gravador compara a SONDA com ela (`conferirCluster`, de novo em `montarCarimbo`), e o gate bloqueia com `CARIMBO_OUTRO_CLUSTER` (ausente ≠ prod). A recusa manda conferir o psql-ro; trocar a constante é decisão do founder |
| referência lida ANTES do fetch que o `corpo` faz logo depois — duas mains no mesmo carimbo (o limite "origin/main LOCAL" era consequência da ORDEM) | desenho A3 · média | **consertado**: `git fetch origin main` é o passo 0 de `lerReferenciaDaMain`; sem rede → recusa |
| main SEM o carimbo (`ausente`) ainda liberava nascimento: o último caminho da ausência de ARQUIVO | desenho A4 · média | **consertado**: recusa `SEM_REFERENCIA` — o nascimento foi em 2026-08-27 e não se repete |
| git falso indexado só pelo subcomando: trocar `origin/main` por `HEAD` passava verde e reabria o achado A | código A1 · média | **consertado**: o falso confere os argumentos exatos, e o CONTROLE cobra a sequência fetch → ls-tree → show |
| fiação do `main()` sem teste: passar `null` à trava ou `[]` à herança no call site ficava verde | código A2 · média | **consertado**: `montarCarimbo` puro (trava + herança + montagem), com teste de IDA E VOLTA (gravador → porta → gate) e tripwire de texto para a herança chegar à montagem |
| gate da classe: o núcleo fora dos scans; anotação com caminho montado sem o literal | código A3 · baixa→média | **consertado**: o núcleo tem UM `JSON.parse` (o da porta); o scan 1 vê `: Carimbo = JSON.parse` e `=> JSON.parse` em qualquer arquivo |
| data que casa o regex e não é calendário (`2026-13-45`, `0000-00-00`), propagada pela herança | código A4 · baixa | **consertado**: ida e volta de calendário na porta |
| exit 1 ainda alcançável depois da sonda (fingerprint que lança; escrita sem `try`) | código A6 · baixa | **consertado**: fingerprints ANTES da sonda; escrita com `try` → exit 2 e `.tmp` removido |
| a recusa com trava vinda da main mandava editar um carimbo local inexistente | desenho A5 · baixa | **consertado** junto com a trava (a mensagem nova não fala do arquivo) |
| `projetoHash` sem forma: `' abc'` caía em `OUTRO_CLUSTER` com espaço invisível | código A5 · baixa | **consertado de outro jeito**: o `alvo` do anterior não é mais lido; na sonda, a recusa cita o hash com `JSON.stringify` |
| `--ours` num conflito leva `primeiraVez` regredida à main sem passar pelo gravador; o gate não tem catraca contra a main | desenho A2 · média | **declarado + procedimento**: a `primeiraVez` é INFORMATIVA (só aparece em `CARIMBO_ACHADO`, que não bloqueia; nenhum outro consumidor no repo), o cenário é plausível e não observado, e uma catraca nova no gate (ler a main no CI) é máquina sem incidente. Procedimento em `database.md` |

Respostas às 5 perguntas: **(1)** furo — o fetch e o `ausente`, consertados; o bump em si ficou fechado
em todas as combinações atacadas. **(2)** ok — chave nova já exigia bump desde a v2; "sobrando" é a
dívida jogada fora que a rigidez protege. **(3)** ok — costura `''` é ausente nos dois pontos, a guarda
casa os dois nomes e nada tem efeito antes dela. **(4)** furo (alta) — o hash fixado no código e no gate.
**(5)** ressalva — nenhuma via de PULAR a trava; a `primeiraVez` aceitava lixo de calendário (consertado)
e o `id` muda se o texto do auditor mudar (limite abaixo).

**Máquina meta: nenhuma nova.** O gate existente ganha o veredito `CARIMBO_OUTRO_CLUSTER`: é a trava
saindo do arquivo para o artefato, consertando um verde-falso provado no próprio gate (`avaliarCarimbo`
com hash alheio → zero veredito). A catraca da `primeiraVez` contra a main ficou de fora justamente por
ser máquina nova sem incidente.

<!-- FALSIFICACAO-2026-10-05 -->

## Limites declarados (revistos em 2026-10-05)

- **A `primeiraVez` não tem catraca no gate.** O gravador a preserva (porta + herança da main); um
  conflito resolvido com o lado da branch sem regravar, ou uma edição à mão, a regride sem o CI ver. Ela
  é informativa. Procedimento: conflito no JSON → fique com a versão da main e regrave.
- **O `id` do achado depende do TEXTO da linha do auditor** (`[CODE] objeto:`). Mudar esse texto num
  auditor — justamente quando o `auditorFingerprint` força a regravação — dá `id` novo e `primeiraVez` de
  hoje. O dourado pina o algoritmo, não o texto dos auditores. Hoje há zero achados vivos.
- **Troca legítima de cluster** (restore ou upgrade com `system_identifier` novo): o gravador recusa até
  um PR trocar `PROJETO_HASH_PROD` — atrito de propósito. Nada impede um agente de trocar a constante;
  por isso a recusa diz que a troca é do founder, com evidência.
- **A fiação herança → montagem** é vigiada por tripwire de TEXTO (prova presença, não controle); o
  comportamento está em `montarCarimbo`. A trava não depende do tripwire: o gate a cobra no artefato.
- **Herança conservadora:** um achado que fechou e reabriu herda a data velha; e um anterior LOCAL de
  outro cluster (a porta não lê mais o `alvo`) empresta datas — sempre para mais antiga, nunca mais nova.
- **`primeiraVez` no futuro** passa pela porta (ela confere calendário, não relógio). O teste do artefato
  commitado (`primeiraVez ≤ ultimaVez`) pega depois da gravação.
- O `heavy` estava travado durante a 1ª rodada de 2026-10-01 (o slot único preso num lote de falsificação
  de outra sessão; fila de 6, a cabeça esperando há 15 h): aquela suíte rodou 1 arquivo com 1 worker, sem
  o semáforo, com 35% de RAM livre. A versão final rodou sob o `heavy`.
