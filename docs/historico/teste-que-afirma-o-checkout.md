# O teste que afirmava o CHECKOUT, não o código — e deixava o `mutation-check` vermelho em todo PR

**2026-09-06.** Classe: **asserção sobre o AMBIENTE disfarçada de asserção sobre o código.** O job
`mutation-check` do CI estava vermelho em TODOS os PRs recentes, sempre na mesma linha, sem que PR
nenhum tivesse causado — e como ele **não é required** na branch protection, o vermelho constante
treinava a ignorar o job. Exatamente o "sinal vermelho que ninguém lê".

## O sintoma e o paradoxo

```
mutcheck: scripts/sonda-versao-sql.ts × scripts/sonda-versao-sql.test.ts
  baseline: ✗ VERMELHO — a suíte já falha sem mutação. Resultados seriam lixo. Abortando.
mutcheck-all: ✗ 1/23 contrato(s) com problema: sonda-versao-sql.mut (exit 1)
```

O `mutcheck` estava **certo**: ele tem controle de baseline e RECUSA medir sobre vermelho — porque
uma suíte sempre-vermelha "pega" todo mutante e aprovaria qualquer coisa. Baseline vermelho não é
medição ruim, é **ausência de medição** (mesma doutrina de
[falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md)).

O que confundia:

1. `bun run mutcheck` **local** passava: 23/23 contratos honrados.
2. O job `validate` do **mesmo run** passava — e ele roda `bun run test`, que inclui esse arquivo.
3. Logo, a mesma suíte passava no `validate` e falhava no `mutation-check`.

## A causa raiz: dois jobs, dois CHECKOUTS

`validate` e `mutation-check` são **jobs distintos, cada um com o seu `actions/checkout`** — não o
mesmo runner. E eles não pedem a mesma coisa:

| job | checkout | `refs/remotes/origin/main` existe? |
|---|---|---|
| `validate` | `actions/checkout@v5` **com `fetch-depth: 0`** (pelo merge-base do gate `sonda:bump`) | **sim** |
| `mutation-check` | `actions/checkout@v5` **nu** (default `fetch-depth: 1`) | **não** |

Medido no log do run 34006830215 (job `mutation-check`):

```
git init /home/runner/work/afiacao/afiacao
git remote add origin https://github.com/LucasSardenbergL/afiacao
git -c protocol.version=2 fetch --no-tags --prune --depth=1 origin +<sha>:refs/remotes/pull/2219/merge
git checkout --progress --force refs/remotes/pull/2219/merge
```

Num PR com `fetch-depth != 0`, o checkout busca **só o merge ref**. `origin/main` nunca é criada.

E `scripts/sonda-versao-sql.test.ts` tinha:

```ts
const r = gitReal(RAIZ_REPO)(['rev-parse', '--verify', '--quiet', 'origin/main']);
expect(r.status).toBe(0);
```

`RAIZ_REPO` é o checkout da sessão. Reproduzido fora do CI (`git init` + remote, sem a ref):

```
worktree local (checkout completo) → {"status":0,"stdout":"74312ffa…"}
repro do runner (só o merge ref)   → {"status":1,"stdout":""}
```

O teste não media o `gitReal`: media se **quem clonou o repo** tinha buscado a `main`. Verde no
worktree do dev e no `validate`; vermelho em qualquer clone raso.

## A regra

**`refs/remotes/origin/main` é propriedade do CLONE, não do código.** Teste que a exige está
afirmando o ambiente. Se o teste precisa de uma remote-tracking ref, ele **constrói** o repo:

```ts
git('init', '-q'); …; git('update-ref', 'refs/remotes/origin/main', 'HEAD');
```

— idioma que os arneses shell da casa já usavam (`test-fecho-edges-pendentes.sh`). O fixture usa
`spawnSync` cru de propósito: montá-lo com o próprio `gitReal` faria o teste do executor depender
do executor.

