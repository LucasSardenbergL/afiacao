# Contexto Industrial — Grupo Colacor

Conhecimento de domínio para classificar produtos, calcular **mix ausente** e priorizar
cross-sell. É a inteligência que distingue esta skill de um "copy de vendedor genérico".

## As três empresas e suas margens (use para priorizar a oferta)

| Empresa | Negócio | Linhas | Lógica de margem |
| --- | --- | --- | --- |
| **Colacor** | Indústria de abrasivos | lixas, discos, rebolos, flap | Produto próprio → **margem alta**. Empurrar com prioridade. |
| **Oben** | Distribuidora p/ ind. moveleira | ferragens, colas, fita de borda, painel, tintométrico/Sayerlack | Revenda → margem menor, mas **giro e fidelização**. |
| **Colacor SC** | Serviços | afiação de serras/fresas/facas/brocas | Serviço recorrente → **margem alta + adesão**. Quem afia volta sempre. |

**Viés de oferta:** o objetivo da ligação é **ampliar o mix**, não vender 1 item. Ordem geral:
serviço recorrente de alta margem → produto de margem própria → giro. **Mas adapte ao cliente
real** (ver cross-sell de alto retorno abaixo) — não empurre afiação pra quem não corta.

### Cross-sell de alto retorno (aprendido da carteira real, 2026)

1. **EPI é o cross-sell universal.** Quase ninguém compra máscara PFF2 / protetor, e **todos
   lixam e pintam**. Oferta de baixa fricção, alta relevância, aplicável a quase toda a rota.
2. **Completar o sistema de acabamento Sayerlack.** Quem compra base + catalisador mas **não**
   leva seladora/primer/fundo/verniz (ou vice-versa) está comprando a outra metade fora.
   Detectável pela ausência dessas famílias no mix. É o cross-sell de maior valor (Oben).
3. **Lixa para quem pinta mas não lixa com você** (e lixa fina pra quem só compra grão grosso).
4. **Afiação SÓ para quem corta** — madeireiras, marcenarias de produção, metalúrgicas. Para
   pintores/vidraceiros/acabadores, afiação é irrelevante: não ofereça.
5. **Cola** (PVA/contato/cianoacrilato) pra marcenaria que monta mas compra cola fora.

## Mapa de classificação de produtos (descrição → categoria)

Ao ler `produtos_comprados` (string `codigo:descrição`), classifique por palavra-chave
(case-insensitive, sem acento). Um produto pode cair em 1 categoria.

| Categoria | Palavras-chave na descrição |
| --- | --- |
| **lixa_madeira** | lixa folha, lixa madeira, lixa massa, lixa rolo, lixa velcro, lixa d'agua, cinta lixa, lixa grão fino |
| **lixa_metal** | lixa ferro, lixa metal, lixa inox |
| **disco_corte** | disco corte, disco de corte, corte fino, abrasivo corte |
| **disco_desbaste** | desbaste, disco desbaste |
| **disco_flap** | flap, disco flap, lixa flap |
| **rebolo** | rebolo, rebolo reto, rebolo copo |
| **escova_aco** | escova aço, escova rotativa, escova copo |
| **diamantado** | diamantado, disco diamantado, serra diamantada |
| **cola_adesivo** | cola, adesivo, cola branca, pva, cola contato, hot melt, cola quente, cola instant |
| **fita_borda** | fita de borda, fita borda, bordo |
| **ferragem** | dobradiça, corrediça, puxador, fecho, suporte, trilho, ferragem |
| **fixacao** | parafuso, bucha, prego, grampo, fixador |
| **painel** | mdf, mdp, painel, chapa, compensado |
| **tintometrico_acabamento** | verniz, seladora, tingidor, fundo nitro, catalisador, thinner, diluente, base tinta, corante, sayerlack, laca |
| **epi** | luva, óculos, máscara, protetor, respirador, epi |
| **afiacao_servico** | afiação, afiar, recondicionamento (serra, fresa, faca de plaina, broca, serra fita) |
| **equipamento** | lixadeira, esmerilhadeira, politriz, máquina, ferramenta elétrica |

Se não casar nenhuma, marque como `outros` e não use no cálculo de mix gap.

### Preferir a coluna `família` (vem na query — é mais exata que parsear o nome)

A query traz `produtos_comprados` como `Descrição [Família]`. **Use a família direto** — mapa real
(auditoria de carteira real, Centro-Oeste MG, 2026):

