# Calendário de Rotas — Dia da semana → Cidades

As Farmers ligam por cidade, seguindo a rota de entrega do dia seguinte. Hub logístico:
**Divinópolis / Formiga (Centro-Oeste de Minas Gerais)**. Este calendário é a **fonte da
verdade da skill** — o banco NÃO tem mapeamento dia→cidade (confirmado na auditoria do
schema). Quando o dono ajustar as cidades, edite **este arquivo**.

> **Formato real no banco** (auditoria 2026-05-23): a coluna `addresses.city` vem como
> `"Divinopolis (Mg)"`, `"Nova Serrana (Mg)"`, `"Sao Joao Del Rei (Mg)"` — **acento já removido
> na origem**, title-case, e **sufixo ` (UF)` entre parênteses**. (A UF limpa também existe
> separada em `addresses.state`.)
>
> **Normalização canônica** para casar cidade → dia (faça os 5 passos): (1) remova o ` (...)`
> final; (2) minúsculas; (3) remova acentos; (4) troque `-` por espaço; (5) colapse espaços e
> trim. Assim `"Sao Joao Del Rei (Mg)"` e `"São João del-Rei"` viram a mesma chave
> `sao joao del rei`.
> Em SQL: `lower(translate(regexp_replace(trim(city), '\s*\([^)]*\)\s*$', ''),
> 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ-',
> 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC '))` → `divinopolis`, `sao joao del rei`.

## Calendário oficial (confirmado pelo dono)

| Dia | Cidades da rota |
| --- | --- |
| **Segunda** | Formiga · Pimenta · Piumhi · Capitólio |
| **Terça** | Cláudio · Itaguara · Itaúna · Mateus Leme · Pará de Minas |
| **Quarta** | Bom Despacho · **Nova Serrana** · Pitangui · Martinho Campos · Abaeté · Pompéu · Luz |
| **Quinta** | Oliveira (inclui Morro do Ferro) · Ritápolis · São João del-Rei · Santa Cruz de Minas · Tiradentes · Prados |
| **Sexta** | Divinópolis · Carmo do Cajuru |

> **Nova Serrana** (291 clientes — 2ª maior cidade da base) entra na **quarta**, no dia do Bom
> Despacho (confirmado pelo dono em 2026-05-23). É a rota do caminhão, não a distância em linha
> reta (geograficamente fica perto de Divinópolis/sexta, mas a entrega é na quarta).
>
> **Carteira por Farmer:** cada Farmer é dona de **certas cidades** (divisão geográfica). Um
> plano é gerado para o conjunto de cidades de uma Farmer. Quando o dono passar o mapa
> Farmer→cidades, registre-o aqui embaixo. Até lá, gere o plano para as cidades informadas no
> pedido (ou por dia de rota).

### Correções de grafia (confirmadas com o dono em 2026-05-23)
- "Matheus Leime" → **Mateus Leme** (município MG). ✅ confirmado.
- "Martim Campos" → **Martinho Campos** (município MG). ✅ confirmado.
- "Cajuru" → **Carmo do Cajuru** (MG, ao lado de Divinópolis). ✅ confirmado.
- "Morro do Ferro" → **= Oliveira** (confirmado pelo dono em 2026-06-15). Não é município; é
  localidade rural. Trate qualquer cliente "Morro do Ferro" como **Oliveira** (quinta) — na
  normalização, mapeie a chave `morro do ferro` → `oliveira`.

## Cidades órfãs — encaixe por proximidade (dono confirmou que existem, 2026-06-15)

Cidades com cliente que **não** estavam no calendário oficial. O dono confirmou que essas órfãs
existem e **delegou o encaixe por proximidade** — então trate os encaixes abaixo como **válidos**
(não mais "a confirmar"), corrigindo pontualmente se alguma estiver no dia errado. Números =
clientes na base (`addresses`). Duas ainda em aberto: **Passos** (longe — confirmar se é rota de
entrega) e o **bolsão sul** (sem âncora — definir dia ou 6º agrupamento).

- **SEGUNDA (eixo Formiga/Pimenta/Piumhi/Capitólio — SO):** Bambuí (31), Arcos (28), Pains (10),
  Alpinópolis (9). ⚠️ **Passos (192)** é grande mas fica longe (~75 km de Piumhi) — confirmar se
  é rota de entrega mesmo ou cliente de transportadora; pode merecer dia próprio.
- **TERÇA (eixo Cláudio/Itaúna/Mateus Leme/Pará de Minas — L/NE):** São Gonçalo do Pará (19),
  Juatuba (16), Carmo da Mata (15), Itatiaiuçu (9).
- **QUARTA (eixo Bom Despacho/Nova Serrana/Pompéu/Luz — N/NO):** Lagoa da Prata (78),
  Santo Antônio do Monte (58), Perdigão (32, perto de Nova Serrana), Dores do Indaiá (17),
  Araújos (7), Japaraíba (6).
- **QUINTA (eixo Oliveira/São João del-Rei/Tiradentes/Prados — SE, Vertentes):** Dores de Campos
  (33), Lagoa Dourada (29), Barbacena (11), Barroso (10), Resende Costa (8), São Tiago (8).
- **SEXTA (hub Divinópolis/Carmo do Cajuru):** Itapecerica (33), São Sebastião do Oeste.

**🟣 Bolsão SUL sem âncora na rota (~90 clientes):** Campo Belo (33), Perdões (23), Alfenas (14),
Lavras (10), Santo Antônio do Amparo (10). Não têm cidade da rota perto — **decisão do dono**:
6º agrupamento próprio, ou encaixar na quinta (Oliveira é o mais perto). Hoje pode ser ponto cego.

**⚪ Fora do raio de rota (~150 clientes — NÃO entram na rota de ligação por dia):** São Paulo (38),
Belo Horizonte (38), Araxá (19), Guarulhos (13), Araguari (12), Cajamar (10), Caxias do Sul (10),
Curitiba (8), Contagem (8). São metrô/outros estados → balcão/transportadora/visita (Hunter), não
televendas por rota. No plano, jogue num bucket "fora da região de rota", não force num dia.

## Como usar no plano

1. Para cada cliente, normalize `city` e procure no calendário oficial → define o dia.
2. Se não achar, procure na lista de vizinhas → sugere o dia + marca "a confirmar".
3. Se não achar em nenhuma → seção **"Cidades órfãs"** do plano, pedindo ao dono o mapeamento.
4. Dentro de cada dia, ordene os clientes pelas cotas (recuperação/expansão/follow-up).
