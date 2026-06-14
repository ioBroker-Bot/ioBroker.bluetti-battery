import { expect } from 'chai';
import { buildV2Device } from './v2device';

/** Encode a word-swapped uint32 the way the device sends it. */
function writeU32(buf: Buffer, offset: number, value: number): void {
    buf.writeUInt16BE(value & 0xffff, offset); // low word first
    buf.writeUInt16BE((value >>> 16) & 0xffff, offset + 2); // high word last
}

describe('v2 device', () => {
    const device = buildV2Device();

    it('is byte-addressed, encrypted and exposes writable switches', () => {
        expect(device.struct.bytesPerAddress).to.equal(1);
        expect(device.encrypted).to.equal(true);
        expect(device.struct.writableField('ac_output_on')?.address).to.equal(2011);
        expect(device.struct.writableField('dc_output_on')?.address).to.equal(2012);
    });

    it('decodes the HOME_DATA block with renamed fields', () => {
        const block = Buffer.alloc(67 * 2); // ReadHoldingRegisters(100, 67) -> 134 bytes
        block.writeUInt16BE(83, 4); // pack_soc @ 100+4 -> total_battery_percent
        writeU32(block, 88, 70000); // total_pv_power @ 100+88 -> dc_input_power
        block.writeUInt16BE(0b110, 48); // ctrl_status @ 100+48 (AC_ENABLE | DC_ENABLE)

        const parsed = device.struct.parse(100, block);
        expect(parsed.total_battery_percent).to.equal(83);
        expect(parsed.dc_input_power).to.equal(70000);
        expect(parsed.ctrl_status).to.equal(0b110);

        device.postParse!(parsed);
        expect(parsed.ac_output_on).to.equal(true);
        expect(parsed.dc_output_on).to.equal(true);
    });
});
