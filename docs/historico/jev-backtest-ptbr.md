# Jev (TypeSafe AI) em pt-BR — backtest offline (PR0 do programa)

> Entrega: `scripts/jev/` (instrumento) + este relatório. Só leitura: nenhuma edge, migration ou deploy;
> todo dado veio de prod por `psql-ro` (papel `claude_ro`, sessão READ ONLY) e do PostHog read-only.
> Doc oficial lida em `docs.typesafe.ai` (2026-09-27). 2ª opinião: Codex gpt-6-astra · xhigh · 165 s ·
> 94.398 tokens — fecha a "REVISÃO INDEPENDENTE PENDENTE" do Caminho B.

## Veredito

**O gargalo de nenhuma das três decisões é o modelo — é o dado.** Medido em prod: o vínculo boletim → SKU
**nunca foi feito** (0 linhas), a promoção **destrói o próprio gabarito** ao confirmar, e o "mapa" da DRE é
o seed da migration. Por isso o go/no-go abaixo vale **com ou sem** a rodada do Jev; a rodada (seção 5)
responde a outra pergunta — se vale continuar investindo no Jev em pt-BR — e não autoriza PR nenhum
sozinha.

| Decisão | Veredito | Por quê (medido) |
|---|---|---|
| **PR1** — pré-seleção de SKU no vínculo boletim → SKU **com o Jev** | **NO-GO como próximo passo** (⚠️ reverte o conteúdo do PR1 do programa) | O universo endereçável é de **32 fichas** (das 119 aprovadas, 87 não têm o código em SKU ativo nenhum). Mesmo 32/32 certas dão limite superior de erro de **8,9%** — o portão do Codex (≤ 2%, 150 sugestões independentes) é inalcançável com a base atual. E 21 das 32 a **regra exata já resolve**. |
| **PR1′** (recomendado no lugar) — pré-seleção pela **regra exata** + confirmação em lote do master | **GO** (decisão sua) | Destrava as 21 fichas que a venda hoje não mostra (a view exige vínculo; há 0) e **gera o ouro humano** (`confirmed`/`rejected`) que o Jev precisa para ser medido nas 11 do resíduo. |
| **PR7** — promoção → SKU com pré-seleção | **NO-GO** | 13 itens `manual_confirmado`, **13/13 com a descrição do fornecedor sobrescrita** pela do SKU (7/13 com código sintético `#omie`). Pré-requisito: a confirmação preservar a entrada original; depois, o portão do Codex (600 sugestões, 0 erro). |
| DRE — categoria → linha | **segue ⏸️** | 36 linhas, todas `_default`, criadas no MESMO instante e nunca editadas = seed. Só 20 das 393 categorias ativas casam com ele, em 2 classes triviais. |
| **PR2/PR3** — copiloto em sombra/cascata | **🚧 sem sinal** | O volume que dimensionaria o PR2 **não é mensurável hoje**: `ia_uso_evento` é tabela de cota purgada aos 7 dias e está **vazia**; o PostHog registrou **73 pageviews de 1 pessoa no app inteiro** em 30 dias (0 na rota do copiloto). Regra "Fase N+1 exige sinal": o pré-requisito é um sensor de uso do copiloto. |
| PR4 · PR5 · PR6 | nada transferível daqui | Cada decisão exige corpus e portão próprios (P1 do Codex); deste backtest só transfere o comportamento do Jev em pt-BR (calibração, ordem, latência, custo). |

## 1. A régua (o que conta como acerto, e onde o instrumento poderia mentir)

- **Unidade decisória:** 1 item que o sistema decidiria SOZINHO acima de um limiar. O erro que importa é
  "respondeu e errou" (automação errada); abster (`null`) manda ao humano e não é erro.
- **Cobertura** = respondidas / TOTAL — falha de API fica no denominador. **Acerto** só nas respondidas, e é
  `NULL` sem respondidas (ausente ≠ zero).
- **Portão pelo limite superior (Clopper-Pearson unilateral 95%) do erro**, não pelo erro observado: "0 erros
  em 40" ainda admite 7,2% de erro verdadeiro; "0 em 150" ≈ 1,98%.
