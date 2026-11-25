import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BackendClient } from "../../client/backend";
import { BackendProvider } from "../../client/react";
import { SessionContext } from "../../lib/session";
import { useMachine } from "../../components/dashboard/chat/panel/machine";
import type { Id } from "../../convex/_generated/dataModel";

const client = new BackendClient();
function Machine() {
  const machine = useMachine("synthetic-conversation" as Id<"conversations">);
  Object.assign(window, { machineActions: machine });
  return <output id="state">{JSON.stringify({ busy: machine.busy, error: machine.error })}</output>;
}
function Fixture() {
  const [mounted, setMounted] = useState(true);
  Object.assign(window, { mountMachine: setMounted, closeBackend: () => client.close() });
  return <BackendProvider client={client}><SessionContext.Provider value={{ dashboardKey: "synthetic", lock: () => {} }}>{mounted ? <Machine /> : <output id="unmounted">Unmounted</output>}</SessionContext.Provider></BackendProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
