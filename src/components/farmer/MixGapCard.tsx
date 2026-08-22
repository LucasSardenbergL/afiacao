import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { MoreVertical, Search, AlertTriangle, WifiOff } from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/EmptyState';
import { useMyMixGap } from '@/hooks/useMyMixGap';
import { useMarkMixGapFeedback } from '@/hooks/useMarkMixGapFeedback';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { buildPorQue } from '@/lib/mixgap/format';
import { track } from '@/lib/analytics';

/**
 * O card colapsava TRÊS estados numa tela em branco só, e o evento só saía num deles.
 *
 *   `if (totalComGap > 0 && !tracked.current) track('carteira.mixgap_visto', …)`
 *   `if (!data || data.totalComGap === 0) return null;`
 *
 * Como `useMyMixGap` LANÇA quando a RPC falha, `data` fica `undefined` no erro — mesma
 * condição do zero. Então "não há oportunidade", "não consegui ler" e "o vendedor nunca
 * abriu a tela" produziam o mesmo silêncio, na tela e no PostHog. É o §6/§12 do money-path
 * (a leitura que falha calada, o motivo que morre) na forma de ADOÇÃO: sem denominador,
 * zero não julga desenho nenhum (`docs/historico/fase-sem-sinal.md`).
 *
 * Não é hipótese: o motor por trás deste card está saindo de 116 para ~84 clientes com gap
 * (a fatia do denominador, #1853 — medido em prod via psql-ro). Sem separar os estados não
 * há como distinguir "caiu para 84" de "quebrou e sumiu", que é exatamente a pergunta que a
 * mudança faz nascer.
 *
 * ⚠️ O evento leva `total_com_gap: null` no erro, nunca `0`. Mandar zero seria fabricar o
 * número que o sensor existe para medir (§2 — ausente ≠ zero): a série de adoção passaria a
 * somar falhas de leitura como se fossem carteiras sem oportunidade.
 *
 * ── QUARTO estado, achado na revisão adversária retroativa do #1859 (Codex e a análise da casa
 * chegaram nele por caminhos separados). Com `networkMode:'online'` (default do QueryClient
 * global, sem `persistQueryClient` no repo) e o navegador offline, a query fica
 * `status:'pending'`/`fetchStatus:'paused'`/`data:undefined`/`error:null`. Em v5
 * `isLoading = isPending && isFetching`, e pausada NÃO está fetching ⇒ `isLoading` é **false**:
 * o predicado antigo (`!isLoading && !error && data === undefined`) casava e o card devolvia
 * `null`. Ou seja, o estado OFFLINE caía no balde "não é staff" — tela em branco e silêncio no
 * PostHog, exatamente a classe de defeito que o #1859 corrigiu. Num PWA de vendedor em campo
 * isso não é hipotético. Daí `fetchStatus` entrar no discriminante: `data === undefined` é
 * pendente, pausado OU desabilitado; só `data === null` é a RPC dizendo "sem acesso".
 *
 * ⚠️ DECISÃO — `aguardando_rede` EMITE evento (com `total_com_gap: null`). Não emitir recriaria
 * o buraco que o #1859 fechou: "vendedor offline" viraria indistinguível de "vendedor nunca
 * abriu". E emitir não contamina o denominador de adoção porque o estado é explícito na série:
 * adoção se calcula sobre os estados com número honesto (`com_gap`/`zero`), como já era preciso
 * fazer com `erro`. O que continua MUDO é `semAcesso` — quem nunca poderia ver o card não
 * pertence ao denominador, e por isso a ausência de acesso não gera linha nenhuma.
 *
 * ⚠️ E o erro tinha precedência sobre o dado STALE, o que custava a lista inteira: um refetch
 * ruim trocava as oportunidades por um aviso, com o cache ainda cheio. Honesto para o sensor,
 * regressão para quem está na rua. O desenho composto (lista PRESERVADA + faixa de aviso +
 * `desatualizado: 'erro' | 'sem_rede'` no evento) serve aos dois: o vendedor não perde a
 * carteira e a série sabe separar "viu número fresco" de "agiu sobre número velho".
 */
type EstadoMixGap = 'com_gap' | 'zero' | 'erro' | 'aguardando_rede';
/** Por que o número na tela pode estar velho. `null` = acabou de ser lido com sucesso. */
type MotivoDesatualizado = 'erro' | 'sem_rede';

function AvisoDesatualizado({ motivo }: { motivo: MotivoDesatualizado }) {
  const Icone = motivo === 'sem_rede' ? WifiOff : AlertTriangle;
  return (
    <div className="flex items-start gap-2 px-3 py-2 border-b border-border bg-muted/40 text-2xs text-status-warning">
      <Icone className="w-3.5 h-3.5 shrink-0 mt-px" />
      <span>
        Informação desatualizada — {motivo === 'sem_rede' ? 'sem conexão agora' : 'a última atualização falhou'}.
        É a última leitura que deu certo; pode ter mudado desde então.
      </span>
    </div>
  );
}

