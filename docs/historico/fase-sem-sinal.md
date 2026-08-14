# Fase sem sinal — a fase N+1 construída sobre uma fase N que nunca provou estar viva

> **A classe (2026-08-13):** entregar a fase N, ler o silêncio que vem depois como funcionamento (ou
> como falha do desenho) e construir a fase N+1 em cima. O repo pagou isso **três vezes**, em três
> domínios diferentes, com o mesmo formato: a fase N estava no ar, ninguém reclamou, nenhum sinal
> positivo de uso jamais existiu — e o trabalho seguinte foi planejado sobre essa suposição.
>
> A regra que ficou no CLAUDE.md (§Armadilhas): **antes da fase N+1, exija ≥1 sinal POSITIVO de uso
> real em produção, com denominador. Toda fase que entrega superfície de uso nasce com o seu sensor.**

É o parente de produto de uma regra que o repo já tinha para comandos — *"validação só conta com
evidência positiva; ausência de sinal não é aprovação"*. A versão de comando protege uma sessão de
trabalho; esta protege um **programa de várias fases**, onde o custo do engano só aparece semanas
depois e já contaminou o que veio em cima.

---

## Os três precedentes

### 1. Piloto Sayerlack de auto-aprovação — o fusível nunca foi ligado

Detalhe completo em [reposicao-auto-aprovacao-piloto.md](reposicao-auto-aprovacao-piloto.md).

| Fato | Evidência (psql-ro, 2026-07-09) |
|---|---|
| Infra em produção desde | 2026-06-11 (tick SQL + cron `*/30` + log + salvaguardas) |
| `reposicao_auto_aprovacao_log` | **0 linhas *ever*** — nem v1 nem v2 |
| Fusível `reposicao_auto_aprovacao_ativa` | **`false` desde o seed** |
| Pedidos elegíveis na janela | **abundantes** (quase todo dia, máximos 17k–22k) — vários aprovados **na mão** |

O piloto foi recalibrado (v1 → v2, 2026-06-15) **sobre uma v1 que nunca havia auto-aprovado nada**:
a v1 ficou inerte por 4 dias e a resposta foi mexer no critério, sem antes provar que o critério
chegava a ser avaliado. Ele não chegava — o braço não executava. Só o check-in agendado, ~4 semanas
depois, produziu o veredito: **inconclusivo/inerte**, sem dado para promover nem para matar.

O doc do piloto já enunciou a regra em escala local: *"se um dia religar, exigir **ver
auto-aprovações acontecendo**; NÃO ligar o fusível achando que já rodou"*. O que faltava era a
generalização — nada impedia o mesmo formato de reaparecer em outro domínio. Reapareceu duas vezes.

### 2. Rota do Farmer (`/rota/ligacoes`) — tela viva, telemetria zerada desde a origem

