---
name: lovable-deploy-verify
description: >-
  Ritual de "está REALMENTE no ar?" para QUALQUER entrega neste repo (Afiação/Colacor),
  que roda em Lovable Cloud. Use SEMPRE que terminar de mergear um PR e precisar saber o que falta pra
  a mudança ir a produção, ou quando o usuário perguntar "já está no ar?", "deu pra ver no app?",
  "publiquei?", "preciso dar Publish?", "tem que deployar a edge?". Vale mesmo quando o usuário não
  diz "deploy" e só assume que mergear basta ("terminei, era só isso?", "pode testar agora?"). Por quê:
  o Lovable NÃO auto-deploya NADA a partir de push no GitHub — mergear na main deixa o código na main,
  mas o app continua servindo o build anterior. TRÊS coisas são manuais e independentes: (1) FRONTEND
  (Publish no editor do Lovable), (2) EDGE FUNCTIONS (chat do Lovable, ler do repo, verbatim), (3)
  MIGRATIONS (SQL Editor — coberto pela skill lovable-db-operator). A skill empacota: detectar quais
  das 3 se aplicam ao diff, montar o checklist de pendências do founder, montar o prompt de deploy de
  edge, e VERIFICAR o deploy do frontend pelos bytes do bundle (hash do index + grep da string-alvo em
  TODOS os chunks). NÃO use para: a mudança de banco em si (use lovable-db-operator), escrever a feature,
  ou debugar erro de runtime no app (use /investigate).
---

# Lovable Deploy & Verify

> **v1.3 — enumeração validada em prod + Codex (2026-06-18); varredura PARALELA + QA visual (2026-07-07).**
> A verificação por bytes (Passo 4) enumera os chunks pela **UNIÃO** de duas fontes que sozinhas têm furos:
> o fechamento transitivo do grafo lazy do Vite (o entry sozinho perdia o 2º nível — 260 vs 274) e o
> precache do Workbox (`/sw.js`, que omite chunks grandes via globIgnores/maxFileSize). Empacotado em
> [`scripts/verify-frontend.sh`](scripts/verify-frontend.sh), agora com **`xargs -P` + halt-on-hit** (o
> bundle passou de 300 chunks — 1-a-1 estourava 600s; medido **~5 min → ~1 min**, mesmo exit) e rede de
> regressão local ([`evals/verify-frontend-eval.sh`](evals/verify-frontend-eval.sh)). Verificação **visual**
> pós-Publish: **Passo 4b** (Claude-in-Chrome logado). Irmã da `lovable-db-operator` (lado do banco).

## Por que esta skill existe (leia antes de qualquer coisa)

Este repo roda em **Lovable Cloud**. Há uma armadilha operacional documentada na §5/§"Deploy do FRONTEND" do CLAUDE.md:

> **O Lovable NÃO auto-deploya o frontend a partir de push no GitHub.** Mergear PR na `main` deixa o
> código na main, mas o app em `steu.lovable.app` **continua servindo o build anterior** até alguém
> clicar **Publish** no editor do Lovable.

Isso já pegou de surpresa: após mergear 6 PRs alguém disse "pronto pra QA" — mas o ar ainda era um build velho (provado nos bytes). O pior tipo de erro: **dizer "está no ar" quando não está.**

As **três** coisas são deploy manual e **independente**, e NENHUMA acontece sozinha no merge:

| Camada | Como sobe | Skill dona |
| --- | --- | --- |
| **Frontend** (app React) | **Publish** no editor do Lovable (pode precisar sincronizar com o GitHub antes — senão publica estado velho dele) | esta skill |
| **Edge functions** (`supabase/functions/`) | **chat do Lovable** (ler do repo, deploy **verbatim**) | esta skill |
| **Migrations** (`supabase/migrations/`) | **SQL Editor** (colar → Run) | `lovable-db-operator` |

## A Lei de Ferro (guardrail inegociável)