- **ECE em 10 faixas sobre `probabilities[choice]`.** O `confidence` da API **não** é probabilidade de acerto
  — a doc oficial o define como estatística do formato da distribuição (≈ `(N·p_max−1)/(N−1)`); entra só como
  escore alternativo de portão. O baseline determinístico não tem probabilidade: ECE "não aplicável", ele é
  um ponto de operação (cobertura × acerto).
- **O limiar sai da NOSSA curva:** o menor limiar de uma grade cujo LS 95% cabe no alvo, **escolhido na
  partição `dev` e medido na `teste`** (partição por código-base, FNV-1a — variantes do mesmo boletim nunca
  ficam dos dois lados). Nenhum limiar sustenta o alvo ⇒ **inconclusivo**, nunca "o maior da grade".
- **3 chamadas por item:** `direta`, `invertida` (TODAS as opções ao contrário, inclusive o "nenhum") e
  `repetida` (a direta de novo) — a repetida separa efeito de POSIÇÃO de não-determinismo; duas execuções
  não dobram o N.
- **Toda Choice tem "nenhum"/"nenhuma"; abstenção é `null`**, nunca uma opção default. Modelo **pinado em
  `jev-1.13.0`** (o alias `jev-latest` pode andar por baixo de um limiar calibrado).
- **Métricas num módulo puro** (`scripts/jev/metricas.ts`) com 25 testes de valor calculado à mão e
  **falsificação 9/9** — vermelho no teste certo, com controle verde na mesma invocação, em `LC_ALL=C` e
  `pt_BR.UTF-8`. Sabotagens: ECE sem peso por faixa · cobertura sem a falha no denominador · limiar exclusivo
  · prob = 1 fora da última faixa · acerto ausente virando 0 · "regra de três" no lugar do Clopper-Pearson ·
  portão pelo erro observado · troca confiante sem exigir as duas respostas · percentil com floor. O script
  de sabotagem **não foi versionado** (máquina meta sem incidente — regra do CLAUDE.md); a evidência está no
  corpo do PR.

## 2. O que a doc oficial confirmou (e o que ela mesma avisa)

- `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`, chave em **`TYPESAFE_API_KEY`**.
  Cliente por `fetch` puro (`scripts/jev/typesafe.ts`), portável para Deno.
- Choice: `criteria` é mapa opção → descrição — **nome e descrição da opção vão ao modelo**; até 255 opções;
  resposta `choice` + `probabilities` (somam 1) + `confidence`; custo em `usage.input_tokens`. O cliente
  serializa as opções à mão: um objeto JS reordenaria chaves "numéricas" e o teste de ordem mediria o motor
  JS, não o Jev.
- US$ 0,042 por milhão de tokens de entrada, saída grátis; 1.200 req/min; 64k de contexto (32k para `state` +
  a maior pergunta).
- **Idioma:** inglês é a língua primária de treino; outras são "handled but not equally well" — a doc manda
  testar no próprio conteúdo.
- **Limitações declaradas pela TypeSafe (jaggedness 1.13):** leitura literal; números e códigos; estado
  grande com ruído; conteúdo adversarial no `state`; Choice é RELATIVO (escolhe entre opções, não diz se
  alguma serve — daí o "nenhum").
- Domínios parasitas que anunciam "endpoint da API": não consultados.

## 3. Os gabaritos: premissa × realidade

Medido em prod (`claude_ro` tem `rolbypassrls = true`: a RLS não esconde linha). O exportador regrava as
contagens em `meta.json` a cada export — não são copiadas deste doc.

| Gabarito | Premissa do programa | Realidade |
|---|---|---|
| (a) boletim → SKU | vínculos do master em `omie_product_spec_links` | **0 linhas** (`n_tup_ins = 0`): nenhum vínculo jamais gravado, nem `confirmed` nem `rejected`. |
| (b) promoção → SKU | `mapeamento_qualidade = 'manual_confirmado'` | **13 itens**; **13/13** com a descrição do fornecedor IGUAL à do SKU escolhido (a confirmação sobrescreve a entrada); 7/13 com código `#omie`. Fora do teste. |
| (c) categoria → DRE | mapa curado em `fin_categoria_dre_mapping` | **36 linhas `_default`**, mesmo `created_at` (2026-03-29 13:16:31.741), 0 editadas = seed. |

