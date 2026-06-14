/**
 * Field decoders + register struct.
 * Ported from bluetti_mqtt/core/devices/struct.py.
 *
 * Addresses and sizes are counted in 16-bit registers (2 bytes each).
 */

export type FieldValue = number | string | boolean | number[];

/** Map of enum register value -> human readable name. */
export type EnumMap = Record<number, string>;

function round(value: number, decimals: number): number {
    return Number(value.toFixed(decimals));
}

/**
 * Swap every pair of bytes (Bluetti stores some strings little-endian per word).
 *
 * @param data
 */
export function swapBytes(data: Buffer): Buffer {
    const arr = Buffer.from(data);
    for (let i = 0; i + 1 < arr.length; i += 2) {
        const tmp = arr[i];
        arr[i] = arr[i + 1];
        arr[i + 1] = tmp;
    }
    return arr;
}

export abstract class DeviceField {
    /** True when this register can be written (set by the device definition). */
    writable = false;
    /** Optional enum value->name map, used to build the ioBroker state's `states`. */
    enumMap?: EnumMap;

    constructor(
        public name: string,
        readonly address: number,
        readonly size: number,
    ) {}

    /** Number of bytes this field occupies in a response. */
    get byteLength(): number {
        return 2 * this.size;
    }

    abstract parse(data: Buffer): FieldValue;

    inRange(_value: FieldValue): boolean {
        return true;
    }

    /**
     * Convert a state value into the register value to write.
     *
     * @param value
     */
    toRegister(value: unknown): number {
        return Number(value) & 0xffff;
    }
}

export class UintField extends DeviceField {
    constructor(
        name: string,
        address: number,
        readonly range?: [number, number],
    ) {
        super(name, address, 1);
    }

    parse(data: Buffer): number {
        return data.readUInt16BE(0);
    }

    inRange(value: FieldValue): boolean {
        if (!this.range) {
            return true;
        }
        return (value as number) >= this.range[0] && (value as number) <= this.range[1];
    }
}

export class BoolField extends DeviceField {
    constructor(name: string, address: number) {
        super(name, address, 1);
    }

    parse(data: Buffer): boolean {
        return data.readUInt16BE(0) === 1;
    }

    toRegister(value: unknown): number {
        return value ? 1 : 0;
    }
}

export class EnumField extends DeviceField {
    constructor(name: string, address: number, enumMap: EnumMap) {
        super(name, address, 1);
        this.enumMap = enumMap;
    }

    parse(data: Buffer): number {
        // Stored as the raw numeric value; the name is exposed via state `states`.
        return data.readUInt16BE(0);
    }
}

export class DecimalField extends DeviceField {
    constructor(
        name: string,
        address: number,
        readonly scale: number,
        readonly range?: [number, number],
    ) {
        super(name, address, 1);
    }

    parse(data: Buffer): number {
        return round(data.readUInt16BE(0) / 10 ** this.scale, this.scale);
    }

    inRange(value: FieldValue): boolean {
        if (!this.range) {
            return true;
        }
        return (value as number) >= this.range[0] && (value as number) <= this.range[1];
    }
}

export class DecimalArrayField extends DeviceField {
    constructor(
        name: string,
        address: number,
        size: number,
        readonly scale: number,
    ) {
        super(name, address, size);
    }

    parse(data: Buffer): number[] {
        const out: number[] = [];
        for (let i = 0; i < this.size; i++) {
            out.push(round(data.readUInt16BE(i * 2) / 10 ** this.scale, this.scale));
        }
        return out;
    }
}

export class StringField extends DeviceField {
    parse(data: Buffer): string {
        return stripNull(data);
    }
}

export class SwapStringField extends DeviceField {
    parse(data: Buffer): string {
        return stripNull(swapBytes(data));
    }
}

function stripNull(data: Buffer): string {
    let end = data.length;
    while (end > 0 && data[end - 1] === 0) {
        end--;
    }
    return data.subarray(0, end).toString('ascii');
}

export class VersionField extends DeviceField {
    constructor(name: string, address: number) {
        super(name, address, 2);
    }

    parse(data: Buffer): number {
        const low = data.readUInt16BE(0);
        const high = data.readUInt16BE(2);
        return round((low + high * 0x10000) / 100, 2);
    }
}

export class SerialNumberField extends DeviceField {
    constructor(name: string, address: number) {
        super(name, address, 4);
    }

    parse(data: Buffer): string {
        // Up to 64 bits - use BigInt and return as string to avoid precision loss.
        let value = 0n;
        for (let i = 0; i < 4; i++) {
            value += BigInt(data.readUInt16BE(i * 2)) << BigInt(16 * i);
        }
        return value.toString();
    }
}

