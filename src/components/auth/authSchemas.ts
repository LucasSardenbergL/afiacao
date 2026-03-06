import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email('E-mail inválido'),
  password: z.string().min(6, 'A senha deve ter pelo menos 6 caracteres'),
});

export const documentSchema = z.object({
  document: z.string().min(11, 'Informe um CPF ou CNPJ válido').max(18, 'Documento inválido'),
});

export const signupSchema = z.object({
  name: z.string().min(2, 'O nome deve ter pelo menos 2 caracteres'),
  tradeName: z.string().optional(),
  email: z.string().email('E-mail inválido'),
  phone: z.string().min(10, 'Telefone inválido'),
  password: z.string().min(6, 'A senha deve ter pelo menos 6 caracteres'),
  confirmPassword: z.string(),
  street: z.string().min(3, 'Endereço é obrigatório'),
  number: z.string().min(1, 'Número é obrigatório'),
  complement: z.string().optional(),
  neighborhood: z.string().min(2, 'Bairro é obrigatório'),
  city: z.string().min(2, 'Cidade é obrigatória'),
  state: z.string().length(2, 'UF deve ter 2 letras'),
  zipCode: z.string().min(8, 'CEP inválido'),
}).refine((data) => data.password === data.confirmPassword, {
  message: 'As senhas não coincidem',
  path: ['confirmPassword'],
});

export type AuthMode = 'login' | 'signup';
export type SignupStep = 'document' | 'form' | 'tools';

export interface OmieClienteData {
  codigo_cliente?: number;
  razao_social?: string;
  nome_fantasia?: string;
  cnpj_cpf?: string;
  email?: string;
  telefone?: string;
  endereco?: string;
  endereco_numero?: string;
  complemento?: string;
  bairro?: string;
  cidade?: string;
  estado?: string;
  cep?: string;
  pessoa_fisica?: string;
}

export interface ToolCategory {
  id: string;
  name: string;
  description: string;
  icon: string;
  usage_type: string;
  suggested_interval_days: number;
}

export interface AuthFormData {
  document: string;
  name: string;
  tradeName: string;
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
  street: string;
  number: string;
  complement: string;
  neighborhood: string;
  city: string;
  state: string;
  zipCode: string;
}

export const INITIAL_FORM_DATA: AuthFormData = {
  document: '', name: '', tradeName: '', email: '', phone: '',
  password: '', confirmPassword: '', street: '', number: '', complement: '',
  neighborhood: '', city: '', state: '', zipCode: '',
};

export const BRAZILIAN_STATES = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA',
  'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN',
  'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
];

export const formatDocument = (value: string): string => {
  const numbers = value.replace(/\D/g, '');
  if (numbers.length <= 11) {
    return numbers
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  } else {
    return numbers
      .replace(/(\d{2})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1/$2')
      .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
  }
};

export const formatPhone = (value: string): string => {
  const numbers = value.replace(/\D/g, '');
  if (numbers.length <= 10) {
    return numbers
      .replace(/(\d{2})(\d)/, '($1) $2')
      .replace(/(\d{4})(\d)/, '$1-$2');
  } else {
    return numbers
      .replace(/(\d{2})(\d)/, '($1) $2')
      .replace(/(\d{5})(\d)/, '$1-$2');
  }
};

export const formatZipCode = (value: string): string => {
  const numbers = value.replace(/\D/g, '');
  return numbers.replace(/(\d{5})(\d)/, '$1-$2');
};

export const handleInputFormat = (field: string, value: string): string => {
  if (field === 'document') return formatDocument(value);
  if (field === 'phone') return formatPhone(value);
  if (field === 'zipCode') return formatZipCode(value);
  if (field === 'state') return value.toUpperCase().slice(0, 2);
  return value;
};
