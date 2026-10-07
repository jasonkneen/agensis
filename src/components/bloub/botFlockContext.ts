import { createContext, useContext } from "react";

export type FlockApi = {
  register: (id: string, el: HTMLElement) => () => void;
  others: (id: string) => DOMRect[];
};

export const Flock = createContext<FlockApi | null>(null);

export function useFlock(): FlockApi | null {
  return useContext(Flock);
}
