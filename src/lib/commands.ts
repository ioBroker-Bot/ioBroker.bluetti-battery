import { modbusCrc } from './crc';

/**
 * MODBUS-over-Bluetooth command frames.
 * Ported from bluetti_mqtt/core/commands.py.
 *
 * Frame layout: [addr=1][function_code][...data...][crc16-le]
 */
export abstract class DeviceCommand {
    readonly functionCode: number;
    /** The full wire frame, including CRC. Written to the device as-is. */
    readonly frame: Buffer;

    constructor(functionCode: number, data: Buffer) {
        this.functionCode = functionCode;

        const buf = Buffer.alloc(data.length + 4);
        buf[0] = 1; // MODBUS address
        buf[1] = functionCode;
        data.copy(buf, 2);
        const crc = modbusCrc(buf.subarray(0, buf.length - 2));
        buf.writeUInt16LE(crc, buf.length - 2);
        this.frame = buf;
    }

    /** Expected total response size in bytes (used to know when a response is complete). */
    abstract responseSize(): number;

    isExceptionResponse(response: Buffer): boolean {
        return response.length >= 2 && response[1] === this.functionCode + 0x80;
    }

    isValidResponse(response: Buffer): boolean {
        if (response.length < 3) {
            return false;
        }
        const crc = modbusCrc(response.subarray(0, response.length - 2));
        return response.readUInt16LE(response.length - 2) === crc;
    }

    /**
     * Extract the raw payload from a validated response.
     *
     * @param response
     */
    parseResponse(response: Buffer): Buffer {
        return response;
    }
}

/** Function 3 - read a contiguous block of holding registers. */
export class ReadHoldingRegisters extends DeviceCommand {
    constructor(
        readonly startingAddress: number,
        readonly quantity: number,
    ) {
        const data = Buffer.alloc(4);
        data.writeUInt16BE(startingAddress, 0);
        data.writeUInt16BE(quantity, 2);
        super(3, data);
    }

    responseSize(): number {
        // 3 byte header + 2 bytes per register + 2 byte crc
        return 2 * this.quantity + 5;
    }

    parseResponse(response: Buffer): Buffer {
        return response.subarray(3, response.length - 2);
    }
}

/** Function 6 - write a single holding register. */
export class WriteSingleRegister extends DeviceCommand {
    constructor(
        readonly address: number,
        readonly value: number,
    ) {
        const data = Buffer.alloc(4);
        data.writeUInt16BE(address, 0);
        data.writeUInt16BE(value & 0xffff, 2);
        super(6, data);
    }

    responseSize(): number {
        return 8;
    }

    parseResponse(response: Buffer): Buffer {
        return response.subarray(4, 6);
    }
}