Corrigido em 2026-08-13 pelo [#1717](https://github.com/LucasSardenbergL/afiacao/pull/1717).

| Fato | Estado |
|---|---|
| Pipeline | **íntegro** — 24 cidades ativas, config viva, RPC funcional, centenas de candidatos/cidade |
| Tela | construída, roteada, no menu; closed-loop de outcome entregue no #550 |
| `route_contact_log` / `route_queue_snapshot` | **zerados desde a origem** |
| Desfechos distinguíveis pela UI | **nenhum** — 4 saídas-vazias + "nunca aberta" eram o mesmo pixel |

Aqui a fase N+1 (`PR2c`, closed-loop de registro de resultado) foi construída **sobre** a fase N
(`PR2a`, motor de rota + lista de ligação) sem que a fase N tivesse emitido um único sinal de uso. O
efeito não é só "não sabemos se funciona": é que a investigação **trava**, porque `cities=0`,
`candidatos=0`, `todos_excluidos`, `sem_capacidade` e "ninguém abriu" produzem exatamente a mesma
tela vazia. A quarta é a perigosa — com `cap=0` a lista de excluídos fica vazia, idêntica a "nenhum
candidato", e inferir o motivo dos totais seria **fabricar diagnóstico**.

A correção é o formato de sensor que este doc recomenda: o motivo é **declarado no ponto que sabe**
(`rota.fila_vazia` + motivo, `rota.fila_carregada`, `rota.fila_erro`, `rota.contato_erro`), nunca
inferido pela UI. O erro tem precedência sobre `data` — o React Query preserva o retrato anterior em
`isError`, e sem essa ordem uma query que **passou** a falhar seguiria reportando sucesso.

### 3. Plano tático do Farmer — o zero media a ausência de usuários

Detalhe e as duas erratas (#1713 e #1716) em [fila-plano-tatico.md](fila-plano-tatico.md).

533 planos gerados, **0 desfechos**. A leitura registrada foi: *"se `concluido` continuar em 0, o
gargalo é adoção da tela, não custo do formulário"*. Errado por omissão — o numerador zero foi lido
como veredito sobre o desenho da tela sem que ninguém tivesse medido o denominador:

| Medição do denominador (psql-ro, 2026-08-13) | Valor |
|---|---|
| `master` | 1 usuário — **1 com sessão viva em 30d** (o próprio founder) |
| `employee` | 2 usuários — **0 com sessão viva** |
| `customer` | 5.664 — **0 com sessão viva** |
| Último sign-in das duas farmers donas de 506 dos planos | **2026-04-15** e **2026-04-13** |

O app inteiro tinha **um usuário ativo, e era o founder**. Um denominador de zero usuários produz
numerador zero em qualquer desenho de tela — o melhor botão do mundo mede o mesmo que o pior. E o
alvo do veredito seria o trabalho de outra pessoa ("a vendedora não adota a tela"), o que torna esse
erro mais caro que um número errado.

---

## A regra, e como aplicá-la

**Antes de construir a fase N+1, a fase N precisa ter emitido ao menos um sinal POSITIVO de uso real
em produção — e o sinal precisa ter denominador (quantos podiam ter usado).**

1. **Rode o sensor da fase N e cole a evidência no plano/PR da fase N+1.** Uma linha de log, um
   evento, uma transição de estado — algo que só existe se alguém usou. "Está no ar e ninguém
   reclamou" é ausência de dado, e ausência de incidente em código que nunca executou é ausência de
   dado, não evidência de segurança.
2. **Se a fase N não tem sensor, a fase N+1 é instalar o sensor** — não a funcionalidade seguinte.
   Foi o que o #1717 fez, e é mais barato que a investigação que ele destravou.
3. **Numerador sem denominador não é métrica** — é o `Number(null) === 0` em escala de produto.
   Antes de ler zero como veredito sobre uma tela, prove (a) que o código está no ar (merge na `main`
   não publica nada: §Lovable = 3 deploys manuais — a errata do caso 3 provou por bytes, varrendo
   331 chunks atrás de uma string exclusiva da entrega) e (b) que existe alguém do outro lado.
4. **Fusível/flag prova-se por efeito observado, não por config lida.** No caso 1 o cron estava
   ativo, a função existia e o fusível estava `false` — cada peça "certa" isoladamente, efeito zero.
5. **Gatilho de "quando medir" é query, não recado.** Enquanto o gatilho for "alguém me avisa", ele
   herda a mesma falha do zero sem denominador: ninguém consegue conferir se já disparou.

### A query canônica do denominador

```sql
SELECT ur.role,
       count(DISTINCT ur.user_id) AS usuarios,
       count(DISTINCT s.user_id)  AS ativos_7d
FROM user_roles ur
LEFT JOIN auth.sessions s
       ON s.user_id = ur.user_id
      AND s.updated_at > now() - interval '7 days'
GROUP BY 1 ORDER BY 2 DESC;
```

⚠️ **O par de sinais tem dente; nenhum dos dois sozinho teria.** `auth.sessions` some no logout e na
expiração — lida sozinha, "0 sessões" é ausência de dado. O que salva a inferência é
`auth.users.last_sign_in_at`: é **evidência positiva** (uma data real, que o Postgres não apaga). Na
direção oposta, `last_sign_in_at` sozinha também não bastaria: o Supabase não a atualiza no refresh
de token, então uma data velha é compatível com uso diário sob sessão persistente. Um mede que
**houve** entrada; o outro, que **há** presença.

### Onde a regra NÃO se aplica

Instrumentar tudo tem custo, e regra que grita errado treina a ignorar o vermelho. O gatilho é a
fase entregar **superfície de uso** — tela, botão, automação que decide sozinha, qualquer coisa cujo
sucesso dependa de alguém (ou de um cron) agir. Refactor interno, migração de tipos, gate de CI e
correção de bug com teste de regressão já nascem com o seu sinal: o teste vermelho→verde.

---

## Lição

Os três casos têm a mesma forma e três disfarces diferentes: no caso 1 o silêncio parecia
"calibragem errada" (e a resposta foi recalibrar); no caso 2, "a tela não presta ou ninguém entra"
(indistinguíveis por construção); no caso 3, "a vendedora não adota" (veredito sobre o trabalho de
outra pessoa). Em nenhum deles o silêncio era informação sobre o desenho — era a **ausência do
sensor** que deixava qualquer história caber no mesmo vazio.

**Corolário para revisão:** quando um plano diz "fase 2" ou "próximo passo", a primeira pergunta não
é sobre o desenho da fase 2. É: *qual linha de dado prova que a fase 1 foi usada, e quantos podiam
tê-la usado?* Se a resposta for uma inferência em vez de uma query, a fase 2 é instalar o sensor.
