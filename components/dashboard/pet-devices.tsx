"use client";

import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { PetDeviceView } from "@/convex/pet";
import { errorText, useNow } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ActionButton, CodeDisplay, CommandLine, List, RelativeTime, StatusBadge } from "./common";

const PLATFORMS: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };
const INSTALLER = "https://raw.githubusercontent.com/TheM1N9/perry/main";

/**
 * The pet on the owner's other computers (convex/pet.ts): each one paired,
 * when it was last heard from, which one they are at, and a button to remove
 * it, which takes its key away. Add a computer makes a pairing code, good
 * once and for ten minutes, and shows the line to paste there, which installs
 * just the pet and pairs it.
 */
export function PetDevices() {
  const { dashboardKey } = useSession();
  const view = useQuery(api.pet.devices, { key: dashboardKey });
  const pair = useMutation(api.pet.pair);
  const cancel = useMutation(api.pet.cancelPairing);
  const remove = useMutation(api.pet.removeDevice);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [making, setMaking] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const pairedBefore = useRef<number | null>(null);

  // Used: the code is gone from the server, and a new computer is on the list.
  const open = view?.pairing ?? null;
  const count = view?.devices.length ?? 0;
  useEffect(() => {
    if (!code || !view) return;
    if (!open) {
      if (pairedBefore.current !== null && count > pairedBefore.current) toast.success(`${view.devices[1]?.name ?? "The computer"} is paired. Its pet is on that screen.`);
      setCode(null);
    }
  }, [code, open, count, view]);

  if (view === undefined) return <Skeleton className="mt-6 h-16 rounded-xl" />;

  // The address this page is open at, when it is not this computer's own name for itself: the other computer can likely use it too.
  const here = typeof window !== "undefined" && !/^(localhost|127\.|\[?::1\]?$)/.test(window.location.hostname) ? window.location.hostname : null;
  const addresses = [...(here && !view.addresses.some((a) => a.address === here) ? [{ address: here, tailscale: /\.ts\.net$/.test(here) }] : []), ...view.addresses];
  const address = picked && addresses.some((a) => a.address === picked) ? picked : here ?? addresses[0]?.address;
  const server = address ? `http://${address}:${view.port}` : null;
  const others = view.devices.filter((device) => device.id !== null);

  const start = async () => {
    setMaking(true);
    try {
      pairedBefore.current = view.devices.length;
      setCode(await pair({ key: dashboardKey }));
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setMaking(false);
    }
  };

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">On your other computers</h3>
        </div>
        {!code && (
          <Button variant="outline" disabled={making || view.loopbackOnly} onClick={() => void start()}>
            <PlusIcon />Add a computer
          </Button>
        )}
      </div>

      {view.loopbackOnly && (
        <p className="mt-3 flex items-start gap-1.5 text-sm text-muted-foreground">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
          Perry listens on this computer alone (PERRY_HOST in .env.local), so no other computer can reach it.
        </p>
      )}

      {code && (
        <PairingPanel code={code} server={server} addresses={addresses} address={address} onPick={setPicked}
          onCancel={() => { setCode(null); void cancel({ key: dashboardKey }).catch(() => {}); }} />
      )}

      {others.length > 0 && (
        <>
          <List label="Computers with the pet" className="mt-4">
            {view.devices.map((device) => (
              <DeviceRow key={device.id ?? "here"} device={device}
                onRemove={device.id ? () => remove({ key: dashboardKey, id: device.id! }) : undefined} />
            ))}
          </List>
          {view.presence === "away" && (
            <p className="mt-2 text-sm text-muted-foreground" data-presence="away">You&apos;re away from all of them, so reminders go to your phone.</p>
          )}
        </>
      )}
    </div>
  );
}

