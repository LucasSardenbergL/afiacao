# Codex além da 2ª opinião: `AGENTS.md` + sabotador cego

**Data:** 2026-09-09 · **Origem:** pergunta do founder — "como explorar o Codex em mais formas para codarmos melhor?"

## 1. Problema

O Codex hoje ocupa **um papel só**: segunda opinião em arquitetura e obrigatória no money-path, via `scripts/codex-async.sh`. O valor está provado (NF-e sobre unidade não persistida, TOCTOU em plpgsql, `Infinity`/`NaN` furando guards, dedup capado 1.000/5.276 indo a produção). Mas ampliar o uso esbarra em dois limites reais:

- **Cota.** Plano Plus, janela de 7 dias, ~21k tokens/chamada; `exit 75` já ocorreu várias vezes e forçou retroativo agendado. Mais pontos de uso sem priorização = Codex faltando onde é **obrigatório**.
- **Nenhuma medição de acerto.** Não existe registro de taxa de acerto/falso-positivo. O histórico tem os dois lados: em `pcp.md` ele levantou 3 P1 e **nenhum sobreviveu às sondas**; errou sobre `claude_ro`/RLS; foi refutado no PG17.

## 2. Achado que orienta o desenho

Consultado sobre onde é sistematicamente melhor que o Claude, o Codex **recusou a premissa**:

> "não tenho evidência suficiente para afirmar isso em nenhuma classe. A diferença estrutural defensável é separar implementação de tentativa de refutação, com contexto independente e prova executável. Uma segunda sessão Claude também pode oferecer isso."

**O que está provado é o valor da independência, não o do modelo.** A vantagem de trocar de modelo é hipótese a medir (fora deste escopo — §8).

Três fontes independentes (mapa do repo, ideação Fable 5.1, parecer do próprio Codex) convergiram no mesmo alvo: **o instrumento de verificação, não o código de produção**. Razão estrutural: o mesmo autor escreve o código e o teste, com a mesma premissa. Se a premissa está errada, o teste fica verde e uma revisão do *código* não pega — só uma sabotagem independente do *teste* pega.

Palavras do Codex: *"um defeito pequeno no instrumento invalida muitas verificações."*

## 3. Peça 1 — `AGENTS.md`

**Problema que resolve:** não existe `AGENTS.md` nem `.codex/` no repo. Todo parecer roda **cego ao catálogo de armadilhas** — o Codex só vê o que o prompt cola. Isso provavelmente explica parte dos erros de conteúdo dele.

**Desenho:**

| Item | Decisão |
|---|---|
| Caminho | `AGENTS.md` na raiz (lido automaticamente pelo `codex exec`) |
| Teto | 10 KB, medido em **bytes** |
| Camada fixa | Escrita à mão: proibições invioláveis (**nunca abrir `supabase/schema-snapshot.sql`** — já travou sessão), definição de money-path, barra de review (localização · impacto · contraexemplo · evidência; hipótese declarada como hipótese; **zero achados é resposta válida**) |
| Camada derivada | Gerada por `scripts/gerar-agents-md.sh` da seção "⚠️ Armadilhas recorrentes" do `CLAUDE.md` — fonte única, sem cópia paralela |
| Gate | `bun run agents:paridade` → `scripts/check-agents-md-paridade.sh`, molde do `check-claude-md-budget.sh`, com baseline versionada |
| Suíte | `scripts/test-agents-md-paridade.sh`, registrada no `test:hooks` |

**Seleção, não cópia (medido em 2026-09-09):** a seção "⚠️ Armadilhas recorrentes" tem **9.114 bytes em 23 bullets** — estoura o teto sozinha. E copiar tudo seria errado: várias armadilhas são sobre coisas que o Codex nunca faz (os 3 deploys do Lovable, worktrees, `/compact`, chips). O gerador copia apenas as marcadas numa **allowlist versionada** (`scripts/agents-md-armadilhas.txt`), casada por âncora — as primeiras palavras em negrito de cada bullet.

**O gate exige decisão explícita, nunca silêncio:** toda armadilha do `CLAUDE.md` precisa estar **ou** no `AGENTS.md` **ou** marcada na allowlist como `IGNORAR # motivo`. Bullet novo que não aparece em nenhum dos dois deixa o CI vermelho. É a mesma doutrina da baseline do `claude:size`: encolher é legítimo, encolher **em silêncio** não. Teto revisado: **10 KB**.

