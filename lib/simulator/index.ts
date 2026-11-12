import dgram from "dgram";
import os from "os";
import { createServer, Server } from "net";
import { ProjectorConfig, SimulatedProjector } from "./handlers";
import { startPreviewServer } from "./preview";
import { DEFAULT_PORTS } from "../shared/ports";
import { ipToBuffer } from "../shared/header";

export type SimulatorOptions = {
  mainPort?: number;
  discoveryPort?: number;
  imagePort?: number;
  /** Projector identity. Defaults to a documentation-range MAC (RFC 7042). */
  projector?: Partial<ProjectorConfig>;
  // Debug-only local HTTP preview of the decoded video stream. Not part of
  // the wire protocol — see docs/README.md.
  preview?: boolean;
  previewPort?: number;
};

export type Simulator = {
  projector: SimulatedProjector;
  mainServer: Server;
  imageServer: Server;
  /** End all sessions from the projector side (sends 0x07). */
  disconnectAll(): void;
  stop(): void;
};

/** 00:00:5e:00:53:01, from the range RFC 7042 reserves for documentation. */
export const DEFAULT_SIMULATOR_MAC = Buffer.from("00005e005301", "hex");

/** "EB" + last three MAC bytes, the naming scheme real units use. */
export function defaultProjectorName(mac: Buffer): string {
  return "EB" + mac.subarray(3, 6).toString("hex").toUpperCase();
}

// The address a peer would reach us on: the local interface on the same
// /24 as the peer, else the first external IPv4.
function localIpFor(peer: string): Buffer {
  const prefix = peer.split(".").slice(0, 3).join(".");
  let fallback = "127.0.0.1";
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family !== "IPv4") continue;
      if (addr.address.startsWith(prefix + ".")) return ipToBuffer(addr.address);
      if (!addr.internal && fallback === "127.0.0.1") fallback = addr.address;
    }
  }
  return ipToBuffer(fallback);
}

/**
 * Starts the three listeners a real projector has: TCP control (3620), TCP
 * video (3621) and UDP discovery (3620).
 */
export function startSimulator(options: SimulatorOptions = {}): Simulator {
  const {
    mainPort = DEFAULT_PORTS.main,
    discoveryPort = DEFAULT_PORTS.discovery,
    imagePort = DEFAULT_PORTS.image,
    preview = true,
    previewPort = 3630,
  } = options;
  const mac = options.projector?.mac ?? DEFAULT_SIMULATOR_MAC;
  const projector = new SimulatedProjector({
    ...options.projector,
    mac,
    name: options.projector?.name ?? defaultProjectorName(mac),
  });

  if (preview) startPreviewServer(previewPort);

  const mainServer = createServer((s) => projector.handleMainConnection(s));
  const imageServer = createServer((s) => projector.handleImageConnection(s));
  const discoveryServer = dgram.createSocket("udp4");
  // Replies go out from an ephemeral port, like the real unit's.
  const replySocket = dgram.createSocket("udp4");

  discoveryServer.on("message", (msg, rinfo) => {
    projector.handleDiscovery(msg, rinfo, localIpFor(rinfo.address), (reply) => {
      // Every UDP message is sent twice; replies go to the app's port 3620,
      // not the port the search came from.
      replySocket.send(reply, discoveryPort, rinfo.address);
      replySocket.send(reply, discoveryPort, rinfo.address);
    });
  });

  mainServer.listen(mainPort, () => console.log(`Control server listening on port ${mainPort}`));
  imageServer.listen(imagePort, () => console.log(`Video server listening on port ${imagePort}`));
  discoveryServer.bind(discoveryPort, () =>
    console.log(`Discovery listening on UDP ${discoveryPort} as "${projector.config.name}"`)
  );

  return {
    projector,
    mainServer,
    imageServer,
    disconnectAll: () => projector.disconnectAll(),
    stop() {
      mainServer.close();
      imageServer.close();
      discoveryServer.close();
      replySocket.close();
    },
  };
}

export { SimulatedProjector } from "./handlers";
export type { ProjectorConfig } from "./handlers";
export { publishInit, publishRect, publishStatus, startPreviewServer } from "./preview";
