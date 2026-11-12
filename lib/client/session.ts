import { connect, Socket as TCPSocket } from "net";
import {
  createDataBuffer,
  decodeDataBuffer,
  extractMessages,
  replaceAllBytes,
} from "../shared/header";
import {
  CAPTURE_CLIENT_IP,
  C_CONNECT_REQUEST,
  C_MSG_08,
  C_SEARCH_MESSAGE,
  C_STREAM_ACK,
  EEMP_CONTROL_WORD,
} from "../shared/constants";
import { buildEprdHello, buildEprdUpdate, Rect } from "../shared/eprd";
import { DEFAULT_PORTS } from "../shared/ports";
import { loadTestCard } from "./frames";

function eempMessage(
  clientIp: Buffer,
  status: number,
  family: number,
  payloadHex: string
): Buffer {
  const payload = replaceAllBytes(
    Buffer.from(payloadHex, "hex"),
    Buffer.from(CAPTURE_CLIENT_IP, "hex"),
    clientIp
  );
  return createDataBuffer(payload, {
    ipAddress: clientIp,
    controlWord: EEMP_CONTROL_WORD,
    status,
    family,
  });
}

function logMessages(
  socket: TCPSocket,
  onMessage: (status: number, family: number) => void
) {
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const { messages, rest } = extractMessages(pending);
    pending = rest;
    for (const message of messages) {
      const { header } = decodeDataBuffer(message);
      console.log(
        `Main <- status=0x${header.status.toString(16)} family=${
          header.family
        } len=${header.dataLength}`
      );
      onMessage(header.status, header.family);
    }
  });
}

export type ProbeOptions = {
  clientIp: Buffer;
  mainPort?: number;
};

// Pre-connect probe: TCP status 2, projector answers 0x03 + 0x15, then close.
export function probeProjector(
  host: string,
  { clientIp, mainPort = DEFAULT_PORTS.main }: ProbeOptions
): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`\nProbing ${host}...`);
    const socket = connect(mainPort, host, () => {
      socket.write(
        createDataBuffer(Buffer.from(C_SEARCH_MESSAGE, "hex"), {
          ipAddress: clientIp,
          controlWord: EEMP_CONTROL_WORD,
          status: 2,
        })
      );
    });
    logMessages(socket, (status) => {
      if (status === 21) {
        socket.end();
        resolve();
      }
    });
    socket.on("error", reject);
  });
}

export type StreamOptions = {
  clientIp: Buffer;
  imagePort?: number;
  frameIntervalMs?: number;
  // Defaults to the built-in test card (see ./frames.ts) if omitted.
  rects?: Rect[];
};

// Video stream: EPRD hello + repeated Tight-JPEG framebuffer updates.
export function streamVideo(
  host: string,
  { clientIp, imagePort = DEFAULT_PORTS.image, frameIntervalMs = 500, rects }: StreamOptions
): Promise<void> {
  const frameRects = rects ?? loadTestCard();
  return new Promise((resolve, reject) => {
    console.log(`\nOpening video stream to ${host}:${imagePort}...`);
    let frames = 0;
    let timer: NodeJS.Timeout | undefined;
    const socket = connect(imagePort, host, () => {
      socket.write(buildEprdHello(clientIp));
      const sendFrame = () => {
        socket.write(buildEprdUpdate(clientIp, frameRects));
        frames++;
        if (frames % 20 === 1) console.log(`Sent frame ${frames}`);
      };
      sendFrame();
      timer = setInterval(sendFrame, frameIntervalMs);
    });
    socket.on("close", () => {
      if (timer) clearInterval(timer);
      console.log(`Video stream closed after ${frames} frames`);
      resolve();
    });
    socket.on("error", (err) => {
      if (timer) clearInterval(timer);
      reject(err);
    });
  });
}

export type ConnectOptions = {
  clientIp: Buffer;
  mainPort?: number;
} & StreamOptions;

// Session: connect request, 0x08 state message, keepalives; when the
// projector signals 0x16 (start projecting), ack with 0x27 and stream.
export function connectToProjector(
  host: string,
  options: ConnectOptions
): Promise<void> {
  const { clientIp, mainPort = DEFAULT_PORTS.main } = options;
  return new Promise((resolve, reject) => {
    console.log(`\nConnecting to ${host}...`);
    const socket = connect(mainPort, host, () => {
      socket.write(eempMessage(clientIp, 1, 1, C_CONNECT_REQUEST));
    });

    let keepalive: NodeJS.Timeout | undefined;
    let streaming = false;
    logMessages(socket, (status, family) => {
      if (status === 2 && family === 1 && !keepalive) {
        console.log("Connected! Sending 0x08 state message");
        socket.write(eempMessage(clientIp, 8, 1, C_MSG_08));
        keepalive = setInterval(() => {
          socket.write(
            createDataBuffer(Buffer.alloc(0), {
              ipAddress: clientIp,
              controlWord: EEMP_CONTROL_WORD,
              status: 0x0a,
            })
          );
        }, 3000);
      } else if (status === 0x16 && family === 0 && !streaming) {
        streaming = true;
        console.log("Projector says start streaming: acking with 0x27");
        socket.write(eempMessage(clientIp, 0x27, 1, C_STREAM_ACK));
        streamVideo(host, options).catch((err) =>
          console.error("Stream error:", err.message)
        );
      }
    });

    socket.on("close", () => {
      if (keepalive) clearInterval(keepalive);
      console.log("Session closed");
      resolve();
    });
    socket.on("error", reject);
  });
}
