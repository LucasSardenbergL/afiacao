# A fatia de deploy tem eixo TEMPO — o PR nomeado não é a pergunta

> 2026-08-30, verificando as 7 edges do #2123. Alvo: o Passo 3 da skill
> `lovable-deploy-verify`. Irmão temporal do #2127 (`--name-status` é cego ao
> import novo de arquivo pré-existente ⇒ a fatia é o CLOSURE, não o diff).

## 1. A tarefa chegou nomeando um PR, e o PR já não era a fatia

O pedido foi explícito e bem-formado: verificar se as 7 edges tocadas pelo **#2123**
(`1cab89d49`, mergeado às **04:04Z**) estão no ar, e montar o pedido de deploy do que faltar.
Trazia até a lista de arquivos derivada do `git show --name-status` daquele commit.

A medição desmontou a premissa por um eixo que a lista não tem:

| commit | horário | tocou o closure das 7? |
|---|---|---|
| #2123 `1cab89d49` | 04:04Z | sim (a fatia nomeada) |
| #2121 `4aa627c81` | 15:33Z | sim — `_shared/reenvio-pedido.ts` (**NOVO**) |
| #2132 `5362ec761` | **16:41Z** | sim — `itens-com-pedido.ts`, `universo-pedidos.ts`, `leitura-critica.ts`, `sonda-fingerprints.ts` |

A verificação começou às **17:13Z**: o #2132 tinha **32 minutos**. O Lovable deploya lendo a
**`main`**, não o commit citado no pedido — então mesmo que o #2123 estivesse comprovadamente no
ar, as 7 precisariam de deploy do mesmo jeito, e um pedido montado com a lista do #2123 subiria
o #2132 **com a lista de arquivos errada**: faltariam os três `_shared/` que só o #2132 tocou, e
a função não bootaria. O modo de falha é o do #2020, alcançado por outro caminho.

**A classe:** `--name-status <sha>` responde *"o que aquele commit tocou"*. A pergunta do deploy é
*"o que a `main` tem de diferente do que está no ar"* — e as duas divergem assim que **qualquer**
outro PR toca o mesmo closure depois. Não é um caso raro: neste repo o auto-merge fecha PR em
minutos, e o CLAUDE.md já manda **re-conferir `origin/main` imediatamente antes do `gh pr create`**
pelo motivo gêmeo. O que faltava era a mesma disciplina do lado da **verificação de deploy**.

## 2. Aconteceu DE NOVO, dentro da mesma sessão

Depois de entregar o pedido, ao começar a escrever esta própria lição, o `git fetch` de rotina
mostrou `origin/main` em **`0d2b32b3e`** (17:46Z) — a main tinha andado outra vez, ~30 min depois
da medição. Desta vez o commit não tocou `supabase/functions/` (o pedido de deploy seguiu válido),
mas tocou **`scripts/sonda-versao-sql.ts`**: o bloco de sonda já entregue ao founder estava gerado
pelo gerador **anterior**, aquele que ainda exigia colar o JSON de `request_id` à mão
([`sonda-eco-passivo-sem-colagem.md`](sonda-eco-passivo-sem-colagem.md)). O artefato foi regerado.

Duas derivas em ~1h30, em eixos diferentes — **fatia de código** e **ferramenta que gera o
artefato**. É por isso que "sincronizar antes de medir" não basta: também é preciso **sincronizar
antes de ENTREGAR**, porque entre a medição e a entrega existe o tempo em que você escreve.

### 2.1 A terceira ocorrência é uma PREVISÃO, e ela testa a regra

Ainda na mesma sessão, o hook de colisão multi-sessão acusou o **PR #2134** (DRAFT, atualizado
17:58Z), que toca `supabase/functions/sync-reprocess/{index.ts,versao.ts}` — **uma das 7** — e
`_shared/sonda-fingerprints.ts`, que está no closure de **todas**. Enquanto ele for draft o pedido
entregue continua válido; no minuto em que sair de draft e mergear, o `fonte` esperado das **7**
muda e o `sync-reprocess` ganha arquivo próprio na fatia. A regra deixa de ser retrospectiva e vira
**operacional**: quando existe PR em voo sobre o mesmo closure, o pedido de deploy tem prazo de
validade, e isso precisa ir dito **junto com o pedido** — não descoberto depois pelo founder.

