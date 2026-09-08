# Ocupação de contexto POR ARQUIVO — a régua que falta para decidir o que destilar

**Data:** 2026-09-07 · **Origem:** pedido do founder para destilar `CLAUDE.md` + `docs/agent`,
com 2ª opinião do Codex (gpt-6-astra) recomendando *"deixar decisões essenciais e roteamento na
raiz; destilar `docs/agent` em procedimentos curtos, remetendo narrativas ao histórico"*.

## 1. O que motivou — e o que a medição corrigiu

O briefing partiu de três números. Os três foram verificados; **dois confirmam e um inverte a
conclusão que deles se tirava**.

| afirmação do briefing | veredito | medido |
|---|---|---|
| `CLAUDE.md` a 2 palavras do teto (2.598/2.600) | ✅ confirmado | `wc -w` |
| `docs/agent` ≈ 779 KB / 222k tokens | ✅ confirmado (800 KB) | `du`/`wc -c` |
| sensor tem `chars=0`, "peso não capturado" | ⚠️ **impreciso** | é `null`, e por contrato |
| "0 eventos de subagente" ⇒ regra não alcança subagente | ❌ **refutado** | subagente recebe o arquivo INTEIRO |
| ⇒ logo, cortar o `CLAUDE.md` economiza | ❌ **refutado** | vale ~2% do custo de entrada |

### 1.1 O sensor não está quebrado — está no limite do contrato

`docs/historico/split-claude-md-sensor.md` (22/08) já havia diagnosticado: `chars` é `null`
porque **o payload do `InstructionsLoaded` nunca traz `file_content`**. Confirmado agora em
**1.741 eventos, zero ocorrências** do campo. O hook está certo; o que ficou por fazer foi o
passo seguinte — medir o peso pelo `file_path`, que o payload traz.

### 1.2 O subagente RECEBE o CLAUDE.md; o cego é o hook

O gate da fase 2 (aberto desde 22/08) exigia "≥1 evento com `agent_type`". Ele nunca chegaria.

- Denominador na janela do sensor: **24 diretórios `subagents/`, 148 arquivos de subagente**,
  75 transcrições com `isSidechain:true`.
- Eventos do sensor rotulados subagente: **0**.
- Cruzamento por sessão que fecha o caso: `b0466403` rodou **34 subagentes → 3 eventos**;
  `ac72c4b2`, **8 subagentes → 1 evento**.

Sonda direta (subagente `fable`, proibido de usar tools, `tool_uses: 0` no `usage`): citou a
primeira linha do `CLAUDE.md`, listou as **10 seções** e acertou três regras críticas
(`security_invoker=on`, `psql-ro`, pt-BR). **Veredito: o carregamento alcança o subagente; o
evento `InstructionsLoaded` não é emitido para ele.** O gate 2 (`motivo: compact`) destravou
sozinho: 0 eventos em 22/08 → **18** hoje.

Corolário para o orçamento: os 1.741 eventos contam só sessões principais. O nº real de
carregamentos é maior, e o `claude:size` se justifica — a premissa "toda sessão + subagente"
é **verdadeira**.

### 1.3 A inversão: o `CLAUDE.md` é a menor metade

`docs/historico/piso-de-contexto.md` já separou piso de excedente sobre 20.933 requests:

| | tokens | custo de entrada |
|---|---|---|
| piso — inclui o `CLAUDE.md` | 24,3% | **25,9%** |
| conversa acumulada | 75,7% | **74,1%** |

Com 2/3 do piso pertencendo ao harness, as alavancas locais valem **~1,7%**. Zerar o
`CLAUDE.md` inteiro — não encolher — vale ~2%.

Mas **`docs/agent` não vive no piso**: vive nos 74%, como custo de OCUPAÇÃO. Um `tool_result`
é relido em todo request seguinte, logo custa `tamanho × requests_restantes`.

| doc | KB | tok/leitura | leituras (17d) |
|---|---|---|---|
| `money-path.md` | 157 | **43.586** | 64 |
| `database.md` | 143 | 39.598 | 34 |
| `deploy.md` | 128 | 35.645 | 23 |

Um Read de `money-path.md` numa sessão com 100 requests pela frente custa ~4,4M tokens de
`cache_read` — **~800× carregar o `CLAUDE.md` uma vez**. E o nudge deste repo já foi
recalibrado para **≥40k → delegar · 10–40k → recortar**: `money-path.md` está acima do
limiar sozinho.

⇒ A recomendação do Codex está certa, **por um motivo mais forte que o do briefing**. E casa
com a lição transferível já registrada: *"o que funciona é limitar o TAMANHO de cada entrada,
não escolher quais entram"*.

