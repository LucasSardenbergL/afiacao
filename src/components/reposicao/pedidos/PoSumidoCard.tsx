import { useState } from 'react';
import { ChevronDown, ChevronRight, FileSearch } from 'lucide-react';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatBRL } from './shared';
import {
  contarIlegiveis,
  descreverIdade,
  passosDaAcao,
  resumirValores,
  type Frescor,
  type PoCandidato,
} from './po-sumido';

// Seção NEUTRA (recolhida) da fila de atenção: pedidos `disparado` cujo PO NÃO apareceu no último run
// VÁLIDO do omie-sync-pedidos-compra — ou seja, o PO sumiu do Omie mas o pedido segue disparado aqui.
// Enquanto está DENTRO da janela de 7d isso infla o estoque efetivo (a CTE em_transito re-soma as
// unidades) e o item some do cockpit; fora dela é sujeira — o motor já voltou a sugerir o SKU.
//
// ⚠️ COPY HONESTA (a lição que custou 16 rodadas de review): "PO sumiu do Omie" NÃO prova "a compra não
// existe". O disparo aciona o PORTAL DO FORNECEDOR **antes** de criar o PO no Omie, então o fornecedor
// pode estar com o pedido protocolado mesmo sem PO. Por isso este card NUNCA sugere cancelar: mostra a
// EVIDÊNCIA (protocolo, canal, status) e deixa a decisão com quem sabe o contexto. Cancelar um pedido
// que o fornecedor tem = o motor re-sugere = compra duplicada.
//
// O TÍTULO é deliberadamente "a reconciliar", não "sem PO": parte das linhas tem
// visto_status='identidade_nao_interpretavel', em que a RPC nem CONSEGUIU comparar o PO. Afirmar
// ausência no título e ressalvar só depois de expandir seria mentir no lugar mais lido.
const TITULO = 'Pedidos com PO a reconciliar no Omie';

/**
 * A frase que descreve o estado do detector, quando ele NÃO está fresco.
 *
 * ⚠️ Este bloco é a razão de ser do PR. A lista vazia deste card significava duas coisas
 * indistinguíveis — "está tudo bem" e "o detector parou" — porque o guard temporal do #1718 esconde
 * todo PO nascido depois do marcador, e o marcador congela se o run completo parar de produzir run
 * válido. Um card que some é indistinguível de um card sem nada a dizer. Agora ele fala.
 *
 * `null` quando está tudo fresco — e aí o card volta a se comportar como antes.
 */
function avisoDeFrescor(frescor: Frescor, temLista: boolean) {
  switch (frescor.estado) {
    case 'fresco':
      return null;
    // Sem autorização também não há aviso, mas por outra razão: o card inteiro já não é para esta
    // pessoa, e um alerta sobre o detector de compras revelaria a existência do que o gate acabou
    // de negar. `return` explícito em cada ramo — o fallthrough de case vazio economizava uma linha
    // e custava um erro de lint (`no-fallthrough`), além de esconder que são motivos diferentes.
    case 'nao_autorizado':
      return null;
    case 'desatualizado': {
      const idade = descreverIdade(frescor.horas);
      return {
        badge: `detector desatualizado há ${idade}`,
        titulo: `${TITULO} — detector desatualizado há ${idade}`,
        texto: (
          <>
            A última varredura completa válida terminou há <strong>{idade}</strong> (o normal é a
            cada 22h). Enquanto ela não roda, um PO criado depois dela{' '}
            <strong>não aparece nesta verificação</strong> —{' '}
            {temLista
              ? 'a lista abaixo pode estar incompleta.'
              : 'então a lista vazia aqui não é notícia boa, é ausência de apuração.'}{' '}
            Se persistir, avise o time técnico.
          </>
        ),
      };
    }
    case 'sem_marcador':
      return {
        badge: 'detector sem base de comparação',
        titulo: `${TITULO} — detector sem base de comparação`,
        texto: (
          <>
            Nenhuma varredura completa válida foi concluída, então não há com o que comparar os
            pedidos. Esta verificação <strong>não está rodando</strong> — o que ela mostra (ou deixa
            de mostrar) não conclui nada. Avise o time técnico.
          </>
        ),
      };
    case 'nao_apurado':
      // Não é o mesmo que "sem marcador": ali sabemos que não há base; aqui não sabemos nada. Manter
      // os dois separados é o que impede "não consegui perguntar" de ser lido como "perguntei e está
      // tudo certo" — a distinção que o §2 do money-path exige e que colapsar apagaria.
      return {
        badge: 'atualização não conferida',
        titulo: `${TITULO} — não foi possível conferir a atualização`,
        texto: (
          <>
            Não conseguimos ler quando foi a última varredura completa. Isso{' '}
            <strong>não</strong> significa que está tudo certo — significa que não sabemos se esta
            verificação está atualizada.
          </>
        ),
      };
  }
}

