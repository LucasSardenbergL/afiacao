# Cota de IA por usuário — desenho

**Data:** 2026-07-31
**Origem:** achado P1 do challenge `/codex` sobre a fase 4 da migração do gateway Lovable → Anthropic (PRs #1592, #1608, #1618, #1626, #1631, #1640).
**Natureza:** lacuna PRÉ-EXISTENTE, não regressão da migração. Ficou mais cara agora que o orçamento é da Anthropic e **organizacional** — o 429/402 de um abusador derruba a IA de todos os usuários e de todas as edges.

## O problema

`identify-tool` e `analyze-services` exigem apenas JWT válido (qualquer usuário autenticado,
incluindo `customer`) e não têm nenhum limite de consumo. Um cliente pode repetir chamadas
com imagens de até 8 MB (`identify-tool`) ou com 100 ferramentas (`analyze-services`) até
bater 429/402 na Anthropic.

O gate "customer pode usar" está **correto** para o produto — identificação por foto e pedido
falado são features do cliente. O que falta é throttle/quota persistente.

## Superfície de risco (medida em prod via psql-ro, 2026-07-31)

| fato | valor |
|---|---|
| contas com role `customer` | **5.664** |
| usuários que já logaram alguma vez (`last_sign_in_at`) | **3** |
| clientes com ferramenta cadastrada | 2 (média 2, p95 2) |
| tabela/função de rate-limit já existente | **nenhuma** |

Duas consequências de desenho:

1. **Não dá para calibrar por uso observado** (é praticamente zero). Os limites saem de uso
   plausível de balcão, não de percentil histórico.
2. **Não há uso legítimo para quebrar.** Estamos blindando antes da abertura — o momento
   barato de fazer isso.

Confirmado que não existe precedente: os hits de `rate.?limit` no repo são backoff da API do
**Omie** (`_shared/omie-paginacao.ts` e afins), não quota de usuário. Em prod, as únicas
tabelas que casam `cota|quota|limit|rate|uso|consum` são `prime_beneficio_uso` (benefício
comercial do plano Prime) e `fin_custo_rateio` — nenhuma reaproveitável.

## Desenho

### Banco (uma migration)

| objeto | papel |
|---|---|
| `ia_uso_evento` (`user_id`, `funcao`, `criado_em`) | uma linha por chamada; índice `(user_id, funcao, criado_em DESC)` |
| `ia_uso_limite` (`funcao` PK, `limite_hora`, `limite_dia`) | os números, seedados |
| `ia_consumir_cota(p_user_id, p_funcao)` SECURITY DEFINER | decide **e** registra na mesma transação |
| cron `ia-uso-evento-purga` | `DELETE` de eventos > 7 dias, diário |

**Log de evento e não bucket agregado.** Bucket por janela truncada (uma linha por hora) é
mais barato, mas a janela vira *tumbling*: 20 chamadas às 10:59 + 20 às 11:00 = 40 em dois
minutos, dentro do limite nominal de 20/hora. O log dá janela **deslizante** de verdade
(`count(*) FILTER (WHERE criado_em > now() - interval '1 hour')`) e, de brinde, responde
"quem gastou" quando o orçamento apertar. O volume é baixíssimo — uso humano de balcão.

**Atomicidade.** A RPC abre com `pg_advisory_xact_lock(hashtextextended(user_id || ':' || funcao, 0))`.
Sem esse lock, duas requisições simultâneas do mesmo usuário leem o mesmo contador e **ambas
passam** — a quota vazaria exatamente sob o padrão de uso que ela existe para conter
(repetição rápida). O lock é por (usuário, função), então não serializa usuários distintos.

**Cálculo de `libera_em_segundos`.** Com janela deslizante, a próxima vaga abre quando a
`limite`-ésima chamada mais recente sai da janela: ordenando por `criado_em DESC` e pegando
`OFFSET (limite - 1) LIMIT 1`, o instante dela `+ 1 hora` (ou `+ 24 horas`) é a liberação.
Vale também quando o limite foi reduzido a quente e `usado > limite`: `criado_em` é monotônico
com a posição, então a expiração da N-ésima implica a expiração de todas as mais antigas.

**Autorização.** Ambas as tabelas com RLS **habilitada e sem policy nenhuma**, mais `REVOKE`
nominal de `anon` e `authenticated` — `REVOKE FROM PUBLIC` não alcança esses dois (grant
explícito; ver `docs/agent/database.md`). Só a RPC toca as tabelas. `FORCE ROW LEVEL SECURITY`
fica **fora** de propósito: com FORCE, a RLS valeria também para o owner e a própria RPC
SECURITY DEFINER seria barrada no INSERT.

A RPC recebe `EXECUTE` só de `service_role`, com `REVOKE` de `anon`/`authenticated`. Se
`authenticated` pudesse executá-la, um cliente chamaria com o `user_id` de outro e queimaria a
cota alheia.

### Edge (`_shared/ia-cota.ts`)

Módulo sem nenhum import remoto — obrigatório, porque `test:edges` roda com `--no-remote` e um
`npm:`/`jsr:` no grafo de teste colocaria o registry no caminho de entrega de todo PR. O
cliente entra por **interface estrutural mínima** (`{ rpc(nome, args) }`), então o teste usa um
duplo e o módulo continua puro:

```ts
export interface ClienteRpc {
  rpc(nome: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
}
```

A checagem entra **depois** da autenticação e **depois** da validação de input (requisição
malformada não queima cota) e **antes** da chamada à Anthropic.

### Fail-closed, com voz própria

Money-path: na dúvida, negar. Mas negar calado repetiria o sintoma que a migração inteira
tentou resolver — "erro de IA" genérico escondendo a causa real. Três respostas distinguíveis:

| situação | HTTP | mensagem |
|---|---|---|
| cota do usuário estourada | 429 + `Retry-After` | "Você atingiu seu limite de N <rótulo> nesta hora — é o seu limite de uso, não uma falha da IA. Libera em X minutos." |
| RPC falhou ou devolveu payload malformado | 503 | "Não consegui verificar seu limite de uso agora. Tente de novo em instantes." |
| 429 da própria Anthropic (já existia) | 429 | "Limite de requisições excedido. Tente novamente em alguns segundos." |

**Duração relativa, não hora absoluta.** O banco é UTC e o balcão é America/Sao_Paulo;
formatar "libera às 14:35" convidaria a um erro de fuso que ninguém notaria. A RPC devolve
`libera_em_segundos` já calculado, o que também elimina dependência de clock skew entre
Postgres e edge.

**Função sem linha em `ia_uso_limite` → nega** (`motivo = 'sem_limite'`). Uma edge nova que
esqueça o seed não ganha acesso irrestrito ao orçamento por omissão.

### Números

Custo estimado ≈ US$ 0,03–0,04 por chamada em Sonnet (imagem/texto de entrada + até 1,5–2k
tokens de saída). Teto por usuário/dia entre parênteses:

| edge | hora | dia | racional |
|---|---|---|---|
| `identify-tool` | 20 | 60 (~$1,80) | p95 real é 2 ferramentas/cliente; 60 cobre cadastro em lote com ~30× de folga |
| `analyze-services` | 20 | 50 (~$2,00) | pedido falado com regravações; ~15/dia já é uso pesado |
| `copilot-analyze` | 600 | 2.500 (~$75) | ligação real é ~450/h; corta o loop de aba esquecida (10.800/dia) |

Ajustáveis por `UPDATE` no SQL Editor, sem redeploy de edge — que no Lovable é manual.

### `copilot-analyze` avaliado separado

Padrão de uso oposto: staff-only (2 employees + 1 master) e disparo a cada 8 s
(`ANALYSIS_INTERVAL_MS`) enquanto a transcrição muda, ou seja ~450 chamadas por hora de ligação
real. O risco ali não é abuso, é **loop acidental** — aba esquecida aberta a noite toda ou
timer que não para. Daí o teto folgado: não toca ligação real, mas limita o dano de um loop a
2.500 chamadas/dia em vez de 10.800.

### Frontend do copiloto (achado durante o desenho)

`useCopilotEngine` hoje **engole o erro**: o `catch` só faz `console.error` e marca
`analiseObsoleta`. Pior, ele zera `lastAnalyzedRef` para o próximo tick tentar de novo — o que
é correto para falha transitória, mas em quota estourada vira um martelo a cada 8 s contra um
limite que não vai ceder, com a vendedora sem saber por que o copiloto parou.

Então o copiloto passa a: exibir o motivo, e **suspender os disparos** até a janela liberar.
Sem isso, colocar a quota só no servidor pioraria a experiência em vez de melhorar.

## Prova antes de entregar

`prove-sql-money-path` em PG17 local, aplicando a migration real:

- limite respeitado (a N-ésima passa, a N+1 nega);
- janela deslizante ignora evento fora dela;
- função sem linha em `ia_uso_limite` é negada (fail-closed);
- RLS sob `SET ROLE authenticated` (psql é superuser e bypassaria);
- `EXECUTE` da RPC negado a `authenticated`;
- **falsificação**: sabotar a migration e exigir vermelho, rodada em `LC_ALL=C` **e**
  `pt_BR.UTF-8` (o #1483 mostrou que falsificar num locale só não prova a asserção).

PL/pgSQL é late-bound: `CREATE` passar não diz nada. O teste **executa** a função.

## Entrega (3 camadas manuais do Lovable)

1. **Migration** → SQL Editor (nome custom não auto-aplica; falha silenciosa).
2. **Edges** → chat do Lovable, verbatim: `_shared/ia-cota.ts`, `identify-tool/index.ts`,
   `analyze-services/index.ts`, `copilot-analyze/index.ts`.
3. **Publish** do frontend (mudança em `useCopilotEngine`).

## Fora de escopo (decidido)

**Disjuntor global** (teto diário da organização). Quota por usuário contém o abusador único,
não o agregado de muitos usuários legítimos — mas com 3 logins reais esse cenário é hipotético,
e um teto global tem risco próprio: por desenho ele derruba a feature para todos, virando o
mesmo sintoma que queremos evitar, com uma mensagem que o usuário não pode resolver sozinho.
O formato da tabela permite adicioná-lo depois sem migration nova.
