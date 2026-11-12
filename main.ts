// Example usage of the library in lib/ — see docs/README.md for the
// protocol this implements.
//
// Two modes, mirroring the two roles in the protocol:
//
//   npm run dev:simulator
//     Acts as a projector. Point a compatible app (or this repo's client)
//     at this machine to see it discover, connect, and stream video.
//     Ctrl-C ends any session from the projector side (0x07) and exits.
//
//   npm run dev:client [host] [jpeg-file]
//     Acts as the app. With no host, broadcasts a discovery search and
//     connects to the first projector that answers (works against this
//     repo's own simulator too, run in a second terminal). With a host,
//     probes it directly. With a jpeg-file, streams that image instead of
//     the built-in test card. Ctrl-C disconnects cleanly (0x04 → 0x05).
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

function runSimulator() {
  console.log("------ PROJECTOR SIMULATOR ------");
  const sim = simulator.startSimulator({
    mainPort: config.MAIN_SERVER_PORT,
    discoveryPort: config.DISCOVERY_SERVER_PORT,
    imagePort: config.IMAGE_SERVER_PORT,
    previewPort: config.PREVIEW_PORT,
  });
  process.once("SIGINT", () => {
    console.log("\nEnding sessions from the projector side...");
    sim.disconnectAll();
    setTimeout(() => {
      sim.stop();
      process.exit(0);
    }, 300);
  });
}

async function runClient(hostArg?: string, streamFile?: string) {
  const clientIpString = process.env.CLIENT_IP ?? detectLocalIpv4();
  const clientIp = ipToBuffer(clientIpString);

  let projector: client.DiscoveredProjector;
  if (hostArg) {
    projector = await client.probeProjector(hostArg, {
      clientIp,
      mainPort: config.MAIN_SERVER_PORT,
    });
  } else {
    const broadcastAddress = process.env.BROADCAST_ADDR ?? toBroadcastAddress(clientIpString);
    console.log(`Searching for projectors from ${clientIpString} (broadcast ${broadcastAddress})...`);
    const found = await client.discoverProjectors({
      clientIp,
      broadcastAddress,
      discoveryPort: config.DISCOVERY_SERVER_PORT,
    });
    if (found.length === 0) {
      console.log("No projectors found");
      return;
    }
    for (const p of found) {
      console.log(`Found "${p.identity?.name}" at ${p.host}${p.identity?.inUse ? " (in use)" : ""}`);
    }
    projector = found[0];
  }

  const caps = projector.capabilities;
  console.log(
    `Projector "${projector.identity?.name}": framebuffer ` +
      `${caps?.framebuffer?.width}x${caps?.framebuffer?.height}, ` +
      `max rect ${caps?.maxRect?.width}x${caps?.maxRect?.height}`
  );

  const rects = streamFile ? client.loadJpegFrame(streamFile) : client.loadTestCard();
  const session = await client.connectToProjector(projector.host, {
    clientIp,
    clientName: process.env.CLIENT_NAME,
    projector,
    mainPort: config.MAIN_SERVER_PORT,
    imagePort: config.IMAGE_SERVER_PORT,
  });
  console.log(streamFile ? `Streaming ${streamFile}` : "Streaming built-in test card");
  // Like the real app: send a frame when the screen changes, not on a timer.
  session.sendFrame(rects);

  process.once("SIGINT", () => {
    console.log("\nDisconnecting...");
    session.disconnect();
  });
  console.log(`Session ended (${await session.closed})`);
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);

  if (mode === "simulator") {
    runSimulator();
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
