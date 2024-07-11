import { Socket as TCPSocket } from "net";
import { RemoteInfo, Socket as UDPSocket } from "dgram";
import {
  bufferToIp,
  createDataBuffer,
  decodeDataBuffer,
} from "../utils/header";

const udpDiscoverMessageResponse =
  "01000000454230303533303200000000000000000000000000000000000000000000000001000c00000100020c0000003030353330320000000000000000000000000000000000000000";
const udpDiscoverMessageResponseBuffer = Buffer.from(
  udpDiscoverMessageResponse,
  "hex"
);

const discoveryMessageString =
  "01000000454230303533303200000000000000000000000000000000000000000000000001000c00000100020c0000003030353330320000000000000000000000000000000000000000";
const discoveryMessageBuffer = Buffer.from(discoveryMessageString, "hex");

const dataMessageString =
  "303035333032000000000000000000000000000000000000000000ba000001040c000000020650423030000003068007b0040000040602008007b00405580709080000000800080080004000e001380400000000070b080000000800080010001000e001380400000000070d080000000800080010001000e0013804000000000000080000000800080010001000e001380400000000070a0100010c022d0000000008089f06f0dd000000000a0a002f0202320401000000000b0b00010a0b09070c02131415160d0a000104401f0000000000000e010005";
const dataMessageBuffer = Buffer.from(dataMessageString, "hex");

export function handleMainServerConnection(socket: TCPSocket) {
  console.log("\n\n--Start--");
  socket.on("data", (data) => {
    const decoded = decodeDataBuffer(data);
    console.log("Status", decoded.header.status);
    if (decoded.header.status === 2) {
      const status2Reponse = createDataBuffer(discoveryMessageBuffer, {
        controlWord: "EEMP0100",
        ipAddress: decoded.header.ipAddress,
        status: 3,
      });

      socket.write(status2Reponse);

      setTimeout(() => {
        const status2Reponse = createDataBuffer(dataMessageBuffer, {
          controlWord: "EEMP0100",
          ipAddress: decoded.header.ipAddress,
          status: 21,
        });

        socket.write(status2Reponse);
      }, 500);
    } else if (decoded.header.status === 1) {
      console.log("Data Length", decoded.header.dataLength);
      console.log("Data", decoded.data.toString("hex"));
      console.log("NetMask", bufferToIp(decoded.data.subarray(14, 18)));
      console.log(
        "ProjectorName",
        decoded.data.subarray(48, 55).toString("ascii")
      );
      const header = createDataBuffer(discoveryMessageBuffer, {
        controlWord: "EEMP0100",
        ipAddress: decoded.header.ipAddress,
        status: 5,
      });

      socket.write(header);
    }
  });

  socket.on("close", () => {
    console.log("--End--");
  });
}
export function handleImageServerConnection(socket: TCPSocket) {
  socket.on("data", (data) => {
    const decoded = decodeDataBuffer(data);
    console.log("Image Server Connection", decoded);
  });

  socket.on("close", () => {});
}

export function handleDiscoveryServerConnection(
  msg: Buffer,
  rinfo: RemoteInfo,
  send: (
    msg: string | Uint8Array | readonly any[],
    port?: number,
    address?: string,
    callback?: (error: Error | null, bytes: number) => void
  ) => void
) {
  const decodedData = decodeDataBuffer(msg);

  if (decodedData.header.status === 1) {
    const discoveryResponse = createDataBuffer(
      udpDiscoverMessageResponseBuffer,
      {
        controlWord: "EEMP0100",
        ipAddress: decodedData.header.ipAddress,
        status: 3,
      }
    );

    const dataResponse = createDataBuffer(dataMessageBuffer, {
      controlWord: "EEMP0100",
      ipAddress: decodedData.header.ipAddress,
      status: 21,
    });

    send(discoveryResponse, 3620, rinfo.address);

    setTimeout(() => {
      send(dataResponse, 3620, rinfo.address);
    }, 200);
  } else if (decodedData.header.status === 4) {
    console.log("\n\nIMPORTANT MESSAGE UDP CODE 4");
  }
}
