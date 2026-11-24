"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import type { Id } from "@/convex/_generated/dataModel";
import type { DeviceInventory } from "@/lib/machine-protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MachineHeader, useMachine } from "./machine";
import { readCapped, writeCapped } from "./store";

const savedDevice = z.object({ sessionId: z.string().default(""), runnerId: z.string().default("") });

export function DevicesSurface({ conversationId }: { conversationId: Id<"conversations"> }) {
  const machine = useMachine(conversationId);
  const [inventory, setInventory] = useState<DeviceInventory>(), [device, setDevice] = useState(""), [app, setApp] = useState("");
  const [session, setSession] = useState(""), [image, setImage] = useState<{ image: string; width: number; height: number }>(), [text, setText] = useState("");
  const [x, setX] = useState(0), [y, setY] = useState(0);
  useEffect(() => { const saved = readCapped("perry.device", conversationId, savedDevice); setSession(saved.runnerId === machine.state?.runner?.id ? saved.sessionId : ""); setImage(undefined); }, [conversationId, machine.state?.runner?.id]);
  function remember(sessionId: string) { setSession(sessionId); writeCapped("perry.device", conversationId, { sessionId, runnerId: machine.state?.runner?.id ?? "" }); }
  const capture = (id = session) => machine.run<{ image: string; width: number; height: number }>({ kind: "device.screenshot", sessionId: id }).then(setImage);
  return <section className="flex min-h-0 flex-1 flex-col" data-surface="devices" aria-label="Devices">
    <MachineHeader machine={machine} />
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      {!session ? <><div className="flex items-center justify-between"><span className="text-sm font-medium">Simulators and devices</span><Button size="sm" variant="outline" disabled={machine.busy || !machine.state?.runner?.online} onClick={() => void machine.run<DeviceInventory>({ kind: "devices.list" }).then(result => { setInventory(result); setDevice(result.devices[0]?.id ?? ""); }).catch(() => {})}>{machine.busy ? "Checking…" : "Discover"}</Button></div>
        <p className="text-xs text-muted-foreground">Android needs the Android SDK. iOS needs Xcode on a Mac. Each panel opens its own agent-device session.</p>
        {inventory?.detail && <p role="status" className="whitespace-pre-wrap text-sm text-muted-foreground">{inventory.detail}</p>}
        {!!inventory?.devices.length && <form className="space-y-3" onSubmit={event => { event.preventDefault(); const chosen = inventory.devices.find(item => item.id === device); if (chosen) void machine.run<{ sessionId: string }>({ kind: "device.open", platform: chosen.platform, deviceId: chosen.id, app }).then(result => { remember(result.sessionId); return capture(result.sessionId); }).catch(() => {}); }}>
          <label className="block space-y-1 text-xs"><span>Device</span><Select value={device} onValueChange={value => setDevice(value ?? "")}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{inventory.devices.map(item => <SelectItem key={item.id} value={item.id}>{item.name} · {item.platform}</SelectItem>)}</SelectContent></Select></label>
          <label className="block space-y-1 text-xs"><span>App name or bundle/package ID</span><Input required value={app} onChange={event => setApp(event.target.value)} placeholder="com.example.app" /></label><Button size="sm" type="submit" disabled={machine.busy || !device || !app.trim()}>Open app</Button>
        </form>}
      </> : <><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={machine.busy} onClick={() => void capture().catch(() => {})}>Refresh screen</Button>{(["back", "home"] as const).map(action => <Button key={action} size="sm" variant="ghost" disabled={machine.busy} onClick={() => void machine.run<{ image: string; width: number; height: number }>({ kind: "device.action", sessionId: session, action }).then(setImage).catch(() => {})}>{action}</Button>)}<Button size="sm" variant="ghost" disabled={machine.busy} onClick={() => void machine.run({ kind: "device.close", sessionId: session }).then(() => { remember(""); setImage(undefined); }).catch(() => {})}>Close device</Button></div>
        {image && <button type="button" className="mx-auto block max-w-full cursor-crosshair rounded border outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Device screen; click to tap" disabled={machine.busy} onClick={event => { if (!event.detail) return; const bounds = event.currentTarget.getBoundingClientRect(); void machine.run<{ image: string; width: number; height: number }>({ kind: "device.action", sessionId: session, action: "tap", x: Math.round((event.clientX - bounds.left) / bounds.width * image.width), y: Math.round((event.clientY - bounds.top) / bounds.height * image.height) }).then(setImage).catch(() => {}); }}><img src={image.image} alt="Current device screen" className="max-h-[60dvh] max-w-full object-contain" /></button>}
        <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void machine.run<{ image: string; width: number; height: number }>({ kind: "device.action", sessionId: session, action: "type", text }).then(result => { setText(""); setImage(result); }).catch(() => {}); }}><Input aria-label="Type on device" value={text} maxLength={4000} onChange={event => setText(event.target.value)} /><Button type="submit" size="sm" disabled={machine.busy || !text}>Type</Button></form>
        <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void machine.run<{ image: string; width: number; height: number }>({ kind: "device.action", sessionId: session, action: "tap", x, y }).then(setImage).catch(() => {}); }}><Input type="number" min={0} max={image ? image.width - 1 : 10000} aria-label="Tap X coordinate" value={x} onChange={event => setX(Number(event.target.value))} /><Input type="number" min={0} max={image ? image.height - 1 : 10000} aria-label="Tap Y coordinate" value={y} onChange={event => setY(Number(event.target.value))} /><Button type="submit" size="sm" disabled={machine.busy}>Tap</Button></form>
      </>}
    </div>
  </section>;
}
