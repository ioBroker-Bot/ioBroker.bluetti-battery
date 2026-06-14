/**
 * CRC-16/MODBUS (poly 0xA001, init 0xFFFF, reflected).
 * Ported from bluetti_mqtt (crcmod 'modbus').
 *
 * @param data
 */
export function modbusCrc(data: Buffer): number {
    let crc = 0xffff;
    for (const byte of data) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) {
            if (crc & 1) {
                crc = (crc >>> 1) ^ 0xa001;
            } else {
                crc >>>= 1;
            }
        }
    }
    return crc & 0xffff;
}
