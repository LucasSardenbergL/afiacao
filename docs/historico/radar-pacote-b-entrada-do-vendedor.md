# Radar — pacote B: entrada do vendedor (2026-11-06)

Continuação do pacote A (`radar-pacote-a-fila-do-vendedor.md`, #3677), com o mesmo objetivo: preparar o piloto
com um vendedor, porque em 60 dias ninguém usou o Radar. O A corrigiu defeitos. O B muda a ENTRADA: a tela tinha
sido feita para um gestor que analisa dados, não para um vendedor que precisa ligar.

## O que mudou

| Item | Antes | Agora |
|---|---|---|
| B1 | Uns 16 controles acima da lista; o 1º lead ficava abaixo da dobra no celular; o número de destaque era "A contatar 508.719" | "Sua fila de hoje" no topo (contagem, região, ordem e "Começar pelo 1º lead"). Filtros, chips de lote, KPIs e o "Onde caçar" ficam em "Mais filtros e território", aberto para o gestor e fechado para o vendedor. Filtro ativo é CONTADO no rótulo. A amostra virou 1 linha, com "como funciona" |
| B3 | O nome dividia o flex com até 8 selos `shrink-0`, e o `truncate` o apagava no celular | O nome tem linha própria e os selos ficam na 2ª linha. `<Selo>` único (a classe estava copiada umas 14 vezes). O 1º motivo do score aparece como texto |
| B4 | O registro não levava nota | Nota opcional na ficha (quem atendeu, o que precisa, próximo passo). O histórico mostra a nota inteira e o autor (via `profiles`; sem nome → "autor não identificado") |
| B5 | `abertaCnpj` era `useState` | `/radar?cnpj=…` abre a ficha (instância própria do `useUrlState`, fora dos filtros). Fora da fila, o lead é lido pelo CNPJ |
| B6 | Uma janela "Cadastrar no Omie agora?" abria depois de cada "em conversa" | O cadastro é ação contextual da ficha quando o lead está em conversa. A ficha fica no lead depois de registrar "em conversa" num lead cadastrável |

**B2 ("Meus atendimentos") ficou de fora deste PR.** Precisa de migration em `radar_lista` (`p_so_meus`), encadeada
sobre a assinatura do pacote C (#3676), que ainda não tinha mergeado. Vai em outra entrega.

## Achados do Codex (código), todos corrigidos com teste falsificado

- **P2:** depois de salvar e desfazer o "em conversa", o botão de cadastro continuava valendo, e a releitura só
  conferia `cadastravelNoOmie`. Agora a releitura exige `em_conversa` (como a oferta antiga exigia) e o desfazer
  limpa o sinal otimista da ficha.
- **P2:** um 2º registro igual em menos de 2 min é deduplicado pela RPC SEM gravar a nota, e a ficha apagava o
  texto. Agora o menu avisa "A nota não foi gravada" e a ficha preserva o campo.
- **P3:** o contador de filtros contava a ORDEM e escondia a região padrão. Agora conta só o que recorta a fila,
  e a região aparece no resumo da fila.

## Lição

Remover uma oferta que tinha uma guarda (o status relido) exige levar a guarda junto para o novo caminho. O
botão contextual herdou o gatilho da oferta, mas não a condição dela.