export function MixGapCard() {
  const { data, error, isPending, fetchStatus } = useMyMixGap();
  const { mutate: markFeedback } = useMarkMixGapFeedback();
  const { isImpersonating } = useImpersonation();

  // `data === null` é a RPC dizendo "você não é staff" (ela retorna NULL sem uid/sem role) — e isso
  // só existe DEPOIS de a query RESOLVER. `undefined` NÃO é sinônimo: é pendente, pausada ou
  // desabilitada, três coisas diferentes. Ler os dois como "sem acesso" foi o defeito de origem.
  const semAcesso = data === null;
  const temDado = data != null;
  const pausado = fetchStatus === 'paused';        // offline: o react-query nem dispara a request
  const inerte = isPending && fetchStatus === 'idle';   // query desabilitada (sem user)
  const carregando = isPending && fetchStatus === 'fetching';

  // Pausado ANTES de erro, e a ordem só decide ALGUMA coisa aqui: `fetchState` (query-core) zera
  // `error`/`status` ao iniciar um fetch APENAS quando `data === undefined` — sem dado, erro e
  // pausa nunca coexistem; COM dado no cache o erro é preservado e os dois se sobrepõem. Nesse
  // caso o motivo acionável é o atual: recarregar não resolve falta de sinal.
  const desatualizado: MotivoDesatualizado | null =
    !temDado ? null : pausado ? 'sem_rede' : error ? 'erro' : null;

  const estado: EstadoMixGap | null =
    semAcesso || inerte || carregando
      ? null
      : data != null
        ? (data.totalComGap > 0 ? 'com_gap' : 'zero')
        : pausado
          ? 'aguardando_rede'   // sem dado os dois ramos são exclusivos (ver `desatualizado`)
          : error
            ? 'erro'
            : null;

  const trackedChave = useRef<string | null>(null);
  useEffect(() => {
    // Um evento por estado RESOLVIDO — e a chave inclui o MOTIVO de desatualização, senão a dedup
    // engoliria a transição "carteira fresca" → "agindo sobre número velho", que é precisamente o
    // sinal de leitura falhando em campo. A guarda por chave (e não por booleano) deixa passar
    // erro → zero → com_gap na mesma montagem, que separa falha transitória de carteira vazia.
    if (!estado) return;
    const chave = `${estado}:${desatualizado ?? 'fresco'}`;
    if (trackedChave.current === chave) return;
    trackedChave.current = chave;
    track('carteira.mixgap_visto', {
      estado,
      total_com_gap: data != null ? data.totalComGap : null,
      desatualizado,
    });
  }, [estado, desatualizado, data]);

  if (semAcesso || inerte) return null;

  if (carregando) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-64 mt-1.5" />
        </CardHeader>
        <div className="divide-y divide-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className="p-3"><Skeleton className="h-4 w-full" /></div>
          ))}
        </div>
      </Card>
    );
  }

  if (estado === 'aguardando_rede') {
    return (
      <Card>
        <EmptyState
          tone="operational"
          icon={WifiOff}
          title="Sem conexão — não consegui consultar"
          description="As oportunidades da sua carteira precisam de rede para carregar. Isto NÃO significa que não há oportunidades: assim que a conexão voltar, o card se atualiza sozinho."
        />
      </Card>
    );
  }

  if (estado === 'erro') {
    return (
      <Card>
        <EmptyState
          tone="operational"
          icon={AlertTriangle}
          title="Não consegui carregar as oportunidades"
          description="A leitura da carteira falhou — isto NÃO significa que não há oportunidades. Recarregue a página; se persistir, avise o suporte."
        />
      </Card>
    );
  }

  // Exaustividade: todo estado SEM dado já saiu acima. Se um caso novo escapar, o card some —
  // mas em nenhuma hipótese fabrica número.
  if (data == null) return null;

  if (data.totalComGap === 0) {
    return (
      <Card>
        {desatualizado && <AvisoDesatualizado motivo={desatualizado} />}
        <EmptyState
          tone="operational"
          icon={Search}
          title="Nenhuma oportunidade de cross-sell agora"
          description="Todos os clientes da sua carteira já compram as famílias que clientes parecidos compram — ou as oportunidades abertas já foram marcadas."
        />
      </Card>
    );
  }

  return (
    <Card>
      {desatualizado && <AvisoDesatualizado motivo={desatualizado} />}
      <CardHeader className="pb-2">
        <h2 className="text-base font-medium">Oportunidades de cross-sell</h2>
        <p className="text-2xs text-muted-foreground">
          {data.totalComGap} clientes da sua carteira sem uma família que clientes parecidos compram
        </p>
      </CardHeader>
      <div className="divide-y divide-border">
        {data.lista.slice(0, 20).map((g) => (
          <div key={g.customer_user_id} className="p-3 flex items-center justify-between gap-3 hover:bg-muted/30">
            <Link
              to={`/admin/customers/${g.customer_user_id}/360`}
              onClick={() => track('carteira.mixgap_cliente_aberto', { familia: g.familia_faltante })}
              className="min-w-0 flex-1"
            >
              <div className="text-sm font-medium truncate">{g.nome ?? 'Cliente sem nome'}</div>
              <div className="text-2xs text-muted-foreground">{buildPorQue(g)}</div>
            </Link>
            <div className="flex items-center gap-2 shrink-0">
              {g.feedback_status === 'ofertado' && (
                <Badge variant="outline" className="text-status-warning text-2xs">ofertado</Badge>
              )}
              <Badge variant="outline" className="text-status-info text-2xs">{g.familia_faltante}</Badge>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={isImpersonating}
                  title={isImpersonating ? 'Indisponível em modo Ver como' : 'Marcar oportunidade'}
                  className="p-1 rounded hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <MoreVertical className="w-4 h-4 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => markFeedback({ customerUserId: g.customer_user_id, familia: g.familia_faltante, status: 'ofertado' })}>
                    Ofertado
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => markFeedback({ customerUserId: g.customer_user_id, familia: g.familia_faltante, status: 'convertido' })}>
                    Convertido
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => markFeedback({ customerUserId: g.customer_user_id, familia: g.familia_faltante, status: 'recusado' })}>
                    Recusado
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
