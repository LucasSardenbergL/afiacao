# O gatilho do proxy foi puxado — e o probe respondeu outra coisa (2026-09-08)

> **Por que este arquivo existe:** [`quanto-do-entregue-e-usado.md`](quanto-do-entregue-e-usado.md)
> (#2360) declarou puxado o gatilho que reabriria o proxy de ingestão recusado em 2026-08-25
> ([`proxy-posthog-descartado.md`](proxy-posthog-descartado.md), #1984). Esta é a re-avaliação
> pedida. **Conclusão: a recusa se mantém** — e o motivo mudou. O que o #2360 não tinha era o
> `probe-censura.sh`, e ele inverte a leitura central da medição.
>
> ⚠️ Toda contagem aqui é perecível. Comandos de re-medição no fim.

## O gatilho é CONJUNTIVO — e só uma condição disparou

A §DECISÃO de [`analytics.md`](../agent/analytics.md) exige **as duas**:

| Condição | Estado em 2026-09-08 |
|---|---|
| (1) um customer **prestes** a ser aprovado | ❌ customers aprovados = **0**, re-medido. |
| (2) censura provada por **probe pareado** | ✅ **SATISFEITA** — 🔴 pela primeira vez. |

⚠️ **`count() = 0` não fecha a condição (1), e a diferença é do desenho.** O gatilho foi
deliberadamente antecipado para *"prestes a ser aprovado"* justamente porque aprovar customer é ato
administrativo nosso, com um instante observável ANTES do primeiro uso. "Zero aprovados hoje" é
compatível com "um será aprovado amanhã", e **essa informação não sai de nenhuma query** — sai do
founder. Ler o `0` como "condição (1) falsa" é usar o eixo velho (tardio) que o #2016 já corrigiu.
**A pergunta fica aberta para o founder, não fechada pela medição.**

## O achado que o #2360 não tinha: o probe falou

O #2360 mediu PostHog e banco. Não rodou o probe pareado. Ele agora tem histórico — e **um único
`user_id` opera os dois aparelhos** (não são duas pessoas):

| Aparelho | Probes gravados (canal PostgREST) | Vistos no PostHog | Janela |
|---|---|---|---|
| `1aedeba2` | **173** — 11 dias, 22 `build_id`, ativo 2026-09-08T01:03Z | **0 — nunca, nem um** | desde 27/08 |
| `fa401591` | 17 | **17 (100%)** | desde 31/08 |

### A inversão: o iPhone não é o aparelho principal, é o único que consegue falar

O #2360 mediu **"1 iPhone = 97,7% dos eventos web"** e a leitura natural é concentração de USO.
No canal imune ao bloqueador, esse mesmo aparelho é **9% dos boots** (17 de 190). O aparelho
dominante — 10× mais sessões — é o que **não aparece em lugar nenhum** do PostHog.

> **A regra:** num canal censurado, o ranking de aparelhos mede QUEM CONSEGUE FALAR, não quem mais
> usa. Um "97,7%" lido como dominância é o mesmo erro de denominador que o #2360 documentou para
> `profiles`, aplicado ao eixo de aparelho. **91% das sessões do único usuário ativo são invisíveis.**

E o par é forte porque é do MESMO aparelho, nas MESMAS sessões: 173 `INSERT`s chegaram via
PostgREST enquanto 0 eventos saíram pelo PostHog. Não é ausência de dado — é presença de um lado e
ausência do outro, simultâneas.

## As três pernas do "não", re-pesadas

| Perna de 2026-08-25 | Estado |
|---|---|
| **A1** — a população que o proxy recupera é vazia | **Inalterada** no que ela mede (0 customers aprovados). Mas M1 mostra que o benefício sobre o estado ATUAL **não é zero**: existe uso ativo invisível, interno, recuperável. O benefício do proxy sobre **(a) funcionando** é que é pequeno. |
| **A2** — não é first-party; o real exige sair do Lovable | **Inalterada e re-medida:** `/ingest/`, `/ingest/e/`, `/api/health` → os três **200, `text/html`, 8.307 bytes**, o mesmo número de 25/08. Nenhuma camada de rewrite apareceu. |
| **A3** — contorna o opt-out do próprio founder | **Mudou de peso, e para "não precisamos".** O único titular censurado é o controlador, que está PEDINDO o dado. ⚠️ Mas a mudança vem do **pedido**, não das medições — e ela enfraquece A3 **igualmente** para o proxy e para qualquer alternativa nossa. Não é vantagem de uma via sobre a outra. |

## ⚠️ Quatro coisas que a 2ª opinião (Codex, `challenge`) derrubou da MINHA argumentação

Ficam registradas porque três delas eu apresentaria como conclusão:

1. **"O relay põe `*.supabase.co` na lista e derruba o app" era forte demais.** As listas fazem
   bloqueio **por caminho** (`||cloudfunctions.net/ingest?`, `||amazonaws.com/analytics/`), não do
   provedor inteiro; escalada para o hostname do projeto é possível, não demonstrada. E a objeção
   **atinge minha própria alternativa**: telemetria em tabela usa o mesmo hostname. A forma
   defensável é *"compartilhar o hostname operacional com telemetria cria impacto colateral
   possível, de magnitude não medida"* — não um veto.
2. **"A saída (a) nunca foi executada" era forte demais.** M1+M3 provam que **não há recuperação
   observável**; não provam que ninguém tentou. Perfil errado, regra insuficiente, outro bloqueador
   e tentativa não persistida produzem o mesmo silêncio. O defensável: **a mitigação decidida não
   foi VALIDADA com sucesso.**
3. **"156 rotas visitadas e perdidas" não está medido.** Sensor instalado, sensor executado e
   evento entregue são **três fatos diferentes**. O `PageViewTracker` emite por construção — isso
   prova cobertura, não visita. As 156 podem nunca ter sido abertas.
4. **"Uma tabela nova" não é o menor passo — o ledger JÁ EXISTE.** [`src/lib/analytics-ledger.ts`](../../src/lib/analytics-ledger.ts)
   é o canal autenticado PostgREST→outbox, com allowlist fechada no banco. O passo é **estender a
   allowlist**, não criar superfície.

E uma correção que atinge o doc irmão: **`pg_stat_user_tables` não prova que "as telas SÃO
abertas".** Prova atividade sobre TABELAS. Falta a correspondência consulta→tela: outra tela, o
backend, cron e consultas administrativas produzem os mesmos contadores, e duas jornadas diferentes
podem gerar requests idênticos. O #2360 já ressalvava humano×cron; o limite é mais fundo que isso.

## A via que responde à pergunta — e ela já está provada em produção

Não é o proxy, e também não é "instrumentar mais telas". É a **quarta saída** (outbox server-side),
que o #1984 já elegia e que agora tem prova **ponta a ponta**, não só de aceite:

| Elo | Evidência |
|---|---|
| fonte → outbox | view `analytics_outbox_reconciliacao`: 15/15 (`prova`) e 24/24 (`indicativa`) |
| outbox → PostHog | **283 `reposicao.sugestao_criada` + 33 + 17 + 1 CHEGARAM ao PostHog** (medido no HogQL) |

⚠️ **`aceito_em` não vale como prova de entrega** — a própria migration diz que marca **aceite
HTTP**, e o PostHog responde 200 e descarta evento inválido. O elo 2 acima foi medido **na origem**,
consultando o PostHog, e é isso que fecha. *Contar linhas com `aceito_em IS NOT NULL` teria
fabricado o mesmo veredito sem o dado.*

**Por que esta via domina o proxy:** ela não passa por navegador, logo não há o que bloquear —
censura é irrelevante por construção, não por obscuridade. E não contorna a escolha de ninguém.

⚠️ **O caminho client→ledger, porém, tem ZERO registros.** `registrarNoLedger` é chamado em
`MixGapCard.tsx:173`, e `carteira.mixgap_servido` não tem uma linha na outbox — que carrega **só**
`reposicao.sugestao_*`, todos por trigger. Não distingui "a tela não foi usada" de "a condição não
foi satisfeita" de "a lente barrou". **A regra (c) segue cumprida em 1 de 111 sensores, e o único
espelho client-side ainda não produziu evidência de vida.**

## O que fica decidido, e o que fica com o founder

**Decidido:** a recusa do proxy (b) se mantém. O gatilho registrado não abriu (1 de 2 condições), a
perna A2 está re-medida e intacta, e a via que responde à pergunta já existe e já entrega.

**Com o founder, nesta ordem:**

1. **Validar a saída (a)** — não "recomendar". Critério de sucesso explícito: liberar
   `us.i.posthog.com` e `us-assets.i.posthog.com` no perfil REALMENTE usado pelo `1aedeba2`,
   recarregar para gerar `attempt_id` novo, abrir duas rotas conhecidas, e conferir o pareamento
   após a carência. ⚠️ **Abrir o host na barra de endereço não substitui o teste** — o #1984 mediu
   `fetch` de dentro do app morrendo em 4 ms com navegação direta funcionando.
2. **Responder se há customer prestes a ser aprovado.** É a condição (1), e nenhuma query a
   responde. Se houver, o gatilho ABRE — e mesmo então a primeira saída continua não sendo o proxy.
3. **Só se (1) falhar e navegação fundamentar decisão:** estender a allowlist do ledger com **rota
   canônica por dia** — não `pathname + search`, que é o que o `PageViewTracker` envia hoje e não
   seria minimização.

## Lição

**Um gatilho conjuntivo puxado pela metade não é um gatilho puxado** — e a metade que faltava aqui
não é medível: depende de um ato administrativo que só o founder conhece. Registrar a condição
"prestes a" foi a decisão certa em 25/08 e continua sendo; o preço é que a reabertura passa por uma
pergunta, não por uma query.

E o corolário de medição, que vale além disto: **antes de tratar um silêncio como sinal, procure o
canal que fala.** O mesmo aparelho que era invisível em 100% dos eventos estava gravando 173 linhas
por outro cano, no mesmo instante. O par imune × censurável não é sofisticação — é o mínimo para
que "não apareceu" signifique alguma coisa.

## Como re-medir

```bash
# 1. O gatilho, lado (2) — 🔴 significa censura persistente PLAUSÍVEL, não certeza
bash scripts/probe-censura.sh

# 2. O gatilho, lado (1) — e lembre: 0 não fecha a condição, ela é "PRESTES a"
~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM profiles p JOIN user_roles ur ON ur.user_id=p.user_id WHERE ur.role='customer' AND p.is_approved"

# 3. A inversão do ranking — boots por aparelho no canal IMUNE (o PostHog não vê isto)
~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -c "SELECT device_id::text, count(*) probes, count(DISTINCT user_id) usuarios, count(DISTINCT build_id) builds, max(criado_em) ultimo, 'FIM_OK' m FROM telemetria_probes GROUP BY 1 ORDER BY 2 DESC"

# 4. A quarta saída, elo que IMPORTA (outbox->PostHog). aceito_em NÃO serve aqui
bash scripts/posthog-query.sh "SELECT event, count() n FROM events WHERE event LIKE 'reposicao.sugestao%' AND timestamp > now() - INTERVAL 30 DAY GROUP BY event"

# 5. A perna A2 — se algum dia der != 8307 bytes/text-html, o modelo de deploy MUDOU
for p in /ingest/ /ingest/e/ /api/health; do curl -s -o /dev/null -w "$p %{http_code} %{content_type} %{size_download}\n" "https://steu.lovable.app$p"; done
```
