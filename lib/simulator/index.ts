import dgram from "dgram";
import { createServer, Server } from "net";
import {
  handleDiscoveryServerConnection,
  handleImageServerConnection,
  handleMainServerConnection,
} from "./handlers";
import { startPreviewServer } from "./preview";
import { DEFAULT_PORTS } from "../shared/ports";

export type SimulatorOptions = {
  mainPort?: number;
  discoveryPort?: number;
  imagePort?: number;
  // Debug-only local HTTP preview of the decoded video stream. Not part of
  // the wire protocol — see docs/README.md.
  preview?: boolean;
  previewPort?: number;
};

export type Simulator = {
  mainServer: Server;
  imageServer: Server;
  stop(): void;
};

// Wires up the three servers a real projector answers on: the TCP session
// channel, the TCP video channel, and the UDP discovery channel. Mirrors
// what a real Epson wireless projector looks like on the wire, for an
// iProjection-compatible client to connect to.
export function startSimulator(options: SimulatorOptions = {}): Simulator {
  const {
    mainPort = DEFAULT_PORTS.main,
    discoveryPort = DEFAULT_PORTS.discovery,
    imagePort = DEFAULT_PORTS.image,
    preview = true,
    previewPort = 3630,
  } = options;

  if (preview) {
    startPreviewServer(previewPort);
  }

  const mainServer = createServer(handleMainServerConnection);
  const imageServer = createServer(handleImageServerConnection);
  const discoveryServer = dgram.createSocket("udp4");

  discoveryServer.on("message", (msg, rinfo) => {
    handleDiscoveryServerConnection(
      msg,
      rinfo,
      (msg, port, address, callback) => {
        discoveryServer.send(msg, port, address, callback);
      },
      discoveryPort
    );
  });

  mainServer.listen(mainPort, () => {
    console.log(`Main server listening on port ${mainPort}`);
  });

  imageServer.listen(imagePort, () => {
    console.log(`Image server listening on port ${imagePort}`);
  });

  discoveryServer.bind(discoveryPort);

  return {
    mainServer,
    imageServer,
    stop() {
      mainServer.close();
      imageServer.close();
      discoveryServer.close();
    },
  };
}

export * from "./handlers";
export { publishInit, publishRect, publishStatus, startPreviewServer } from "./preview";