export function PoSumidoCard({
  candidatos,
  frescor,
  falhaApuracao = false,
  apurando = false,
}: {
  candidatos: PoCandidato[];
  /** Quão velha é a base de comparação do detector. Obrigatório: sem ele o card volta a mentir por omissão. */
  frescor: Frescor;
  /** A RPC não respondeu (erro que NÃO é o gate de permissão). Ver comentário abaixo. */
  falhaApuracao?: boolean;
  /** Primeira apuração ainda em voo: não sabemos se há candidatos. */
  apurando?: boolean;
}) {
  const [aberto, setAberto] = useState(false);
  const avisoBruto = avisoDeFrescor(frescor, candidatos.length > 0);
  // Com a apuração da LISTA já falhando, "não conseguimos ler o marcador" não acrescenta nada: é a
  // mesma notícia, quase sempre a mesma causa, dita duas vezes em dois parágrafos. Já "detector
  // desatualizado" e "sem base de comparação" são fatos NOVOS — e mais graves que uma falha
  // transitória de rede — então esses continuam aparecendo mesmo empilhados.
  const aviso = falhaApuracao && frescor.estado === 'nao_apurado' ? null : avisoBruto;

  // A INSTRUÇÃO é suprimida quando a base de comparação não sustenta uma ação irreversível — a mesma
  // regra que este card já aplica a `falhaApuracao`, agora estendida à causa que faltava.
  //
  // Por que marcador velho conta: a evidência "o PO não foi confirmado" é carimbada no run COMPLETO,
  // então ela tem a idade do marcador. Com 40h, o card está afirmando algo sobre anteontem — e nesse
  // intervalo alguém pode ter recriado o PO. Manter "recrie o PO" ali produz compra DUPLICADA, que é
  // o dano que este card existe para evitar, só que pelo outro lado. As travas do plano ("confirme
  // que não existe nenhum outro PO ativo… achou algum? PARE") reduzem o risco mas não o fecham: elas
  // dependem de o comprador executá-las, e a linha que ele lê primeiro é "recrie".
  //
  // `nao_apurado` NÃO suprime, e a distinção é deliberada: ali não sabemos a idade da base — não
  // sabemos que ela é velha. Suprimir por não-saber tornaria o card inútil toda vez que a consulta
  // secundária falhasse, trocando um risco raro por uma perda certa. A evidência continua na tela
  // nos três casos; o que sai é o comando de agir.
  const baseNaoSustentaAcao = frescor.estado === 'desatualizado' || frescor.estado === 'sem_marcador';
  const instrucaoSuprimida = falhaApuracao || baseNaoSustentaAcao;

  // "Não consegui apurar" ≠ "não há nada" (money-path). Se a RPC falhou, sumir em silêncio faria o
  // detector parecer saudável justamente quando ele está cego — o mesmo tipo de silêncio que deixou o
  // PO fantasma passar 7 dias despercebido. Então falha vira aviso VISÍVEL, não ausência.
  //
  // Só ocupa a tela SOZINHO quando não há lista anterior. Havendo, o aviso entra por cima dela (mais
  // abaixo): apagar pedido, protocolo e valor legítimos por um erro de rede transitório seria trocar
  // uma mentira por uma perda — e a lista antiga é do próprio usuário, porque a chave da query é
  // escopada pelo principal autenticado.
  if (falhaApuracao && candidatos.length === 0) {
    return (
      <Card className="border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2 text-muted-foreground">
            <FileSearch className="w-4 h-4" />
            {TITULO} — não foi possível apurar
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            A verificação de pedidos disparados sem PO no Omie falhou agora. Isso <strong>não</strong>{' '}
            significa que está tudo certo — significa que não sabemos. Recarregue a página; se persistir,
            avise o time técnico.
          </p>
        </CardHeader>
      </Card>
    );
  }

  // Mesma regra do bloco acima, na versão transitória: enquanto a 1ª apuração não volta, lista vazia
  // não é resposta — é pergunta em aberto. Sumir aqui seria "ainda não sei" exibido como "não há".
  if (apurando) {
    return (
      <Card className="border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2 text-muted-foreground">
            <FileSearch className="w-4 h-4" />
            {TITULO} — apurando…
          </CardTitle>
        </CardHeader>
      </Card>
    );
  }

  // ⚠️ ESTE `return null` ERA O BUG. Card que some AFIRMA "não há pedido a reconciliar" — e isso só
  // é verdade se o detector de fato rodou. Com o marcador congelado, o guard temporal do #1718
  // esconde todo PO posterior a ele, e a lista fica vazia porque ninguém olhou, não porque não há
  // nada. Some quando está fresco (aí a ausência é informação); fala quando não está.
  if (candidatos.length === 0) {
    if (!aviso) return null;
    return (
      <Card className="border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2 text-status-warning">
            <FileSearch className="w-4 h-4" />
            {aviso.titulo}
          </CardTitle>
          <p className="text-sm text-muted-foreground">{aviso.texto}</p>
        </CardHeader>
      </Card>
    );
  }

  const comDanoAtivo = candidatos.filter((c) => c.na_janela_7d).length;
  const valores = resumirValores(candidatos);
  const ilegiveis = contarIlegiveis(candidatos);

  return (
    <Card className="border-border">
      <CardHeader className="cursor-pointer select-none" onClick={() => setAberto((v) => !v)}>
        <CardTitle className="text-base flex items-center gap-2 text-muted-foreground">
          {aberto ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          <FileSearch className="w-4 h-4" />
          {TITULO} ({candidatos.length})
          {/* "na janela de 7 dias" afirma o estado ATUAL (o dano está acontecendo agora), e com a
              apuração velha isso não se sustenta. Mas SUPRIMIR era o pior dos dois lados: escondia
              urgência que de fato existia na última apuração. Então o fato continua visível, no tempo
              verbal certo. */}
          {comDanoAtivo > 0 && (
            <Badge variant="outline" className="text-status-warning border-status-warning/40">
              {falhaApuracao
                ? `${comDanoAtivo} estava${comDanoAtivo > 1 ? 'm' : ''} na janela na última apuração`
                : `${comDanoAtivo} na janela de 7 dias`}
            </Badge>
          )}
          {falhaApuracao && (
            <Badge variant="outline" className="text-status-warning border-status-warning/40">
              pode estar desatualizado
            </Badge>
          )}
          {aviso && (
            <Badge variant="outline" className="text-status-warning border-status-warning/40">
              {aviso.badge}
            </Badge>
          )}
        </CardTitle>
        {/* Com lista na tela o aviso QUALIFICA a evidência (pode faltar linha — as exibidas não são
            falsas) e, quando o marcador está velho ou ausente, também retira a INSTRUÇÃO: ver
            `instrucaoSuprimida`. Evidência sobre base velha é informação; comando de agir sobre base
            velha é como se produz um PO duplicado. */}
        {aviso && <p className="text-sm text-status-warning">{aviso.texto}</p>}
        {/* A lista continua na tela, mas o usuário precisa saber que ela é a ÚLTIMA conhecida e não a
            atual — "desatualizado" é informação, "sumiu" seria perda, e nenhum dos dois pode virar
            silêncio. O que NÃO pode continuar é a INSTRUÇÃO: manter "recrie o PO" sobre uma lista
            velha faz o comprador recriar um PO que já pode ter sido recriado (o ciclo se resolve entre
            uma apuração e a seguinte). Evidência histórica, sim; ação sobre estado velho, não. */}
        {falhaApuracao && (
          <p className="text-sm text-status-warning">
            A última verificação falhou. O que está abaixo é o resultado da <strong>última apuração
            bem-sucedida</strong> e pode já ter sido resolvido. <strong>Não aja por esta lista</strong>{' '}
            — confira o pedido no Omie antes de qualquer coisa.
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {/* "não foi CONFIRMADO", não "não foi encontrado": para as linhas com identidade ilegível a
              RPC não chegou a comparar nada, e afirmar ausência aqui seria falso — no lugar mais lido
              do card, já que a ressalva por linha só aparece depois de expandir. Neutralizar só o
              título teria sido meia-correção: trocar o rótulo sem mudar a afirmação.
              Em falha, os mesmos fatos vão para o PASSADO: no presente eles afirmam um estado atual que
              não foi verificado. */}
          {falhaApuracao ? (
            <>
              Na última apuração, estes pedidos estavam <strong>disparados</strong> aqui sem PO
              confirmado no Omie.{' '}
            </>
          ) : (
            <>
              O pedido está <strong>disparado</strong> aqui, mas o PO não foi confirmado na última
              varredura do Omie. Dentro da janela de 7 dias isso infla o estoque e o item some do
              cockpit; fora dela, o motor já voltou a sugerir o SKU.{' '}
              <strong>Não cancele sem conferir</strong> — o fornecedor pode estar com o pedido (o portal
              é acionado antes do Omie).{' '}
            </>
          )}
          {ilegiveis > 0 && (
            <>
              Em {ilegiveis} {ilegiveis === 1 ? 'desse pedido' : 'desses pedidos'} o código do PO não é
              legível, então aí <strong>não foi possível comparar</strong> com o Omie.{' '}
            </>
          )}
          {/* Nunca imprimir R$ 0,00 quando nada foi apurado: zero afirma "não há dinheiro em jogo", e a
              verdade é "não sabemos quanto". Caso misto é SUBTOTAL declarado, jamais "total". */}
          {valores.tipo === 'nao_apurado' && (
            <>
              Valor <strong>não apurado</strong> (nenhum pedido tem todos os itens precificados).
            </>
          )}
          {valores.tipo === 'parcial' && (
            <>
              Subtotal de {valores.comValor} de {candidatos.length} pedidos: {formatBRL(valores.total)} —
              os outros {valores.semValor} têm item sem preço e ficaram de fora.
            </>
          )}
          {valores.tipo === 'completo' && <>Total {formatBRL(valores.total)}.</>}
        </p>
      </CardHeader>
      {aberto && (
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ciclo</TableHead>
                <TableHead>Fornecedor / Canal</TableHead>
                <TableHead>Evidência</TableHead>
                <TableHead>{instrucaoSuprimida ? 'Ação' : 'O que fazer'}</TableHead>
                <TableHead className="text-right">Valor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidatos.map((c) => (
                <TableRow key={c.pedido_id}>
                  <TableCell className="text-xs tabular-nums whitespace-nowrap">
                    {format(new Date(c.data_ciclo + 'T12:00:00'), 'dd/MM/yyyy')}
                    {/* Mesmo cuidado do badge, por linha: "na janela" é presente. Com a apuração velha
                        o rótulo vai para o passado em vez de afirmar um estado não verificado. */}
                    <div className="text-muted-foreground">
                      {c.idade_dias}d
                      {c.na_janela_7d && (falhaApuracao ? ' · estava na janela' : ' · na janela')}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{c.fornecedor_nome ?? '—'}</div>
                    <div className="text-xs text-muted-foreground">{c.canal_usado ?? '—'}</div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {c.portal_protocolo && (
                      <div>
                        protocolo <span className="font-medium tabular-nums">{c.portal_protocolo}</span>
                      </div>
                    )}
                    {c.status_envio_portal && (
                      <div className="text-muted-foreground">{c.status_envio_portal}</div>
                    )}
                    {/* "registrado" importa: o que sabemos é que NÃO CONSTA sinal aqui — não que o
                        fornecedor não foi acionado lá fora. */}
                    {!c.algum_sinal_de_canal && (
                      <span className="text-muted-foreground">sem sinal registrado</span>
                    )}
                    <div className="text-muted-foreground">
                      {c.omie_codigo_pedido ? `PO ${c.omie_codigo_pedido}` : 'PO não identificado'}
                    </div>
                  </TableCell>
                  {/* Com a apuração desatualizada a sugestão é SUPRIMIDA, não exibida com ressalva:
                      "recrie o PO no Omie" sobre uma linha que já pode ter sido resolvida produz PO
                      duplicado — o mesmo dano que este PR existe para evitar, só que pelo outro lado. */}
                  {/* <ol> em vez de um parágrafo único: os passos carregam TRAVAS ("PARE — não
                      recrie", "não pelo número antigo") e, num nó de texto corrido de 22rem, a quebra
                      cai onde couber — quem escaneia encontra "recrie o PO" antes da condição que o
                      impede. Um item por passo mantém a trava colada ao passo a que pertence. */}
                  <TableCell className="text-xs max-w-[24rem]">
                    {instrucaoSuprimida ? (
                      <span className="text-muted-foreground">
                        Confira este pedido no Omie —{' '}
                        {falhaApuracao
                          ? 'a apuração está desatualizada.'
                          : 'a base de comparação está velha demais para orientar uma ação.'}
                      </span>
                    ) : (
                      <ol className="list-decimal pl-4 space-y-1">
                        {passosDaAcao(c).map((passo) => (
                          <li key={passo}>{passo}</li>
                        ))}
                      </ol>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {c.valor_total == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      formatBRL(c.valor_total)
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      )}
    </Card>
  );
}
