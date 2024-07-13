import { Socket as TCPSocket } from "net";
import { RemoteInfo, Socket as UDPSocket } from "dgram";
import {
  bufferToIp,
  createDataBuffer,
  decodeDataBuffer,
} from "../utils/header";
import { PJ_INFO_1, PJ_INFO_2, PJ_INFO_3 } from "../utils/constants";

export function handleMainServerConnection(socket: TCPSocket) {
  console.log("\n\n--Start Main Server--");
  socket.on("data", (data) => {
    const decoded = decodeDataBuffer(data);
    console.log("Status", decoded.header.status);
    if (decoded.header.status === 2) {
      const status2Reponse = createDataBuffer(Buffer.from(PJ_INFO_1), {
        controlWord: "EEMP0100",
        ipAddress: decoded.header.ipAddress,
        status: 3,
      });

      socket.write(status2Reponse);

      setTimeout(() => {
        const status2Reponse = createDataBuffer(Buffer.from(PJ_INFO_3), {
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
      const header = createDataBuffer(Buffer.from(PJ_INFO_3), {
        controlWord: "EEMP0100",
        ipAddress: decoded.header.ipAddress,
        status: 5,
      });

      socket.write(header);
    } else if (decoded.header.status === 10) {
      console.log("Header", decoded.header);

      const header = createDataBuffer(Buffer.from(PJ_INFO_1), {
        controlWord: "EEMP0100",
        ipAddress: decoded.header.ipAddress,
        status: 5,
      });

      socket.write(header);

      setTimeout(() => {
        const header = createDataBuffer(Buffer.from(PJ_INFO_3), {
          controlWord: "EEMP0100",
          ipAddress: decoded.header.ipAddress,
          status: 5,
        });

        socket.write(header);
      }, 200);
    }
  });

  socket.on("close", () => {
    console.log("--End--");
  });
}
export function handleImageServerConnection(socket: TCPSocket) {
  console.log("\n\n--Start Image Server--");
  socket.on("data", (data) => {
    const decoded = decodeDataBuffer(data);
    console.log("Image Server Connection", decoded);
    const header = createDataBuffer(Buffer.from(PJ_INFO_1), {
      controlWord: "EPRD0600",
      ipAddress: decoded.header.ipAddress,
      status: 0,
    });

    socket.write(header);
  });

  socket.on("close", () => {
    console.log("--End Image Server--");
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
  ) => void
) {
  console.log("\n\n--Start Discovery Server--");

  const decodedData = decodeDataBuffer(msg);
  console.log(decodedData.header);
  if (decodedData.header.status === 1) {
    const pjInfo1 = createDataBuffer(Buffer.from(PJ_INFO_1, 'hex'), {
      controlWord: "EEMP0100",
      ipAddress: decodedData.header.ipAddress,
      status: 1,
    });

    const pjInfo2 = createDataBuffer(Buffer.from(PJ_INFO_2, 'hex'), {
      controlWord: "EEMP0100",
      ipAddress: decodedData.header.ipAddress,
      status: 3,
    });

    const pjInfo3 = createDataBuffer(Buffer.from(PJ_INFO_3, 'hex'), {
      controlWord: "EEMP0100",
      ipAddress: decodedData.header.ipAddress,
      status: 21,
    });

    send(pjInfo1, 3620, rinfo.address);

    send(pjInfo2, 3620, rinfo.address);

    send(pjInfo3, 3620, rinfo.address);

  } else if (decodedData.header.status === 4) {
    console.log("\n\nIMPORTANT MESSAGE UDP CODE 4");
  }
}
