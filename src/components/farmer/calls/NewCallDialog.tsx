// Diálogo de registro de ligação (formulário) da página de Ligações.
// Extraído de src/pages/FarmerCalls.tsx (god-component split). Componente controlado:
// todo o estado vive no pai e desce via props.
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  Phone, PhoneOff, Play, Pause, Search, Timer, CheckCircle, XCircle,
  Loader2, PhoneCall, PhoneIncoming,
} from 'lucide-react';
import { CALL_TYPES, CALL_RESULTS, formatTimer, type Customer } from './types';

export function NewCallDialog({
  open, onOpenChange,
  selectedCustomer, setSelectedCustomer,
  customerSearch, setCustomerSearch, customers, setCustomers, searchLoading,
  callType, setCallType, callResult, setCallResult,
  attemptNumber, setAttemptNumber, notes, setNotes, revenue, setRevenue, margin, setMargin,
  callSeconds, followUpSeconds, isCallActive, isFollowUpActive,
  nvoipIsConnecting, nvoipIsRinging, nvoipIsEstablished, nvoipIsActive, nvoipError, callBackend,
  saving,
  onStartCall, onStopCall, onStartFollowUp, onStopFollowUp, onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCustomer: Customer | null;
  setSelectedCustomer: (c: Customer | null) => void;
  customerSearch: string;
  setCustomerSearch: (s: string) => void;
  customers: Customer[];
  setCustomers: (c: Customer[]) => void;
  searchLoading: boolean;
  callType: string;
  setCallType: (s: string) => void;
  callResult: string;
  setCallResult: (s: string) => void;
  attemptNumber: number;
  setAttemptNumber: (n: number) => void;
  notes: string;
  setNotes: (s: string) => void;
  revenue: string;
  setRevenue: (s: string) => void;
  margin: string;
  setMargin: (s: string) => void;
  callSeconds: number;
  followUpSeconds: number;
  isCallActive: boolean;
  isFollowUpActive: boolean;
  nvoipIsConnecting: boolean;
  nvoipIsRinging: boolean;
  nvoipIsEstablished: boolean;
  nvoipIsActive: boolean;
  nvoipError: string | null;
  callBackend: string;
  saving: boolean;
  onStartCall: () => void;
  onStopCall: () => void;
  onStartFollowUp: () => void;
  onStopFollowUp: () => void;
  onSave: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Phone className="w-5 h-5" /> Registrar ligação
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {/* Customer Search */}
          <div>
            <label className="text-sm font-medium">Cliente</label>
            {selectedCustomer ? (
              <div className="flex items-center justify-between bg-muted/50 rounded-lg p-3 mt-1">
                <div>
                  <p className="text-sm font-medium">{selectedCustomer.name}</p>
                  <p className="text-xs text-muted-foreground">{selectedCustomer.phone || selectedCustomer.email}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setSelectedCustomer(null)}>
                  <XCircle className="w-4 h-4" />
                </Button>
              </div>
            ) : (
              <div className="mt-1">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input placeholder="Buscar cliente..." value={customerSearch} onChange={e => setCustomerSearch(e.target.value)} className="pl-9 h-9" />
                </div>
                {searchLoading && <div className="flex justify-center py-2"><Loader2 className="w-4 h-4 animate-spin" /></div>}
                {customers.length > 0 && (
                  <div className="border rounded-lg mt-1 max-h-60 overflow-y-auto">
                    {customers.map((c, idx) => (
                      <button key={`${c.user_id || c.omie_codigo_cliente || c.document}-${idx}`}
                        onClick={() => { setSelectedCustomer(c); setCustomerSearch(''); setCustomers([]); }}
                        className="w-full text-left px-3 py-2 hover:bg-muted/50 text-sm border-b last:border-b-0">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-medium truncate">{c.name}</p>
                          {c.omie_codigo_cliente && (
                            <Badge variant="outline" className="text-[10px] shrink-0">Omie</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          {[c.document, c.phone, c.email].filter(Boolean).join(' · ') || 'Sem contato'}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <Select value={callType} onValueChange={setCallType}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>{CALL_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
          </Select>

          {/* Timers */}
          <Card className="bg-muted/30">
            <CardContent className="p-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="text-center">
                  <p className="text-xs text-muted-foreground mb-1">Ligação</p>
                  <p className="text-2xl font-mono font-bold">{formatTimer(callSeconds)}</p>
                  {selectedCustomer?.phone ? (
                    <Badge variant="outline" className="text-[10px] mt-1">
                      {nvoipIsConnecting && <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Conectando...</>}
                      {nvoipIsRinging && <><PhoneCall className="w-3 h-3 mr-1 animate-pulse" /> Tocando ramal/destino</>}
                      {nvoipIsEstablished && <><PhoneIncoming className="w-3 h-3 mr-1 text-emerald-600" /> Em chamada</>}
                      {!nvoipIsActive && !nvoipIsEstablished && (
                        <>📞 Disca via {callBackend === 'webrtc' ? 'WebRTC' : 'Nvoip'} → {selectedCustomer.phone}</>
                      )}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] mt-1 text-amber-700">
                      Sem telefone — cronômetro manual
                    </Badge>
                  )}
                  <Button size="sm" variant={isCallActive ? 'destructive' : 'default'} className="mt-2 w-full h-8"
                    onClick={isCallActive ? onStopCall : onStartCall}
                    disabled={nvoipIsConnecting}>
                    {isCallActive ? <><PhoneOff className="w-3 h-3 mr-1" /> Parar</> : <><Play className="w-3 h-3 mr-1" /> Iniciar</>}
                  </Button>
                  {nvoipError && (
                    <p className="text-[10px] text-destructive mt-1">{nvoipError}</p>
                  )}
                </div>
                <div className="text-center">
                  <p className="text-xs text-muted-foreground mb-1">Follow-up</p>
                  <p className="text-2xl font-mono font-bold">{formatTimer(followUpSeconds)}</p>
                  <Button size="sm" variant={isFollowUpActive ? 'destructive' : 'outline'} className="mt-2 w-full h-8"
                    onClick={isFollowUpActive ? onStopFollowUp : onStartFollowUp}>
                    {isFollowUpActive ? <><Pause className="w-3 h-3 mr-1" /> Parar</> : <><Timer className="w-3 h-3 mr-1" /> Iniciar</>}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Select value={callResult} onValueChange={setCallResult}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>{CALL_RESULTS.map(r => <SelectItem key={r.value} value={r.value}>{r.icon} {r.label}</SelectItem>)}</SelectContent>
          </Select>

          <Input type="number" min={1} value={attemptNumber} onChange={e => setAttemptNumber(parseInt(e.target.value) || 1)} className="h-9" placeholder="Nº da tentativa" />

          {callResult === 'contato_sucesso' && (
            <div className="grid grid-cols-2 gap-3">
              <Input type="number" step="0.01" placeholder="Receita (R$)" value={revenue} onChange={e => setRevenue(e.target.value)} className="h-9" />
              <Input type="number" step="0.01" placeholder="Margem (R$)" value={margin} onChange={e => setMargin(e.target.value)} className="h-9" />
            </div>
          )}

          <Textarea placeholder="Observações da ligação..." value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={onSave} disabled={!selectedCustomer || saving} className="gap-1.5">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />} Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
