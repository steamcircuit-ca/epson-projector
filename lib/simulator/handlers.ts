// A simulated projector. Behaviour follows what the real projector does in
// the packet captures; see docs/eemp-control-protocol.md. All payloads are
// built from this simulator's own identity via lib/shared/messages.ts.
import { Socket as TCPSocket } from "net";
import { RemoteInfo } from "dgram";
import { decodeDataBuffer, extractMessages, ipToBuffer, bufferToIp } from "../shared/header";
import {
  ClientIdentity,
  Fam0,
  Fam1,
  HEARTBEAT_INTERVAL_MS,
  ProjectorIdentity,
  Size,
  capabilitiesPayload,
  connectAcceptPayload,
  disconnectAckPayload,
  disconnectedByProjectorPayload,
  eempMessage,
  identityPayload,
  inUsePayload,
  layoutAcceptedPayload,
  parseConnectRequest,
  projectorHeartbeatPayload,
  soloLayout,
  staleSessionPayload,
  startStreamPayload,
  stateBroadcastPayload,
} from "../shared/messages";
import { EprdStreamParser, jpegDimensions } from "../shared/eprd";
import { publishInit, publishRect, publishStatus } from "./preview";

/** How long to wait for the app's video sockets before sending 0x16 anyway. */
const VIDEO_CONNECT_TIMEOUT_MS = 1500;

export type ProjectorConfig = {
  /** Projector name, ASCII. Real units use "EB" + the last 3 MAC bytes. */
  name: string;
  /** MAC address, 6 bytes. */
  mac: Buffer;
  modelCode?: number;
  nativeResolution?: Size;
  maxRect?: Size;
};

type Session = {
  socket: TCPSocket;
  client: ClientIdentity;
  heartbeat?: NodeJS.Timeout;
  sawHeartbeat: boolean;
  cleanExit: boolean;
};

/**
 * Projector-wide state. Mirrors the real unit: one state version counter
 * shared by all sessions, and a "presenter" that survives a session whose
 * app vanished without sending 0x04 (a stale session).
 */
export class SimulatedProjector {
  private stateVersion = 0;
  private presenter: ClientIdentity | null = null;
  private sessions = new Set<Session>();
  private videoSockets = new Map<string, Set<TCPSocket>>();
  private videoWaiters = new Map<string, () => void>();

  constructor(readonly config: ProjectorConfig) {}

  private identity(ip: Buffer): ProjectorIdentity {
    return { mac: this.config.mac, ip, name: this.config.name };
  }

  private get inUse(): boolean {
    return this.presenter !== null;
  }

  /** Replies to a search or probe: [0x1a] + identity + capabilities. */
  discoveryReplies(clientIp: Buffer, ownIp: Buffer): Buffer[] {
    const out: Buffer[] = [];
    if (this.inUse) out.push(eempMessage(clientIp, Fam1.inUse, 1, inUsePayload()));
    out.push(
      eempMessage(
        clientIp,
        Fam0.identity,
        0,
        identityPayload(this.identity(ownIp), {
          connectedUsers: this.inUse ? 1 : 0,
          modelCode: this.config.modelCode,
        })
      ),
      eempMessage(
        clientIp,
        Fam0.capabilities,
        0,
        capabilitiesPayload(this.config, {
          modelCode: this.config.modelCode,
          nativeResolution: this.config.nativeResolution,
          maxRect: this.config.maxRect,
        })
      )
    );
    return out;
  }

  // -- control channel ------------------------------------------------------