E a recuperação em (a), que nenhuma premissa previa: das **119 fichas aprovadas**, a réplica fiel de
`buscar_skus_candidatos` (pré-voo por `pg_get_functiondef` em prod: `LIKE`, `ativo IS NOT FALSE`,
`ORDER BY account, descricao`, `LIMIT 100`) não traz **nenhum** candidato para **87**. Não é falha da busca: o
miolo numérico do código não aparece em SKU ativo nenhum (só **48** SKUs ativos da Colacor e **467** da Oben
têm código Sayerlack pontuado na descrição) — ex.: `FB.6068.00 VERNIZ PU 6068`, sem `6068` no catálogo. Os
boletins cobrem o catálogo do fornecedor; a empresa vende uma fração. Nenhuma ficha bateu no `LIMIT 100`.

**Volume do copiloto** (pedido para dimensionar o PR2): a consulta de 30 dias sobre `ia_uso_evento` não pode
responder por desenho — a tabela é de COTA e o cron `ia-uso-evento-purga` (ativo; último sucesso
2026-10-01 04:23Z) apaga o que passa de 7 dias. Ela está **vazia**. No PostHog, o denominador do app inteiro é
**73 pageviews de 1 pessoa em 30 dias** (0 na rota `/farmer/copilot`), e o copiloto não emite `track()`.
Uso do copiloto: **não mensurável** — ausência de dado, não zero.

## 4. Os conjuntos medidos

**(a) boletim → produto — a unidade é a FÓRMULA (código-base), não o SKU.** 1 boletim → N embalagens ×
contas; uma Choice por SKU faria respostas igualmente certas disputarem a massa de probabilidade (P1 do
Codex). As opções são as famílias de SKUs agrupadas por código-base + "nenhum". **77 itens:**

| Conjunto | n | O que mede | Gabarito |
|---|---|---|---|
| prata | 21 | o Jev concorda com o código exato quando ele está visível? (sanidade + calibração) | a regra que o domínio já aceita para autoconfirmação (`refinarCandidatos`: base exata E não-ambígua) — o baseline acerta 21/21 **por construção** |
| negativo sintético | 3 | escolhe um distrator confiante quando a família certa SAI das opções? | "nenhum" |
| negativo cruzado | 21 | idem, com as famílias da ficha de nome mais parecido (base diferente) — o teste de **falsa pré-seleção** | "nenhum" |
| prata mascarada | 21 | com códigos ocultos no boletim e nas opções, só o texto decide | a família exata |
| sem gabarito (resíduo) | 11 | quanto o Jev decidiria onde a regra não decide (`FLA.6269.02` × `FL.6269.02QT`, `FO20` × `FOA05`) | — (adjudicação humana pendente) |

Mediana de **2 opções** na prata (a família + "nenhum"; máx. 7): a prata é fácil por construção, e é por isso
que o veredito do PR1 não se apoia nela.

**(c) DRE — 393 categorias ativas não-totalizadoras** das 3 empresas: 20 com rótulo do seed (exploratório) e
373 sem gabarito (cobertura + concordância com as regex). Baseline = só as 9 regex da edge
`fin-suggest-mapping` (o passo "mapa de outra empresa pelo código" ficou de fora: com tudo em `_default` ele
devolveria o próprio seed). As regex respondem 110/393; uma delas tem falso positivo real: `iss` casa
"Com**iss**ões" ⇒ `impostos`.

## 5. Resultados da rodada real

> ⏭️ **Fica para um PR de continuação.** Decisão do founder em 2026-10-03: mergear o instrumento e o
> diagnóstico já, porque o veredito acima não depende da rodada, e rodar quando existir a `TYPESAFE_API_KEY`
> (criada só em `console.typesafe.ai`, exportada no shell — nunca no chat). Nesse PR, as tabelas geradas por
> `scripts/jev/relatorio.ts` — acerto e cobertura nos limiares 0,80/0,90/0,95 (prob e `confidence`), ECE +
> confiabilidade, limiar dev → teste, ordem e repetição, resíduo, latência p50/p95 e custo — entram aqui sem
> edição manual, e o veredito de TECNOLOGIA (vale continuar com o Jev em pt-BR?) é escrito em cima delas.