| Família(s) no banco | Categoria da skill |
| --- | --- |
| Bases MixMachine, Catalisadores PU, Diluente PU, Seladora Nitrocelulose, Vernizes PU, Primer PU, Fundos PU, Laca Vidro/Fundo, Tingidor Concentrado, Concentrados MixMachine/LC, Retardador PU, Isolantes, Thinner (Limpeza/Nitro), Revenda Sayerlack, Cartelas de Cores, Complementos/Preparação | **acabamento_sayerlack** (sistema de pintura PU/nitro) |
| Cintas Estreitas, Folhas de Lixa Seco, Folha de Lixa Ferro, Disco de Lixa Ind, Discos de Lixa, Disco de Fibra, Folha de Não Tecido | **abrasivo_lixa** |
| Cola Branca, Adesivo Cianoacrilato (Almasuper/Akfix), Adesivo de Contato (Formica) | **cola_adesivo** |
| EPI (máscara PFF2, protetor) | **epi** |
| Fitas Crepe/Embalagens, Plástico Bolha, Coador, Pistola/Caneca de Pintura | **acessorio_pintura** |
| Parafuso Chip | **fixacao** |

> **Realidade desta base:** a carteira é **pesada em acabamento Sayerlack + cintas de lixa +
> cola** (marcenarias/vidraçarias que fazem pintura). NÃO é "ferragem/fita de borda" como o mix
> moveleiro clássico. Ajuste a leitura de mix-gap a isso (ver cross-sell abaixo).

## Determinar o ramo do cliente (na prática, pelo NOME)

⚠️ No banco real, `cnae` e `customer_type` vêm quase sempre vazios/"domestic" — **não confie
neles**. O ramo se infere **do nome do cliente** (razão social), que costuma ser explícito. Mapa:

| Pista no nome | Ramo |
| --- | --- |
| `MARCENARIA`, `MOVEIS`, `MÓVEIS`, `MOVELARIA`, `PLANEJADOS` | marcenaria / moveleiro |
| `MADEIREIRA`, `MADEREIRA`, `MADEIRAS` | madeireira (revende madeira; compra lixa/abrasivo, afiação de serra) |
| `VIDROS`, `VIDRAÇARIA`, `TEMPERADO`, `BOX` (+ "box"/banheiro) | vidraçaria |
| `ESQUADRIAS`, `ALUMINIO`, `ALUMÍNIO`, `SERRALHERIA`, `SERRALERIA`, `METALICA` | esquadria de alumínio / serralheria |
| `CALHA`, `FUNILARIA`, `ACABAMENTOS` (metal) | calhas / funilaria |
| `TAPECARIA`, `ESTOFADOS` | tapeçaria / estofado |
| `PINTOR`, `PINTURA`, `TINTAS` | pintura / acabamento |
| `MARMORARIA`, `GRANITO`, `MARMORE` | marmoraria |
| `METALURGICA`, `USINAGEM`, `TORNO`, `CALDEIRARIA` | metalúrgica |
| nome de pessoa física, sem pista | cliente difuso — infira pelo que já compra |

Use o nome primeiro; o que ele já compra confirma. Ex.: "PINTOR E ARTE EM VIDROS" → vidraçaria
+ pintura; "MÓVEIS E ESQUADRIAS DE ALUMÍNIO" → móveis + esquadria de alumínio (mix duplo).

## Mix esperado por ramo de cliente (o coração do cross-sell)

Determine o ramo pelo **nome** (acima); `customer_type`/`cnae` só se preenchidos. O **mix
ausente** = categorias esperadas do ramo que **não** aparecem no que ele compra.

