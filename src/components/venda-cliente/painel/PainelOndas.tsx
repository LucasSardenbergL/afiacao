import { Check, Circle, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatarPct, rotuloSemana, type PainelVenda } from '@/lib/venda-cliente/painel';

type Ondas = PainelVenda['ondas'];

function Item({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  const Icone = ok === null ? Circle : ok ? Check : X;
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icone
        aria-hidden
        className={cn(
          'mt-0.5 h-3.5 w-3.5 shrink-0',
          ok === null ? 'text-muted-foreground' : ok ? 'text-status-success' : 'text-muted-foreground',
        )}
      />
      <span className={cn(ok === false && 'text-muted-foreground')}>{children}</span>
    </li>
  );
}

function dataHora(iso: string) {
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });
}

function Cartao({
  titulo,
  subtitulo,
  ligada,
  ligadaEm,
  children,
}: {
  titulo: string;
  subtitulo: string;
  ligada: boolean;
  ligadaEm: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{titulo}</p>
          <p className="text-xs text-muted-foreground">{subtitulo}</p>
        </div>
        <Badge variant={ligada ? 'default' : 'outline'} className="shrink-0">
          {ligada ? 'Ligada' : 'Desligada'}
        </Badge>
      </div>
      {ligada ? (
        <p className="text-sm text-muted-foreground">
          {ligadaEm ? `Ligou sozinha em ${dataHora(ligadaEm)}, pela condição registrada.` : 'Ligada na configuração, sem registro da condição.'}
        </p>
      ) : (
        <ul className="space-y-1.5">{children}</ul>
      )}
    </div>
  );
}

/**
 * Estado das 3 ondas (spec §8). Ligam sozinhas pelo cron do gerador; o painel só LÊ — mostra os
 * pré-requisitos da próxima avaliação. A comparação de lista idêntica (Onda 1) é do cron.
 */
export function PainelOndas({ ondas }: { ondas: Ondas }) {
  const o1 = ondas.onda_recompra;
  const p1 = o1.prerequisitos;
  const histOk = p1.historico_dias >= p1.historico_meta;
  const sombraOk = p1.sombra_ao_vivo.length === 3 && p1.sombra_ao_vivo.every((d) => d.ao_vivo);
  const o2 = ondas.onda_complemento;
  const o3 = ondas.onda_preco;
  const repasse = o3.prerequisitos.repasse_vigente;

  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Cartao titulo="Onda 1 · Recompra" subtitulo="Meu Dia com a lista e a ficha" ligada={o1.ligada} ligadaEm={o1.ligada_em}>
        <Item ok={histOk}>
          Histórico reconstruído: <span className="tabular-nums">{p1.historico_dias}</span> de {p1.historico_meta} dias
        </Item>
        <Item ok={sombraOk}>
          Lista ao vivo (sombra) nos 3 dias anteriores:{' '}
          {[...p1.sombra_ao_vivo].reverse().map((d) => (
            <span key={d.dia} className={cn('ml-1 tabular-nums', !d.ao_vivo && 'line-through')}>
              {rotuloSemana(d.dia)}
            </span>
          ))}
        </Item>
        {histOk && sombraOk && (
          <Item ok={false}>
            {p1.avaliada_hoje
              ? 'Pré-requisitos cumpridos, mas a onda não ligou: a lista ao vivo divergiu da reconstruída — linha de base não confiável.'
              : 'Pré-requisitos cumpridos — aguardando a avaliação de hoje (cron das 05:15).'}
          </Item>
        )}
      </Cartao>

      <Cartao titulo="Onda 2 · Oferecer também" subtitulo="Complemento na ficha" ligada={o2.ligada} ligadaEm={o2.ligada_em}>
        <Item ok={o2.prerequisitos.onda_recompra_ligada}>Onda 1 ligada</Item>
        {o2.prerequisitos.semanas.map((s) => (
          <Item key={s.semana} ok={s.farmers > 0 ? s.ok : null}>
            Semana de {rotuloSemana(s.semana)}:{' '}
            {s.farmers > 0 && s.menor_taxa !== null
              ? <>menor taxa de contato <span className="tabular-nums">{formatarPct(s.menor_taxa)}</span> (meta 80%)</>
              : 'sem lista ativa'}
          </Item>
        ))}
      </Cartao>

      <Cartao titulo="Onda 3 · Preço alvo" subtitulo="Repasse aprovado na ficha" ligada={o3.ligada} ligadaEm={o3.ligada_em}>
        <Item ok={o3.prerequisitos.onda_complemento_ligada}>Onda 2 ligada</Item>
        <Item ok={repasse}>
          {repasse === null
            ? 'Repasse ainda não instalado no banco'
            : repasse
              ? 'Há repasse aprovado vigente'
              : 'Nenhum repasse aprovado vigente'}
        </Item>
      </Cartao>
    </div>
  );
}
