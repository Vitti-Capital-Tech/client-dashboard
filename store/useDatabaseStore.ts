import { create } from 'zustand';
import {
  Database,
  INITIAL_DATABASE,
  scanAlerts,
  seedAudits,
  mutatePlaceBid,
  mutateWithdrawBid,
  mutateScaleBids,
  mutateUpdatePlacementStage,
  mutateAckAlert,
  mutateAddCustomAlert,
  mutateClientBpayPayment,
  Alert,
  AuditEntry,
  TODAY
} from "@/lib/db";

interface DatabaseState {
  db: Database;
  role: "client" | "admin";
  clientId: string;
  viewClient: string;
  currentUserLabel: string;
  setRole: (role: "client" | "admin") => void;
  setClientId: (id: string) => void;
  setViewClient: (id: string) => void;
  placeBid: (placementId: string, amount: number) => void;
  withdrawBid: (placementId: string) => void;
  scaleBids: (placementId: string, clientAllocations: Record<string, number | null>) => void;
  updatePlacementStage: (placementId: string, stage: "open" | "closed" | "upcoming" | "settled") => void;
  ackAlert: (alertId: string) => void;
  addCustomAlert: (code: string, threshold: number, direction: "above" | "below") => void;
  notifyBpayPayment: (placementId: string) => void;
}

const initialDb = { ...INITIAL_DATABASE };
initialDb.alerts = scanAlerts(initialDb, TODAY);
initialDb.audit = seedAudits();

export const useDatabaseStore = create<DatabaseState>((set, get) => ({
  db: initialDb,
  role: "client",
  clientId: "C1",
  viewClient: "C1",
  
  get currentUserLabel() {
    const state = get();
    return state.role === "admin" ? "S. Goyal (staff)" : state.db.clients[state.clientId]?.name || state.clientId;
  },

  setRole: (newRole) => set((state) => {
    const userLabel = newRole === "admin" ? "S. Goyal (staff)" : state.db.clients[state.clientId]?.name || state.clientId;
    const detail = newRole === "admin" ? "Vitti staff console · 2FA verified" : "Client portal · 2FA verified";
    
    const auditEntry: AuditEntry = {
      ts: new Date(),
      user: userLabel,
      role: newRole,
      action: "Signed in",
      detail
    };

    return {
      role: newRole,
      db: {
        ...state.db,
        audit: [auditEntry, ...state.db.audit]
      }
    };
  }),

  setClientId: (id) => set({ clientId: id }),
  setViewClient: (id) => set({ viewClient: id }),

  placeBid: (placementId, amount) => set((state) => ({
    db: mutatePlaceBid(state.db, placementId, state.clientId, amount, state.currentUserLabel)
  })),

  withdrawBid: (placementId) => set((state) => ({
    db: mutateWithdrawBid(state.db, placementId, state.clientId, state.currentUserLabel)
  })),

  scaleBids: (placementId, clientAllocations) => set((state) => ({
    db: mutateScaleBids(state.db, placementId, clientAllocations, state.currentUserLabel)
  })),

  updatePlacementStage: (placementId, stage) => set((state) => ({
    db: mutateUpdatePlacementStage(state.db, placementId, stage, state.currentUserLabel)
  })),

  ackAlert: (alertId) => set((state) => ({
    db: mutateAckAlert(state.db, alertId, state.currentUserLabel)
  })),

  addCustomAlert: (code, threshold, direction) => set((state) => ({
    db: mutateAddCustomAlert(state.db, state.clientId, code, threshold, direction, state.currentUserLabel)
  })),

  notifyBpayPayment: (placementId) => set((state) => ({
    db: mutateClientBpayPayment(state.db, placementId, state.clientId, state.currentUserLabel)
  }))
}));
