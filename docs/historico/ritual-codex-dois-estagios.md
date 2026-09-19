# Ritual Codex em 2 estágios — e a medição que mostrou que o corte não era a alavanca

> **A classe (2026-09-18):** cortar pela metade um processo que **nunca rodou inteiro**, contando a
> economia pela aritmética da política (4 estágios → 2 = −50%) em vez da distribuição do uso REAL.
> Medido: o corte rende **−7% a −9%**. O consumo estava em três coisas que a política nem menciona —
> duplicatas por um defeito de transporte (19%), rodadas repetidas do MESMO estágio (23%) e challenge
> retroativo de PR já mergeado (10%).
>
> A regra que fica: **antes de cortar um processo para economizar, meça a distribuição do uso por
> OBJETO, não a prescrição por etapa.** Processo prescrito e processo praticado divergem, e a
> economia vive na diferença.

Irmã de [cota-codex-medida-em-tokens.md](cota-codex-medida-em-tokens.md), no eixo do PROCESSO: lá a
régua errada era a unidade (tokens×pp); aqui é o denominador (a política diz 4, a prática fez 1).

---

## O que a política mandava, e o que de fato acontecia

`money-path.md` prescrevia **metodologia → spec → plano → adversarial no código** — 4 consultas por
entrega money-path. Classificando à mão as **174 sessões de setembro** (as que carregam o medidor
`used_percent`) **por objeto revisado**:

| objeto da consulta | n | pp | % do consumo | reprovações/pp |
|---|---:|---:|---:|---:|
| adversarial no **código** (diff/PR/migration) | 59 | 113 | **41%** | 0,35 |
| **desenho** (spec/plano, antes do código) | 31 | 56 | 20,5% | **0,41** |
| challenge **retroativo** de PR já mergeado | 13 | 27 | 10% | — |
| decisão pontual (metade fora do money-path) | 24 | 26 | 9,5% | 0,39 |
| **metodologia** (régua, gate, processo) | 12 | 18–25 | 6,6% | **0,22** |
| subagentes que o próprio Codex gerou | 10 | 17 | 6% | — |

**"Plano" como objeto puro: 0 sessões** — a palavra só aparecia dentro de rodadas de desenho. E o
ritual **nunca rodou como 4 estágios**: 36 entregas tiveram 1 consulta, 5 tiveram 2, 4 tiveram 3; as
de 4+ eram rodadas do MESMO estágio (uma entrega com 5 sessões, todas no código).

Consumo apurado pelo **envelope monótono** do medidor, não pela soma de incrementos: com até 9
sessões concorrentes os valores chegam defasados (91→92→91→92) e a soma crua inflava 498 pp contra
**326 pp** reais no bucket. Disso, **273 pp atribuíveis às 174 sessões = 1,57 pp/sessão**.

## Onde a cota estava de verdade

1. **Duplicatas — 19% (53 pp, 21 grupos, 34 sessões).** Um único `tool_use` do wrapper (`tentativa 1`,
   um cabeçalho `PARECER CODEX`) produziu **4 rollouts**, mesmo prompt, mesmo minuto, mesmo cwd, com
   pareceres **distintos** (md5 diferentes ⇒ todos gerados, todos pagos). **Não é o retry do wrapper**
   (backoffs 0/20/60 s são sequenciais; as cópias rodam em paralelo, ~60 chamadas cada). Defeito entre
   `codex exec` 0.153.4 e o transporte — **a diagnosticar**. Corrigir devolve 19% sem tocar em política.
2. **Rodadas ≥2 — 23%.** 26 das 59 sessões de código eram 2ª a 5ª rodada do mesmo objeto.
3. **Retroativo pós-merge — 10%.** Nem consta da política: é challenge de PR que já entrou.
4. **Subagentes do próprio Codex — 6%.** Prompt pedindo "N lentes" faz o Codex abrir threads que
   multiplicam o custo sem aparecer como consulta.
5. **53 pp (16%) em lacunas sem sessão neste Mac** — o ChatGPT.app aponta `CODEX_HOME` para o mesmo
   `~/.codex`: há um **2º cliente na mesma cota**.

## Por que o par ficou "desenho + adversarial"

O critério não é preferência, é **detecção por unidade de cota**: desenho 0,41 reprovações/pp ·
código 0,35 · metodologia **0,22**. A tese inicial desta sessão — manter *metodologia* + adversarial,
porque o erro da régua (o da irmã deste doc) é invisível a qualquer revisão de diff — **foi rejeitada
pelos dados**: metodologia é o estágio de pior rendimento, e 8 das suas 12 sessões eram higiene de
processo (descartar branch, onde documentar), não money-path.

Mas a preocupação era legítima, e a saída é mais barata que um estágio: **a régua virou seção
obrigatória do prompt de desenho** (`RÉGUA:`). Captura a classe sem pagar uma consulta por ela.

O desenho reprovou com P0 **antes de existir código** em casos que o adversarial pegaria tarde ou não
pegaria: RPC `SECURITY INVOKER` chamando função revogada · bundle de rollback executando IO sem gate ·
backfill na chave errada ("produz dinheiro errado sem divergência aparente") · extrator que fabrica a
versão esperada. Por isso "só adversarial" (1 estágio) foi rejeitado: −20% de cota, mas empurra esses
P0 para depois da implementação, onde a rodada custa 1,92 pp e tipicamente vira 2+.

## O medo que a medição desfez

Temia-se que 2 consultas ficassem mais caras que 4, por carregarem mais contexto. **Falso.** O custo
correlaciona com as chamadas que o Codex faz explorando (Spearman **0,60**), não com o tamanho do
prompt (**0,26**) — prompts de 3–6k chars custaram MAIS que os de 6–10k. E consultas que citam parecer
anterior são mais curtas (5,5k vs 6,0k), exploram menos (9,5 vs 14 chamadas) e custam menos. Efeito de
+0,1–0,2 pp/consulta: ordens de grandeza abaixo das duplicatas.

## Não determinado

- **O mecanismo do 1 `exec` → 4 rollouts** (19% da cota). Provado que não é o agente nem o retry;
  falta a causa dentro do `codex exec` 0.153.4.
- **Os 53 pp em lacunas** e 3 resets do medidor (99→0, 34→0, 100→4) com buckets distintos
  (`codex_bengalfox`/`premium`): troca de plano ou 2º cliente. Não fecha só com rollouts.
- **Detecção ÚNICA por estágio** — "reprovou" é proxy; provar que o código não pegaria o que o desenho
  pegou exigiria experimento controlado.
- **Chamadas mortas não deixam rollout** (exit 75/79) — contam-se só pelo ledger do wrapper.

## Regras

1. **Meça o processo PRATICADO antes de cortar o prescrito.** A economia vive na diferença entre os dois.
2. **Corte de política é higiene; gasto anômalo é bug.** Duplicata, rodada repetida e trabalho fora de
   política renderam 52% contra 8% do corte — procure o defeito antes de reescrever a regra.
3. **Estágio caro que detecta pouco perde para uma SEÇÃO obrigatória no estágio que fica.**
4. **Soma de gauge concorrente infla** — use envelope monótono quando há sessões paralelas.
