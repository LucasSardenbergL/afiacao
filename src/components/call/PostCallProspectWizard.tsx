import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWebRTCCallContext } from '@/contexts/WebRTCCallContext';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Sparkles, Loader2, UserPlus, X } from 'lucide-react';
import { useCreateProspect } from '@/hooks/useCreateProspect';
import { formatBrPhone } from '@/lib/phone';

/**
 * Wizard que aparece após encerrar chamada inbound de cliente NÃO identificado,
 * QUANDO a IA capturou >=2 campos cadastrais durante a conversa.
 *
 * Pré-preenche form com tudo que IA extraiu. Vendedor confirma e cria prospect.
 * Próxima chamada do mesmo número será auto-identificada.
 *
 * PR-CAPTURE-B (próximo): adiciona sync automático nos 3 Omies aqui.
 */
export function PostCallProspectWizard() {
  const { lastCallCapture, dismissLastCallCapture } = useWebRTCCallContext();
  const navigate = useNavigate();
  const create = useCreateProspect();

  const [razaoSocial, setRazaoSocial] = useState('');
  const [nomeContato, setNomeContato] = useState('');
  const [email, setEmail] = useState('');
  const [cnpj, setCnpj] = useState('');
  const [cidade, setCidade] = useState('');
  const [estado, setEstado] = useState('');
  const [segmento, setSegmento] = useState('');

  // Pré-preenche quando captura abre
  useEffect(() => {
    if (!lastCallCapture) return;
    const c = lastCallCapture.capture;
    setRazaoSocial(c.razao_social ?? '');
    setNomeContato(c.nome_contato ?? '');
    setEmail(c.email ?? '');
    setCnpj(c.cnpj ?? '');
    setCidade(c.cidade ?? '');
    setEstado(c.estado ?? '');
    setSegmento(c.segmento ?? '');
  }, [lastCallCapture]);

  if (!lastCallCapture) return null;

  const handleCreate = () => {
    if (!razaoSocial.trim()) return;
    create.mutate(
      {
        razao_social: razaoSocial.trim(),
        phone: lastCallCapture.phoneDialed,
        nome_contato: nomeContato.trim() || undefined,
        email: email.trim() || undefined,
        cnpj: cnpj.trim() || undefined,
        segmento: segmento.trim() || undefined,
        tags: lastCallCapture.capture.tags_detectadas,
        origin_call_id: lastCallCapture.callId ?? undefined,
        source: 'chamada_inbound',
        // PR-CAPTURE-B: passa pros sync Omie
        cidade: cidade.trim() || undefined,
        estado: estado.trim() || undefined,
        endereco: lastCallCapture.capture.endereco ?? undefined,
        sync_omie: true,
      },
      {
        onSuccess: (data) => {
          dismissLastCallCapture();
          navigate(`/admin/customers/${data.user_id}`);
        },
      },
    );
  };

  const c = lastCallCapture.capture;

  return (
    <Dialog open={true} onOpenChange={(open) => !open && dismissLastCallCapture()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-status-warning" />
            Cliente novo detectado
          </DialogTitle>
          <DialogDescription>
            A IA capturou estes dados durante a chamada. Revise e confirme pra cadastrar como prospect. Telefone: <strong>{formatBrPhone(lastCallCapture.phoneDialed)}</strong>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs">Razão social *</Label>
            <Input
              value={razaoSocial}
              onChange={(e) => setRazaoSocial(e.target.value)}
              placeholder="Marcenaria São Pedro Ltda"
              autoFocus
            />
            {c.razao_social && (
              <p className="text-2xs text-status-success mt-0.5">✓ Capturado da conversa</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Nome do contato</Label>
              <Input value={nomeContato} onChange={(e) => setNomeContato(e.target.value)} />
              {c.nome_contato && <p className="text-2xs text-status-success mt-0.5">✓</p>}
            </div>
            <div>
              <Label className="text-xs">CNPJ</Label>
              <Input value={cnpj} onChange={(e) => setCnpj(e.target.value)} placeholder="00.000.000/0001-00" />
              {c.cnpj && <p className="text-2xs text-status-success mt-0.5">✓</p>}
            </div>
          </div>

          <div>
            <Label className="text-xs">Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="contato@empresa.com" />
            {c.email && <p className="text-2xs text-status-success mt-0.5">✓</p>}
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <Label className="text-xs">Cidade</Label>
              <Input value={cidade} onChange={(e) => setCidade(e.target.value)} />
              {c.cidade && <p className="text-2xs text-status-success mt-0.5">✓</p>}
            </div>
            <div>
              <Label className="text-xs">UF</Label>
              <Input value={estado} onChange={(e) => setEstado(e.target.value)} maxLength={2} />
              {c.estado && <p className="text-2xs text-status-success mt-0.5">✓</p>}
            </div>
          </div>

          <div>
            <Label className="text-xs">Segmento</Label>
            <Input value={segmento} onChange={(e) => setSegmento(e.target.value)} placeholder="marcenaria, indústria moveleira..." />
            {c.segmento && <p className="text-2xs text-status-success mt-0.5">✓</p>}
          </div>

          {c.produtos_interesse.length > 0 && (
            <div>
              <Label className="text-xs">Produtos de interesse detectados</Label>
              <div className="flex flex-wrap gap-1 mt-1">
                {c.produtos_interesse.map((p) => (
                  <Badge key={p} variant="outline" className="text-2xs">{p}</Badge>
                ))}
              </div>
            </div>
          )}

          {c.tags_detectadas.length > 0 && (
            <div>
              <Label className="text-xs">Tags detectadas (serão salvas)</Label>
              <div className="flex flex-wrap gap-1 mt-1">
                {c.tags_detectadas.map((t) => (
                  <Badge key={t} variant="outline" className="text-[10px]">{t}</Badge>
                ))}
              </div>
            </div>
          )}

          {c.volume_mensal_litros && (
            <div className="text-2xs text-muted-foreground">
              Volume mencionado: <strong>{c.volume_mensal_litros}L/mês</strong>
            </div>
          )}

          {c.observacoes && (
            <div className="text-2xs text-muted-foreground italic border-l-2 border-status-warning pl-2">
              {c.observacoes}
            </div>
          )}

          <div className="flex items-center gap-2 pt-2 border-t border-border">
            <Button
              variant="outline"
              size="sm"
              onClick={dismissLastCallCapture}
              disabled={create.isPending}
              className="gap-1.5"
            >
              <X className="w-3.5 h-3.5" />
              Descartar
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!razaoSocial.trim() || create.isPending}
              className="gap-1.5 flex-1"
            >
              {create.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
              Cadastrar prospect
            </Button>
          </div>

          <p className="text-2xs text-muted-foreground text-center">
            Próxima chamada deste número será auto-identificada.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