| Ramo do cliente | Mix esperado (categorias) | Gatilho clássico de cross-sell |
| --- | --- | --- |
| **Marcenaria / movelaria pequena** | lixa_madeira, cola_adesivo, fita_borda, ferragem, tintometrico_acabamento, afiacao_servico | Compra só lixa → falta **cola, ferragem, acabamento e afiação de serra/fresa**. |
| **Indústria moveleira (média/grande)** | lixa_madeira (rolo/cinta), cola_adesivo, fita_borda, ferragem, painel, tintometrico_acabamento, afiacao_servico, fixacao | Compra abrasivo de produção → oferecer **afiação industrial + acabamento Sayerlack**. |
| **Serralheria / estrutura metálica** | disco_corte, disco_desbaste, disco_flap, lixa_metal, rebolo, escova_aco, epi | Compra só disco de corte → falta **flap, lixa metal, rebolo, escova, EPI**. |
| **Metalúrgica / usinagem** | rebolo, disco_corte, disco_flap, lixa_metal, afiacao_servico, equipamento | Oferecer **afiação de ferramenta + rebolo + flap**. |
| **Esquadria de alumínio / vidraçaria** | disco_corte (alumínio), disco_flap, lixa_metal (fino), fixacao (rebite/parafuso), epi, afiacao_servico (serra de alumínio) | Compra disco → falta **lixa fina, EPI, fixação e afiação da serra de corte de alumínio**. |
| **Madeireira (revenda de madeira)** | lixa_madeira, afiacao_servico (serra/disco), disco_corte, equipamento | Oferecer **afiação de serra/disco de bancada + lixa** — quem corta madeira o dia todo cega lâmina rápido. |
| **Marmoraria / vidraçaria** | diamantado, disco_corte, rebolo, lixa (polimento), epi | Oferecer **diamantado + polimento + EPI**. |
| **Construção / pintor / loja de tintas** | tintometrico_acabamento, lixa_madeira (massa/parede), epi | Oferecer **tintométrico + lixa de massa + EPI**. |
| **Loja / revenda de ferragens** | mix amplo de todas as linhas | Foco em **giro**: cobrir buracos do sortimento (o que não recompra há tempo). |

> Quando o ramo for desconhecido, infira pelo mix atual: quem compra disco de corte é
> metal/serralheria; quem compra fita de borda + cola é moveleiro; quem compra verniz é
> acabamento. Nunca ofereça lixa de metal pra marcenaria nem fita de borda pra serralheria.

## Critérios de queda (idem à query SQL — explique sempre em linguagem humana)

- 🔴 **Queda crítica**: `dias_desde_ultima > 2 × intervalo_medio` **ou** `> 90 dias` sem comprar.
  Falar: *"faz 70 dias que o sr. não faz pedido — normalmente compra a cada 30. Aconteceu algo?"*
- 🟡 **Alerta**: atraso entre 1,5× e 2× o intervalo, **ou** faturamento dos últimos 60 dias <
  60% da média histórica. Falar: *"notei que o movimento de vocês caiu nas últimas semanas..."*
- 🟢 **Em dia**: dentro do ritmo — entra como expansão de mix ou follow-up, não recuperação.
- 🟣 **Dormente** (`> 365 dias` sem comprar): sumido há mais de um ano. **NÃO é call da semana** —
  vai pra uma **lista de reativação** à parte. Muitos compraram 1x num lote antigo (ex.: dados
  `importado` de 2020) e nunca voltaram. Tratar como campanha separada, não como queda recente.
- ⚪ **Nunca comprou** (carteira sem pedido): ativação — apresentar o portfólio, entender o ramo.

> **Por que separar dormente de queda:** com 6 anos de histórico (`importado` de 2020+), o sinal
> "atraso > 2× intervalo" sozinho marca como crítico quem comprou uma vez em 2020. Sem o corte de
> 365 dias, o plano mandaria a Farmer ligar como prioridade pra quem sumiu há 6 anos. Crítico/
> alerta = escorregando agora (recuperável); dormente = perdido faz tempo (reativação eventual).

## Sazonalidade e ganchos (use com parcimônia, só quando real)

- **Moveleiro**: aquece pré-fim de ano (móveis sob encomenda) e queda em janeiro. Obra/reforma
  aquece após chuvas (abril+).
- **Metal/serralheria**: ligado a obras — segue o calendário da construção.
- **Afiação**: demanda contínua; bom gancho de recorrência ("manda as serras essa semana que
  devolvo afiadas pra próxima").
- Não invente promoção ou data comemorativa que você não tem certeza que existe.

## Glossário rápido

- **Mix ausente / mix gap**: categorias que o ramo costuma comprar mas este cliente não compra.
- **Cross-sell**: oferecer categoria nova ao cliente (ampliar mix).
- **Up-sell**: trocar por item de maior valor/qualidade na mesma categoria.
- **Intervalo médio de recompra**: dias médios entre pedidos do cliente (base do sinal de queda).
- **Recência**: dias desde a última compra.
- **Reativação**: trazer de volta cliente sumido (>90d ou >2× intervalo).
- **Carteira**: conjunto de clientes das **cidades que uma Farmer atende** (cada Farmer é dona de
  certas cidades). Os compradores reais vêm de `sales_orders`, consolidados por CNPJ. (A
  atribuição por vendedor do Omie existe no banco mas está desconectada das vendas — não usar.)
