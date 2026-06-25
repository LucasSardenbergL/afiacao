# Threat-model de engine money-path — formato

> Threat-model curto por engine que produz **número de decisão** (DRE/A1-A4, pricing, reposição, positivação/comissão, projeção de caixa). Destilado do `aura/THREAT_MODEL.md` do ECC (affaan-m), reescrito p/ o money-path (análise Codex 2026-06-23). O ponto: separar o que o número **prova** do que **não prova**, e travar o default em fail-closed ANTES de alguém tratar o output como verde.

## O esqueleto (5 blocos)

1. **O que o número prova** — a afirmação exata e o regime (competência? caixa? snapshot de quando?). Quase sempre *backward-looking*: descreve o passado registrado, não autoriza a ação presente.
2. **O que NÃO prova** — os saltos que o consumidor faria por engano. Ex.: "DRE positivo" ≠ "tem caixa pra pagar"; "custo reposto" ≠ "custo da próxima compra"; "score de cliente" ≠ "vai pagar este pedido".
3. **Failure-modes** — tabela `# | ameaça | mitigação na engine | risco residual do chamador`. Endpoint fora, dado stale, fonte trocada, gaming/sybil, over-trust. Cada linha deixa explícito o que a engine resolve e o que sobra pro chamador.
4. **Default fail-closed** — ausente / ambíguo / timeout → `null` + confiança-baixa, **NUNCA** número fabricado (money-path §2: `Number(null)===0` é fabricação). O default é a linha que mais erra **silenciosamente** — declare-o aqui em uma frase.
5. **Fronteira** — onde o número vira decisão (gate determinístico/humano) e onde **não pode** virar (UI ≠ guard; enumere TODAS as vias até o efeito, money-path §5). Assinatura/escrita/allow-deny ficam no seu código, auditáveis.

## Invariante de consistência (o achado que motiva isto)

Doc e código **não podem divergir no default**. No aura, o THREAT_MODEL diz que `new`/`unknown` são rejeitados por default, mas o adapter faz `DEFAULT_ALLOW` permitir `new` (`adapter.py:46` × `THREAT_MODEL.md:34`) — contradição que um teste pega e a prosa não. Regra: **todo default declarado neste doc tem assert correspondente** (`prove-sql-money-path` p/ SQL, vitest p/ helper TS). Se o doc afirma "fail-closed em ausência", existe um teste que semeia ausência e exige `null`.

## Quando escrever um

Toda engine **nova** que emite número de decisão money-path, antes do primeiro consumidor. Não é doc cerimonial: é o checklist que vira asserts e a barra que o `/codex` adversário ataca. Se a engine só transporta dado (sem decisão), pule — o formato é pro número que alguém vai *confiar*.
