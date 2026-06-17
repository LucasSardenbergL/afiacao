# Projeto Verificado Sayerlack — design

> Spec de produto/estratégia. Combate ao **desvio de especificação** de acabamentos Sayerlack (pintor/marcenaria aplica tinta automotiva ou de concorrente imitando só a cor) **fundido** ao **programa de relacionamento com arquitetos** — num único objeto: o **Projeto Verificado**.
>
> Origem: brainstorming founder (Lucas) + 3 rounds de consulta adversária ao Codex (gpt-5.5, reasoning alto, com pesquisa web). Convergência dos três rounds registrada abaixo.

---

## 1. Problema

Arquitetos/designers (**especificadores**) definem uma cor/acabamento Sayerlack para um projeto. A especificação passa para a **marcenaria**, que contrata (ou tem internamente) um **pintor**. Na execução, é comum o pintor/marcenaria **substituir o produto especificado** por tinta automotiva (PU/poliéster) ou laca/verniz de concorrente mais barato, **imitando apenas a cor**. O especificador e o cliente final acreditam ter recebido Sayerlack, mas não receberam.

Três dores, hoje com peso parecido (confirmado pelo founder):
1. **Perda de venda** — a substituição tira faturamento do Colacor/Oben e da Renner Sayerlack.
2. **Confiança do especificador traída** — a recomendação do arquiteto é usada e desrespeitada; risco reputacional dele e da marca.
3. **Cliente final enganado** — durabilidade/qualidade/garantia diferentes do que foi especificado.

A substituição é **economicamente motivada** (substituto mais barato, às vezes seca mais rápido) e **quase invisível a olho nu** porque só a cor é copiada.

### Contexto que define a solução

- **Colacor/Oben é distribuidora regional** da **Renner Sayerlack** (maior fabricante de tintas/vernizes para madeira da América Latina; a marca já mira indústria moveleira, marceneiro, arquitetos, designers, consumidor). **Fabricante é Renner Sayerlack — não Sherwin.**
- **O Colacor opera o Sayersystem localmente** — o sistema tintométrico automatizado da Sayerlack (+8.000 cores dosadas por projeto). Logo, **toda cor genuína nasce de um evento de dosagem registrado pelo Colacor**: fórmula, base, corantes, volume, comprador, data. Este é o **ativo único** (moat) do Colacor — nenhuma marca de móveis tem o equivalente. Tabelas relacionadas já existem no app: `tint_formulas`, `tint_corantes`, `tint_bases`, `tint_skus`, `tint_produtos`.
- **O Colacor tem relacionamento direto com especificadores** (confirmado) — o ciclo de fiscalização pode fechar.
- App B2B já existe (**Afiação**) com módulo tintométrico (12 páginas) e portal Sayerlack (que é o canal de **compra** Colacor↔Sayerlack — `pedido_compra_sugerido` —, **não** a relação com o especificador).

---

## 2. Tese central (o que estamos construindo)

**Não vamos criar um "programa de comissão para arquiteto" nem prometer "prova antifraude definitiva".** Vamos criar um programa de **especificação protegida** ancorado num objeto único:

> **Projeto Verificado = especificação rastreada + compra/dosagem compatível + evidências de execução + garantia condicionada.**

Reposicionamento honesto (decisão travada): o produto é **"aceite técnico rastreado para acabamento Sayerlack em madeira"**, não "garantia antifraude". O Colacor é o **operador técnico e registrador**, não a seguradora do acabamento.

### Por que isto e não outra coisa

- **Prova química em campo é teatro** para o caso de uso. Colorímetro mede só a **cor** (imitável). FTIR/Raman/NIR forense (ASTM E2937) é real, mas caro, laboratorial e não-operável por leigo; serve como auditoria de escalada, não como produto. **Prova 100% só com taggant na fórmula** — e isso depende da Renner (longo prazo).
- **O ledger de dosagem é um moat forte, mas prova incompleta.** Ele prova que *produto genuíno foi dosado/comprado para um contexto* — **não prova sozinho que foi aplicado naquela peça**. Por isso o desenho é uma **escada de evidências** que torna o desvio **mais difícil, mais visível e mais caro**, deslocando o fraudador para fora da carteira dos especificadores que cobram conformidade.
- **O motor de adoção não é ética — é dinheiro indireto.** O gatilho mais forte é a **retenção de pagamento pelo cliente final**, ancorada numa **cláusula de aceite** que o arquiteto coloca no contrato: o cliente segura os últimos 3–5% (ou a última parcela) até o certificado ficar verde. A marcenaria/pintor só recebe 100% se entregar a evidência mínima.

### Decisões travadas pelo founder

