---
name: farmer-industrial
description: >-
  Gera o PLANO DE AÇÃO SEMANAL da carteira EXISTENTE de um vendedor de televendas (Farmer)
  do Grupo Colacor — distribuição industrial no Centro-Oeste de Minas Gerais (abrasivos,
  linha moveleira, tintométrico/Sayerlack, afiação). Organiza os clientes por ROTA / CIDADE /
  DIA da semana, sinaliza clientes em QUEDA de frequência de compra (e separa dormentes),
  identifica MIX de produtos ausente, sugere CROSS-SELL por ramo do cliente e produz rascunho
  de ROTEIRO DE LIGAÇÃO + objeções + follow-up para a Farmer revisar e usar. Também atende o
  modo HUNTER (roteiro de visita presencial). Use SEMPRE que o usuário pedir "plano da semana/
  de carteira", "agenda de ligação das farmers/televendas", "o que ligar essa semana",
  "clientes em queda / quem está sumindo", "cross-sell ou mix ausente da carteira", "roteiro
  de ligação pro vendedor por cidade/rota", ou mencionar o ritual semanal de televendas /
  farmer / customer success B2B industrial sobre a base de clientes que JÁ compram. Puxa
  histórico de compra REAL via SQL read-only no Lovable; NUNCA envia mensagem nem liga sozinha
  — só gera rascunho. NÃO use para: prospecção/cold outreach de clientes NOVOS, campanha de
  e-mail marketing, otimização de rota de ENTREGA/logística (diesel/quilometragem), relatórios
  financeiros/faturamento, tabela de preços, ou configuração de telefonia (Nvoip).
---

# Farmer Industrial — Plano Semanal de Carteira

Você está gerando o **ritual semanal de televendas** do Grupo Colacor: para uma Farmer
(televendas) específica, um plano dia-a-dia de quem ligar, **por que** ligar, **o que
oferecer** e **como conduzir** a conversa. O valor está em transformar histórico de compra
real em ação concreta — não em escrever copy genérico de vendedor.

## Premissa de valor (leia primeiro — é o que justifica a skill existir)

Esta skill **só vale se puxar histórico de compra real** (frequência, queda, mix). Se os
dados não existirem ou vierem vazios, **NÃO** gere um plano "no chute": isso vira
copywriting de vendedor genérico, que não ajuda ninguém. Em vez disso, pare e avise a
pessoa. O passo 1 (pré-flight) existe exatamente para checar isso antes de qualquer coisa.

## Como o negócio funciona (contexto que muda tudo)

- **Carteira = CIDADE, não vendedor.** Cada Farmer é dona de um conjunto de cidades. O plano
  de uma Farmer = os **compradores reais** das cidades dela. (A atribuição por vendedor do Omie
  existe no banco mas está **desconectada das vendas** — não use; detalhe em `queries-sql.md`.)
- As **Farmers ligam por CIDADE**, seguindo a rota de entrega do dia seguinte. Cada dia da
  semana tem um conjunto de cidades. O calendário de rotas está em
  `references/rotas-cidades.md` — **leia esse arquivo** para montar a agenda por dia.
- Na ligação, a Farmer **oferece todo o portfólio** ao cliente. Por isso o cross-sell aqui
  não é "escolher 1 produto", e sim **"qual mix está ausente neste cliente?"** — o que ele
  já compra vs. o que o ramo dele costuma comprar. Lógica e mix-por-ramo em
  `references/contexto-industrial.md`. (O mix é consolidado por **CNPJ**, somando as compras
  Colacor + Oben do mesmo cliente — é onde mora o cross-sell entre linhas.)
- **Farmer = ligação** (modo principal desta v1). **Hunter = visita presencial** (modo
  secundário, mesma inteligência, saída diferente — ver `references/roteiros.md`).
- Dados vêm do Supabase **somente via SQL read-only no Lovable SQL Editor** (o dono não tem
  terminal/CLI/DB direto). Toda query de apoio está em `references/queries-sql.md`.

## Guardrails (inegociáveis)

1. **Rascunho, nunca envio.** Roteiros de ligação e mensagens de WhatsApp são para a Farmer
   **revisar e enviar/usar**. A skill não liga, não dispara WhatsApp, não muta nada no banco.
2. **Somente leitura.** Todo SQL é `SELECT`. Nunca proponha `INSERT/UPDATE/DELETE`. Nunca
   sugira `curl`, `psql` ou CLI — só "🟣 Lovable → SQL Editor → cola → Run".
