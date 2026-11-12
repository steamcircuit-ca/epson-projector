import dgram from "dgram";
import { createDataBuffer, decodeDataBuffer } from "../shared/header";
import { C_SEARCH_MESSAGE, EEMP_CONTROL_WORD } from "../shared/constants";
import { DEFAULT_PORTS } from "../shared/ports";

export type DiscoveredProjector = { host: string; data: Buffer[] };

export type DiscoverOptions = {
  // This client's own IP, embedded in the search message's header.
  clientIp: Buffer;
  // Where to broadcast the search, e.g. "192.168.1.255" for a /24.
  broadcastAddress: string;
  discoveryPort?: number;
  // How long to wait for replies before resolving.
  timeoutMs?: number;
};

// Broadcasts an EEMP0100 search (status 1) on the discovery port and
// collects every projector's identity/capability reply for `timeoutMs`.
export function discoverProjectors({
  clientIp,
  broadcastAddress,
  discoveryPort = DEFAULT_PORTS.discovery,
  timeoutMs = 3000,
}: DiscoverOptions): Promise<DiscoveredProjector[]> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const responses: { [host: string]: Buffer[] } = {};

    socket.on("listening", () => {
      const address = socket.address();
      console.log(`UDP client listening on ${address.address}:${address.port}`);
      socket.setBroadcast(true);

      const data = createDataBuffer(Buffer.from(C_SEARCH_MESSAGE, "hex"), {
        ipAddress: clientIp,
        controlWord: EEMP_CONTROL_WORD,
        status: 1,
      });

      socket.send(
        data,
        0,
        data.length,
        discoveryPort,
        broadcastAddress,
        (err) => {
          if (err) {
            console.error("Error sending message:", err);
            socket.close();
            reject(err);
          } else {
            console.log(`Search sent to ${broadcastAddress}:${discoveryPort}`);
          }
        }
      );
    });

    socket.on("message", (msg, rinfo) => {
      const { header } = decodeDataBuffer(msg);
      console.log(
        `Discovery reply from ${rinfo.address}: status=0x${header.status.toString(
          16
        )} len=${header.dataLength}`
      );

      const host = rinfo.address;
      if (!responses[host]) {
        responses[host] = [];
      }
      responses[host].push(msg);
    });

    socket.on("error", (err) => {
      console.error("Socket error:", err);
      socket.close();
      reject(err);
    });

    // Replies target the protocol port, not an ephemeral one, so we have to
    // listen there rather than let dgram pick a random source port.
    socket.bind(discoveryPort);

    setTimeout(() => {
      socket.close();
      resolve(
        Object.keys(responses).map((host) => ({
          host,
          data: responses[host],
        }))
      );
    }, timeoutMs);
  });
}