1. **Arquiteto 100% limpo.** Zero cash/pontos/prêmio/viagem/cashback ao arquiteto por especificar, por NF, por volume ou por conversão. Risco material sob **CAU / Lei 12.378** ("locupletar-se ilicitamente às custas do cliente"; reserva técnica/comissão por indicação é conduta vedada). O valor para o arquiteto é **não-financeiro** (ferramentas, reputação, verificação) **ou** um fee cobrado do **cliente final dele**, transparente, fora da NF do fabricante.
2. **Objetivo = escada de evidências** ("rastreabilidade com consequência comercial"), não prova antifraude definitiva.

---

## 3. Os 4 papéis (o loop)

O objeto é único, mas **as interfaces e incentivos são diferentes por papel** — não vender a mesma tela para todos.

| Papel | O que ganha | O que NÃO pode existir |
|---|---|---|
| **Arquiteto / especificador** | proteção reputacional + ferramenta de cobrança contra o executor; amostra acabada no substrato em ≤72h com aceite digital; memorial técnico + cláusulas de aceite prontas; relatório de não-conformidade; dashboard de verificação | qualquer valor/ponto/brinde relevante/viagem/prêmio/desconto pessoal atrelado a especificação, venda, NF, volume ou conversão (= RT, vedado). "Leads de obra" para o arquiteto é **benefício oco** num distribuidor regional → **descartado** como promessa central |
| **Marcenaria** (compradora real da tinta) | preço/prazo/prioridade de balcão/verba de retoque/leads — **via contrato mercantil claro**, **condicionados a compra genuína vinculada + evidência completa + NPS** | rebate "disfarçado" sem contrato/documentação |
| **Pintor / aplicador** (executor) | status de aplicador certificado (lista, indicação por marcenarias, treinamento, prioridade em suporte); eventualmente bônus por projeto auditado — como **programa técnico/comercial de aplicador**, nunca roteado pelo arquiteto | pagamento via arquiteto; selo sem auditoria |
| **Cliente final** (auditor/beneficiário) | certificado + QR; garantia/assistência de conformidade condicionada; checklist de aceite; canal de contestação | — |

**Como o arquiteto ganha dinheiro de forma limpa (existe):** ele oferece ao **cliente final dele** um item separado — *"gestão e fiscalização de especificação de acabamentos de madeira"* — fee fixo ou por escopo, na nota/contrato do próprio arquiteto, que **não varia** por volume de tinta, NF, fornecedor escolhido ou compra efetivada. O programa fornece a ferramenta (memorial, amostra, checklist, certificado, relatório) que torna esse fee defensável. Funciona mesmo com a marcenaria comprando a tinta, porque o serviço vendido não é intermediar compra — é especificar, controlar evidências e proteger o interesse do cliente. **Requer validação jurídica** (ver §8), mas é conceitualmente muito mais limpo que RT.

---

## 4. Anatomia do Projeto Verificado (modelo de dados conceitual)

Entidades do núcleo (o detalhe físico de tabelas/migrations fica para o plano de implementação):

- **Projeto** — `project_id` (curto, vira QR), arquiteto, cliente final, marcenaria, pintor, ambiente, área estimada, sistema Sayerlack especificado (produto + cor/código + brilho + fundo + catalisador + diluente), **faixa** de consumo esperado, status.
- **Especificação** — o sistema técnico completo escolhido (não só a cor). Gera o **memorial** anexável e as **cláusulas de aceite**.
- **Vínculo de dosagem** — liga o `project_id` a um ou mais **eventos de dosagem** do Sayersystem (fórmula, base, corantes, volume, comprador, data, NF/lote). No MVP, vínculo **manual assistido** no balcão (ver §6).
- **Batch de dosagem** — cada dosagem vira um "batch" com etiqueta **QR na lata**. Pode ser **pai** de alocações para vários projetos (rateio por litros/%).
- **Evidências de execução** — fotos (embalagem/lote aberta no local, substrato antes, aplicação, peça final), assinatura do aplicador, aceite do cliente.
- **Certificado** — agrega tudo e expõe um **status semáforo**.
- **Contestação** — aberta pelo cliente/arquiteto; coloca o projeto em revisão.

### Status do certificado (semáforo — nunca "aprovado/reprovado" binário)

| Cor | Significado |
|---|---|
| 🟢 **Verde** | especificação registrada + dosagem genuína vinculada com **consumo compatível** (dentro da faixa) + evidências mínimas completas |
| 🟡 **Amarelo** | parcialmente comprovado — falta evidência, consumo na borda da faixa, ou vínculo "de estoque rastreado" em vez de "dosado para o projeto" |
| 🔴 **Vermelho** | incompatível — sem compra/dosagem vinculada, volume grosseiramente abaixo do esperado, ou contestação aberta |

**Consumo esperado é faixa de plausibilidade, não cálculo exato.** Rendimento em madeira varia por substrato, lixamento, seladora, primer, bordas, método (spray/pincel), perdas, nº de demãos e habilidade. Regra: se o projeto pede ~20 L e aparecem 3 L → alerta forte (vermelho/amarelo). Se pede ~20 L e aparecem 16 L → **não prova nada** (verde/amarelo conforme evidências). Usar **bandas amplas**.