**Regra de conteúdo (anti-vazamento):** o arquivo carrega **regras genéricas** ("view recriada sem repetir `security_invoker` passa a ler como owner e bypassa RLS"), **nunca respostas de caso** ("no PR #1483 o erro foi X"). Motivo: o `AGENTS.md` é destilado de casos históricos; medir o Codex depois com esses mesmos casos seria medi-lo com o gabarito colado, e ler o resultado como "melhorou". Isso condiciona o piloto de calibração (§8).

**Falsificação obrigatória:** remover uma armadilha do `AGENTS.md` gerado deve deixar o gate **vermelho**, com **controle verde na mesma invocação do laço** (regra de `docs/historico/falsificacao-sem-linha-de-base.md`: sabotar sem controle verde aprova tudo).

## 4. Peça 2 — Sabotador cego, sobre a infra `mutcheck` que JÁ existe

**Descoberta que redimensiona a peça (2026-09-09):** o repo já tem mutação implantada e madura — `scripts/mutcheck.sh` (com `--selftest`), `scripts/mutcheck-all.sh` (`bun run mutcheck`), **25 contratos** em `scripts/mutcheck.d/*.mut`, gate barato `scripts/mutcheck-seco-gate.sh` e job `mutation-check` no CI. O contrato já carrega o veredito esperado por linha:

```
# @src: src/lib/financeiro/aging-helpers.ts
# @test: src/lib/financeiro/__tests__/aging-helpers.test.ts
PEGA      | faixaAging <=30 -> <30  | s/diasAtraso <= 30/diasAtraso < 30/
SOBREVIVE | concentracao <=0.6      | s/<= 0.6/< 0.6/
```

**Sai da spec** (já resolvido pela infra, não construir): executor de mutação, classificação pego/sobreviveu/inválido, controle verde, exigência de árvore limpa, worktree descartável, fila de vereditos própria, detecção de contrato stale.

**A lacuna que sobra — e que é exatamente a da §2:** as ~200 linhas dos 25 contratos foram escritas **pelo mesmo autor dos testes**. Ponto cego correlacionado, não corrigível por mais esforço do mesmo autor. E nada propõe mutação nova quando um teste nasce ou muda.

### Nova forma
O Codex recebe fonte + teste e devolve **linhas `.mut` candidatas no formato exato**, cada uma com seu palpite `PEGA`/`SOBREVIVE`. O `mutcheck.sh` executa. O produto é a **divergência entre predição e realidade**:

| Codex previu | Realidade | Significado |
|---|---|---|
| `PEGA` | sobreviveu | **Buraco de cobertura real e novo** — é o achado que se procura |
| `SOBREVIVE` | pegou | Teste mais forte que o previsto — descarta, sem custo |
| bate | bate | Cobertura confirmada; a linha vira contrato permanente |
| padrão não casa | `INVÁLIDO` | Mutação mal-formada; não conta como nada |

**A propriedade decisiva:** o Codex não emite parecer — emite **predição falsificável**, e a infraestrutura existente a falsifica sozinha. Não há espaço para objeção plausível-porém-inventada, que era o modo de teatro temido na §2. O resíduo é **durável e versionado** (linhas novas no `.mut`), não relatório efêmero.

### Entrega
`scripts/codex-propoe-mut.sh` — monta o prompt (fonte + teste + o formato do contrato + os contratos vizinhos como exemplo de estilo), chama `codex-async.sh`, grava um `.mut` candidato em diretório de trabalho, roda `mutcheck.sh` contra ele e imprime a tabela de divergência. Nenhuma linha entra em `scripts/mutcheck.d/` sem revisão humana.

## 5. Peça 3 — Guard no `gh pr create`

Duas lacunas confirmadas, uma por peça. A segunda: **nada cobra contrato `.mut`** para arquivo money-path novo ou alterado — a cobertura existe onde alguém lembrou de criar.

