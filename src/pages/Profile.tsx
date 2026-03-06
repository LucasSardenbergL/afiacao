import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, Phone, Mail, ChevronRight, LogOut, HelpCircle, Loader2, Wrench, Camera, Pencil, Fingerprint, Scan, Check, X, Plus, Clock } from 'lucide-react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SharpeningSuggestions } from '@/components/SharpeningSuggestions';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { useBiometricAuth } from '@/hooks/useBiometricAuth';
import { useUserRole } from '@/hooks/useUserRole';
import { useProfile, useProfileStats } from '@/queries/useProfile';
import { useQueryClient } from '@tanstack/react-query';


const Profile = () => {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { toast } = useToast();
  const { isStaff } = useUserRole();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  
  const { data: profile, isLoading: loading } = useProfile(user?.id);
  const { data: stats } = useProfileStats(user?.id);
  const addressCount = stats?.addressCount ?? 0;
  const orderCount = stats?.orderCount ?? 0;
  const toolCount = stats?.toolCount ?? 0;
  
  const [uploading, setUploading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editDocument, setEditDocument] = useState('');
  const [editBusinessOpen, setEditBusinessOpen] = useState('');
  const [editBusinessClose, setEditBusinessClose] = useState('');
  const [editLunchStart, setEditLunchStart] = useState('');
  const [editLunchEnd, setEditLunchEnd] = useState('');
  const [editDeliveryTime, setEditDeliveryTime] = useState('');
  const [saving, setSaving] = useState(false);
  
  const { isSupported: biometricSupported, isRegistered: biometricRegistered, isLoading: biometricLoading, register: registerBiometric, removeCredential: removeBiometric, checkRegistration } = useBiometricAuth();
  

  useEffect(() => {
    if (user) {
      checkRegistration(user.id);
    }
  }, [user, checkRegistration]);

  // Fallback profile for display when no DB profile exists
  const displayProfile = profile ?? {
    name: user?.email?.split('@')[0] || 'Usuário',
    email: user?.email || null,
    phone: null, document: null, customer_type: null, avatar_url: null,
    business_hours_open: null, business_hours_close: null,
    lunch_start: null, lunch_end: null, preferred_delivery_time: null,
  };

  const handleAvatarClick = () => {
    fileInputRef.current?.click();
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    if (!file.type.startsWith('image/')) {
      toast({
        title: 'Arquivo inválido',
        description: 'Por favor, selecione uma imagem',
        variant: 'destructive',
      });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: 'Arquivo muito grande',
        description: 'A imagem deve ter no máximo 5MB',
        variant: 'destructive',
      });
      return;
    }

    setUploading(true);

    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `${user.id}/avatar.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(fileName, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('avatars')
        .getPublicUrl(fileName);

      const { error: updateError } = await supabase
        .from('profiles')
        .update({ avatar_url: publicUrl })
        .eq('user_id', user.id);

      if (updateError) throw updateError;

      queryClient.invalidateQueries({ queryKey: ['profile', user.id] });

      toast({
        title: 'Foto atualizada!',
        description: 'Sua foto de perfil foi alterada com sucesso',
      });
    } catch (error) {
      console.error('Error uploading avatar:', error);
      toast({
        title: 'Erro ao enviar foto',
        description: 'Tente novamente mais tarde',
        variant: 'destructive',
      });
    } finally {
      setUploading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut();
      toast({
        title: 'Até logo!',
        description: 'Você saiu da sua conta',
      });
    } catch (error) {
      toast({
        title: 'Erro ao sair',
        description: 'Tente novamente',
        variant: 'destructive',
      });
    }
  };

  const handleEditClick = () => {
    setEditName(profile?.name || '');
    setEditPhone(profile?.phone || '');
    setEditEmail(profile?.email || '');
    setEditDocument(profile?.document || '');
    setEditBusinessOpen(profile?.business_hours_open || '');
    setEditBusinessClose(profile?.business_hours_close || '');
    setEditLunchStart(profile?.lunch_start || '');
    setEditLunchEnd(profile?.lunch_end || '');
    setEditDeliveryTime(profile?.preferred_delivery_time || '');
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  const handleSaveProfile = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const updateData: Record<string, unknown> = {
        name: editName,
        email: editEmail || null,
        phone: editPhone || null,
        document: editDocument?.replace(/\D/g, '') || null,
        business_hours_open: editBusinessOpen || null,
        business_hours_close: editBusinessClose || null,
        lunch_start: editLunchStart || null,
        lunch_end: editLunchEnd || null,
        preferred_delivery_time: editDeliveryTime || null,
      };

      // Validate delivery time against business hours and lunch
      if (editDeliveryTime && editBusinessOpen && editBusinessClose) {
        if (editDeliveryTime < editBusinessOpen || editDeliveryTime >= editBusinessClose) {
          toast({
            title: 'Horário inválido',
            description: `O horário de entrega deve ser entre ${editBusinessOpen} e ${editBusinessClose}`,
            variant: 'destructive',
          });
          setSaving(false);
          return;
        }
        if (editLunchStart && editLunchEnd && editDeliveryTime >= editLunchStart && editDeliveryTime < editLunchEnd) {
          toast({
            title: 'Horário inválido',
            description: `O horário de entrega não pode ser durante o almoço (${editLunchStart} - ${editLunchEnd})`,
            variant: 'destructive',
          });
          setSaving(false);
          return;
        }
      }

      const { error } = await supabase
        .from('profiles')
        .update(updateData)
        .eq('user_id', user.id);

      if (error) throw error;

      queryClient.invalidateQueries({ queryKey: ['profile', user.id] });

      setIsEditing(false);
      toast({
        title: 'Perfil atualizado!',
        description: 'Suas informações foram salvas com sucesso',
      });
    } catch (error) {
      console.error('Error saving profile:', error);
      toast({
        title: 'Erro ao salvar',
        description: 'Tente novamente mais tarde',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const menuItems = [
    { icon: Wrench, label: 'Minhas Ferramentas', count: toolCount, path: '/tools' },
    { icon: MapPin, label: 'Meus Endereços', count: addressCount, path: '/addresses' },
    { icon: HelpCircle, label: 'Ajuda e FAQ', path: '/support' },
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Meu Perfil" showBack showNotifications />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Meu Perfil" showBack showNotifications />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Profile card */}
        <div className="bg-card rounded-xl p-6 shadow-soft border border-border mb-6">
          <div className="flex items-center gap-4 mb-4">
            {/* Avatar with upload */}
            <div className="relative">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleAvatarUpload}
                className="hidden"
              />
              <button
                onClick={handleAvatarClick}
                disabled={uploading}
                className={cn(
                  'w-16 h-16 rounded-full overflow-hidden flex items-center justify-center transition-all',
                  uploading ? 'opacity-50' : 'hover:opacity-90',
                  profile?.avatar_url ? '' : 'bg-gradient-primary'
                )}
              >
                {uploading ? (
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                ) : profile?.avatar_url ? (
                  <img 
                    src={profile.avatar_url} 
                    alt="Avatar" 
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-2xl font-bold text-primary-foreground">
                    {profile?.name?.charAt(0).toUpperCase() || 'U'}
                  </span>
                )}
              </button>
              <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-primary flex items-center justify-center shadow-md">
                <Camera className="w-3 h-3 text-primary-foreground" />
              </div>
            </div>

            <div className="flex-1">
              <h2 className="font-display font-bold text-lg">{profile?.name || 'Usuário'}</h2>
              <div className="flex items-center gap-2">
                <p className="text-sm text-muted-foreground">
                  Cliente desde {new Date(user?.created_at || Date.now()).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' })}
                </p>
              </div>
              {profile?.customer_type && (
                <span className="inline-flex items-center text-xs px-2 py-0.5 rounded-full mt-1 bg-amber-100 text-amber-800">
                  Industrial
                </span>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={handleEditClick}>
              <Pencil className="w-3 h-3 mr-1" />
              Editar
            </Button>
          </div>

          {isEditing ? (
            <div className="space-y-3 border-t border-border pt-4">
              <div>
                <Label htmlFor="editName">Nome</Label>
                <Input id="editName" value={editName} onChange={e => setEditName(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="editEmail">E-mail</Label>
                <Input id="editEmail" type="email" value={editEmail} onChange={e => setEditEmail(e.target.value)} placeholder="seu@email.com" />
              </div>
              <div>
                <Label htmlFor="editPhone">Telefone</Label>
                <Input id="editPhone" value={editPhone} onChange={e => setEditPhone(e.target.value)} placeholder="(11) 99999-9999" />
              </div>
              <div>
                <Label htmlFor="editDocument">CPF/CNPJ</Label>
                <Input id="editDocument" value={editDocument} onChange={e => setEditDocument(e.target.value)} placeholder="000.000.000-00" />
              </div>
              {!isStaff && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="editOpen">Horário Abertura</Label>
                      <Input id="editOpen" type="time" value={editBusinessOpen} onChange={e => setEditBusinessOpen(e.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="editClose">Horário Fechamento</Label>
                      <Input id="editClose" type="time" value={editBusinessClose} onChange={e => setEditBusinessClose(e.target.value)} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="editLunchStart">Início Almoço</Label>
                      <Input id="editLunchStart" type="time" value={editLunchStart} onChange={e => setEditLunchStart(e.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="editLunchEnd">Fim Almoço</Label>
                      <Input id="editLunchEnd" type="time" value={editLunchEnd} onChange={e => setEditLunchEnd(e.target.value)} />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="editDelivery">Horário Preferido de Entrega</Label>
                    <Input id="editDelivery" type="time" value={editDeliveryTime} onChange={e => setEditDeliveryTime(e.target.value)} placeholder="Ex: 14:30" />
                    <p className="text-xs text-muted-foreground mt-1">
                      Deve ser dentro do horário comercial e fora do almoço
                    </p>
                  </div>
                </>
              )}
              <div className="flex gap-2 pt-2">
                <Button onClick={handleSaveProfile} disabled={saving} className="flex-1">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Check className="w-4 h-4 mr-1" />}
                  Salvar
                </Button>
                <Button variant="outline" onClick={handleCancelEdit} disabled={saving}>
                  <X className="w-4 h-4 mr-1" />
                  Cancelar
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2 text-sm">
                {profile?.phone && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Phone className="w-4 h-4" />
                    <span>{profile.phone}</span>
                  </div>
                )}
                {profile?.email && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Mail className="w-4 h-4" />
                    <span>{profile.email}</span>
                  </div>
                )}
                {!isStaff && (profile?.business_hours_open || profile?.business_hours_close) && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Clock className="w-4 h-4" />
                    <span>Funcionamento: {profile.business_hours_open || '--:--'} às {profile.business_hours_close || '--:--'}</span>
                  </div>
                )}
                {!isStaff && (profile?.lunch_start || profile?.lunch_end) && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Clock className="w-4 h-4" />
                    <span>Almoço: {profile.lunch_start || '--:--'} às {profile.lunch_end || '--:--'}</span>
                  </div>
                )}
                {!isStaff && profile?.preferred_delivery_time && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Clock className="w-4 h-4" />
                    <span>Entrega preferida: {profile.preferred_delivery_time}</span>
                  </div>
                )}
              </div>

              {/* Stats */}
              <div className="flex gap-4 mt-4 pt-4 border-t border-border">
                <div className="flex-1 text-center">
                  <p className="text-2xl font-bold text-primary">{orderCount}</p>
                  <p className="text-xs text-muted-foreground">Pedidos</p>
                </div>
                <div className="flex-1 text-center border-l border-border">
                  <p className="text-2xl font-bold text-foreground">{toolCount}</p>
                  <p className="text-xs text-muted-foreground">Ferramentas</p>
                </div>
                <div className="flex-1 text-center border-l border-border">
                  <p className="text-2xl font-bold text-foreground">{addressCount}</p>
                  <p className="text-xs text-muted-foreground">Endereços</p>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="mb-6">
          <h3 className="font-display font-bold text-lg mb-3">Agenda de Afiação</h3>
          <SharpeningSuggestions />
          <Button 
            variant="outline" 
            className="w-full mt-3"
            onClick={() => navigate('/tools')}
          >
            <Plus className="w-4 h-4 mr-2" />
            Adicionar Ferramenta
          </Button>
        </div>
        {/* Biometric Settings - hidden for now */}

        {/* Menu items */}
        <div className="bg-card rounded-xl shadow-soft border border-border overflow-hidden mb-6">
          {menuItems.map((item) => (
            <button
              key={item.label}
              onClick={() => item.path && navigate(item.path)}
              className="w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors border-b border-border last:border-b-0"
            >
              <item.icon className="w-5 h-5 text-muted-foreground" />
              <span className="flex-1 text-left font-medium">{item.label}</span>
              {item.count !== undefined && item.count > 0 && (
                <span className="text-sm text-muted-foreground">{item.count}</span>
              )}
              <ChevronRight className="w-5 h-5 text-muted-foreground" />
            </button>
          ))}
        </div>

        {/* Logout */}
        <Button 
          variant="outline" 
          className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={handleLogout}
        >
          <LogOut className="w-4 h-4 mr-2" />
          Sair da conta
        </Button>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Versão 1.0.0
        </p>
      </main>

      <BottomNav />
    </div>
  );
};

export default Profile;
