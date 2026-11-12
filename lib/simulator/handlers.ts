import { Socket as TCPSocket } from "net";
import { RemoteInfo } from "dgram";
import {
  createDataBuffer,
  decodeDataBuffer,
  extractMessages,
  ipToBuffer,
  replaceAllBytes,
} from "../shared/header";
import {
  CAPTURE_CLIENT_IP,
  CAPTURE_PROJECTOR_IP,
  EEMP_CONTROL_WORD,
  PJ_CONNECT_ACCEPT,
  PJ_INFO_2,
  PJ_INFO_3,
  PJ_PUSH_0E_A,
  PJ_PUSH_0E_B,
  PJ_START_STREAM,
  ZERO_PAYLOAD,
} from "../shared/constants";
import { EprdStreamParser, jpegDimensions } from "../shared/eprd";
import { DEFAULT_PORTS } from "../shared/ports";
import { publishInit, publishRect, publishStatus } from "./preview";

// The status 0x03 + 0x15 identity pair. The real projector answers every
// search (UDP status 1), probe (UDP/TCP status 2) with exactly these two
// messages and nothing else — no status-1 echo.
function infoResponses(clientIp: Buffer): Buffer[] {
  return [
    createDataBuffer(Buffer.from(PJ_INFO_2, "hex"), {
      controlWord: EEMP_CONTROL_WORD,
      ipAddress: clientIp,
      status: 3,
    }),
    createDataBuffer(Buffer.from(PJ_INFO_3, "hex"), {
      controlWord: EEMP_CONTROL_WORD,
      ipAddress: clientIp,
      status: 21,
    }),
  ];
}

function ownIp(socket: TCPSocket): Buffer {
  return socket.localAddress ? ipToBuffer(socket.localAddress) : Buffer.alloc(4);
}

// Captured payloads embed the capture-time client IP; patch in the live one
function patchedPayload(templateHex: string, clientIp: Buffer): Buffer {
  return replaceAllBytes(
    Buffer.from(templateHex, "hex"),
    Buffer.from(CAPTURE_CLIENT_IP, "hex"),
    clientIp
  );
}

export function handleMainServerConnection(socket: TCPSocket) {
  console.log(`\n--Main server: connection from ${socket.remoteAddress}--`);

  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const { messages, rest } = extractMessages(pending);
    pending = rest;
    for (const message of messages) {
      handleMainMessage(socket, message);
    }
  });

  socket.on("error", (err) => {
    console.log("Main server socket error:", err.message);
  });

  socket.on("close", () => {
    console.log("--Main server: connection closed--");
  });
}

function handleMainMessage(socket: TCPSocket, message: Buffer) {
  const { header, data } = decodeDataBuffer(message);
  console.log(
    `Main <- status=0x${header.status.toString(16)} family=${
      header.family
    } len=${header.dataLength}`
  );

  if (header.family === 0 && header.status === 2) {
    // Pre-connect probe: same identity pair as discovery, over TCP
    for (const response of infoResponses(header.ipAddress)) {
      socket.write(response);
    }
  } else if (header.family === 1 && header.status === 1) {
    // Connect request -> 0x02/01 accept. Captured template with the client
    // and projector IPs patched to the live addresses.
    const payload = replaceAllBytes(
      patchedPayload(PJ_CONNECT_ACCEPT, header.ipAddress),
      Buffer.from(CAPTURE_PROJECTOR_IP, "hex"),
      ownIp(socket)
    );
    socket.write(
      createDataBuffer(payload, {
        controlWord: EEMP_CONTROL_WORD,
        ipAddress: header.ipAddress,
        status: 2,
        family: 1,
      })
    );
    // The real projector follows the accept with two 0x0e/01 state pushes
    const push = createDataBuffer(
      patchedPayload(PJ_PUSH_0E_A, header.ipAddress),
      {
        controlWord: EEMP_CONTROL_WORD,
        ipAddress: header.ipAddress,
        status: 0x0e,
        family: 1,
      }
    );
    socket.write(push);
    socket.write(push);
    console.log("Main -> connect accept + 0x0e pushes");
  } else if (header.family === 0 && header.status === 0x0a) {
    // Keepalive: reply with 48 zero bytes; the real projector stamps its
    // own IP in this header rather than echoing the client's.
    socket.write(
      createDataBuffer(Buffer.from(ZERO_PAYLOAD, "hex"), {
        controlWord: EEMP_CONTROL_WORD,
        ipAddress: ownIp(socket),
        status: 0x0a,
      })
    );
  } else if (header.family === 1 && header.status === 8) {
    // Client state message: mirrored back as 0x09/01 with two ack fields set
    // (uint32 at payload offset 4 -> 2, byte at offset 120 -> 1).
    const payload = Buffer.from(data);
    if (payload.length >= 8) payload.writeUInt32LE(2, 4);
    if (payload.length > 120) payload.writeUInt8(1, 120);
    socket.write(
      createDataBuffer(payload, {
        controlWord: EEMP_CONTROL_WORD,
        ipAddress: header.ipAddress,
        status: 9,
        family: 1,
      })
    );
    // After the 0x08/0x09 exchange the real projector pushes 0x0e/01 (B),
    // 0x10/01 and then 0x16/00 — the signal that makes the app open the
    // video stream port.
    socket.write(
      createDataBuffer(patchedPayload(PJ_PUSH_0E_B, header.ipAddress), {
        controlWord: EEMP_CONTROL_WORD,
        ipAddress: header.ipAddress,
        status: 0x0e,
        family: 1,
      })
    );
    socket.write(
      createDataBuffer(Buffer.alloc(0), {
        controlWord: EEMP_CONTROL_WORD,
        ipAddress: header.ipAddress,
        status: 0x10,
        family: 1,
      })
    );
    socket.write(
      createDataBuffer(Buffer.from(PJ_START_STREAM, "hex"), {
        controlWord: EEMP_CONTROL_WORD,
        ipAddress: header.ipAddress,
        status: 0x16,
      })
    );
    console.log("Main -> 0x09 mirror, 0x0e push, 0x10, 0x16 (start stream)");
  } else if (header.family === 1 && header.status === 0x27) {
    console.log("Main <- 0x27 stream ack: app should now open the video port");
  } else {
    console.log("Main: unhandled message", message.toString("hex"));
  }
}

