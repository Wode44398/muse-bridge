import dgram from "node:dgram";
import os from "node:os";

// Which address this machine actually holds on the local network. A dev box is
// full of adapters that are not it — Hyper-V switches, VPN tunnels, link-local
// APIPA — and naming the wrong one is worse than saying nothing. So: ask the OS
// which source address its default route would use (a connected UDP socket
// sends no packet; connect() only runs the route lookup), then match that back
// to a real interface. 2026-08-16: a k3 run only discovered it could reach a
// smart speaker on the LAN by chance, and that discovery was the turning point of the task.

export interface LanAddress {
  address: string;
  cidr: string;
  iface: string;
}

const PRIVATE_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

let cached: LanAddress | null = null;
let probed = false;

function candidates(): LanAddress[] {
  const rows: LanAddress[] = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      // 169.254.x is APIPA: an adapter that failed to get a lease, routed nowhere.
      if (addr.address.startsWith("169.254.")) continue;
      rows.push({ address: addr.address, cidr: addr.cidr ?? `${addr.address}/32`, iface });
    }
  }
  return rows;
}

// Fallback ranking for when the route lookup has not answered yet, failed, or
// points at a tunnel: ordinary home/office ranges first.
function bestGuess(): LanAddress | null {
  const rank = (address: string) =>
    address.startsWith("192.168.") ? 0 : address.startsWith("10.") ? 1 : PRIVATE_RE.test(address) ? 2 : 3;
  return [...candidates()].sort((a, b) => rank(a.address) - rank(b.address))[0] ?? null;
}

function routeSource(): Promise<string | null> {
  return new Promise((resolve) => {
    let socket: dgram.Socket;
    const done = (value: string | null) => {
      try {
        socket?.close();
      } catch {
        // already closed
      }
      resolve(value);
    };
    try {
      socket = dgram.createSocket("udp4");
      socket.once("error", () => done(null));
      // 192.0.2.1 is TEST-NET-1: reserved, never a real host. Nothing is sent.
      socket.connect(53, "192.0.2.1", () => {
        try {
          done(socket.address().address);
        } catch {
          done(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

// Called once at startup. Safe to call again; never throws.
export async function primeLanAddress(): Promise<void> {
  let routed: string | null = null;
  try {
    routed = await routeSource();
  } catch {
    routed = null;
  }
  const match = routed ? candidates().find((row) => row.address === routed) : undefined;
  // A non-private route source means the default route is a tunnel (proxy TUN/VPN),
  // which is not where the phones and speakers live — fall back to the ranking.
  cached = match && PRIVATE_RE.test(match.address) ? match : bestGuess();
  probed = true;
}

export function lanAddress(): LanAddress | null {
  return probed ? cached : bestGuess();
}