---

## 5. Garantia → "Assistência de Conformidade Colacor"

O Colacor **não** banca "garantia de acabamento" sozinho — a exposição é ruim (o custo do produto é mísero perto de refazer móvel, mão de obra, prazo, desmontagem, conflito; e o acabamento depende de variáveis fora do controle do Colacor que a própria ficha técnica Sayerlack ressalta). **CDC torna oferta de garantia vinculante** → a redação é jurídica (ver §8).

O que o Colacor consegue oferecer **sozinho**, crível, sem virar passivo perigoso:
- **Suporte técnico prioritário** para projeto verificado.
- **Laudo/relatório de conformidade documental** (especificação, dosagem, NF/lote, fotos, responsáveis, lacunas) — vale como **prova em disputa**.
- **Mediação técnica** entre cliente, marcenaria e pintor.
- **Reposição limitada de produto** apenas para falha **atribuível ao Colacor** (erro de dosagem, divergência de fórmula, produto defeituoso fornecido), com **teto**.
- **Kit de retoque limitado** (cortesia comercial) se o protocolo foi cumprido e o problema é pequeno.
- **Encaminhamento qualificado à Renner/Sayerlack** quando depender do fabricante.

Texto honesto de referência (a ser revisado por jurídico):
> "O Projeto Verificado não comprova quimicamente o filme aplicado. Ele comprova especificação registrada, compra/dosagem Sayerlack compatível e evidências declaradas de execução. A cobertura Colacor limita-se a suporte técnico, mediação e correção de falhas atribuíveis ao produto fornecido/dosado pela Colacor, conforme avaliação técnica. Não cobre substituição por produto de terceiros, preparo inadequado, aplicação fora de boletim técnico, substrato incompatível ou ausência de evidências."

---

## 6. Operacional do Project ID (fricção é fatal — o peso fica no Colacor)

Fluxo mínimo de captura:
1. Arquiteto/Colacor cria o `project_id` por **link/WhatsApp**.
2. Afiação gera **QR + memorial**.
3. Marcenaria faz o pedido citando "usar PID ABC123".
4. **Operador do balcão** seleciona/escaneia o PID no Afiação **no momento da dosagem**.
5. Se o Sayersystem for software **separado**, o vínculo inicial é **manual assistido**: registro da fórmula/volume/cliente/cor + NF/lote (foto do comprovante). Depois evolui para **import CSV/batch diário** se o Sayersystem exportar.
6. A lata recebe **etiqueta QR "Batch de Dosagem"**.
7. O pintor fotografa: lata QR + substrato antes + aplicação + peça final (link WhatsApp/PWA, **sem login pesado**).

Casos de borda:
- **Compra para estoque (sem projeto ainda):** "**Carteira de Estoque Rastreado**" por marcenaria — só vale se registrada **no momento da compra** (batch QR, NF/lote, volume, validade). Vínculo posterior é permitido, mas com **selo diferente** ("vinculado de estoque rastreado", não "dosado para este projeto"). **Estoque antigo / vínculo retroativo pós-reclamação não vira verificado** — no máximo "documento apresentado".
- **Uma dosagem para vários projetos:** **rateio por alocação** (litros ou %), batch "pai" → alocações-filhas; soma ≤ volume comprado (tolerância pequena para perda); alocar **antes ou até 48h após** o início da aplicação; depois disso, cai de nível. Para projeto premium: recomendar **dosagem dedicada** sempre que possível.

**Linha de fricção** — aceitável: ~2 min no balcão + 3–4 fotos do pintor + 1 aprovação do cliente. **Fatal:** app obrigatório com senha para o pintor, digitar fórmula manualmente, estimar m² com precisão, exigir consumo exato, fazer o arquiteto perseguir foto.

---

## 7. Escopo do MVP (60–90 dias, distribuidor regional — não plataforma nacional)

Roda **dentro do Afiação**, em cima dos dados do Sayersystem que já existem; concierge humano no piloto.

**Entra:**
- `project_id` / QR + cadastro simples de projeto (arquiteto, cliente, marcenaria, pintor, cor/acabamento, ambiente, área, faixa de consumo).
- Memorial técnico + cláusulas de aceite.
- Amostra acabada aprovada pelo cliente (aceite digital).
- **Vínculo manual assistido** de dosagem/NF/lote/fórmula no Afiação.
- QR por batch/lata.
- Coleta de **4 evidências** via link WhatsApp/PWA.
- Certificado **verde/amarelo/vermelho** com linguagem honesta.
- Contestação do cliente + relatório de conformidade.
- **Assistência Colacor limitada e com teto.**
- Benefícios comerciais **só para marcenaria/pintor**, condicionados ao protocolo.

