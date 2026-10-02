# O gravador do carimbo relia o anterior com cast — a trava de cluster seria pulada calada (2026-10-01)

> Classe: **artefato JSON commitado, gerado por script e relido com `JSON.parse(...) as <Tipo>`, sem
> conferir `schemaVersion` nem a forma** — calibrada em 2026-09-25 na matriz do `exclusividade`
> ([base](exclusividade-media-outra-coisa.md), #2575). Esta entrega fecha o último site afetado que
> aquela varredura deixou em chip: o GRAVADOR do carimbo de authz (`db/authz-carimbo-gravar.ts`).
> Domínio: [`carimbo-evidencia-authz-prod.md`](carimbo-evidencia-authz-prod.md) · `docs/agent/database.md` §1.

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

## Falsificação

Laço com CONTROLE verde na mesma invocação (aborta se não for), uma camada por vez, restauração por
`git checkout --` sobre o commit, vermelho exigido NOS TESTES CERTOS (pelo nome, reporter JSON do
vitest), nos dois locales:

| sabotagem | vermelho exigido em | `LC_ALL=C` | `pt_BR.UTF-8` |
|---|---|---|---|
| S1 porta aceita anterior sem `projetoHash` | SEM_ALVO (porta) + binário "sem alvo" | 3 falhos | 3 falhos |
| S2 porta não confere a versão (cai nas chaves de hoje) | SCHEMA_INCOMPATIVEL + ordem versão→forma + binário "futura" | 4 | 4 |
| S3 gravador volta ao cast | scan da classe + sentinela + binário | 7 | 7 |
| S4 gravador lê o anterior DEPOIS da guarda de env | binário "futura" e "null" | 4 | 4 |
| S5 herança ignora o anterior | herança na migração + anterior vence a semente | 2 | 2 |
| S6 trava sempre passa | OUTRO_CLUSTER + ponta a ponta | 2 | 2 |
| S7 env volta ao prefixo `AUTHZ_` | env do `claudeRo` + nomes da fonte | 2 | 2 |
| S8 forma aceita chave faltando/sobrando | FALTANDO ou SOBRANDO | 2 | 2 |
| S9 `null` vira nascimento | raiz não-objeto + binário "null" | 3 | 3 |
| S10 leitor novo do carimbo sem porta | "todo arquivo que nomeia o carimbo" | 1 | 1 |

`FALSIFICACAO-OK 20 sabotagens (10 x 2 locales)`, controle 97/97 verde em cada locale, árvore restaurada.
O dourado do `idFinding` foi falsificado à parte (ver o PR).

## Codex: não rodou (Caminho B)

`scripts/codex-async.sh -r max` saiu **79** sem gastar a chamada: cota em 86% (teto 85%), janela de 7
dias reabre em 2026-10-03 19:11. Seguiu por Caminho B — a RÉGUA acima, falsificação nos dois locales
e revisão adversarial independente (subagente read-only). **REVISÃO INDEPENDENTE PENDENTE**: rodar o
Codex retroativo com as perguntas abaixo quando a janela reabrir.

1. Janela explícita {N-1, N} vs "1..N" vs estrito + flag: há modo de falha não visto?
2. Exigir EXATAMENTE as chaves da versão lida é certo, ou rígido demais?
3. A costura `AUTHZ_CARIMBO_ANTERIOR_TEST_JSON` no escritor de evidência de prod abre alguma superfície?
4. Outra via pela qual a trava seria pulada ou a `primeiraVez` regrediria calada depois deste desenho?
5. O gate fica com o cast (já-correto, exceção de 1 arquivo no scan) ou passa pela mesma porta?

## Limites declarados

- **Anterior desatualizado na mesma versão** (ou em N-1, restaurado de um commit velho) passa pela
  porta: a forma está certa, a dívida é que está incompleta. A versão não distingue isso — é outra
  falha (anterior que não é o último), fora desta classe.
- **`primeiraVez` no futuro** passa pela porta (ela confere forma, não calendário — não tem relógio).
  O teste do artefato commitado (`primeiraVez ≤ ultimaVez`) pega depois da gravação.
- O `heavy` estava travado durante a entrega (o slot único preso num lote de falsificação de outra
  sessão; fila de 6, a cabeça esperando há 15 h): a suíte local rodou 1 arquivo com 1 worker, sem o
  semáforo, com 35% de RAM livre. O CI é a prova autoritativa.
