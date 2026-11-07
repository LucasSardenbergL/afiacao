import { useState } from 'react';
import { toast } from 'sonner';
import { GitFork, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { estadoDeLeitura, naoConsegui } from '@/lib/leitura/estado-de-leitura';
import { podeGerirRadar } from '@/lib/nav/acesso-radar';
import { CLASSE_TOM } from '@/lib/radar/ui-helpers';
import {
  dataBr, documentoCompleto, mensagemRecusaSucessao, normalizarDocumento, resumoLado, textoEstadoSucessao,
  tituloSucessao, type PreviaLado, type SucessaoDeclarada, type TipoSucessao,
} from '@/lib/radar/sucessao';
import type { VinculoCliente } from '@/lib/radar/vinculos';
import { cn } from '@/lib/utils';
import {
  useRadarDeclararSucessao, useRadarPreviaSucessao, useRadarRevogarSucessao, useRadarSucessoes,
} from '@/queries/useRadarSucessoes';
import { RadarVinculosLead } from './RadarVinculosLead';

/** Prefill da declaração: vazio (manual) ou a partir de uma pista automática ("confirmar" em 1 clique). */
interface Rascunho { antigo: string; tipo: TipoSucessao }

/**
 * "Já é cliente?" na ficha: a sucessão DECLARADA (fato, com autor e data) em cima, as pistas automáticas embaixo.
 * O selo não depende de `ja_cliente` — segue visível depois do cadastro no Omie. Gestor/master declara (ou confirma
 * uma pista) e revoga; a decisão é do usuário REAL (`useAuth`) e a escrita fica desligada na lente "Ver como".
 */
export function RadarSucessaoLead({ cnpj, dataAbertura }: { cnpj: string; dataAbertura: string | null }) {
  const { role, commercialRole } = useAuth();
  const { isImpersonating } = useImpersonation();
  const gestor = podeGerirRadar({ role, commercialRole });
  const q = useRadarSucessoes(cnpj);
  const estado = estadoDeLeitura(q);
  const [rascunho, setRascunho] = useState<Rascunho | null>(null);

  const declaradas = q.data?.sucessoes ?? [];
  const ativasComoNovo = declaradas.filter((s) => s.papel === 'novo' && s.estado !== 'revogada');
  const podeDeclarar = gestor && !isImpersonating && q.isSuccess;
  const antigosJaDeclarados = new Set(ativasComoNovo.map((s) => s.antigoDocumento));

  return (
    <div className="space-y-2" data-testid="radar-sucessao-lead">
      {estado === 'carregando' && <Skeleton className="h-5 w-48" />}
      {naoConsegui(estado) && !q.data && (
        <AvisoLeituraFalhou oque="se este CNPJ tem sucessão declarada" estado={estado} className="mb-0" />
      )}
      {declaradas.length > 0 && (
        <ul className="space-y-1.5" data-testid="radar-sucessoes">
          {declaradas.map((s) => (
            <SeloSucessao key={s.id} s={s} versao={q.data!.versao} podeRevogar={gestor && !isImpersonating} />
          ))}
        </ul>
      )}
      <RadarVinculosLead
        cnpj={cnpj}
        onConfirmar={podeDeclarar
          ? (v: VinculoCliente) => setRascunho({ antigo: v.clienteCnpj, tipo: v.clienteSituacao === '08' ? 'sucessao' : 'cisao' })
          : undefined}
        jaConfirmados={antigosJaDeclarados}
      />
      {podeDeclarar && (
        <Button size="sm" variant="outline" onClick={() => setRascunho({ antigo: '', tipo: 'cisao' })}
          data-testid="radar-declarar-sucessao">
          <GitFork className="w-4 h-4 mr-1" /> Declarar sucessão de um cliente
        </Button>
      )}
      {rascunho && q.data && (
        <DialogDeclarar
          novo={cnpj}
          dataAbertura={dataAbertura}
          inicial={rascunho}
          versao={q.data.versao}
          onFechar={() => setRascunho(null)}
        />
      )}
    </div>
  );
}

function SeloSucessao({ s, versao, podeRevogar }: { s: SucessaoDeclarada; versao: number; podeRevogar: boolean }) {
  const tom = s.estado === 'ativa' ? 'success' : s.estado === 'declarada' ? 'info' : 'muted';
  return (
    <li className={cn('text-sm', s.estado === 'revogada' && 'text-muted-foreground')} data-testid="radar-sucessao">
      <span className={cn('mr-1.5 inline-block rounded border px-1.5 py-px text-[11px] leading-4', CLASSE_TOM[tom])}>
        {s.estado === 'revogada' ? 'revogada' : 'confirmada'}
      </span>
      {tituloSucessao(s)}
      <div className="text-xs text-muted-foreground">
        Corte comercial em {dataBr(s.dataCorte)} · declarada por {s.declaradoPorNome ?? 'alguém da gestão'} em{' '}
        {dataBr(s.declaradoEm)} · {textoEstadoSucessao(s)}
        {s.estado === 'revogada' && s.revogadoMotivo
          ? ` por ${s.revogadoPorNome ?? 'alguém da gestão'} em ${dataBr(s.revogadoEm)}: ${s.revogadoMotivo}`
          : ''}
      </div>
      {s.observacao && <div className="text-xs text-muted-foreground">{s.observacao}</div>}
      {podeRevogar && s.estado !== 'revogada' && <RevogarSucessao id={s.id} versao={versao} />}
    </li>
  );
}

function RevogarSucessao({ id, versao }: { id: string; versao: number }) {
  const [aberto, setAberto] = useState(false);
  const [motivo, setMotivo] = useState('');
  const revogar = useRadarRevogarSucessao();
  const confirmar = async () => {
    try {
      const r = await revogar.mutateAsync({ id, motivo: motivo.trim(), versao });
      if (!r.ok) { toast.info(mensagemRecusaSucessao(r)); return; }
      toast.success('Declaração revogada', { description: 'Fica registrada no histórico, com o seu motivo.' });
      setAberto(false); setMotivo('');
    } catch (e) {
      toast.error('Não foi possível revogar', { description: e instanceof Error ? e.message : undefined });
    }
  };
  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">Revogar</Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-2">
        <Label htmlFor={`motivo-${id}`}>Por que revogar?</Label>
        <Textarea id={`motivo-${id}`} value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} />
        <Button size="sm" variant="destructive" disabled={!motivo.trim() || revogar.isPending} onClick={confirmar}>
          {revogar.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />} Revogar declaração
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function DialogDeclarar({ novo, dataAbertura, inicial, versao, onFechar }: {
  novo: string; dataAbertura: string | null; inicial: Rascunho; versao: number; onFechar: () => void;
}) {
  const [antigo, setAntigo] = useState(inicial.antigo);
  const [tipo, setTipo] = useState<TipoSucessao>(inicial.tipo);
  const [dataCorte, setDataCorte] = useState(dataAbertura ?? '');
  const [observacao, setObservacao] = useState('');
  const declarar = useRadarDeclararSucessao();
  const antigoOk = documentoCompleto(antigo);
  const dataOk = /^\d{4}-\d{2}-\d{2}$/.test(dataCorte);
  const previa = useRadarPreviaSucessao(antigoOk && dataOk
    ? { antigo: normalizarDocumento(antigo), novo, dataCorte } : null);
  const antigoCliente = previa.data?.antigo.cadastrado === true;

  const enviar = async () => {
    try {
      const r = await declarar.mutateAsync({
        antigo: normalizarDocumento(antigo), novo, tipo, dataCorte,
        dataCorteSugerida: dataAbertura, observacao: observacao.trim() || null, versao,
      });
      if (!r.ok) { toast.info(mensagemRecusaSucessao(r)); if (r.motivo === 'versao_mudou') onFechar(); return; }
      toast.success(`${tipo === 'cisao' ? 'Cisão' : 'Sucessão'} de ${r.antigoNome ?? 'cliente'} declarada`, {
        description: r.novoCadastrado
          ? 'O rateio do histórico de compras é o próximo passo.'
          : 'O histórico só passa a valer depois do cadastro deste CNPJ no Omie.',
      });
      onFechar();
    } catch (e) {
      toast.error('Não foi possível declarar', { description: e instanceof Error ? e.message : undefined });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onFechar(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Declarar sucessão</DialogTitle>
          <DialogDescription>
            Este CNPJ novo nasce de um cliente nosso. Não altera pedido, preço nem financeiro: só registra o fato,
            com você como autor.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="sucessao-antigo">CNPJ do cliente antigo</Label>
            <Input id="sucessao-antigo" value={antigo} onChange={(e) => setAntigo(e.target.value)} inputMode="text"
              placeholder="00.000.000/0000-00" />
          </div>
          <RadioGroup value={tipo} onValueChange={(v) => setTipo(v as TipoSucessao)} className="gap-1.5">
            <div className="flex items-center gap-2">
              <RadioGroupItem value="cisao" id="sucessao-cisao" />
              <Label htmlFor="sucessao-cisao" className="font-normal">Cisão — a antiga continua comprando</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="sucessao" id="sucessao-sucessao" />
              <Label htmlFor="sucessao-sucessao" className="font-normal">Sucessão — a antiga encerrou</Label>
            </div>
          </RadioGroup>
          <div className="space-y-1">
            <Label htmlFor="sucessao-corte">Data de corte comercial</Label>
            <Input id="sucessao-corte" type="date" value={dataCorte} onChange={(e) => setDataCorte(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              O dia em que a operação passou para a empresa nova
              {dataAbertura ? ` (aberta na Receita em ${dataBr(dataAbertura)}: é só uma sugestão)` : ''}.
              Pedidos do próprio dia do corte em diante ficam com quem comprou.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sucessao-obs">Observação (opcional)</Label>
            <Textarea id="sucessao-obs" rows={2} value={observacao} onChange={(e) => setObservacao(e.target.value)} />
          </div>
          {antigoOk && dataOk && <Previa estado={previa} />}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onFechar}>Cancelar</Button>
          <Button disabled={!antigoCliente || declarar.isPending} onClick={enviar} data-testid="radar-confirmar-sucessao">
            {declarar.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />} Confirmar declaração
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Previa({ estado }: { estado: ReturnType<typeof useRadarPreviaSucessao> }) {
  if (estado.isLoading) return <Skeleton className="h-16 w-full" />;
  if (estado.isError || !estado.data) {
    return <p className="text-xs text-status-error">Não consegui montar a prévia dos pedidos: confira o CNPJ.</p>;
  }
  const p = estado.data;
  return (
    <div className="rounded border p-2 text-xs space-y-2" data-testid="radar-previa-sucessao">
      <LadoPrevia titulo="Antiga" lado={p.antigo} />
      <LadoPrevia titulo="Nova" lado={p.novo} />
      {!p.antigo.cadastrado && (
        <p className="text-status-warning">O CNPJ antigo não é cliente no cadastro: não dá para declarar.</p>
      )}
    </div>
  );
}

function LadoPrevia({ titulo, lado }: { titulo: string; lado: PreviaLado }) {
  return (
    <div>
      <div className="font-medium">{titulo}: {lado.nome ?? lado.documento}</div>
      <div className="text-muted-foreground">{resumoLado(lado)}</div>
      {lado.recentes.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1">
          {lado.recentes.map((r, i) => (
            <li key={`${r.dia}-${i}`}
              className={cn('rounded border px-1', r.antesDoCorte ? CLASSE_TOM.muted : CLASSE_TOM.info)}
              title={`${r.empresa}${r.estimada ? ' · data estimada (sem data do pedido no Omie)' : ''}`}>
              {dataBr(r.dia)}{r.estimada ? '*' : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
