# Roteiros — Ligação (Farmer), WhatsApp e Visita (Hunter)

Tudo aqui é **rascunho para a pessoa revisar e usar** — a skill nunca liga nem envia. Tom:
**consultivo, direto, mineiro, respeitoso**. A Farmer conhece o cliente; o roteiro é um apoio,
não um teleprompter. Frases curtas e faláveis. Personalize com o **dado real** do cliente
(atraso, mix), nunca com frase de efeito vazia.

## Princípios

- **Abrir pela relação, não pela venda.** Primeiro entender (movimento, obra, estoque), depois oferecer.
- **Ancorar no dado.** "Vi que faz X dias..." soa atencioso e verdadeiro; "tô passando pra oferecer" soa spam.
- **Uma oferta principal + uma secundária.** Não despejar o catálogo inteiro de uma vez (mesmo
  que o objetivo seja ampliar mix — conduza, não atropele).
- **Sempre terminar com próximo passo concreto** (pedido agora, orçamento por WhatsApp, retorno em X dias).

## Modo FARMER — roteiro de ligação (modo principal)

Estruture cada cliente assim (adapte ao tier e ao mix):

**1. Abertura (relação)**
- Em dia: *"Oi [nome], aqui é a [Farmer] da Colacor. Tudo bem? Como tá o movimento aí em [cidade]?"*
- Queda 🟡: *"Oi [nome], da Colacor. Senti falta de vocês — tava olhando aqui e o pedido de
  vocês deu uma espaçada. Tá tudo certo por aí?"*
- Queda 🔴 / sumido: *"Oi [nome], da Colacor. Faz [X] dias que a gente não fecha um pedido e
  vocês sempre foram cliente certo. Quis ligar pra entender se aconteceu alguma coisa."*

**2. Diagnóstico (uma pergunta que abre a venda)**
- *"Como tá o estoque de [categoria que ele já compra]? Não quero deixar vocês na mão."*
- Para sumido: *"Vocês passaram a comprar em outro lugar, ou só deu uma calmaria na produção?"*
  (escuta a objeção real antes de oferecer)

**3. Oferta (puxa o mix ausente — o gancho do cross-sell)**
- *"Aproveitando: vocês trabalham com [ramo], né? A gente fornece [categoria ausente] também —
  vocês chegam a comprar [ex: cola, lixa] de quem hoje?"*
- **Escolha o gancho pelo ramo/mix real** (ver `contexto-industrial.md` → cross-sell de alto
  retorno). Exemplos por caso:
  - **EPI** (quase universal): *"Vi que vocês lixam e pintam direto — máscara PFF2 e protetor
    vocês pegam com a gente? Já mando junto."*
  - **Completar acabamento Sayerlack:** *"Vocês levam seladora com a gente, mas o verniz/base PU
    vocês compram de quem? Fecho o sistema completo."*
  - **Afiação — SÓ pra quem corta** (madeireira, marcenaria de produção, metalúrgica): *"E as
    serras/discos de vocês, quem tá afiando? A gente busca, afia e devolve."* (Não use com
    pintor/vidraceiro/acabador — é irrelevante pra eles.)

**4. Fechamento / próximo passo**
- *"Fecho [item principal] pra entrar na entrega de [dia da rota]? E te mando no WhatsApp o
  preço de [item secundário] pra você ver com calma."*

> No output, escreva 3–5 falas curtas por cliente, não um monólogo. Marque [colchetes] para a
> Farmer preencher o que for específico.

## Rascunho de WhatsApp (quando o follow-up pedir)

Curto, sem "bom dia copia-e-cola" genérico. Exemplo para alerta de queda + mix:

> *Oi [nome], aqui é a [Farmer] da Colacor 👋 Passei pra ver se tá precisando repor [categoria
> que ele compra] — e te mandar o valor de [categoria ausente], que vi que pode encaixar no que
> vocês fazem. Quer que eu já deixe separado pra entrega de [dia]?*

Regras do WhatsApp: 1 mensagem, sem corrente de emojis, sem "promoção imperdível", sempre com
pergunta no fim (abre resposta). A Farmer revisa e envia.

## Catálogo de objeções + resposta (enquadramento, não embate)

| Objeção | O que costuma estar por trás | Resposta (rascunho) |
| --- | --- | --- |
| **"Tá caro / achei mais barato"** | preço vs. custo total | *"Entendo. Posso te mostrar o rendimento? Às vezes o disco mais barato dura metade — no fim sai mais caro. Faço uma conta com você?"* |
| **"Já tenho fornecedor"** | lealdade / comodismo | *"Justo. Não quero tomar seu fornecedor — quero ser a sua segunda opção pra quando faltar. Posso te cotar [item ausente] só pra você comparar?"* |
| **"Tô sem demanda / movimento fraco"** | sazonalidade | *"Tá osso pra todo mundo. Quando voltar, te deixo prioridade na entrega. Enquanto isso, quer adiantar a afiação das serras, que aí já fica pronto?"* |
| **"Tô com estoque"** | timing | *"Show, melhor assim. Quando costuma repor [categoria]? Te ligo uns dias antes pra não faltar."* |
| **"Esse produto não funcionou da última vez"** | qualidade/técnica | *"Poxa, me conta o que houve — era pra [aplicação]? Talvez fosse o grão/linha errada pro material de vocês. Deixa eu acertar a recomendação."* |
| **"Não sou eu que compro / vou ver com o dono"** | decisor | *"Claro. Quem que eu falo pra agilizar? Te mando o orçamento pronto pra você só repassar."* |
| **"Me liga depois"** | desinteresse momentâneo | *"Combinado. Melhor [dia] de manhã ou de tarde? Já anoto pra não incomodar fora de hora."* |

Adapte a objeção provável ao tier e ao ramo (ex.: serralheria reclama de durabilidade de
disco; marcenaria reclama de acabamento de lixa).

## Modo HUNTER — roteiro de visita presencial (modo secundário)

Mesma inteligência de carteira, **saída diferente**: em vez de roteiro de ligação, gere um
**roteiro de visita**. Diferenças:

- Agrupe por **cidade/região da visita do dia** (o Hunter se desloca; use a cidade, e quando
  houver `lat/lng` em `route_visits`, ordene por proximidade — v2 fará a roteirização fina).
- Para cada cliente, em vez de "abertura ao telefone", produza:
  - **Objetivo da visita** (recuperar / expandir mix / apresentar lançamento).
  - **O que levar/mostrar** (amostra de [categoria ausente], tabela, catálogo da linha).
  - **Pergunta-chave presencial** (ver o estoque/bancada do cliente é uma vantagem da visita:
    *"deixa eu dar uma olhada no que vocês usam hoje"*).
  - **Meta da visita** (pedido na hora, agendar entrega, fechar afiação).
- Objeções: mesmas do catálogo acima, com a vantagem de demonstração presencial.

> v1 foca no Farmer (ligação). O modo Hunter está aqui para quando o usuário pedir
> explicitamente "roteiro de visita" / "plano do vendedor externo".