## 6. Parecer do Codex — a revisão independente que faltava

Sem P0; cinco P1 capazes de produzir falso "go". Todos os de INSTRUMENTO foram incorporados:

| P1 do Codex | Como ficou no instrumento |
|---|---|
| Vazamento no gabarito de promoção; DRE com seed | (b) fora do teste conclusivo (13/13 sobrescritos, medido); (c) exploratório (seed medido) |
| Unidade decisória 1:N; empresa na chave | Opção = família por código-base, com todas as embalagens e contas dentro; embalagem nunca conta como observação independente |
| Confirmados + candidatos recuperados escondem os casos difíceis | Recuperação medida (87/119 sem candidato, 0 no `LIMIT 100`); negativos sintéticos e cruzados rotulados como sintéticos; resíduo sem acerto, só cobertura; adjudicação cega das 32 fichas preparada |
| Calibração é hipótese; limiar no mesmo conjunto = otimismo | Limiar escolhido em `dev`, medido em `teste`; modelo pinado; ECE só sobre `probabilities[choice]` com contagem por faixa; portão pelo LS 95%; N pequeno ⇒ inconclusivo |
| (P2) baseline sem probabilidade; ordem × variabilidade; métricas sem prova | ECE do baseline "não aplicável"; chamada `repetida`; 25 testes à mão + falsificação 9/9 |

O 5º P1 é do PROGRAMA: **evidência não se transfere entre decisões** (acertar SKU não valida intenção
comercial, extração nem opt-out). O Codex manteve os 4 critérios de priorização e acrescentou **custo
assimétrico do erro, reversibilidade real, volume com denominador, disponibilidade de gabarito e ganho
incremental**. Portões mínimos propostos para pré-seleção com confirmação humana: **PR1** — 150 sugestões
independentes com 0 vínculo errado (LS ≈ 1,98%), cobertura útil ≥ 30%, ≥ 60 negativos/ambíguos humanos sem
falsa pré-seleção; **PR7** — 600 com 0 erro (LS ≈ 0,50%), cobertura ≥ 20%, ≥ 300 negativos; ambos com limiar
congelado, zero troca confiante para SKU errado nas perturbações e ganho ≥ 10 p.p. de cobertura sobre o
baseline sob o mesmo teto de erro. Ordem recomendada: PR0 → PR1 → PR4 (sombra/veto) → PR5 (opt-out separado
de intenção) → PR2 → PR3 → PR6 (sugestão, não auto-conclusão) → PR7.

**O que os dados acrescentaram depois do parecer** (o Codex não tinha estes números): o portão do PR1 é
inalcançável com 32 fichas endereçáveis, e o PR2 não tem sinal de uso. Daí o PR1′ e o 🚧 do PR2 no veredito.

## 7. Reproduzir

```bash
cd ~/Projetos/afiacao-feat-jev-backtest
bun scripts/jev/exportar.ts            # psql-ro → scripts/jev/.dados/ (fora do git) + meta.json
bun scripts/jev/rodar.ts --limite 2    # sonda do contrato com poucas chamadas
bun scripts/jev/rodar.ts               # rodada completa; retomável, nunca paga 2× a mesma chamada
bun scripts/jev/relatorio.ts           # tabelas → scripts/jev/.dados/relatorio.md
```

Custo estimado da rodada completa: 470 itens × 3 chamadas ≈ 1,2 M tokens de entrada ≈ US$ 0,05.

## 8. Pendências

- 🔑 `TYPESAFE_API_KEY` → rodada real (comandos da seção 7, a partir de um export novo) → seção 5 preenchida num PR de continuação.
- 🧭 Adjudicação cega das 32 fichas endereçáveis (formulário entregue na sessão; o mapa de respostas vive em
  `scripts/jev/.dados/adjudicacao-mapa.json`, fora do git) — transforma a prata em ouro e dá gabarito ao
  resíduo.
- Promoção: a confirmação preservar a descrição original do fornecedor (pré-requisito do PR7).