// --- v2 (byte-addressed) field types ------------------------------------------

/** Single unsigned byte. */
export class Uint8Field extends DeviceField {
    constructor(name: string, address: number) {
        super(name, address, 1);
    }
    get byteLength(): number {
        return 1;
    }
    parse(data: Buffer): number {
        return data[0];
    }
}

/** 32-bit unsigned, stored word-swapped (high word last) as Bluetti does. */
export class Uint32Field extends DeviceField {
    constructor(name: string, address: number) {
        super(name, address, 2);
    }
    get byteLength(): number {
        return 4;
    }
    parse(data: Buffer): number {
        return ((data[2] << 24) | (data[3] << 16) | (data[0] << 8) | data[1]) >>> 0;
    }
}

/** Word-swapped 32-bit value scaled by 10^-scale. */
export class Decimal32Field extends DeviceField {
    constructor(
        name: string,
        address: number,
        readonly scale: number,
    ) {
        super(name, address, 2);
    }
    get byteLength(): number {
        return 4;
    }
    parse(data: Buffer): number {
        const raw = ((data[2] << 24) | (data[3] << 16) | (data[0] << 8) | data[1]) >>> 0;
        return round(raw / 10 ** this.scale, this.scale);
    }
}

export class DeviceStruct {
    readonly fields: DeviceField[] = [];

    /**
     * @param bytesPerAddress How many bytes one address unit spans. 2 for the
     *   classic register-addressed devices, 1 for the byte-addressed v2 devices.
     */
    constructor(readonly bytesPerAddress: 1 | 2 = 2) {}

    addUint(name: string, address: number, range?: [number, number]): void {
        this.fields.push(new UintField(name, address, range));
    }
    addUint8(name: string, address: number): void {
        this.fields.push(new Uint8Field(name, address));
    }
    addUint32(name: string, address: number): void {
        this.fields.push(new Uint32Field(name, address));
    }
    addDecimal32(name: string, address: number, scale: number): void {
        this.fields.push(new Decimal32Field(name, address, scale));
    }
    addBool(name: string, address: number): void {
        this.fields.push(new BoolField(name, address));
    }
    addEnum(name: string, address: number, enumMap: EnumMap): void {
        this.fields.push(new EnumField(name, address, enumMap));
    }
    addDecimal(name: string, address: number, scale: number, range?: [number, number]): void {
        this.fields.push(new DecimalField(name, address, scale, range));
    }
    addDecimalArray(name: string, address: number, size: number, scale: number): void {
        this.fields.push(new DecimalArrayField(name, address, size, scale));
    }
    addString(name: string, address: number, size: number): void {
        this.fields.push(new StringField(name, address, size));
    }
    addSwapString(name: string, address: number, size: number): void {
        this.fields.push(new SwapStringField(name, address, size));
    }
    addVersion(name: string, address: number): void {
        this.fields.push(new VersionField(name, address));
    }
    addSerialNumber(name: string, address: number): void {
        this.fields.push(new SerialNumberField(name, address));
    }

    /**
     * Mark every field whose address falls inside one of the given [start, end)
     * ranges as writable.
     *
     * @param ranges
     */
    markWritable(ranges: Array<[number, number]>): void {
        for (const f of this.fields) {
            if (ranges.some(r => f.address >= r[0] && f.address < r[1])) {
                f.writable = true;
            }
        }
    }

    /**
     * Find the writable field for a given name (used to build setter commands).
     *
     * @param name
     */
    writableField(name: string): DeviceField | undefined {
        return this.fields.find(f => f.name === name && f.writable);
    }

    /**
     * Parse a register block starting at `startingAddress` into a name->value map.
     * Out-of-range sensor readings are skipped (mirrors the Python behaviour).
     *
     * @param startingAddress
     * @param data
     */
    parse(startingAddress: number, data: Buffer): Record<string, FieldValue> {
        const bpa = this.bytesPerAddress;
        const end = startingAddress + Math.floor(data.length / bpa);
        const result: Record<string, FieldValue> = {};

        for (const f of this.fields) {
            const unitSpan = Math.ceil(f.byteLength / bpa);
            if (f.address < startingAddress || f.address + unitSpan - 1 >= end) {
                continue;
            }
            const start = bpa * (f.address - startingAddress);
            const fieldData = data.subarray(start, start + f.byteLength);
            if (fieldData.length < f.byteLength) {
                continue;
            }
            const value = f.parse(fieldData);
            if (!f.inRange(value)) {
                continue;
            }
            result[f.name] = value;
        }

        return result;
    }
}