**Sai (explicitamente fora do MVP):**
- Cashback/pontos/qualquer benefício ao arquiteto por compra.
- Garantia ampla de acabamento.
- Prova antifraude química / laboratório / taggant.
- Consumo exato como critério forte.
- Retroverificação de estoque antigo.
- Marketplace de leads, ranking público complexo, rebate automático.
- BIM completo, app pesado para pintor, CRM enterprise.
- **Integração profunda com o Sayersystem no dia 1** (começa manual assistido).

### Sequência de onboarding (quem puxa a cadeia)

A tração nasce no **arquiteto premium que já sofre com execução ruim** + cliente final — os únicos com incentivo natural para exigir conformidade. **Não** começar por marcenaria genérica.

1. Selecionar **10–20 arquitetos premium** com histórico de dor de execução.
2. Vender o pacote: amostra 72h + memorial + proteção reputacional + aceite.
3. Colocar **cláusula de Project ID** nos próximos projetos desses arquitetos.
4. Onboardar **as marcenarias desses projetos** (não marcenarias avulsas).
5. Treinar o **balcão Colacor** e criar a rotina de etiqueta QR.
6. Certificar os **pintores** usados por essas marcenarias.
7. Rodar **30–50 projetos** com concierge humano.
8. Medir: adesão, fotos completas, disputas, recompra Sayerlack, custo de suporte, conversão de amostra em pedido.

---

## 8. Pendências (devem ser resolvidas — não bloqueiam começar a construir o núcleo)

1. **Jurídico — fee do arquiteto:** validar a estrutura "gestão e fiscalização de especificação" cobrada do cliente final como item próprio do arquiteto (não recair em RT sob CAU/Lei 12.378).
2. **Jurídico — termos da Assistência de Conformidade:** redação vinculante sob CDC; tetos; o que é/não é coberto.
3. **Unit economics:** custo de visita/laudo/kit de retoque/amostra 72h — qual o envelope que o Colacor sustenta no piloto.
4. **Dados do Sayersystem:** confirmar o que é **exportável** (CSV/batch) e em que cadência; definir o caminho do "manual assistido" → "import".
5. **Renner Sayerlack (pós-piloto, com números):** levar `Project ID` nacional no Sayersystem, QR de lote/dosagem, cofinanciamento de amostra/showroom, garantia estendida do fabricante e — longo prazo — **taggant** na fórmula. **O MVP não espera a Renner.**

### Métricas para o dossiê da Renner
% de projetos especificados que viraram dosagem genuína · casos de desvio detectado/evitado · ticket médio por projeto verificado · adesão de arquitetos e marcenarias · pedidos de garantia/contestação · evidência de que o Colacor está protegendo a reputação Sayerlack.

---

## 9. Procedência desta spec

- **Round 1 (Codex):** 5 famílias de solução; passaporte digital + prova de compra como melhor impacto×viabilidade; taggant/forense como longo prazo/teatro de campo; lista do que não funciona (QR isolado, curso sem auditoria, blockchain, app pesado).
- **Round 2 (Codex, crítica adversária da fusão):** validou a fusão como tese; cravou que o ledger é âncora de **compra/dosagem, não de aplicação**; refinou para loop de 4 papéis; confirmou risco CAU; ajustou o objetivo para escada de evidências.
- **Round 3 (Codex, fechamento das 4 fragilidades):** motor = retenção de pagamento + cláusula de aceite; "leads para arquiteto" descartado; garantia → Assistência de Conformidade com teto; fee limpo do arquiteto via cliente final; operacional do Project ID (estoque rastreado, rateio, linha de fricção); reposicionamento final = "aceite técnico rastreado".
- Precedentes citados pelo Codex (web): CAU/RS sobre reserva técnica; CDC sobre garantia vinculante; ficha técnica Sayerlack sobre variáveis de aplicação; programas Lutron Preferred Pro e Pentair TradeGrade (garantia + treinamento + diretório + canal protegido como benefícios reais de execução).
- Pesquisa do ChatGPT (2 PDFs) aproveitada no princípio **compliance-by-design** (separar quem prescreve de quem executa/revende; zero RT disfarçada) e adaptada: o material era furniture-cêntrico (cliente do arquiteto paga procurement fee); em coatings **quem compra a tinta é a marcenaria**, então o lever forte do Colacor é **verificação + economics de canal**, não procurement fee.

**Caveat de fidelidade:** o Codex recebeu resumos fiéis (curados pelo agente) do código do app e dos PDFs, mais sua própria pesquisa web — não leu o repositório nem os PDFs crus diretamente. A leitura da fonte original (módulo tintométrico, portal Sayerlack, 12+3 páginas dos PDFs) foi feita pelo agente. Os três rounds convergiram para o mesmo desenho.
