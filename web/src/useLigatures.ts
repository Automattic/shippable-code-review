import { useEffect, useState } from "react";
import { getStoredLigatures, persistLigatures } from "./ligatures";

export function useLigatures() {
  const [ligatures, setLigatures] = useState(getStoredLigatures);

  useEffect(() => {
    document.documentElement.dataset.ligatures = ligatures ? "on" : "off";
    persistLigatures(ligatures);
  }, [ligatures]);

  return [ligatures, setLigatures] as const;
}