  handleMainConnection(socket: TCPSocket) {
    console.log(`\n--Main: connection from ${socket.remoteAddress}--`);
    let pending = Buffer.alloc(0);
    let session: Session | undefined;

    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const { messages, rest } = extractMessages(pending);
      pending = rest;
      for (const message of messages) {
        try {
          session = this.handleMainMessage(socket, message, session);
        } catch (err) {
          console.log("Main: bad message:", (err as Error).message);
        }
      }
    });
    socket.on("error", (err) => console.log("Main socket error:", err.message));
    socket.on("close", () => {
      if (session) this.endSession(session);
      console.log("--Main: connection closed--");
    });
  }

  private handleMainMessage(
    socket: TCPSocket,
    message: Buffer,
    session: Session | undefined
  ): Session | undefined {
    const { header, data } = decodeDataBuffer(message);
    const clientIp = header.ipAddress;
    const send = (status: number, family: 0 | 1, payload?: Buffer) =>
      socket.write(eempMessage(clientIp, status, family, payload));
    console.log(
      `Main <- fam=${header.family} st=0x${header.status.toString(16)} len=${header.dataLength}`
    );

    if (header.family === 0 && header.status === Fam0.probe) {
      for (const reply of this.discoveryReplies(clientIp, ownIp(socket))) socket.write(reply);
      return session;
    }

    if (header.family === 1 && header.status === Fam1.connectRequest) {
      const request = parseConnectRequest(data);
      const client = { ip: request.client.ip, name: request.client.name };
      const stale = this.presenter !== null && this.presenter.ip.equals(client.ip);
      const next: Session = { socket, client, sawHeartbeat: false, cleanExit: false };
      this.sessions.add(next);
      this.closeVideo(client.ip); // a new session replaces any half-open video

      send(Fam1.connectAccept, 1, connectAcceptPayload(client, this.identity(ownIp(socket))));
      this.stateVersion++;
      if (stale) {
        // Same app reconnecting over a session it never closed.
        const state = stateBroadcastPayload(this.stateVersion, {
          ...soloLayout(client),
          users: [client],
        });
        send(Fam1.stateBroadcast, 1, state);
        send(Fam1.staleSession, 1, staleSessionPayload());
        send(Fam1.stateBroadcast, 1, state);
        console.log(`Main -> accept (stale session for ${client.name})`);
      } else {
        const state = stateBroadcastPayload(this.stateVersion, {
          presenter: [{ empty: 1 }],
          users: [client],
        });
        send(Fam1.stateBroadcast, 1, state);
        send(Fam1.stateBroadcast, 1, state);
        console.log(`Main -> accept "${client.name}"`);
      }
      return next;
    }

    if (!session) {
      console.log("Main: message before connect request, ignoring");
      return session;
    }

    if (header.family === 1 && header.status === Fam1.resume) {
      send(
        Fam1.stateBroadcast,
        1,
        stateBroadcastPayload(this.stateVersion, {
          ...soloLayout(session.client),
          users: [session.client],
        })
      );
    } else if (header.family === 1 && header.status === Fam1.layoutRequest) {
      this.stateVersion++;
      this.presenter = session.client;
      send(Fam1.layoutAccepted, 1, layoutAcceptedPayload(data, this.stateVersion));
      send(
        Fam1.stateBroadcast,
        1,
        stateBroadcastPayload(this.stateVersion, {
          ...soloLayout(session.client),
          users: [session.client],
        })
      );
      send(Fam1.openVideo, 1);
      // The real projector sends 0x16 shortly after the app's video sockets
      // connect. Fall back to a timeout for clients that wait for 0x16.
      this.waitForVideo(session.client.ip).then(() => {
        if (!socket.destroyed) send(Fam0.startStream, 0, startStreamPayload());
        console.log("Main -> 0x16 start streaming");
      });
    } else if (header.family === 0 && header.status === Fam0.heartbeat) {
      if (!session.sawHeartbeat) {
        session.sawHeartbeat = true;
        // Immediate reply to the first heartbeat only, then our own timer.
        socket.write(eempMessage(ownIp(socket), Fam0.heartbeat, 0, projectorHeartbeatPayload(0)));
        session.heartbeat = setInterval(() => {
          socket.write(eempMessage(ownIp(socket), Fam0.heartbeat, 0, projectorHeartbeatPayload()));
        }, HEARTBEAT_INTERVAL_MS);
      }
    } else if (header.family === 1 && header.status === Fam1.streamStarted) {
      console.log("Main <- 0x27 streaming started");
    } else if (header.family === 1 && header.status === Fam1.disconnect) {
      send(Fam1.disconnectAck, 1, disconnectAckPayload());
      session.cleanExit = true;
      socket.end();
      console.log(`Main -> 0x05, "${session.client.name}" disconnected`);
    } else {
      console.log("Main: unhandled", message.toString("hex"));
    }
    return session;
  }

  private endSession(session: Session) {
    if (session.heartbeat) clearInterval(session.heartbeat);
    this.sessions.delete(session);
    if (session.cleanExit) {
      // Clean exit: free the screen and close the video sockets.
      if (this.presenter?.ip.equals(session.client.ip)) this.presenter = null;
      this.closeVideo(session.client.ip);
    }
    // Otherwise, like the real unit, stay "in use" with the video sockets
    // half-open until the next session replaces them.
  }

  /** End every session from the projector side (0x07), like its remote. */
  disconnectAll() {
    for (const session of [...this.sessions]) {
      session.socket.write(
        eempMessage(session.client.ip, Fam1.disconnectedByProjector, 1, disconnectedByProjectorPayload())
      );
      session.cleanExit = true;
      session.socket.end();
      this.closeVideo(session.client.ip);
    }
    this.presenter = null;
  }

  // -- video channel --------------------------------------------------------

  private waitForVideo(ip: Buffer): Promise<void> {
    const key = bufferToIp(ip);
    if (this.videoSockets.get(key)?.size) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.videoWaiters.delete(key);
        resolve();
      }, VIDEO_CONNECT_TIMEOUT_MS);
      this.videoWaiters.set(key, () => {
        clearTimeout(timer);
        this.videoWaiters.delete(key);
        resolve();
      });
    });
  }

  private closeVideo(ip: Buffer) {
    const key = bufferToIp(ip);
    for (const s of this.videoSockets.get(key) ?? []) s.destroy();
    this.videoSockets.delete(key);
  }

  handleImageConnection(socket: TCPSocket) {
    const key = bufferToIp(ipToBuffer(socket.remoteAddress ?? "0.0.0.0"));
    console.log(`\n--Video: connection from ${key}--`);
    const set = this.videoSockets.get(key) ?? new Set();
    set.add(socket);
    this.videoSockets.set(key, set);
    this.videoWaiters.get(key)?.();

    // Push-only from the app; the real projector never writes here. The
    // app's second socket stays idle (probably reserved for audio).
    let rectCount = 0;
    const parser = new EprdStreamParser({
      onInit: (info) => {
        console.log(`Video init: ${info.width}x${info.height}`);
        publishInit(info);
      },
      onRect: (rect) => {
        rectCount++;
        const dims = jpegDimensions(rect.jpeg);
        console.log(
          `Video rect: (${rect.x},${rect.y}) ${rect.w}x${rect.h} jpeg=${rect.jpeg.length}B` +
            (dims ? ` (${dims.width}x${dims.height})` : "")
        );
        publishRect(rect);
      },
      onError: (message) => {
        console.log("Video stream error:", message);
        socket.destroy();
      },
    });
    socket.on("data", (chunk) => parser.feed(chunk));
    socket.on("error", (err) => console.log("Video socket error:", err.message));
    socket.on("close", () => {
      set.delete(socket);
      console.log(`--Video: closed after ${rectCount} rects--`);
      if (rectCount) publishStatus("stream ended");
    });
  }

  // -- discovery (UDP) ------------------------------------------------------

  handleDiscovery(
    msg: Buffer,
    rinfo: RemoteInfo,
    ownIpForPeer: Buffer,
    send: (reply: Buffer) => void
  ) {
    let header;
    try {
      header = decodeDataBuffer(msg).header;
    } catch {
      return;
    }
    if (header.controlWord !== "EEMP0100") return;
    if (header.family === 0 && (header.status === Fam0.search || header.status === Fam0.probe)) {
      for (const reply of this.discoveryReplies(header.ipAddress, ownIpForPeer)) send(reply);
      console.log(`Discovery -> replied to ${rinfo.address}`);
    } else if (![Fam0.identity, Fam0.capabilities, Fam1.inUse].includes(header.status as never)) {
      // Our own replies loop back when the client runs on this machine;
      // anything else is new and worth seeing.
      console.log(`Discovery: unhandled status ${header.status}`, msg.toString("hex"));
    }
  }
}

function ownIp(socket: TCPSocket): Buffer {
  return socket.localAddress ? ipToBuffer(socket.localAddress) : Buffer.alloc(4);
}
