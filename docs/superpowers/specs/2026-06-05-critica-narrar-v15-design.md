# Crítica da Fila v1.5 — camada de LLM ("linha de abordagem") — design (shell)

> Data: 2026-06-05 · Status: spec do **shell** aprovável; **BUILD GATED no piloto** da Crítica da Fila v1.
> Programa: **"Buddy" (UPOPS/Itaú)** — v1.5. v1 (Crítica da Fila rep-facing) + GestorBuddy já em produção.
> Consult codex (3 rodadas) salvo em `.context/codex-session-id`.

## 0. ⚠️ Gate do piloto (ler primeiro)

**NÃO construir até o piloto de 2 semanas da Crítica da Fila v1 passar** (critério de morte na spec da v1 §8: ≥50% dos top-5 abertos/acionados etc.). Razão (nossa + codex): *"LLM/agêntico antes da qualidade da ação ser provada = teatro"*; se o piloto matar a tese, mais LLM é o movimento errado.

Esta spec desenha o **shell** (arquitetura, grounding, validação, telemetria, degradação) — robusto independente do piloto. O **conteúdo** (redação do prompt, quais contradições narrar, default-visível vs só-expand, "o que dizer" vs "o que checar") **NÃO é travado aqui** — decide-se com dado do piloto.

## 1. A UMA tarefa (codex)

Traduzir a **contradição determinística** na **primeira frase/movimento de conversa** do vendedor: reconhecer → perguntar → sondar → recuperar. **NÃO** repetir o `motivo`/`contradicoes` (que a vendedora já lê). Se não produzir um movimento operacional, **descarta a linha** (a evidência determinística já faz o trabalho real).

- ❌ Fluff: *"Entre em contato e entenda a necessidade do cliente."*
- ✅ Operacional: *"Abre reconhecendo que ele saiu do ritmo e pergunta se mudou de fornecedor, demanda ou prazo antes de oferecer produto."*

**Regra-mestra (codex): a prosa do LLM é descartável; a evidência é o produto.**

## 2. Não-objetivos (v1.5)

- **Resumo de transcrição / voz do cliente** — superfície separada (seleção/truncação/privacidade/ausência); **v1.6**, e só se o piloto mostrar que a vendedora quer ajuda narrativa.
- **Batch/cron/tabela/persistência** da prosa — over-engineering; on-demand basta. Prefetch dos top-1-2 no idle só **se** a latência provar que atrapalha a ação.
- **Gateway Lovable/Gemini** — usamos Anthropic direto (padrão já em prod).
- Travar redação do prompt / quais `chave`s narrar / visibilidade default — **adiado pro piloto**.

## 3. Arquitetura — edge Anthropic direto, on-demand-on-open

```
PorQueAgora (card já existente)  — rep expande "por que agora" → dispara fila.critica_opened
        │  (no expand, se a contradição é forte o suficiente p/ narrar)
        ▼
useCriticaNarrar(pack)  [novo hook]  — React Query key ['critica-narrar', clienteUserId, packHash]
        │   staleTime = sessão/dia · timeout HARD ~2s · enabled só no expand
        ▼
edge `critica-narrar`   [novo, padrão claude-spin-analyze]
        │   Anthropic({ANTHROPIC_API_KEY}) · claude-sonnet-4-6 · system cacheado (ephemeral)
        │   · forced tool-use (saída estruturada) · authorizeCronOrStaff (staff)
        ▼
validarLinhaAbordagem(saida, pack)  [helper PURO, TDD]  — pós-validação anti-alucinação
        │   passou → linha aparece ABAIXO da timeline determinística
        │   rejeitou/erro/timeout → card fica no determinístico v1 (silencioso)
```

- **Provider:** edge `critica-narrar` seguindo **exatamente** o `claude-spin-analyze` (ANTHROPIC_API_KEY [já é secret], `claude-sonnet-4-6`, system prompt num breakpoint `cache_control: ephemeral` → ~$0.005/call, `tools`+`tool_choice` forçado, gate `authorizeCronOrStaff`). **NÃO** o gateway Gemini.
- **Cadência: on-demand-on-open.** Chama só após o expand (`fila.critica_opened`). Pack determinístico renderiza **imediatamente**; a linha de abordagem aparece embaixo **se/quando** pronta (≤2s). Sem tabela, sem cron, sem persistência.
- **Custo:** caching do system + só-cards-abertos + bounded → centavos. (Se o piloto mostrar que a espera atrapalha, aí sim prefetch dos top-1-2 no idle — não antes.)

