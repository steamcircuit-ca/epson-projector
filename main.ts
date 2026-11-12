// Example usage of the library in lib/ — see docs/README.md for the
// protocol this implements.
//
// Two modes, mirroring the two roles in the protocol:
//
//   npm run dev:simulator
//     Acts as a projector. Point a real iProjection app at this machine
//     to see it discover, connect, and stream video.
//
//   npm run dev:client [host] [jpeg-file]
//     Acts as the iProjection app. With no host, broadcasts a discovery
//     search and connects to the first projector that answers (works
//     against this repo's own simulator too, run in a second terminal).
//     With a host, skips discovery and connects directly — handy for
//     talking to a real projector, or to a simulator on localhost.
//     With a jpeg-file, streams that image full-frame instead of the
//     built-in test card.
import os from "os";
import config from "./config";
import * as client from "./lib/client";
import * as simulator from "./lib/simulator";
import { ipToBuffer } from "./lib/shared";

function detectLocalIpv4(): string {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return "127.0.0.1";
}

function toBroadcastAddress(ipv4: string): string {
  const parts = ipv4.split(".");
  parts[3] = "255";
  return parts.join(".");
}

async function runSimulator() {
  console.log("------EPSON NETWORK PROJECTOR SIMULATOR------");
  simulator.startSimulator({
    mainPort: config.MAIN_SERVER_PORT,
    discoveryPort: config.DISCOVERY_SERVER_PORT,
    imagePort: config.IMAGE_SERVER_PORT,
    previewPort: config.PREVIEW_PORT,
  });
  // The servers above keep the process alive; nothing left to await here.
}

async function runClient(hostArg?: string, streamFile?: string) {
  const clientIpString = process.env.CLIENT_IP ?? detectLocalIpv4();
  const clientIp = ipToBuffer(clientIpString);
  const ports = {
    mainPort: config.MAIN_SERVER_PORT,
    imagePort: config.IMAGE_SERVER_PORT,
  };

  let host = hostArg;
  if (!host) {
    const broadcastAddress = process.env.BROADCAST_ADDR ?? toBroadcastAddress(clientIpString);
    console.log(`Searching for projectors from ${clientIpString} (broadcast ${broadcastAddress})...`);
    const projectors = await client.discoverProjectors({
      clientIp,
      broadcastAddress,
      discoveryPort: config.DISCOVERY_SERVER_PORT,
    });
    if (projectors.length === 0) {
      console.log("No projectors found");
      return;
    }
    console.log(`Found projector(s): ${projectors.map((p) => p.host).join(", ")}`);
    host = projectors[0].host;
  }

  const rects = streamFile ? client.loadJpegFrame(streamFile) : client.loadTestCard();
  console.log(streamFile ? `Streaming ${streamFile}` : "Streaming built-in test card");

  await client.probeProjector(host, { clientIp, ...ports });
  await client.connectToProjector(host, { clientIp, ...ports, rects });
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);

  if (mode === "simulator") {
    await runSimulator();
  } else if (mode === "client") {
    await runClient(rest[0], rest[1]);
  } else {
    console.log("Usage:");
    console.log("  ts-node main.ts simulator");
    console.log("  ts-node main.ts client [host] [jpeg-file]");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
