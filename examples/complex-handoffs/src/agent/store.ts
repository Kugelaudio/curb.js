import { createAgentStore } from "curb";

export type Customer = { id: string; name: string; plan: string };

/** What every skill shares. It outlives a skill being unloaded; a skill's `useState` does not. */
export const useCase = createAgentStore<{
  customer: Customer | null;
  transferFailed: boolean;
  setCustomer: (customer: Customer) => void;
  setTransferFailed: () => void;
}>("case", (set) => ({
  customer: null,
  transferFailed: false,
  setCustomer: (customer) => set({ customer }),
  setTransferFailed: () => set({ transferFailed: true }),
}));

/** Your CRM. Replace it with a call to your own API. */
export const CUSTOMERS: Record<string, Customer> = {
  "4711": { id: "4711", name: "Sam Weber", plan: "Green 12" },
};