## 2. A lacuna real

`ocupacao-contexto.sh` mede ocupação **por FERRAMENTA** (Read ~55% · Bash ~40% · Edit ~3%).
Não existe régua que responda **qual ARQUIVO** custa mais em ocupação — que é exatamente a
pergunta que decide o que destilar primeiro. Essa é a única peça faltando.

Hipótese a falsificar: espera-se `docs/agent/money-path.md` no topo. Se o topo for código
(`src/**`), a frente de destilação de docs muda de prioridade — e isso é resultado válido.

## 3. O que construir

### 3.1 `ocupacao-contexto.sh --por-arquivo` (estender, não criar)

Flag nova no script existente. Mesma fonte (`~/.claude/projects/**/*.jsonl`), mesma unidade
(`CHARS_POR_TOKEN=3.5`), mesmo dedupe por `requestId` — herda a régua já corrigida em 06/08.

- Agrupa por `file_path` de `tool_use` (Read/Edit), somando `tamanho × requests_restantes`,
  onde `requests_restantes` é contado dentro da MESMA sessão.
- **`Bash` fica de fora do agrupamento, e isso é declarado na saída** — ele é ~40% da
  ocupação mas não tem `file_path`, então some numa linha `(bash — sem arquivo)` em vez de
  desaparecer. Um ranking que omite 40% do custo sem dizer é o mesmo defeito de classe que
  este spec existe para corrigir: ausência apresentada como medida.
- Ordena por custo de ocupação, não por nº de leituras nem por tamanho.
- Default: projetos Afiação (dirs contendo `afiacao`), janela **30 dias**, `--dias N` ajusta,
  `--todos` abre para a máquina inteira.
- **Fail-closed:** toda sonda com controle positivo; controle vazio ⇒ **erro alto**, nunca
  tabela vazia. Marcador positivo de fim.

### 3.2 Dois consertos no `instrucoes-carregadas.sh`

- `bytes_arquivo`/`palavras_arquivo` medidos do `file_path` com `wc`; **`null` se ilegível,
  nunca `0`** (a doutrina `ausente ≠ zero`, aplicada onde ela já falhou uma vez).
- `agente: (.agent_type // null)` + `agente_fonte` — para de rotular "principal" o que nunca
  foi observado. Comentário registrando que o evento **nunca** vem de subagente (medido).

### 3.3 Teste em `test:hooks`

`scripts/test-ocupacao-por-arquivo.sh`, com fixture sintética de transcrição.

Casos, cada um com **controle verde na MESMA invocação antes do primeiro `sed`**:
1. arquivo lido cedo numa sessão longa custa mais que o mesmo arquivo lido no fim — é a tese
   inteira; se inverter, o cálculo está errado;
2. dedupe por `requestId` (herdado): request repetido não conta 2×;
3. **o caso que dá nome à suíte** — comando cuja saída é vazia por FALHA deve sair
   vermelho, jamais imprimir "0 leituras". Foi assim que, ao levantar esta linha de base,
   um `xargs -a` (que não existe no BSD) com `2>/dev/null` quase produziu o veredito
   "`docs/agent` nunca é lido" — o oposto da verdade (200 leituras).

### 3.4 Resíduo durável

- `docs/historico/ocupacao-por-arquivo-linha-de-base.md` — a linha de base e o achado do
  subagente.
- `split-claude-md-sensor.md` — fase 2 encerrada: gate 1 **respondido** (cegueira estrutural
  do hook, não "sem dado"), gate 2 destravado.
- `evidencia-positiva-shell.md` — entra `xargs -a` inexistente no BSD + `2>/dev/null`
  convertendo `invalid option` em ausência.
- `piso-de-contexto.md` — acrescenta a fatia por ARQUIVO à decomposição por ferramenta.

**`CLAUDE.md`: zero palavras a mais.** Tudo acima é lição de domínio e vai para `docs/`,
conforme a política do topo do arquivo.

## 4. Fora de escopo (fase seguinte, agora com número)

Destilar `money-path.md`/`database.md`/`deploy.md`; mover qualquer regra do `CLAUDE.md`.
A destilação passa a ter alvo ordenado por custo medido, em vez de por tamanho aparente.

## 5. Riscos

| risco | mitigação |
|---|---|
| formato interno das transcrições muda | mesma exposição das 3 réguas que já existem; controle positivo falha alto em vez de calar |
| `--por-arquivo` discorda de `--top` | mesma fonte e unidade; o teste checa que o total por arquivo não excede o de ferramenta |
| medir MENÇÃO em vez de leitura | erro já cometido e medido: menção deu 505 para `money-path`, leitura real 64 (8×). Só `tool_use.input.file_path` conta |
