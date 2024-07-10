import dgram from 'dgram';
import { createServer } from 'net';

const discoveryString = "00000001000000454230303533303200000000000000000000000000000000000000000000000001000c00000100020c0000003030353330320000000000000000000000000000000000000000";
const dataString = "000000303035333032000000000000000000000000000000000000000000ba000001040c000000020650423030000003068007b0040000040602008007b00405580709080000000800080080004000e001380400000000070b080000000800080010001000e001380400000000070d080000000800080010001000e0013804000000000000080000000800080010001000e001380400000000070a0100010c022d0000000008089f06f0dd000000000a0a002f0202320401000000000b0b00010a0b09070c02131415160d0a000104401f0000000000000e010005";

const decodeHeader = (messageBuffer) => {
    const controlWord = messageBuffer.slice(0, 8).toString('ascii');
    const clientIpString = `${messageBuffer[8]}.${messageBuffer[9]}.${messageBuffer[10]}.${messageBuffer[11]}`;
    const clientIpBuffer = messageBuffer.slice(8, 12);
    const status = messageBuffer[12];
    const payloadLength = messageBuffer.slice(13, 17).readUInt32BE();

    return {
        controlWord,
        clientIpString,
        clientIpBuffer,
        status,
        payloadLength
    };
}

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
        payloadLengthBuffer
    ]);
}


// Function to create the first response packet
const createDiscoveryResponse = (packet) => {
    const header = createHeader(packet, 3, 74);
    const discoveryBuffer = Buffer.from(discoveryString, 'hex');
    return Buffer.concat([
        header,
        discoveryBuffer
    ]);
};

// Function to create the second response packet
const createDataResponse = (packet) => {
    const header = createHeader(packet, 21, 216);
    const dataBuffer = Buffer.from(dataString, 'hex');
    return Buffer.concat([
        header,
        dataBuffer
    ]);
};

// Function to print packet report
const printPacketReport = (packet) => {
    try {
        const header = decodeHeader(packet);
        
        console.log('Header', header);
    } catch (error) {
        console.error('Error while printing packet report:', error);
    }
};

// Function to handle TCP data
const handleTcpData = (data, socket) => {
    console.log('------Start------');
    printPacketReport(data);

        const discoverResponse = createDiscoveryResponse(data);
        console.log('Discover response:', discoverResponse.toString('hex'));
        socket.write(discoverResponse);

        setTimeout(() => {
            const dataResponse = createDataResponse(data);
            console.log('Data response:', dataResponse.toString('hex'));
            socket.write(dataResponse);
        }, 500);

};

// TCP server setup
const tcpServer = createServer((socket) => {
    socket.on('data', (data) => handleTcpData(data, socket));


    socket.on('error', (err) => {
        console.error('TCP server error:', err);
    });
});

tcpServer.listen(3620, '172.16.0.9', () => {
    console.log('TCP server is listening on port 3620');
});