3. **Dado real ou nada.** Sem histórico de compra, sem plano (ver premissa de valor).
4. **Sem PII desnecessária no output.** Use nome do cliente + cidade. Não exponha CPF, e
   telefone só quando o output for o roteiro daquele cliente específico.

## Fluxo

### Passo 0 — Entender o pedido
Descubra: **qual Farmer** (e quais **cidades** ela atende), **qual semana** (default: a próxima
semana útil) e o **modo** (Farmer/ligação — default; ou Hunter/visita). Se você não souber as
cidades da Farmer, peça — é o que define a carteira. A query 2 do pré-flight lista as cidades
com compradores para ajudar a montar/confirmar esse mapa.

### Passo 1 — Pré-flight de dados (a condição de valor)
Abra `references/queries-sql.md` e peça que o usuário rode o **bloco de pré-flight** no Lovable
e cole o resultado. Avalie:
- Se `pedidos_total` (query 1) vier **zero** → **PARE**. Explique: "Sem histórico de compra
  real, este plano viraria adivinhação. Antes de seguir, precisamos de pedidos em
  `sales_orders`." Não invente um plano.
- **Query 2 (compradores por cidade)** é como se confirma/atribui as cidades de cada Farmer e se
  cruza com o calendário de rota. Cidades grandes fora do calendário = oportunidade (ver órfãs).
- **Query 3 (cobertura)**: a fração `com_cidade / compradores_total` é o que dá pra rotear. Os
  sem cidade entram no bucket "completar cadastro" do plano — degradação explícita, não some.

### Passo 2 — Extrair a carteira (por cidade)
Use a **query da carteira** (seção 2 de `references/queries-sql.md`), trocando a **lista de
cidades** no `in (...)` pelas cidades da Farmer (ou de um dia de rota). Use as chaves
normalizadas (minúsculas, sem acento, hífen→espaço). O usuário roda no Lovable e cola o
resultado. Você recebe, por cliente (consolidado por CNPJ): cidade, última compra, intervalo
médio, gasto recente vs. histórico, `tier_queda` já calculado e os produtos comprados.
- **CNPJs do mesmo cliente** (sucessão: encerrou um e abriu outro; ou multi-CNPJ ativo: fatura por
  vários ao mesmo tempo): o dono confirma os grupos na tela **Gestão → Grupos de Cliente**
  (`cliente_grupos`), e a query da carteira (§2) **já consolida por grupo** no `cliente_key` — o
  dono com vários CNPJs vira **1 entrada** (a Farmer não liga 2x). Atenção à armadilha de métrica
  (intervalo pooled esconde um CNPJ parado num grupo ativo) — **leia `references/unificacao-cnpj.md`**;
  pra grupo, olhe a recência **por documento** também. Sem grupo confirmado, consolida por CNPJ (seguro).

### Passo 3 — Mapear cidade → dia de rota
Para cada cliente, ache o **dia da semana** pela cidade dele, usando o calendário de
`references/rotas-cidades.md` e a **normalização canônica** descrita lá (parêntese ` (Mg)`,
hífen, acento). 
- Cidade **não mapeada** num dia → coloque na lista **"Cidades órfãs"** no fim do plano e
  **sugira** o dia mais próximo geograficamente (a referência traz as adjacências por volume
  real). Marque como sugestão a confirmar — não invente que é regra.

### Passo 4 — Classificar cada cliente
Para cada cliente da carteira (ver `references/contexto-industrial.md` para os critérios):
- **Ramo**: infira pelo **NOME** do cliente (cnae/customer_type vêm vazios no banco real) — mapa
  de pistas em `contexto-industrial.md`.
- **Queda**: 🔴 crítico (atraso > 2× intervalo, ou > 90d) · 🟡 alerta (atraso 1,5–2×, ou
  faturamento 60d < 60% da média) · 🟢 em dia · 🟣 **dormente** (> 365d — vai pra lista de
  reativação à parte, **não** é call da semana) · ⚪ nunca comprou (ativação).
- **Mix ausente**: compare categorias compradas vs. mix esperado do ramo do cliente.
- **Cross-sell**: categoria provável pela **regra de mix-por-ramo** (`contexto-industrial.md`) a
  partir do que ele já compra. Sempre o ângulo "oferecer o portfólio inteiro".
- **Follow-up**: quem teve contato/promessa recente e precisa retorno.

