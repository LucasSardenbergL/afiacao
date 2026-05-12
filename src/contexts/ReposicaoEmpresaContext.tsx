import { createContext, useContext } from "react";

interface ReposicaoEmpresaContextType {
  empresa: string;
  setEmpresa: (e: string) => void;
}

const ReposicaoEmpresaContext = createContext<ReposicaoEmpresaContextType>({
  empresa: "OBEN",
  setEmpresa: () => {},
});

export const ReposicaoEmpresaProvider = ReposicaoEmpresaContext.Provider;
export const useReposicaoEmpresa = () => useContext(ReposicaoEmpresaContext);
