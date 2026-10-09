import { networkInterfaces } from "node:os";

/**
 * Desktop pets on the owner's other computers (convex/pet.ts pairs them,
 * server/devices.ts lets them in): what the pairing and the server share.
 */

/** A paired pet's key starts with this, so the server tells it from the dashboard key at a glance. */
export const PET_KEY_PREFIX = "pet_";

/** Keys and codes are kept only as this: a SHA-256, in hex. */
export async function hashOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * This computer's addresses another device may reach Perry at: its Tailscale
 * one first (100.64.0.0/10), which works wherever the owner is signed in and
 * is encrypted on the way, then its local network's, home networks' own
 * ranges before others. Adapters only this computer can reach (Hyper-V and
 * WSL, Docker, VirtualBox, VMware, bridges) and self-assigned addresses are
 * left out.
 */
export function reachableAddresses(): Array<{ address: string; tailscale: boolean }> {
  const found: Array<{ address: string; tailscale: boolean; rank: number }> = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (/^(vEthernet|docker|br-|veth|virbr|vboxnet|VirtualBox|VMware)/i.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal || address.address.startsWith("169.254.")) continue;
      const [a, b] = address.address.split(".").map(Number);
      const tailscale = a === 100 && b >= 64 && b <= 127;
      const rank = tailscale ? 0 : a === 192 && b === 168 ? 1 : a === 172 && b >= 16 && b <= 31 ? 2 : a === 10 ? 3 : 4;
      found.push({ address: address.address, tailscale, rank });
    }
  }
  return found.sort((x, y) => x.rank - y.rank).map(({ address, tailscale }) => ({ address, tailscale }));
}
