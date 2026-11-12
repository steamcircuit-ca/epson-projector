import dgram from "dgram";
import { decodeDataBuffer, extractMessages } from "../shared/header";
import {
  Fam0,
  ParsedCapabilities,
  ParsedIdentity,
  eempMessage,
  parseCapabilities,
  parseIdentity,
  searchPayload,
} from "../shared/messages";
import { DEFAULT_PORTS } from "../shared/ports";

export type DiscoveredProjector = {
  host: string;
  identity?: ParsedIdentity;
  capabilities?: ParsedCapabilities;
};

export type DiscoverOptions = {
  // This client's own IP, embedded in the search message's header.
  clientIp: Buffer;
  // Where to broadcast the search, e.g. "192.168.1.255" for a /24.
  broadcastAddress: string;
  discoveryPort?: number;
  // How long to wait for replies before resolving.
  timeoutMs?: number;
};

/** Fill in identity/capabilities from one reply message. */
export function absorbReply(projector: DiscoveredProjector, message: Buffer) {
  const { header, data } = decodeDataBuffer(message);
  if (header.family !== 0) return; // 0x1a "in use" is family 1; identity says so too
  try {
    if (header.status === Fam0.identity) projector.identity = parseIdentity(data);
    if (header.status === Fam0.capabilities) projector.capabilities = parseCapabilities(data);
  } catch {
    // ignore malformed replies
  }
}

// Broadcasts an EEMP0100 search (status 1) on the discovery port and
// collects every projector's identity/capability reply for `timeoutMs`.
// Like the real app, every search is sent twice.
export function discoverProjectors({
  clientIp,
  broadcastAddress,
  discoveryPort = DEFAULT_PORTS.discovery,
  timeoutMs = 3000,
}: DiscoverOptions): Promise<DiscoveredProjector[]> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const found = new Map<string, DiscoveredProjector>();

    socket.on("listening", () => {
      socket.setBroadcast(true);
      const search = eempMessage(clientIp, Fam0.search, 0, searchPayload());
      for (let i = 0; i < 2; i++) {
        socket.send(search, discoveryPort, broadcastAddress, (err) => {
          if (err) {
            socket.close();
            reject(err);
          }
        });
      }
    });

    socket.on("message", (msg, rinfo) => {
      const projector = found.get(rinfo.address) ?? { host: rinfo.address };
      for (const message of extractMessages(msg).messages) absorbReply(projector, message);
      if (projector.identity) found.set(rinfo.address, projector);
    });

    socket.on("error", (err) => {
      socket.close();
      reject(err);
    });

    // Replies target port 3620 on the client, not the search's source
    // port, so we must listen there.
    socket.bind(discoveryPort);

    setTimeout(() => {
      socket.close();
      resolve([...found.values()]);
    }, timeoutMs);
  });
}
