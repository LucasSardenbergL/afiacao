# O proxy de ingestão do PostHog: construído, revisado e DESCARTADO (2026-08-25)

> **Por que este arquivo existe:** o código não está na `main` e não estará. O que sobrevive são
> duas lições que a revisão adversarial produziu — e o registro de que isto **já foi tentado**, para
> a próxima sessão não reconstruir. A decisão de produto vive na `§DECISÃO` de
> [`analytics.md`](../agent/analytics.md); a colisão entre sessões, em
> [`duplicata-por-objetivo.md`](duplicata-por-objetivo.md).

## O que foi construído, e por que foi jogado fora

O `#1984` provou que `us.i.posthog.com` está bloqueado no cliente (no Chrome do founder o `fetch`
morre em **4 ms**; num Chromium limpo, `200` em **1112 ms**, mesma máquina e minuto). A resposta
desenhada foi um proxy de ingestão em edge do Supabase: roteamento puro com allowlist, edge pública
com travas, tabela + RPC de contador, contador fire-and-forget e doc. Cinco tarefas, executadas com
subagentes, com revisão adversarial por tarefa (a da edge levou **3 rodadas**; a do banco, **2**).

Foi descartado porque a premissa era falsa, e a medição que a derruba veio de outra sessão: a
população externa que o proxy recuperaria é **vazia** — `user_roles` com role customer = **5.664**,
mas `profiles` aprovados = **4** (todos internos) e customers **aprovados = 0**. Os 5.664 são
cadastro importado da Omie: sem `is_approved` ninguém entra. Some-se que `*.supabase.co` **não é
first-party** — é obscuridade que expira na próxima atualização de lista — e que o único cliente
bloqueado medido era o próprio founder, o que faz do proxy um contorno do opt-out de si mesmo.

**Nada chegou a produção:** nenhuma migration aplicada, nenhuma env setada, edge nunca deployada, o
branch nunca pushado. O desenho continua recuperável — spec e plano estão na `main` pelo #2011,
marcados como superados.

## Lição 1 — um guard cujo COMENTÁRIO e cujo NOME DE TESTE afirmam cobertura que ele não tem

O módulo de roteamento recusava travessia de caminho checando `..`, `%2f`, `%5c` e `\`. O comentário
dizia que pegava "inclusive percent-encoded". O teste se chamava "travessia de diretório é
recusada". **As duas afirmações eram falsas**, e a suíte estava verde porque os casos testados eram
exatamente os que o guard pegava.

A revisão final não aceitou a triagem: **rodou**. E a allowlist de caminhos inteira caiu:

```
"/static/%2e%2e/%2e%2e/x"             => rota assets, alvo final https://us-assets.i.posthog.com/x
"/static/%2E%2E/%2E%2E/api/projects"  => rota assets, alvo final https://us-assets.i.posthog.com/api/projects
```

`%2e` é o ponto percent-encoded; o guard nunca o viu, e a normalização WHATWG do `fetch` remonta o
`..` **depois** da checagem. O host literal segurava o pior caso (sem SSRF, sem credencial relayada),
mas qualquer caminho dos dois hosts ficava alcançável anonimamente.

⚠️ **O agravante é de PROCESSO, não de código:** este achado foi triado como *"Menor, impacto
baixo"* **três vezes** — por dois revisores de tarefa e pelo orquestrador, que o carregou de tarefa
em tarefa sem nunca executá-lo. Três julgamentos concordantes, nenhuma medição. O que quebrou o
empate foi um revisor que rodou três linhas.

> **A regra:** severidade de um bypass não se estima por leitura, e concordância entre revisores não
> substitui execução. Se o achado é *"o guard talvez não cubra X"*, o custo de **construir X e
> rodar** é de minutos — e é a única coisa que distingue "impacto baixo" de "allowlist decorativa".
> Um guard é código como outro qualquer: só o que tem teste que **reprova quando ele some** está
> coberto.

## Lição 2 — revisão POR TAREFA é estruturalmente cega à composição ENTRE tarefas

Cada tarefa foi revisada e aprovada isoladamente, e as aprovações estavam **certas**:

- a edge (Task 2) não toca banco — pública sem auth, mas só encaminha;
- o RPC (Task 3) é inatacável isolado — `SECURITY DEFINER`, mas só `service_role` executa, com
  `REVOKE` nomeando `anon` e `authenticated`.

Cruzando as duas, aparece o que nenhuma das duas revisões podia ver: a edge chama o contador para
**toda** requisição fora da allowlist. Numa edge `verify_jwt=false` **sem rate limit**, um laço de
requisições inválidas vira, por requisição, uma chamada PostgREST e um `UPSERT` **na mesma linha**
`(hoje,'recusado',404)` — contenção de lock serializada numa linha quente e consumo do pool que
serve o app inteiro, disparável por qualquer um. E é justamente o caminho que exige **zero**
legitimidade que escreve: os ramos caros de rejeitar (413, 400) não escrevem.

> **A regra:** "cada peça foi aprovada" não é "o conjunto foi aprovado" — nem por soma, nem por
> indução. Composição cria superfície que não existe em nenhuma das partes, e o portão por tarefa
> **não pode** enxergá-la, porque só vê um diff. A revisão de branch inteiro não é carimbo final:
> é o único lugar onde perguntas do tipo *"quem, sem autenticação nenhuma, consegue fazer o sistema
> escrever no banco?"* têm como ser feitas.

## O gatilho que reabriria isto

Está nomeado na `§DECISÃO` de [`analytics.md`](../agent/analytics.md). Enquanto ele não disparar,
a regra vigente é a de lá: **liberar o host nos aparelhos internos** e manter todo sinal que DECIDE
em tabela própria — que é o que o par tabela × evento de
[`fase-sem-sinal.md`](fase-sem-sinal.md) já prescrevia.