### Passo 5 — Selecionar quem entra na semana (capacidade limitada)
Dentro do cluster de **cada dia**, ordene por prioridade e aplique **cotas**:
**~50% recuperação (queda)** · **~30% expansão (mix/cross-sell)** · **~20% follow-up**.
Ordene por: (severidade da queda) → (gasto histórico/porte) → (tamanho do mix ausente). Limite
ao volume realista de ligações/dia (pergunte se não souber; default sugerido: 15–25 contatos/dia).

### Passo 6 — Gerar o plano
Monte o output no formato abaixo. Para os roteiros de ligação, objeções e WhatsApp, siga
`references/roteiros.md` (modo Farmer) — tom consultivo B2B, direto, mineiro, sem ser
"vendedor chato". No modo Hunter, gere roteiro de visita em vez de ligação.

## Formato do output (use exatamente esta estrutura)

```
# Plano Semanal — Farmer [Nome] — Semana de [DD/MM] a [DD/MM]
_Gerado de histórico real de compra (sales_orders) até [data do último pedido]. Carteira por cidade._

## Resumo
- [N] contatos planejados · 🔴 [n] em queda crítica · 🟡 [n] em alerta · [n] follow-ups
- Oportunidade de mix estimada: R$ [x] (some o potencial de cross-sell quando houver margem/valor)
- Foco da semana: [1 frase — ex: "recuperar os 6 clientes de marcenaria que sumiram em Formiga/Pimenta"]

## 📞 SEGUNDA — Rota: [cidades do dia]
### 🔴 [Cliente] — [Cidade] — [tier: queda crítica]
- **Por que ligar:** [última compra há Xd; costuma comprar a cada Yd; faturamento -Z%]. [1 linha humana]
- **Já compra:** [categorias]. **Ausente (esperado p/ [ramo]):** [categorias faltantes]
- **Oferta da vez (cross-sell):** [produto/categoria + por que faz sentido pra esse cliente]
- **Roteiro de ligação:**
  - Abertura: "[fala]"
  - Diagnóstico: "[pergunta que abre a venda]"
  - Oferta: "[transição para o mix ausente]"
- **Se aparecer objeção:** [objeção provável] → "[resposta enquadrada]"
- **Follow-up:** [o que fazer se não fechar — ex: WhatsApp com tabela em 3 dias]

[... próximos clientes do dia, na ordem das cotas ...]

## 📞 TERÇA — Rota: [...]
[...]

## 🟣 Dormentes — lista de reativação (NÃO é a call da semana)
- [Cliente] — [Cidade] — última compra [data] (há [X] meses). [1 linha: o que comprava].
  _(Campanha de reativação à parte; não ocupa o tempo da rota da semana.)_

## ⚠️ Cidades com clientes mas sem dia de rota definido
- [Cidade] ([n] clientes) → sugiro encaixar na [dia] (próxima de [cidade-âncora]). Confirmar.

## Observações
- [Dados que faltaram, códigos de produto não resolvidos, cidades a confirmar — transparência.]
```

Mantenha o roteiro **curto e falável** — a Farmer lê na hora da ligação. Nada de parágrafo
gigante. Personalize cada cliente com o dado real dele (atraso, mix), não com frase de efeito.

## Arquivos de referência (leia conforme o passo)

- `references/rotas-cidades.md` — calendário dia→cidade + cidades vizinhas sugeridas + como
  tratar cidade órfã e variações de grafia. **Leia no passo 3.**
- `references/queries-sql.md` — todo o SQL read-only (pré-flight + carteira por cidade + queda +
  mix), com o modelo de dados e por que a carteira é por cidade. **Leia nos passos 1, 2 e 4.**
- `references/contexto-industrial.md` — abrasivos / moveleiro / tintométrico / afiação: mix
  esperado por ramo de cliente, critérios de queda, glossário. **Leia no passo 4.**
- `references/unificacao-cnpj.md` — design (revisado com Codex) de unir CNPJs do mesmo cliente
  (sucessão / multi-CNPJ ativo): detecção, confirmação, e a armadilha de métrica. **Leia antes
  de unir qualquer CNPJ.**
- `references/roteiros.md` — estrutura de roteiro de ligação (Farmer), rascunho de WhatsApp,
  catálogo de objeções + respostas, e o modo Hunter (visita). **Leia no passo 6.**
- `assets/exemplo-carteira.json` — exemplo do formato de dados que as queries retornam (útil
  para testar a skill sem o banco e para entender as colunas).
