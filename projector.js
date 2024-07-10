import dgram from "dgram";
import { createServer } from "net";

const discoveryString =
  "00000001000000454230303533303200000000000000000000000000000000000000000000000001000c00000100020c0000003030353330320000000000000000000000000000000000000000";
const dataString =
  "000000303035333032000000000000000000000000000000000000000000ba000001040c000000020650423030000003068007b0040000040602008007b00405580709080000000800080080004000e001380400000000070b080000000800080010001000e001380400000000070d080000000800080010001000e0013804000000000000080000000800080010001000e001380400000000070a0100010c022d0000000008089f06f0dd000000000a0a002f0202320401000000000b0b00010a0b09070c02131415160d0a000104401f0000000000000e010005";

const decodeHeader = (messageBuffer) => {
  const controlWord = messageBuffer.slice(0, 8).toString("ascii");
  const clientIpString = `${messageBuffer[8]}.${messageBuffer[9]}.${messageBuffer[10]}.${messageBuffer[11]}`;
  const clientIpBuffer = messageBuffer.slice(8, 12);
  const status = messageBuffer[12];
  const payloadLength = messageBuffer.slice(13, 17).readUInt32BE();

  return {
    controlWord,
    clientIpString,
    clientIpBuffer,
    status,
    payloadLength,
  };
};

const createHeader = (messageBuffer, status, payloadLength) => {
  const controlWord = messageBuffer.slice(0, 8);
  const clientIp = messageBuffer.slice(8, 12);
  const statusBuffer = Buffer.alloc(1);
  statusBuffer.writeUInt8(status, 0);
  const payloadLengthBuffer = Buffer.alloc(4);
  payloadLengthBuffer.writeUInt32BE(payloadLength, 0);

  return Buffer.concat([
    controlWord,
    clientIp,
    statusBuffer,
    payloadLengthBuffer,
  ]);
};

// Function to create the first response packet
const createDiscoveryResponse = (packet) => {
  const header = createHeader(packet, 3, 74);
  const discoveryBuffer = Buffer.from(discoveryString, "hex");
  return Buffer.concat([header, discoveryBuffer]);
};

// Function to create the second response packet
const createDataResponse = (packet) => {
  const header = createHeader(packet, 21, 216);
  const dataBuffer = Buffer.from(dataString, "hex");
  return Buffer.concat([header, dataBuffer]);
};

// Function to create the first response packet
const createConnectionResponse = (packet) => {
    const header = createHeader(packet, 4, 74);
    const discoveryBuffer = Buffer.from(discoveryString, "hex");
    return Buffer.concat([header, discoveryBuffer]);
  };

// Function to print packet report
const printPacketReport = (packet) => {
  try {
    const header = decodeHeader(packet);

    console.log("Header", header);
  } catch (error) {
    console.error("Error while printing packet report:", error);
  }
};

// Function to handle TCP data
const handleTcpData = (data, socket) => {
  const header = decodeHeader(data);

  if(header.status === 2) {
    // Search Request
    console.log('Search Request')
    const discoverResponse = createDiscoveryResponse(data);
    socket.write(discoverResponse);
  
    setTimeout(() => {
      const dataResponse = createDataResponse(data);
      socket.write(dataResponse);
    }, 500);
  } else if(header.status === 1) {
    // Connection Request
    console.log('Connection Request')
    console.log(header)
    const restOfData = data.slice(17).toString('hex');
    console.log('Rest of data:', restOfData);

    const connectionResponse = createConnectionResponse(data);
    socket.write(connectionResponse);

    setTimeout(() => {
        const dataResponse = createConnectionResponse(data);
        socket.write(dataResponse);
        }, 500);
  } else {
    console.log('Unknown request')
  }
 
};

// TCP server setup
const tcpServer = createServer((socket) => {
    console.log("------Start------");
  socket.on("data", (data) => handleTcpData(data, socket));

  socket.on('close', () => {
    console.log("------End------");
});

  socket.on("error", (err) => {
    console.error("TCP server error:", err);
  });
});

tcpServer.listen(3620, "0.0.0.0", () => {
  console.log("TCP server is listening on port 3620");
});

// TCP Image server setup
const tcpImageServer = createServer((socket) => {
    console.log("------Image Connection------");
  socket.on("data", (data) => console.log(data.toString('hex')));

  socket.on('close', () => {
    console.log("------Image End------");
});

  socket.on("error", (err) => {
    console.error("TCP server error:", err);
  });
});

tcpImageServer.listen(3621, "0.0.0.0", () => {
  console.log("TCP Image server is listening on port 3621");
});

// UDP server setup
const udpServer = dgram.createSocket("udp4");

udpServer.on("error", (err) => {
    console.error("UDP server error:", err);
    }
);

udpServer.on("message", (msg, rinfo) => {
    const header = decodeHeader(msg);

    if(header.status === 2) {
      // Search Request
      console.log('Search Request UDP')
      const discoverResponse = createDiscoveryResponse(msg);
        udpServer.send(discoverResponse, rinfo.port, rinfo.address);
    
      setTimeout(() => {
        const dataResponse = createDataResponse(msg);
        udpServer.send(dataResponse, rinfo.port, rinfo.address);
      }, 500);
    } else if(header.status === 1) {
      // Connection Request
      console.log('Connection Request UDP')
      console.log(header)
      const restOfData = msg.slice(17).toString('hex');
      console.log('Rest of data:', restOfData);
  
      const connectionResponse = createConnectionResponse(msg);
        udpServer.send(connectionResponse, rinfo.port, rinfo.address);
    } else {
      console.log('Unknown request')
    }
    }
);

udpServer.on("listening", () => {
    const address = udpServer.address();
    console.log(`UDP server listening ${address.address}:${address.port}`);
    });

udpServer.bind(3620);