## 4. Grounding / anti-alucinação (a parte crítica — codex)

⚠️ **Furo que o codex pegou:** o `EvidencePack.sinais[].texto` JÁ contém números renderizados ("Faturamento caiu 60%", "28d sem comprar (1,9×)"). Se o Claude vê esses textos, pode **parafrasear o número errado**. Por isso "sem número na saída" tem que ser **enforçado**, não só pedido.

**Pré-requisito (toca o v1):** adicionar **`id` estável** a cada `SinalVoz` (hoje só há `fonte{tabela,id,observadoEm}`). Derivado determinístico (ex.: `${tipo}:${fonte.tabela}:${fonte.id}:${i}`). Mudança **aditiva** ao `montar.ts`/`types.ts` (não muda comportamento da v1; só dá âncora pro v1.5).

**Contrato:**
- O edge recebe SÓ o `EvidencePack` (sem acesso a DB). O Claude vê os `sinais`/`contradicoes` + os `id`s.
- **Forced tool-use**, schema da saída = `{ approach_line: string, theme: 'reconhecer'|'perguntar'|'sondar'|'recuperar'|'fechar', evidence_ids_used: string[] }`. **Sem números no schema.**
- A UI renderiza **todos** os números a partir do pack determinístico; o LLM só adiciona prosa.

**`validarLinhaAbordagem(saida, pack)` (helper puro, TDD) — rejeita (→ descarta a linha) se:**
1. `approach_line` contém dígito, `R$`, `%`, `×`/`x`, `90d`/`dias`/`d` numérico, ou palavra de moeda/quantia.
2. `evidence_ids_used` vazio, ou algum id **∉** pack.
3. menciona falta de dado como fato.
4. `> 180` chars.
5. nome de cliente não passado explicitamente.

Passou → renderiza. Rejeitou → **degrada silencioso** pro determinístico (a linha é aditiva).

## 5. Degradação & confiança (regras do codex)

- LLM caiu/timeout/rejeitado → card mostra o determinístico v1 (a ausência da linha **nunca** quebra nada).
- **Nunca** narrar card de evidência fraca / `faltaDado` — só contradição forte.
- A linha **nunca** conflita com o CTA determinístico (que segue mandando).
- Pack determinístico **primeiro**, visualmente dominante; a prosa entra **abaixo**, secundária — nunca compete com a prova.

## 6. Telemetria (PostHog)

`fila.critica_narrar_generated` (linha passou na validação e renderizou; props: `chaves`, `theme`) · `fila.critica_narrar_rejected` (validação barrou; props: `motivo`) · reusa `fila.critica_acted` (ação após ver a linha). Mede: a linha muda comportamento? Se não → **deletar** antes de qualquer camada de LLM mais rica.

## 7. O que é robusto agora × o que o piloto decide (codex)

**Travado no shell (robusto qualquer que seja o piloto):** padrão Anthropic-direto + cache + forced-tool; validação de evidence-id; pós-validação anti-número; invocação on-open; degradação silenciosa; IDs estáveis no `SinalVoz`; telemetria.

**NÃO travar (decide com dado do piloto):** redação do prompt; quais `chave`s de contradição merecem narração; linha default-visível vs só-no-expand; se a vendedora quer "o que dizer" vs "o que checar antes de ligar"; se a transcrição entra (v1.6).

## 8. Testes

- **TDD no helper puro** `validarLinhaAbordagem` (`src/lib/fila/critica/__tests__/`): cada regra de rejeição (número em várias formas, id inexistente, vazio, >180, menção a falta-de-dado) + caso válido.
- **TDD nos IDs estáveis** do `SinalVoz` (determinístico, sem colisão num pack).
- Edge espelha o helper (validação roda no edge **e** no client). Sem teste de rede no helper.

## 9. Custo / risco

- ~$0.005/call (cache), só cards abertos, bounded → centavos/dia em <20 usuários.
- Risco-mor (codex): a prosa erodir a confiança que a v1 construiu. Mitigação = §4 (anti-número enforçado) + §5 (degradação/secundária/nunca-conflita) + §1 (descarta se não for operacional) + a telemetria §6 que mata a feature se não mudar comportamento.