export function handleImageServerConnection(socket: TCPSocket) {
  console.log(`\n--Image server: connection from ${socket.remoteAddress}--`);

  // The app sends an EPRD0600 hello + RFB-style init, then streams
  // FramebufferUpdates with Tight-JPEG rects. The real projector never
  // writes anything on this port; we parse and forward to the preview.
  let rectCount = 0;
  const parser = new EprdStreamParser({
    onInit: (info) => {
      console.log(`Image stream init: ${info.width}x${info.height}`);
      publishInit(info);
    },
    onRect: (rect) => {
      rectCount++;
      const dims = jpegDimensions(rect.jpeg);
      console.log(
        `Image rect: (${rect.x},${rect.y}) ${rect.w}x${rect.h} jpeg=${
          rect.jpeg.length
        }B${dims ? ` (${dims.width}x${dims.height})` : ""}`
      );
      publishRect(rect);
    },
    onError: (message) => {
      console.log("Image stream error:", message);
      socket.destroy();
    },
  });

  socket.on("data", (chunk) => parser.feed(chunk));

  socket.on("error", (err) => {
    console.log("Image server socket error:", err.message);
  });

  socket.on("close", () => {
    console.log(`--Image server: closed after ${rectCount} rects--`);
    publishStatus("stream ended");
  });
}

export function handleDiscoveryServerConnection(
  msg: Buffer,
  rinfo: RemoteInfo,
  send: (
    msg: string | Uint8Array | readonly any[],
    port?: number,
    address?: string,
    callback?: (error: Error | null, bytes: number) => void
  ) => void,
  discoveryPort: number = DEFAULT_PORTS.discovery
) {
  const { header } = decodeDataBuffer(msg);
  console.log(
    `\nDiscovery <- status=${header.status} from ${rinfo.address}:${rinfo.port}`
  );

  // Status 1 = broadcast search, status 2 = unicast probe of a known
  // projector. Both get the identity pair, sent to the protocol port on the
  // client (the app listens on 3620, not on its ephemeral source port).
  if (header.status === 1 || header.status === 2) {
    for (const response of infoResponses(header.ipAddress)) {
      send(response, discoveryPort, rinfo.address);
    }
    console.log(`Discovery -> sent info pair to ${rinfo.address}`);
  } else if (header.status !== 3 && header.status !== 21) {
    // 3 and 21 are projector replies (ours echoing back when the client runs
    // on this machine, or another projector's). Nothing else has been seen on
    // UDP in the captures, so log it (docs/reverse-engineering-todo.md).
    console.log(
      `Discovery: unhandled status ${header.status}`,
      msg.toString("hex")
    );
  }
}