`.claude/hooks/pr-contrato-mut-guard.sh`, PreToolUse(Bash). Calibrado pela regra tácita dos hooks do repo — **`deny` no inequívoco e irreversível** (`destructive-bash`, `migration-collision`, `migration-immutability`), **`allow` + aviso no ambíguo** (`pr-collision`, `pr-duplicata`):

| Situação | Decisão | Razão |
|---|---|---|
| Fonte money-path alterada **com** contrato `.mut` cujo `PEGA` virou sobrevivente | `deny` | Regressão de cobertura executada — fato, não opinião |
| Fonte money-path **nova** sem nenhum contrato | `allow` + aviso nomeado | Ambíguo: nem todo arquivo novo merece contrato; a decisão é de quem escreve |
| Fora de money-path | silêncio | Não gastar cota nem atenção |

**Respeitar o desenho existente:** o job `mutation-check` é **não-required de propósito** — um refactor alheio pode dessincronizar um `.mut` de terceiro e travar PR de quem não tem culpa. O guard novo herda essa restrição: só avalia contrato cujo **`@src` este diff tocou**, nunca a suíte inteira.

**Escape nomeado:** grava o motivo no corpo do PR como marcador estruturado. Fecha de brinde uma lacuna existente — hoje o marcador "REVISÃO INDEPENDENTE PENDENTE" (Caminho B, cota esgotada) **não tem sensor de fechamento**.

## 6. Como se sabe que funcionou

Com denominador, conforme `docs/historico/fase-sem-sinal.md`:

- **`PEGA` previsto que sobreviveu / mutações propostas** — métrica primária: buracos de cobertura reais por chamada.
- **linhas incorporadas a `scripts/mutcheck.d/` / linhas propostas** — o resíduo durável. Se nada é incorporado, o rito é decorativo.
- **`INVÁLIDO` / propostas** — se alto, o prompt está ruim (padrão que não casa o fonte), não o teste.
- **Linha de base humana já existe.** Os 25 contratos foram escritos pelo mesmo autor dos testes. Rodar o rito sobre um deles **sem mostrar o contrato ao Codex** e comparar as duas listas é o teste direto da hipótese desta spec — e custa uma chamada, porque o gabarito humano já está versionado.
- **Alarme de trivialidade:** predição que bate 100% na primeira rodada é suspeita de mutações óbvias (que qualquer teste pega), não de excelência. Acerto perfeito mede o alvo, não o atirador.

## 7. Riscos honestos

- **Teatro por erro correlacionado.** Codex e Claude podem partir da mesma especificação incompleta. Mitigação parcial: o produto aqui é veredito **executado** (mutante morreu ou não), não parecer — não há espaço para objeção plausível-porém-inventada. Não elimina o risco de ambos ignorarem a mesma dimensão ausente.
- **Cota.** Teto de 1 chamada/PR e escopo restrito a caminho vigiado. Se ainda assim competir com o money-path, o money-path ganha.
- **Guard que trava em momento ruim.** Daí o escape nomeado. Se o escape virar rotina (medir!), o guard falhou e vira nudge.
- **Escopo do teste.** Mutação fora do que o `describe` afirma cobrir gera ruído legítimo-porém-inútil. O prompt precisa amarrar a mutação ao comportamento declarado.

## 8. Fora de escopo (descartado com motivo)

- **"Codex revisa todo PR":** 18 de 40 merges recentes já levam parecer; o resto é UI/docs onde a barra rebaixa quase tudo → ruído ignorado.
- **CRUD React, formulários, CSS, refactor mecânico:** o próprio Codex disse não ter vantagem comparativa demonstrada.
- **Convenções já fiscalizadas por gate** (toast, manifesto, flags Deno): rodar o gate é mais barato e mais confiável que consultar modelo.
- **`codex mcp-server`:** tool call síncrono devolveria o ritual ao foreground — o problema que o `codex-async.sh` resolveu.
- **`codex cloud` + `apply`:** repo com segredos Lovable/Supabase.
- **Codex escrevendo código** (`-s workspace-write`): serve à dor de paralelizar, mas é **mudança de política** (hoje o Codex nunca escreve) — decisão separada.
- **Piloto cego de calibração** (Codex vs 2ª sessão Claude, orçamento igual, métrica "defeitos confirmados por minuto total incluindo investigação de falso positivo"): peça seguinte, condicionada pela regra anti-vazamento da §3.