function PairingPanel({ code, server, addresses, address, onPick, onCancel }: {
  code: { code: string; expiresAt: number };
  server: string | null;
  addresses: Array<{ address: string; tailscale: boolean }>;
  address: string | undefined;
  onPick: (address: string) => void;
  onCancel: () => void;
}) {
  const now = useNow(1000);
  const left = Math.max(0, code.expiresAt - now);
  const tailscale = addresses.find((a) => a.address === address)?.tailscale ?? false;
  const pet = `${server} ${code.code}`;
  return (
    <div className="mt-4 border-l-2 border-primary/60 pl-4" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Pairing code</p>
        <p className="nums text-sm text-muted-foreground">
          {left > 0 ? `Works once, for ${Math.floor(left / 60_000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")} more` : "Expired: make a new one"}
        </p>
      </div>
      <CodeDisplay className="mt-2" data-pairing-code>{code.code}</CodeDisplay>

      {server ? (
        <>
          {addresses.length > 1 && (
            <div className="mt-4">
              <p className="text-sm font-medium">Where the other computer finds Perry</p>
              <ToggleGroup aria-label="Perry's address" value={address ? [address] : []} onValueChange={(next) => { if (next[0]) onPick(next[0]); }}
                variant="outline" size="sm" className="mt-1.5 flex-wrap">
                {addresses.map((option) => (
                  <ToggleGroupItem key={option.address} value={option.address} className="font-mono text-xs text-muted-foreground aria-pressed:text-foreground">
                    {option.address}{option.tailscale && <span className="font-sans">Tailscale</span>}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          )}
          <p className="mt-4 text-sm font-medium">On the other computer, paste this in a terminal</p>
          <p className="mt-1 mb-1.5 text-xs text-muted-foreground">Windows, in PowerShell:</p>
          <CommandLine>{`$env:PERRY_PET='${pet}'; iwr -useb ${INSTALLER}/install.ps1 | iex`}</CommandLine>
          <p className="mt-2 mb-1.5 text-xs text-muted-foreground">macOS or Linux:</p>
          <CommandLine>{`curl -fsSL ${INSTALLER}/install.sh | PERRY_PET='${pet}' sh`}</CommandLine>
          <p className="mt-3 text-xs text-pretty text-muted-foreground">
            It installs only the pet (under 1 GB), which starts with that computer and gets a key of its own; remove the computer here to take it away.
            {tailscale
              ? " Over Tailscale, what he and Perry say to each other is encrypted on the way."
              : " On a local network it is not encrypted on the way: pair over one you trust, like your home's, or use Tailscale."}
          </p>
        </>
      ) : (
        <p className="mt-3 flex items-start gap-1.5 text-sm text-muted-foreground">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
          No other computer can reach this one. Connect it to your network or to Tailscale.
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>{left > 0 ? "Cancel" : "Close"}</Button>
      </div>
    </div>
  );
}

function DeviceRow({ device, onRemove }: { device: PetDeviceView; onRemove?: () => Promise<unknown> }) {
  return (
    <li className="flex items-center gap-3 py-3" data-pet-device={device.name}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{device.name}</span>
          {!device.id && <span className="text-xs text-muted-foreground">Perry&apos;s computer</span>}
          <StatusBadge>{device.running ? "Running" : "Not running"}</StatusBadge>
          {device.current && <StatusBadge>You&apos;re here</StatusBadge>}
        </div>
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-muted-foreground">
          {device.platform && <span>{PLATFORMS[device.platform] ?? device.platform}</span>}
          {device.seenAt ? <span>Seen <RelativeTime at={device.seenAt} /></span> : <span>Not heard from yet</span>}
        </p>
      </div>
      {onRemove && (
        <ActionButton variant="ghost" size="sm" className="shrink-0 text-muted-foreground hover:text-destructive" action={onRemove} success={`${device.name} is removed; its pet is locked out.`}
          confirm={{ title: `Remove ${device.name}?`, body: "Its pet's key stops working at once, and he says he is locked out. To have him there again, add the computer again.", label: "Remove" }}>
          Remove
        </ActionButton>
      )}
    </li>
  );
}