1. **Você nunca diz "está no ar" sem prova.** Mergear na main **não publica nada**. Frontend: os **bytes do bundle** confirmam (string-alvo nos chunks — Passo 4). Edge **não serve seu código**, logo não há prova por bytes — a prova é a **escada** existência (`verify-edge.sh`) → versão (Management API/painel) → comportamento (probe); `Active` sozinho prova existência, **não** que a versão nova subiu. Até lá: "mergeado na main; **falta Publish/deploy** pra ir ao ar".
2. **As 3 camadas são independentes — sempre diga QUAIS se aplicam.** Um diff só-frontend não precisa de deploy de edge; um diff de edge precisa de deploy via chat *e* (se mexeu em UI) Publish. Liste só o que o diff realmente toca.
3. **Edge deploy SÓ DEPOIS do merge, e VERBATIM.** Deployar "da main" antes do merge faz o Lovable ler a main **velha** (já mordeu em #383/#252 — a action nova não existia no binário → `400 "Ação desconhecida"`). E o Lovable tende a "melhorar" o código — o prompt deve mandar **não modificar/reinterpretar**, ler de `supabase/functions/<nome>/index.ts` e deployar idêntico.
4. **Verificar frontend varre TODOS os chunks, e enumerá-los é a UNIÃO de duas fontes.** Nenhuma sozinha é completa (validado em prod 2026-06-18 + Codex): (a) o **fechamento transitivo** do grafo lazy do Vite — o entry lista só o 1º nível via `__vite__mapDeps(["assets/x.js"])` (sem barra, aspas), e um lazy-dentro-de-página guarda o mapDeps no chunk DELE (entry=260, closure=274); (b) o **precache do Workbox** (`/sw.js`), que omite chunks grandes (globIgnores/maxFileSize — faltavam 6). Use a UNIÃO. Grep de literais `/assets/...` dá 0 (o bug original). Contagem 0/1 = enumeração quebrada — conserte antes de concluir.
5. **Todo artefato pro founder tem o DESTINO rotulado na 1ª linha** — `🟣 SQL Editor` / `💬 chat do Lovable` / `🖱️ Publish (editor do Lovable)` / `⌨️ seu terminal` — e **zero placeholders** (`<VALOR>` não substituído já foi colado em produção) — e **valor de EXEMPLO plausível CONTA como placeholder, com falha PIOR, porque é CALADA**: o `<VALOR>` quebra ruidoso (404, erro de sintaxe), o número plausível devolve uma linha real de OUTRO emissor. Em 2026-08-24 um `WHERE id = 58967` inventado leu o tick do watchdog e reprovou um deploy money-path CORRETO. Campo que o founder substitui nasce sintaticamente **inválido** (`COLE_AQUI_O_REQUEST_ID`), nunca preenchido de exemplo → `deploy.md` §Canárias. JS/bash NUNCA vai pro SQL Editor (já foi colado lá 4×); o rótulo responde de antemão o "isso eu colo onde?".

## O ritual — 5 passos

Crie estes todos (TodoWrite) ao fechar uma entrega que pode precisar de deploy:

1. **Classificar o diff** — quais das 3 camadas o PR toca (frontend / edge / migration)?
2. **Pendências do founder** — montar o checklist do que ele precisa fazer manualmente
3. **Prompt de edge** (se houver edge) — montar o handoff "ler do repo, verbatim, não melhorar"
4. **Verificar o deploy** — frontend pelos bytes; edge pela escada existência→versão→comportamento
5. **Confirmar honestamente** — só então dizer "no ar", com a evidência

---

### Passo 1 — Classificar o diff

Quais das 3 camadas o PR toca? A lógica canônica — ampliada para pegar **arquivos de build na raiz**
(`vite.config`, `package.json`, …), não só `src/` — vive em [`evals/classify.sh`](evals/classify.sh) e é
coberta por [`evals/run.sh`](evals/run.sh) (8 casos + mutation-check):

```bash
git diff --name-only origin/main...HEAD \
  | .claude/skills/lovable-deploy-verify/evals/classify.sh
# -> frontend=SIM|não · edge=SIM|não · migration=SIM|não
```

### Passo 2 — Checklist de pendências do founder (ORDEM TRAVADA: merge → SQL → edge → Publish)

**Nada de deploy antes do MERGE** (Lei de Ferro #3 — o Lovable lê da main). Entregar SÓ as linhas que se aplicam (do passo 1), NESTA ordem, cada uma com o destino rotulado:

> ⚠️ **Pra ir ao ar, falta (manual no Lovable) — nesta ordem, APÓS o merge do PR:**
> - [ ] 🟣 **SQL Editor**: migration Z *(se tocou `supabase/migrations/` — bloco da `lovable-db-operator`; banco ANTES do código que o consome)*
> - [ ] 💬 **chat do Lovable**: deploy das edges X, Y — verbatim da main *(se tocou `supabase/functions/`)*
> - [ ] 🖱️ **Publish** do frontend no editor do Lovable *(se o passo 1 deu frontend=SIM; por último — o build novo nasce contra banco/edge já atualizados)*

### Passo 3 — Prompt de deploy de edge (se aplicável)

Montar pro founder colar no chat do Lovable (um por edge tocada):

> Edit the existing edge function `<nome>` and replace its code with the current contents of
> `supabase/functions/<nome>/index.ts` from the `main` branch. Deploy it **verbatim** — do NOT modify,
> reinterpret, "improve", or reformat the code. After deploying, confirm it shows **Active**.

⚠️ Só depois do PR **mergeado** na main (Lei de Ferro #3).

### Passo 4 — Verificar o frontend pelos bytes (após Publish)

> **Validado em produção (2026-06-18) + 2ª opinião do Codex.** Enumerar os chunks tem furos sutis:
> o entry sozinho perde o 2º nível (lazy-dentro-de-lazy, 260 vs 274); o precache do Workbox omite
> chunks grandes (globIgnores/maxFileSize, faltavam 6). Por isso a enumeração é a **UNIÃO** de (A)
> fechamento transitivo do grafo Vite + (B) precache do `/sw.js`. Tudo empacotado no script:

```bash
.claude/skills/lovable-deploy-verify/scripts/verify-frontend.sh \
  --pai <sha-do-commit-ANTERIOR-ao-PR> \
  'COLE_UMA_STRING_LITERAL_UNICA_DO_COMMIT'   # 2º posicional opcional: a URL (default steu.lovable.app)
# saída: "✓ sentinela exclusiva: …" + "chunks (closure ∪ precache): N" + "✅ ALVO em <chunk>"
#        + "✓ CONTROLE_NEGATIVO_OK — <chunk> não casa controle_negativo_<hex>"   (ramo do hit)
#        + "✓ CONTROLE_POSITIVO_OK — <entry> ainda devolve bytes e o mesmo grep acha '<agulha>'"
# exit 0 = no ar E o controle negativo passou · 1 = ausente E o controle POSITIVO provou que a
#          sonda enxergava (Publish pendente / alvo não-literal)
#      2 = a MECÂNICA da sonda não é confiável: enumeração quebrada, SONDA_NAO_DISCRIMINA (ramo
#          do hit) ou SONDA_CEGA (ramo ausente)
#      3 = RECUSA: uso inválido, ou exclusividade da sentinela não provada — NUNCA é veredito
#          sobre o deploy (`--novo <sha>` muda o lado positivo; default HEAD)
```

> **Varredura PARALELA (não estoura mais o timeout).** O crawl e o grep do alvo rodam com `xargs -P 8`
> (override `PAR=<n>`); o grep tem **halt-on-hit** — o 1º chunk que casa faz `exit 255` → o xargs para de
> disparar novos. O bundle já passou de **300 chunks**: 1-a-1 sequencial **estourava 600s** (medido: exit
> 124, nem terminava — era a fonte dos "4 timeouts + 4 exit 143" numa sessão); paralelo varre tudo em **~1
> min**, menos no caso comum (string presente para cedo). Cada worker escreve no próprio arquivo → **sem
> intercalação** de linhas; a lógica da UNIÃO (fechamento transitivo ∪ precache) é **idêntica**. Rede de
> regressão: `evals/verify-frontend-eval.sh` (harness local determinístico — 2º nível, precache, exit
> 0/1/2/3, guard `--pai` nos dois lados + `--falsify`; entra no gate `evals/run.sh`).

**A sentinela tem de ser EXCLUSIVA do PR que se verifica — a não-exclusiva dá falso POSITIVO
(2026-08-24).** O script acha os bytes de **qualquer** string presente no bundle, **inclusive uma
que já estava lá antes do seu PR**: se ela veio de um PR ANTERIOR que tocou o mesmo arquivo, o verde
confirma um Publish que talvez não tenha acontecido. **Por isso `--pai` deixou de ser recado e virou
guard**: com ele o script prova a exclusividade no git — e **antes de tocar a rede** — recusando com
**exit 3** em vez de varrer. Os dois lados são exigidos, nesta ordem:

| lado | o que exige | por quê |
|---|---|---|
| **positivo** (`--novo`, default HEAD) | ≥1 ocorrência em `src/` | sem ele o zero no pai é **ausência de dado** (sha ou pathspec errado, string não-literal), não prova de novidade |
| **negativo** (`--pai`) | **0** ocorrência em `src/` | é o que separa "este Publish" de "bytes de um PR anterior" |

Fail-CLOSED: fora de repo git, sha que não resolve ou `--pai` sem valor **recusam** — guard que
degrada para "não provei" não guarda nada. `command -v git` não basta (presente-porém-quebrado
esvazia o guard igual): cada consulta exige resposta POSITIVA. **Sem `--pai` o script varre igual,
mas imprime `EXCLUSIVIDADE_NAO_PROVADA`** — o verde continua sendo seu, e a lacuna fica dita.

Arquivo **QUENTE** (vários PRs no mesmo dia) é onde isso morde, e foi onde mordeu: verificando o
#1949 (`src/hooks/useLastVisit.ts`, o **terceiro** PR no arquivo depois de #1934 e #1945), a
sentinela sugerida de início foi `visita_tentativa` — que era do **#1945**, mergeado e publicado
HORAS antes. É o caso que o guard hoje recusa, rodado no repo de verdade:

```console
$ verify-frontend.sh --pai b7a9f5a8a --novo a7571a596 'visita_tentativa'
❌ [--pai] SENTINELA_NAO_EXCLUSIVA — já existia em b7a9f5a8a (…), em 2 arquivo(s) de src/:
     …:src/hooks/__tests__/useLastVisit.test.tsx:6
     …:src/hooks/useLastVisit.ts:4
   Um verde com ela confirmaria bytes de um PR ANTERIOR, não este Publish.        # exit 3

$ verify-frontend.sh --pai b7a9f5a8a --novo a7571a596 'keepalive_network'
✓ sentinela exclusiva: 0 ocorrências em b7a9f5a8a · 1 arquivo(s) em a7571a596 (pathspec src/)
```

`keepalive_network` e `time_since_last_visit_resolvido` foram as sentinelas usadas de fato. É o
**irmão** da armadilha do id de EXEMPLO (`deploy.md` §Canárias), não a mesma: lá o erro é falso
NEGATIVO (reprova um deploy correto — caro, mas a verificação CONTINUA); aqui é falso POSITIVO,
estritamente pior, porque **ENCERRA** a verificação.

**O guard não prova que a sonda sabe dizer "não" — isso é o CONTROLE NEGATIVO, e ele virou
embutido (2026-08-24).** Um `exit 0` sozinho não distingue "está no ar" de "o script dá verde pra
tudo". Era recado (`verify-frontend.sh 'sentinela_de_controle_negativo_xyz'` num 2º comando,
exigindo exit≠0) — e recado depende de alguém lembrar, que é **exatamente** como a armadilha da
sentinela não-exclusiva acima passou. Agora, **quando o ALVO casa**, o script auto-audita antes de
devolver 0: reexecuta o **mesmo pipeline** (`curl`+`grep -q`+captura do `$HIT`) no **mesmo chunk que
acabou de casar**, com uma string hex aleatória nascida naquele processo. Se ela "casar" →
`SONDA_NAO_DISCRIMINA`, **exit 2**, e o `✅` acima não vale nada. Sem entropia pra gerar a string, o
script **recusa** (exit 3) antes de tocar a rede — mesma disciplina fail-closed do `--pai`.

**Por que UM chunk e não uma 2ª varredura inteira — a conta, medida em prod (2026-08-24, 334 chunks):**

| etapa | requests | tempo |
|---|---|---|
| enumeração (closure ∪ precache) | ~337 | **73 s** |
| grep do alvo, varrendo tudo (sem hit) | 334 | **18 s** |
| **controle A** — 2ª invocação completa (o recado antigo) | **+671** | **+91 s** |
| **controle A′** — embutido reusando a lista, só o 2º grep | **+334** | **+18 s** |
| **controle B** — 1 chunk, mesmo pipeline (**o implementado**) | **+1** | **+0,14 s** |

B custa **0,3%** dos requests de A′ e **0,15%** dos de A. E prova a mesma coisa: **discriminar é
propriedade do par (padrão, `grep`), não do chunk** — o padrão é o mesmo e o `grep` é a mesma
invocação, então repetir em 334 chunks é redundância, não informação nova. Os modos de falha que o
controle existe pra pegar (alvo vazio na expansão, `grep` trocado/shim, o `&&` virando `;`, `$HIT`
com lixo, `[ -n "$HIT" ]` invertido) são todos globais ao mecanismo; **nenhum** deles é visível em
334 chunks e invisível em 1. Os dois furos que sobram — servidor devolvendo conteúdo constante que
contém o alvo (fallback SPA), e alvo degenerado tipo `.*` — escapam **igualmente** de A e de B, logo
não são argumento a favor da versão cara. Roda contra prod:

```console
✅ ALVO em /assets/StaffDashboard-CM-hPkx2.js
✓ CONTROLE_NEGATIVO_OK — /assets/StaffDashboard-CM-hPkx2.js não casa controle_negativo_90896fde…
```

⚠️ **O que um controle EMBUTIDO não pode pegar, por construção:** a asserção é feita pelo próprio
script, então ele não denuncia "o script inteiro mente" (bloco do controle comentado, `exit 0`
plantado antes). Essa hipótese é de outra camada e tem dono: o gate `evals/run.sh --falsify`, que
sabota o script e **exige** vermelho — asserção externa, em commit-time. Runtime e commit-time
cobrem coisas diferentes; nenhum substitui o outro.

**O ramo `exit 1` tem o controle POSITIVO — o irmão, no ramo onde o risco se inverte.** O negativo
audita o falso **positivo**; ali o risco é o falso **negativo**: `exit 1` **afirma** "Publish
pendente", e uma sonda CEGA produz a MESMA saída — se os chunks passam a falhar (CDN 403 em
`/assets/*`, rate limit, DNS) enquanto o `index.html` ainda responde, a varredura volta vazia por não
ter enxergado nada, e o operador pede um Publish que não era necessário. Então, **antes de enunciar a
ausência**, uma **agulha** derivada do corpo do entry é procurada NO entry pelo MESMO `varre()`:

```console
✓ CONTROLE_POSITIVO_OK — /assets/index-TTF9Kw1g.js ainda devolve bytes e o mesmo grep acha '__vite__mapDeps' neles
→ ❌ ALVO ausente nos 334 chunks: Publish pendente, OU o ALVO não é literal/único no bundle
```

```console
❌ [controle] SONDA_CEGA: AGULHA_INDISPONIVEL — o corpo de /assets/index-TTF9Kw1g.js (0 bytes) não deu token de 12+ caracteres
   Logo NÃO dá pra afirmar 'ausente': varredura vazia por 'nenhum chunk casou' e por 'nenhum
   chunk RESPONDEU' são a mesma saída, e esta é a segunda.                                     (exit 2)
```

**Por que não é circular:** o corpo baixado lá no closure só **escolhe** a agulha; o veredito sai de um
`curl`+`grep` **novo**, no momento da conclusão — se a rede caiu no meio dos 18 s de varredura, é esse
request que denuncia. A agulha é **derivada, nunca fixa** (string fixa do bundle quebraria no build
seguinte e viraria `exit 2` espúrio) e **alfanumérica** — o maior token `[A-Za-z0-9_]` do corpo —
porque o `grep` dos chunks é BRE, e metacaractere mudaria a semântica do controle (mesma razão do hex
puro no negativo). Três modos de cegueira, marcas ASCII discrimináveis: `ENTRY_NAO_E_JS` (o chunk
respondeu HTML com 200 — fallback do SPA / erro; o `-f` do curl não pega, o corpo VEM, e sem esse
check a agulha nasceria do próprio fallback e casaria em si mesma), `AGULHA_INDISPONIVEL` (corpo
vazio/curto — é o caso do curl que falhou) e `AGULHA_NAO_CASOU`. **Custo:** o download do entry já
acontecia no closure e passou a ser salvo (0 request a mais ali); o controle é **1 request / 0,14 s**
sobre os 91 s do pior caso do script — **+0,15%**. Nos dois ramos a marca `CONTROLE_NEGATIVO_NAO_SE_APLICA`
continua saindo: ela diz qual dos dois controles está falando, não que falta controle.

**Sinal auxiliar de graça: o hash do chunk muda a cada build.** A saída já imprime `entry:` e
`✅ ALVO em <chunk>`, e os dois nomes carregam hash de conteúdo. **Anote-os.** Hash IGUAL ao da
verificação anterior = bundle velho, suspeite antes de comemorar — no #1949 o deploy trocou
`StaffDashboard-DzAIuK90.js` (o do #1934) por `StaffDashboard-BEQNVZMq.js`.

**Escolher a string-alvo — refactor visual NÃO tem texto novo.** A sentinela ideal é texto de UI
literal e único do commit. Mas refactor puramente visual (spinner→skeleton, cor→token, troca de
layout) não adiciona texto — e a string precisa estar em **JSX renderizado**: comentário (`//`),
teste e edge NÃO entram no bundle (mordido em prod 2026-07-07: `'identidade não provada'` só vivia
num comentário → falso "ausente", não prova nada). Duas saídas:
- **Calibrar** com uma string RENDERIZADA já existente da própria página (um `<h2>`/label antigo) —
  prova que o chunk certo está no ar + o método enumera (não é falso-negativo). Não prova a versão.
- **Provar a versão** por **assinatura estrutural** no chunk da página, baixado direto
  (`curl .../assets/<Página>-<hash>.js`): a **prop/classe NOVA presente E a marca REMOVIDA ausente**,
  as duas no MESMO chunk (uma só pode dar falso-positivo por reuso). Ex. spinner→skeleton (provado
  #1215): `variant:"detail"` presente (o `<PageSkeleton>` novo) **+** `animate-spin` ausente (o
  `<Loader2>` que saiu). Pela atomicidade do Publish (build da `main` inteira), 1 página provada ⇒ o
  lote todo no ar.
  - **Marca removida não-única** (componente eager / classe Tailwind reusada em chunks lazy): a ausência
    **global** não prova nada. Ancore o chunk-alvo pela string renderizada única do mesmo fluxo (a *Calibrar*
    acima, como localizador) e valide as TRÊS no MESMO chunk: (i) marca removida ausente, (ii) unicidade dela
    naquele escopo provada antes (`git grep` no commit pai), (iii) um **controle positivo irmão** ainda
    presente — senão chunk vazio / leitura quebrada lê como "removido". Ex. #1232 (spinner→skeleton no
    `ProtectedRoute` eager): `animate-spin text-primary`=0 (removido) **+** `animate-spin text-muted-foreground`≥1
    (gates vizinhos intocados = controle).

⚠️ Guards embutidos que dão **exit 2** (= a mecânica da sonda não é confiável; NÃO conclua "não está
no ar", conserte o script primeiro): contagem 0/1 de chunks = **enumeração quebrada** (formato do
bundler/Workbox mudou); controle negativo casando = **`SONDA_NAO_DISCRIMINA`**. Os bytes provam que o **código subiu**; se a
mudança for **visual** (renderização/comportamento na tela), a prova complementar é o **QA visual do
Passo 4b** — o maior sinal sem o founder continua sendo este, pelos bytes.

**Edge — a escada (o código da edge NÃO é servido em produção, logo não há prova por bytes):**

```bash
.claude/skills/lovable-deploy-verify/scripts/verify-edge.sh <nome> [<nome2> ...]
# N1 existência (sem auth): OPTIONS -> servida (200) vs AUSENTE (404); exit 1 se alguma 404.
# N2 versão: Management API — INDISPONÍVEL neste projeto (Supabase é da org do Lovable). NÃO peça PAT.
```

- **N1 existência** — automático e barato, mas só prova que a função está servida, **não** que é a versão nova.
- **N2 versão** — seria o canônico (`version` sobe, `updated_at` fica recente), mas aqui é **estruturalmente indisponível**: o app roda em **Lovable Cloud** e o Supabase (`fzvklzpomgnyikkfkzai`) é da **org do Lovable** — o founder não tem conta com acesso ao ref, logo **não existe Access Token que ele possa gerar**. ⛔ **Não peça o PAT** (pedido 3× já: 2× em 2026-07-23 + 1× em 2026-08-19 — nas três o agente seguiu o texto da ferramenta, não o doc). `~/.config/afiacao/supabase-pat` existe vazio: mecanismo válido, sem quem preencha. O substituto do N2 é o **rastro do commit do bot** na `main` (`Deployed …`/`Redeployed …`) — prova que UM deploy rodou, não QUAL versão.
- **N3 comportamento** — chamar com a assinatura da mudança (gated → founder logado / cron secret). Sem N2 aqui, é a **única prova de versão** que existe neste setup — não um luxo. Edge sem canária: declare "N1 + rastro; versão não provada", **nunca** "no ar".
  - **5 edges já nascem com canária** (#1772): `fin-cashflow-engine`, `omie-cliente`, `omie-nfe-webhook`, `omie-sync-estoque`, `omie-sync-nfes-recebidas` respondem `{"probe":true}` com `{ok,probe:true,versao}` (contrato em `supabase/functions/_shared/sonda-versao.ts`). O eco `probe:true` é **obrigatório** na leitura: bundle ANTERIOR à sonda **ignora o parâmetro e executa o fluxo real** (sync Omie de verdade) — por isso **só sonde DEPOIS do deploy**, e resposta sem o eco já é o veredito "bundle velho, e ele rodou o efeito caro". Invocação sem terminal: bloco `net.http_post` no 🟣 SQL Editor + leitura de `net._http_response` (receita em `docs/agent/deploy.md` §Canárias).

### Passo 4b — QA visual pós-Publish (Claude-in-Chrome na sessão logada do founder)

Os bytes (Passo 4) provam que o **código subiu** — não que a tela **renderiza/comporta** certo. Refactor
puramente visual (spinner→skeleton, layout, token de cor) e perguntas de tela ("cadê os R$ 5,1 mi neste
painel?") pedem **olho**. Duas armadilhas já registradas — **não repita**:

- **`/browse` do gstack (headless) NÃO serve:** a SPA React **não monta** nele (3 falhas). Não é bug do
  browse — é headless sem o runtime da app.
- **Chrome MCP genérico** deu timeout CDP de 45s em outra sessão.

**O que FUNCIONA** (caso de sucesso real: o agente configurou o PostHog inteiro sozinho): **Claude-in-Chrome
no Chrome REAL logado do founder.** A sessão autenticada (login/RLS/lente "Ver como") já está viva na aba
dele — o agente **navega e confere**, em vez de devolver a verificação pro olho do founder ("não achei os
R$ 5,1 mi nessa tela, quer entrar e ver?").

**O padrão (inverte o ônus — o AGENTE confere, não o founder):**
1. **Handoff do founder = 1 clique:** abrir o app logado (`steu.lovable.app`) no Chrome real com a extensão
   **Claude-in-Chrome** conectada. É o ÚNICO passo manual — sem sessão autenticada não há como ler tela
   gated (login/RLS/impersonação).
2. **Carregar as tools numa chamada só** (são *deferred*): `ToolSearch` →
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__computer`
   (não uma-a-uma — cada `ToolSearch` é um round-trip).
3. **`tabs_context_mcp`** acha a aba já aberta → **`navigate`** pra rota-alvo → **`read_page`**/screenshot lê
   o estado renderizado → **`computer`** só se precisar interagir (abrir menu, filtrar, paginar).
4. **Assertar o que a mudança prometia** (o número aparece? o skeleton no lugar do spinner? o fluxo
   completa?) e **reportar com a evidência lida** (texto/print) — nunca "deve estar ok".

⚠️ **Escopo & segurança:** é a sessão REAL do founder — **só LEITURA/navegação de QA**; nada de
escrita/ação destrutiva/mover dinheiro sem ele pedir (valem as regras de Chrome/computer-use; URL de
origem duvidosa: confirmar antes). Sem a aba logada aberta, **degrade honesto:** "bytes provam que subiu
(Passo 4); a renderização eu confirmo quando você abrir o app logado no Chrome (Passo 4b)."

**Exercitado 2026-07-08 (o que esperar antes de tentar):** a aba que a extensão controla é um **contexto
próprio** — **não herda** a sessão de outra aba/perfil só porque o founder está logado no Chrome. No teste,
`steu.lovable.app` caiu direto no **`/auth`** e o console trouxe `AuthApiError: Invalid Refresh Token:
Refresh Token Not Found` (o Supabase guarda a sessão em `localStorage` **por origem**; a aba MCP não tinha a
chave). Consequências práticas:
- **RENDER + telas públicas o agente confere SOZINHO** — a SPA React **monta de verdade** aqui (o que os
  bytes NÃO provam e o `/browse` headless não faz); `/auth`, landing e afins são QA legítimo sem login.
- **Telas gated exigem o founder logar NA aba do grupo MCP** (`tabs_context_mcp` → ele loga ali), não em
  outra aba. Detecção barata de "sem sessão": redirect pra `/auth` **ou** `read_console_messages` com o erro
  de refresh token → **degrade e peça o login; o agente NUNCA digita credenciais** (linha vermelha).
- Sanidade útil de graça: `read_console_messages onlyErrors` na tela renderizada — mas o `Invalid Refresh
  Token` numa aba deslogada é **esperado** (fail-closed do auth), não regressão.

**Exercitado 2026-07-12 (QA do #1300 — o "404 fantasma" pós-Publish):** rota NOVA deu **404 com os bytes
PROVADOS no ar** (Passo 4 verde). Não era o Publish — era o **service worker do PWA servindo o build
ANTERIOR** na aba: a SPA velha monta (título ok) e o catch-all loga `404 Error: User attempted to access
non-existent route` vindo de um chunk `NotFound-*.js` de hash VELHO (a assinatura no console). **Hard-reload
(Cmd+Shift+R) na aba ativa o SW novo** e a rota monta. Regras práticas:
- Bytes verdes + 404 na tela ⇒ **suspeite do SW antes de suspeitar do Publish** — nunca conclua "não subiu"
  contra o Passo 4 sem hard-reload.
- Vale pros USUÁRIOS também: quem já tinha o app cacheado vê o build antigo no 1º acesso pós-Publish —
  reload resolve (design offline-first, não regressão). Mudança de ROTA nova demora 1 ciclo de SW pra
  chegar em quem não recarrega.

### Passo 5 — Confirmar honestamente

- Frontend: "✅ no ar — `ALVO` presente em `<chunk>`, entry hash `<novo>`" **ou** "❌ ainda o build velho (hash inalterado / alvo ausente) — Publish pendente".
- Edge: nunca "Active = no ar" (Active só prova existência). Diga o NÍVEL provado: "✅ N2 — version subiu + updated agora" / "✅ N3 — probe `<assinatura>` confere" **ou** "só N1 (existe); versão não confirmada — falta PAT/founder".
- Nunca um "pronto!" genérico sem uma dessas evidências por camada tocada.

---

## Smoke E2E autônomo (carimbo de SHA + monitor)

O build **carimba o commit no bundle** (`vite.config` → `define __COMMIT_SHA__`; `main.tsx` →
`window.__BUILD_SHA__`). Com isso o monitor responde "**o ar == `origin/main`?**" sem adivinhar um ALVO:

```bash
.claude/skills/lovable-deploy-verify/scripts/monitor-deploy.sh [url] [sentinela]
# exit 0 = sincronizado · 3 = ATRASADO (Publish pendente) · 4 = deploy novo, versão indeterminada
```

- **Determinístico** quando o ar tem `__BUILD_SHA__="<sha>"` — compara com `origin/main`.
- **Fallback**: se vier `"dev"` (Lovable sem `.git` no build) ou ausente (build pré-carimbo), passe uma
  `sentinela` (string de UI única do HEAD) → o monitor cai pro `verify-frontend.sh`.
- **Agendar** (cron de sistema, sem gastar Claude): `*/30 * * * * cd <repo> && bash .../monitor-deploy.sh
  >> ~/.config/afiacao/deploy-monitor.log 2>&1` (exit 3/4 = avisar; combine com `osascript`/email).

⚠️ **Confirmado em prod (2026-06-26):** o ar serve `__BUILD_SHA__="dev"` — o build do Lovable roda **sem
`.git`**, então o carimbo nunca materializa um SHA real e o caminho determinístico é **inviável neste host**.
Consequência operacional: o monitor **depende SEMPRE da sentinela** (2º arg) — sem ela, exit 4 ("indeterminado")
a cada run. E **passe a URL com `https://`**: sem esquema, o `curl` (sem `-L`) volta vazio e o monitor reporta
falso `"fora do ar"` (exit 2) — não é o site caído, é a URL malformada.

## Referências
- CLAUDE.md §"Deploy do FRONTEND (app) — Publish MANUAL no Lovable" (a técnica dos bytes; armadilha do chunk de nome inesperado)
- CLAUDE.md §"Edge functions — caminho oficial Lovable" (deploy via chat, ler do repo, verbatim)
- CLAUDE.md §5 lições #383/#252 (deployar edge só após merge), #608 (verificação por bytes usada com sucesso)
- Skill irmã `lovable-db-operator` (camada de banco)

## Estado / pendências
- [x] Enumeração = **UNIÃO** (fechamento transitivo do Vite ∪ precache do Workbox) — nenhuma fonte sozinha é completa (closure 274 ⊃ precache 268; precache omite 6). Validado em prod + Codex; empacotado em `scripts/verify-frontend.sh`.
- [x] **Controle negativo EMBUTIDO (2026-08-24):** deixou de ser 2º comando manual e passou a rodar
  sozinho no ramo do hit — mesmo pipeline, mesmo chunk, string hex aleatória do processo; casou =
  `SONDA_NAO_DISCRIMINA` + exit 2. Escolhido o controle de **1 chunk** sobre a 2ª varredura completa
  com número, não opinião (prod, 334 chunks: **1 req / 0,14 s** contra **334 req / 18 s** ou **671 req
  / 91 s**), porque discriminar é propriedade do par (padrão, `grep`) e não do chunk. Harness: +4 casos
  e +2 sabotagens (grep degenerado → o controle acusa; controle trocado por string que DEVE casar →
  prova que ele exercita a rede e não é enfeite). Detalhe no Passo 4.
- [x] **Controle POSITIVO no ramo `exit 1` (2026-08-25):** a lacuna acima fechada — "ausente" só é
  ENUNCIADO depois de o script provar que ainda enxerga, com uma agulha DERIVADA do corpo do entry
  procurada pelo MESMO `varre()`; cega → `SONDA_CEGA` + exit 2, nunca exit 1. **+1 request / 0,14 s
  sobre 91 s (+0,15%)**, porque o download do entry já acontecia no closure. Harness: +4 casos (2
  fixtures novos — `site-cego` com `/assets/*` em 404 e `site-fallback` servindo HTML com 200) e +3
  sabotagens. E um furo do PRÓPRIO harness saiu junto: `falsify_case` aceitava o `exit_normal`
  **declarado**, então uma sabotagem escrita antes da feature ficava verde sem sabotar nada — agora
  o normal é **medido** no script real antes de comparar. Detalhe no Passo 4.
- [x] `evals/` = **gate dos 2 passos**: classificação de diff (8 casos, Passo 1) **+** verificação por bytes (harness local `verify-frontend-eval.sh`, Passo 4: 2º nível, precache, exit 0/1/2), ambos com `--falsify`. Um `bash evals/run.sh` cobre tudo.
- [x] Domínio canônico `steu.lovable.app` confirmado (HTTP 200).
- [x] **Edge:** verificação por escada — N1 existência (`verify-edge.sh`, OPTIONS, automático) · N2 versão (Management API — indisponível aqui: Supabase da org do Lovable, não peça PAT) · N3 comportamento (probe gated). Fecha a assimetria com o frontend.
- [x] **Smoke E2E autônomo:** carimbo de SHA no build (`__BUILD_SHA__`) + `monitor-deploy.sh` (cron) compara o ar vs `origin/main`. **Exercido em prod 2026-06-26** (pós-Publish do #1065): o carimbo está no ar mas vem `"dev"` (Lovable builda sem `.git`) ⇒ SHA determinístico inviável neste host; **fallback de sentinela validado ponta-a-ponta** (`get_ultimos_precos_cliente` PRESENTE → exit 0). Regra firmada: no cron, **sentinela obrigatória + URL com `https://`** (ver ⚠️ acima).
- [x] **Varredura PARALELA (2026-07-07):** `xargs -P 8` no crawl + halt-on-hit (`exit 255`) no grep do alvo. O bundle passou de 300 chunks (união medida 308–560) — sequencial estourava 600s (exit 124, não terminava); no mesmo bundle (308 ch, sentinela ausente) **299s → 61s (~4,9×), mesmo exit**. Enumeração/UNIÃO **inalterada** (worker-por-arquivo → sem intercalação). `PAR=<n>` overridável. Rede: harness local + gate `run.sh`.
- [x] **QA visual pós-Publish (Passo 4b, 2026-07-07):** padrão documentado — **Claude-in-Chrome na sessão logada do founder** (ele abre 1×, o agente confere as telas). `/browse` headless não monta a SPA (3 falhas); Chrome MCP genérico deu timeout CDP de 45s. Caso de sucesso: config do PostHog feita pelo agente sozinho. **Exercitado 2026-07-08:** RENDER confirmado (a SPA monta no Chrome real; QA de tela pública `/auth` OK) — mas a aba do grupo MCP veio **sem sessão** (`Invalid Refresh Token`), então **telas gated dependem do founder logar NA aba MCP**; agente nunca digita credenciais. Detalhe no Passo 4b.
- [x] **"404 fantasma" pós-Publish (2026-07-12, QA visual do #1300):** rota nova 404 com bytes VERDES = **SW do PWA servindo o build anterior** (assinatura: `NotFound-*.js` de hash velho logando "non-existent route"); hard-reload ativa o SW novo. Regra: bytes verdes + 404 → suspeitar do SW, nunca concluir "Publish falhou" sem hard-reload. Detalhe no Passo 4b.
- [ ] (menor) Confirmar se há ambiente de **preview** distinto do publicado a checar.
