/**
[HEADER] ASCII
45 45 4d 50 30 31 30 30 <EEMP0100>

[CLIENT IP] HEX
ac 10 00 e2 <172 16 0 226>

[STATUS] HEX
1: 02 <2>
2: 03 <3>
3: 15 <21>

[PAYLOAD_LENGTH] HEX
1: 00 00 00 30 <48>
2: 00 00 00 4a <74>
3: 00 00 00 d8 <216>

[PROJECTOR_NAME] ASCII
1: 45 42 41 46 36 37 41 41 <EB005302>
2: 41 46 36 37 41 41 <005302>

[GAP]
00 00 00

[U1] ASCII
50 42 30 30 <PB00>


-------Open TCP:3620 Connection-------
Discovery Message From iProjection App
[HEADER][CLIENT_IP][STATUS:1][PAYLOAD_LENGTH:1][GAP][GAP][GAP][GAP][GAP][GAP][GAP][GAP][GAP][GAP][GAP][GAP][GAP][GAP][GAP][GAP][GAP]

Response From Projector
[HEADER][CLIENT_IP][STATUS:2][PAYLOAD_LENGTH:2][GAP]01[GAP][PROJECTOR_NAME:1][GAP][GAP][GAP][GAP][GAP][GAP][GAP]00000001000c00000100020c[GAP][PROJECTOR_NAME:2]0000000000000000000000000000000000000000

Response From Projector
[HEADER][CLIENT_IP][STATUS:3][PAYLOAD_LENGTH:3][GAP][PROJECTOR_NAME:2][GAP][GAP][GAP][GAP][GAP][GAP][GAP]ba000001040c[GAP]0206[U1]000003068007b0040000040602008007b00405580709080000000800080080004000e001380400000000070b080000000800080010001000e001380400000000070d080000000800080010001000e0013804000000000000080000000800080010001000e001380400000000070a0100010c022d0000000008089f06f0dd000000000a0a002f0202320401000000000b0b00010a0b09070c02131415160d0a000104401f0000000000000e010005

 */
const message1HexString = "45454d5030313030c0a8012d030000004a00000001000000454230303533303200000000000000000000000000000000000000000000000001000c00000100020c0000003030353330320000000000000000000000000000000000000000"
const message1Buffer = Buffer.from(message1HexString, "hex");

const message2HexString = "45454d5030313030c0a8012d15000000d8000000303035333032000000000000000000000000000000000000000000ba000001040c000000020650423030000003068007b0040000040602008007b00405580709080000000800080080004000e001380400000000070b080000000800080010001000e001380400000000070d080000000800080010001000e0013804000000000000080000000800080010001000e001380400000000070a0100010c022d0000000008089f06f0dd000000000a0a002f0202320401000000000b0b00010a0b09070c02131415160d0a000104401f0000000000000e010005";
const message2Buffer = Buffer.from(message2HexString, "hex");


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

const decodeDiscoveryResponse = (messageBuffer) => {
    const unknownStatusCode = messageBuffer[20];
    // 21, 22, 23 are gaps
    const projectorName = messageBuffer.slice(24, 32).toString('ascii');
    const gap = messageBuffer.slice(32, 56).toString('hex');
    const unknownData = messageBuffer.slice(56, 68).toString('hex');
    const projecterName2 = messageBuffer.slice(68, 74).toString('ascii');
    
    return {
        unknownStatusCode,
        projectorName,
        gap,
        unknownData,
        projecterName2
    }
};

const decodeDataResponse = (messageBuffer) => {
    const projectorName = messageBuffer.slice(20, 26).toString('ascii');
    const gap = messageBuffer.slice(32, 56).toString('hex');
    const unknownData = messageBuffer.slice(56, 68).toString('hex');
    const projecterName2 = messageBuffer.slice(68, 74).toString('ascii');
    const ips = [];

    let startingIndex = 130;
    for (let i = 0; i < 500; i++) {
        ips.push(`${messageBuffer[startingIndex]}.${messageBuffer[startingIndex + 1]}.${messageBuffer[startingIndex + 2]}.${messageBuffer[startingIndex + 3]}`);
        startingIndex += 1;
    }
    const routerAddressIp = `${messageBuffer[startingIndex]}.${messageBuffer[startingIndex + 1]}.${messageBuffer[startingIndex + 2]}.${messageBuffer[startingIndex + 3]}`;
    
    return {
        projectorName,
        gap,
        unknownData,
        projecterName2,
        routerAddressIp,
        ips
    }
}

const decode = (messageBuffer) => {
    const header = decodeHeader(messageBuffer);

    if (header.status === 3) {
        const data = decodeDiscoveryResponse(messageBuffer);
        return {
            ...header,
            ...data,
        }
    } else if (header.status === 21) {
        const data = decodeDataResponse(messageBuffer);
        return {
            ...header,
            ...data,
        }
    }
}

console.log(decode(message1Buffer));
console.log(decode(message2Buffer));