## Por que NÃO foi consertado com `fetch-depth: 0` no `mutation-check`

Consertaria o sintoma **naquele job** e deixaria a bomba armada: qualquer clone raso legítimo
(outro job, um worktree recém-criado sem fetch, um `git clone --depth`) voltaria a ficar vermelho,
e o custo é ~118 MB de clone por PR (medido no comentário do `validate`). A causa é a asserção, não
o checkout.

## Ecos

- **Baseline verde é pré-condição de qualquer medição por mutação/falsificação** — e o `mutcheck`
  já fazia a coisa certa ao abortar. Não afrouxe o controle de baseline para "destravar" o job.
- **Job não-required que fica vermelho por semanas é pior que job ausente:** ele ensina a rolar o
  olho pelo vermelho. Ou conserta ou sai.
- Vizinho de classe: [teste-que-afirma-o-defeito.md](teste-que-afirma-o-defeito.md) (a suíte verde
  que afirmava o bug) — aqui a suíte vermelha afirmava o clone.

## Adendo (2026-09-06): o fixture ainda herdava a config GLOBAL do hospedeiro

O #2227 tirou do teste a dependência da **ref** do checkout, mas o fixture que entrou no lugar
deixava a **config global** decidir seu desfecho: `git commit` obedece `commit.gpgsign` e roda os
hooks de `core.hooksPath`/`init.templateDir` do usuário. Numa máquina com assinatura global ligada,
o commit do fixture pede passphrase e a suíte INTEIRA (91 testes) fica vermelha por **config**, não
por comportamento. Mesma classe um nível abaixo: a ref é propriedade do CLONE, a config é da MÁQUINA.

Blindagem: `-c commit.gpgsign=false` + `--no-verify` no commit do fixture. Mora no helper
COMPARTILHADO `repoGitCru()` (extraído pelo #2243), não em cada chamador — então cobre de uma
vez os dois fixtures, o COM a `origin/main` e o SEM ela.

**Medido na M2 do founder em 2026-09-06:** `commit.gpgsign`, `core.hooksPath`, `init.templateDir` e
`tag.gpgsign` globais todos VAZIOS — risco não-materializado. Ficou fora do #2232 de propósito:
conserto especulativo não entra no mesmo diff que o diferencial medido.

### Como se provou que as duas flags não são decoração

O `mutcheck` mede o **fonte** (`sonda-versao-sql.ts`); flag de fixture vive no **teste**, então o
contrato não lhe dá dente nenhum — e num hospedeiro limpo as duas são no-op, logo "91/91 verde" é
**ausência de dado**, não aprovação. A prova exigiu **forjar o hospedeiro** (`GIT_CONFIG_GLOBAL`
apontando para um `.gitconfig` hostil) e sabotar **uma camada por vez**, com o controle verde na
MESMA invocação do laço:

| cenário | esperado | medido |
|---|---|---|
| variante sabotada / hospedeiro limpo | verde (a sabotagem sozinha não quebra) | verde |
| fiel / `gpgsign=true` + `gpg.program` inexistente | verde | verde |
| fiel / `core.hooksPath` com `pre-commit` que reprova | verde | verde |
| **sem `-c commit.gpgsign=false`** / hostil-gpg | **vermelho** | vermelho: `cannot exec '/nao/existe/este/gpg'` |
| **sem `--no-verify`** / hostil-hooks | **vermelho** | vermelho: `HOOK-GLOBAL-REPROVOU` |

Cada vermelho casa a **marca própria** da sua camada (não "lançou algo"), e a mensagem de erro
mostra a OUTRA flag ainda presente no comando — o que prova que o isolamento foi limpo e que
nenhuma das duas é redundante. Sabotar as duas juntas teria medido UMA coisa, não duas.

**Eco:** contrato de mutação sobre o fonte é cego para o ARNÊS. Blindagem de fixture só se prova
forjando o ambiente que ela promete neutralizar — senão o verde vem de a hostilidade não existir.
