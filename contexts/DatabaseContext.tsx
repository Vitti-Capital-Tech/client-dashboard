"use client";

import React, { createContext, useContext, useState } from "react";
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

interface DatabaseContextType {
  db: Database;
  role: "client" | "admin";
  clientId: string;
  viewClient: string;
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
  currentUserLabel: string;
}

const DatabaseContext = createContext<DatabaseContextType | undefined>(undefined);

export function DatabaseProvider({ children }: { children: React.ReactNode }) {
  const [db, setDb] = useState<Database>(() => {
    // Initialize DB with seed alerts and seed audits
    const initialDb = { ...INITIAL_DATABASE };
    initialDb.alerts = scanAlerts(initialDb, TODAY);
    initialDb.audit = seedAudits();
    return initialDb;
  });

  const [role, setRoleState] = useState<"client" | "admin">("client");
  const [clientId, setClientId] = useState<string>("C1");
  const [viewClient, setViewClient] = useState<string>("C1");

  const currentUserLabel = role === "admin" ? "S. Goyal (staff)" : db.clients[clientId]?.name || clientId;

  const setRole = (newRole: "client" | "admin") => {
    setRoleState(newRole);
    // Add audit entry for signing in
    const userLabel = newRole === "admin" ? "S. Goyal (staff)" : db.clients[clientId]?.name || clientId;
    const detail = newRole === "admin" ? "Vitti staff console · 2FA verified" : "Client portal · 2FA verified";
    
    setDb(prev => {
      const auditEntry: AuditEntry = {
        ts: new Date(),
        user: userLabel,
        role: newRole,
        action: "Signed in",
        detail
      };
      return {
        ...prev,
        audit: [auditEntry, ...prev.audit]
      };
    });
  };



  const placeBid = (placementId: string, amount: number) => {
    setDb(prev => mutatePlaceBid(prev, placementId, clientId, amount, currentUserLabel));
  };

  const withdrawBid = (placementId: string) => {
    setDb(prev => mutateWithdrawBid(prev, placementId, clientId, currentUserLabel));
  };

  const scaleBids = (placementId: string, clientAllocations: Record<string, number | null>) => {
    setDb(prev => mutateScaleBids(prev, placementId, clientAllocations, currentUserLabel));
  };

  const updatePlacementStage = (placementId: string, stage: "open" | "closed" | "upcoming" | "settled") => {
    setDb(prev => mutateUpdatePlacementStage(prev, placementId, stage, currentUserLabel));
  };

  const ackAlert = (alertId: string) => {
    setDb(prev => mutateAckAlert(prev, alertId, currentUserLabel));
  };

  const addCustomAlert = (code: string, threshold: number, direction: "above" | "below") => {
    setDb(prev => mutateAddCustomAlert(prev, clientId, code, threshold, direction, currentUserLabel));
  };

  const notifyBpayPayment = (placementId: string) => {
    setDb(prev => mutateClientBpayPayment(prev, placementId, clientId, currentUserLabel));
  };

  return (
    <DatabaseContext.Provider
      value={{
        db,
        role,
        clientId,
        viewClient,
        setRole,
        setClientId,
        setViewClient,
        placeBid,
        withdrawBid,
        scaleBids,
        updatePlacementStage,
        ackAlert,
        addCustomAlert,
        notifyBpayPayment,
        currentUserLabel
      }}
    >
      {children}
    </DatabaseContext.Provider>
  );
}

export function useDatabase() {
  const context = useContext(DatabaseContext);
  if (context === undefined) {
    throw new Error("useDatabase must be used within a DatabaseProvider");
  }
  return context;
}
