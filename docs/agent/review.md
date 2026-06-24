# Review — barra de evidência (anti-falso-positivo)

> Critério de aceite de **todo finding** de review: humano, `/code-review`, `/codex` (consult/challenge), `triagem-3-modelos`. Money-path herda `precisão > recall` aqui também — no review, um falso-positivo custa confiança e tempo do founder; melhor **3 achados provados que 10 hipóteses**. Padrão destilado do `code-reviewer` do ECC (affaan-m), reescrito CC-puro + money-path (análise Codex 2026-06-23).

## A barra — sem prova, rebaixa (nunca descarta caladamente)

1. **Trigger concreto.** O input/estado que dispara o bug, não "pode acontecer". Ex.: `parseFloat('')||0` vira preço 0 — o trigger é *carrinho com `unit_price` string vazia*, não "parsing pode falhar". Sem o trigger nomeado, é hipótese, não finding.
2. **Local exato + caminho até o efeito.** `arquivo:linha` e as **vias** que chegam lá (enumere TODAS, como money-path §5: o pedido tem ≥4 caminhos até o Omie). Um finding que aponta um caminho e ignora os outros 3 é meio-finding.
3. **Severidade por blast-radius demonstrado.** `HIGH`/`CRITICAL` só com **repro ou caminho de exploração andado**. "Parece arriscado" sem caminho → `MEDIUM`/observação. Espelha "diagnosticado ≠ corrigido": severidade alta é afirmação de efeito, não de cheiro.
4. **Confiança explícita.** Abaixo de ~80% e sem repro → rebaixa a **hipótese-a-investigar** com o que falta pra confirmar, não a finding. Rebaixar ≠ silenciar: o item continua visível, só muda de gaveta.

## Anti-teatro (espelha o assert negativo do money-path)

- O reviewer **demonstra**, não supõe. "Acho que pode dar problema" é o `WHEN OTHERS THEN 'OK'` do review: engole a falta de prova e parece cobertura. Se não consegue nomear trigger+linha+efeito, diga isso — "suspeita sem repro" é um estado honesto e útil; finding fabricado não.
- **Falsifique o próprio finding** antes de subir a severidade: existe um caminho em que o código está certo? Se some sob 30s de leitura, era ruído. (Mesmo dente que a sabotagem-de-migração exige do `prove-sql-money-path`.)

## Painel multi-modelo (triagem-3-modelos / Codex)

- A barra é o **filtro ANTES da regra determinística**, não depois: finding sem prova **não entra no contrato JSON** do `triagem-3-modelos` — senão a decisão-por-regras herda lixo de três fontes em vez de uma. A divergência entre modelos é sinal (lentes diferentes), o falso-positivo de qualquer um não é.
- Concordância cross-model é **recomendação, não decisão** — registre quem achou o quê; dois modelos errando junto continua errado. (No money-path, o Codex adversário é etapa obrigatória, mas o veredito final é do gate determinístico/humano.)

## Quando relaxar — de propósito

Brainstorm, spec exploratório, `/codex challenge` em modo "me mostre tudo que pode quebrar": aí a **hipótese é bem-vinda** — marque-a como hipótese e siga. A barra vale para o **gate de aceite** (o finding que vira trabalho/PR/bloqueio), não para a ideação que o alimenta. Confundir os dois mata recall onde recall é o objetivo.