⚠️ **Método, de brinde:** `gh pr diff <n> -- <path>` devolveu **vazio** para um arquivo que o PR
realmente toca — o pathspec não filtra como no `git diff`, e o vazio se lê como "não colide". A
fonte correta é `gh pr view <n> --json files`. Mais um caso de ausência-de-dado com cara de
resposta, na dimensão **FERRAMENTA**.

## 3. O que a verificação por PR nomeado NÃO detecta

O ponto fino: as três edges sem arquivo próprio na fatia — `scoring-recalc-batch`,
`sync-reprocess`, `visit-score-recalc-batch` — continuam em `VERSAO = "v1.0-sensor-inicial"` nos
**dois** lados. Uma verificação que compare marcadores as declararia idênticas e concluiria "nada
mudou", quando o bundle delas mudou por inteiro via `_shared/`. Só o **`fonte`** (fingerprint da
fonte) as discrimina — os 7 hashes mudaram, os 3 `VERSAO` não. Casado com a regra já registrada em
[`verificabilidade-do-conjunto-orquestrado.md`](verificabilidade-do-conjunto-orquestrado.md): o
marcador esperado é **por edge**, nunca "o bump do lote".

## 4. A pergunta certa, e como perguntá-la

Trocar o eixo de **commit** para **intervalo até `origin/main`**, e fechar o closure sobre esse
intervalo:

```bash
git fetch origin                       # ANTES de medir — e outra vez antes de ENTREGAR
git diff --name-status <sha-do-PR>^ origin/main -- supabase/functions/ | grep -v '_test\.ts$'
```

O `^` no lado esquerdo e **`origin/main`** no direito são o que faz a fatia cobrir tudo que entrou
depois. Sobre o resultado, o closure de imports de cada edge (`from '...'` — **aspas simples E
duplas**; nesta sessão um regex só-aspas-duplas devolveu closure **vazio** para 3 das 7, e "0
arquivos" só não passou por resposta porque o `stderr` estava visível).

E ao montar o pedido, nomeie o **estado**, não o PR: *"deploy these functions from the `main`
branch"*. Um pedido que diz "o código do #2123" convida o Lovable a resolver uma referência que já
não descreve o que precisa subir.

## 5. Nota sobre o custo — por que não sondar antes

A skill abre uma exceção para sondar **antes** do deploy (a única ordem em que a sonda EVITA um
deploy redundante), válida quando a versão que se teme estar no ar já tinha sonda. Aqui ela não se
aplicava, por duas medições:

1. As 7 **não ecoam identidade em resposta normal** — só na sonda (`respostaSonda(VERSAO)`,
   conferido no `index.ts` da main **e** do pai). O TTL inteiro (264 respostas, 11:15→17:10Z) não
   tem nenhuma delas. Não é a intermitência do #2079: é ausência **estrutural**, e esperar o
   próximo tick não muda.
2. Com a main tendo mudado há 32 min e zero rastro de deploy, a sonda pré-deploy gastaria um
   round-trip com o founder para confirmar o que o relógio já dizia — e em **4 das 7** ela é
   **cara** (bundle pré-sensor ignora o probe: `carteira-positivacao-snapshot` regrava o snapshot
   do mês anterior, `visit-score-recalc-batch` faz upsert, `scoring-recalc-batch` dispara o
   fan-out, `fin-valor-cockpit` paga 9 varreduras completas).

Uma via de prova positiva foi tentada e **fechada por configuração**: as RPCs novas do #2132
(`cockpit_itens_snapshot`, `apriori_universo_snapshot`) são *incapazes* de serem chamadas pelo
bundle velho, o que seria discriminador perfeito — mas `track_functions = none`, então
`pg_stat_user_functions` volta vazio por **config**, não por ausência de chamadas, e
`pg_stat_statements` não existe neste banco. Ler aquele vazio como "nunca chamada" teria sido
`ausente ≠ zero` na dimensão **INSTRUMENTAÇÃO** — o guard é checar o `track_functions` **antes** da
contagem, e nunca a contagem sozinha.
