import { useState } from 'react';
import { toast } from 'sonner';
import { Building2, Ban, ClipboardPlus, Download } from 'lucide-react';
import { BulkActionsBar } from '@/components/ui/bulk-actions-bar';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { track } from '@/lib/analytics';
import { hojeSP } from '@/lib/time/sp-day';
import { csvEmpresas, limitarSelecao, TETO_LOTE } from '@/lib/radar/lote';
import { registrarContatoRadar } from '@/queries/useRegistrarContatoRadar';
import { atribuirTarefaRadar } from '@/queries/useRadarAcoesLead';
import { useRadarAcaoEmLote, type useRadarLoteOmie } from '@/queries/useRadarLote';
import type { RadarEmpresa } from '@/queries/useRadarLista';

function baixarCsv(csv: string, nome: string) {
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Barra de ações sobre a SELEÇÃO (checkbox por linha). "Selecionar todos do filtro"
 * (server-side, milhares) é recusado de propósito: só o que está carregado, com teto por
 * lote — e a UI diz quantos ficaram de fora.
 */
export function RadarAcoesLote({
  selecao,
  onLimpar,
  onRemover,
  loteOmie,
  onAbrirLote,
}: {
  selecao: RadarEmpresa[];
  onLimpar: () => void;
  /** Tira CNPJs da seleção (sucessos saem; falhas ficam para o usuário decidir). */
  onRemover: (cnpjs: string[]) => void;
  loteOmie: ReturnType<typeof useRadarLoteOmie>;
  onAbrirLote: () => void;
}) {
  const { isImpersonating } = useImpersonation();
  const acao = useRadarAcaoEmLote();
  const [confirmOmie, setConfirmOmie] = useState(false);
  const [confirmDescartar, setConfirmDescartar] = useState(false);
  const [confirmTarefa, setConfirmTarefa] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [dias, setDias] = useState('7');

  const { dentro, fora } = limitarSelecao(selecao);
  const ocupado = acao.rodando || loteOmie.rodando || isImpersonating;
  const cnpjs = dentro.map((e) => e.cnpj);

  const iniciarOmie = () => {
    setConfirmOmie(false);
    if (!loteOmie.iniciar(dentro)) {
      toast.info('Há um lote anterior com pendências — resolva ou esqueça-o antes de começar outro.');
      onAbrirLote();
      return;
    }
    onRemover(cnpjs);
    onAbrirLote();
  };

  const descartar = async () => {
    setConfirmDescartar(false);
    const nota = motivo.trim() || undefined;
    const r = await acao.executar(cnpjs, (cnpj) => registrarContatoRadar({ cnpj, acao: 'descartado', nota }), 'radar.lote_descartado');
    onRemover(cnpjs.filter((c) => !r.falhas.some((f) => f.item === c)));
    if (r.falhas.length === 0) toast.success(`${r.ok} lead(s) descartado(s)`);
    else toast.warning(`${r.ok} descartado(s) · ${r.falhas.length} falharam (continuam selecionados)`, { description: r.falhas[0]?.erro });
    setMotivo('');
  };

  const criarTarefas = async () => {
    setConfirmTarefa(false);
    const n = Math.max(1, Math.min(Number(dias) || 7, 90));
    const r = await acao.executar(cnpjs, (cnpj) => atribuirTarefaRadar({ cnpj, diasRetomada: n }), 'radar.lote_tarefas');
    onRemover(cnpjs.filter((c) => !r.falhas.some((f) => f.item === c)));
    if (r.falhas.length === 0) toast.success(`${r.ok} tarefa(s) criada(s) pra você`, { description: `Retomar em ${n} dia(s)` });
    else toast.warning(`${r.ok} criada(s) · ${r.falhas.length} falharam — confira em Tarefas antes de repetir`, { description: r.falhas[0]?.erro });
  };

  const exportar = () => {
    baixarCsv(csvEmpresas(selecao), `radar-leads-${hojeSP()}.csv`);
    track('radar.lote_exportado_csv', { total: selecao.length });
  };

  const tituloFora = fora > 0 ? ` (teto ${TETO_LOTE}: ${fora} ficam de fora)` : '';

  return (
    <>
      <BulkActionsBar
        count={selecao.length}
        onClear={onLimpar}
        itemSingular="lead"
        itemPlural="leads"
        actions={[
          loteOmie.temPendencias
            ? { id: 'omie', label: 'Lote pendente — ver', icon: Building2, variant: 'outline', onClick: onAbrirLote }
            : { id: 'omie', label: `Cadastrar no Omie${fora > 0 ? ` (${dentro.length})` : ''}`, icon: Building2, onClick: () => setConfirmOmie(true), disabled: ocupado },
          { id: 'tarefa', label: 'Criar tarefas', icon: ClipboardPlus, variant: 'outline', onClick: () => setConfirmTarefa(true), disabled: ocupado },
          { id: 'csv', label: 'Exportar CSV', icon: Download, variant: 'outline', onClick: exportar },
          { id: 'descartar', label: 'Descartar', icon: Ban, variant: 'destructive', onClick: () => { setMotivo(''); setConfirmDescartar(true); }, disabled: ocupado },
        ]}
      />

      <AlertDialog open={confirmOmie} onOpenChange={setConfirmOmie}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cadastrar {dentro.length} lead{dentro.length === 1 ? '' : 's'} no Omie (Oben)?{tituloFora}</AlertDialogTitle>
            <AlertDialogDescription>
              Cada CNPJ é consultado no Omie antes de criar (quem já existir só é reconciliado). Os cadastrados
              viram <strong>já-cliente</strong> e saem desta fila. Roda um por vez; você pode parar a qualquer momento
              e retentar só o que falhar. Não cadastra nas outras empresas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={iniciarOmie}>Cadastrar na Oben</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDescartar} onOpenChange={setConfirmDescartar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Descartar {dentro.length} lead{dentro.length === 1 ? '' : 's'}?{tituloFora}</AlertDialogTitle>
            <AlertDialogDescription>Saem da fila de prospecção. O motivo (opcional) vale para todos.</AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Motivo (opcional)" />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={descartar}>Descartar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmTarefa} onOpenChange={setConfirmTarefa}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Criar {dentro.length} tarefa{dentro.length === 1 ? '' : 's'} pra você?{tituloFora}</AlertDialogTitle>
            <AlertDialogDescription>Uma tarefa "ligar" por lead, na sua lista, com a data de retomada abaixo.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center gap-2">
            <Label htmlFor="radar-lote-dias" className="text-sm">Retomar em</Label>
            <Input id="radar-lote-dias" value={dias} onChange={(e) => setDias(e.target.value)} className="w-16 h-8" inputMode="numeric" />
            <span className="text-sm text-muted-foreground">dias</span>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={criarTarefas}>Criar tarefas</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
