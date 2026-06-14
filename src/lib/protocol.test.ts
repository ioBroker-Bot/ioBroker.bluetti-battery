import { expect } from 'chai';
import { modbusCrc } from './crc';
import { ReadHoldingRegisters, WriteSingleRegister } from './commands';
import { buildDevice, detectFromName } from './devices';
import type { BoolField } from './fields';

describe('modbusCrc', () => {
    it('matches the CRC-16/MODBUS catalog check value', () => {
        expect(modbusCrc(Buffer.from('123456789'))).to.equal(0x4b37);
    });
});

describe('commands', () => {
    it('builds a correct ReadHoldingRegisters frame', () => {
        const cmd = new ReadHoldingRegisters(10, 40);
        // 01 03 00 0A 00 28 + CRC(little-endian)
        expect(cmd.frame.toString('hex')).to.equal('0103000a002865d6');
        expect(cmd.responseSize()).to.equal(2 * 40 + 5);
    });

    it('validates a response by its CRC', () => {
        const cmd = new ReadHoldingRegisters(0, 1);
        // header 01 03 02, one register 00 55, then valid CRC
        const body = Buffer.from([0x01, 0x03, 0x02, 0x00, 0x55]);
        const crc = modbusCrc(body);
        const resp = Buffer.concat([body, Buffer.from([crc & 0xff, crc >> 8])]);
        expect(cmd.isValidResponse(resp)).to.equal(true);
        resp[4] = 0x99; // corrupt
        expect(cmd.isValidResponse(resp)).to.equal(false);
    });

    it('builds a WriteSingleRegister frame', () => {
        const cmd = new WriteSingleRegister(3007, 1);
        expect(cmd.functionCode).to.equal(6);
        expect(cmd.isValidResponse(cmd.frame)).to.equal(true); // self-consistent CRC
    });
});

describe('device detection', () => {
    it('parses advertised names', () => {
        expect(detectFromName('AC3001234567890123')).to.deep.equal({ type: 'AC300', serial: '1234567890123' });
        expect(detectFromName('EP500P999')).to.deep.equal({ type: 'EP500P', serial: '999' });
        expect(detectFromName('NOPE123')).to.equal(undefined);
    });
});

describe('field decoding (AC300)', () => {
    const device = buildDevice('AC300')!;

    function registerBlock(startAddress: number, length: number, values: Record<number, number>): Buffer {
        const buf = Buffer.alloc(length * 2);
        for (const [addr, value] of Object.entries(values)) {
            const offset = (Number(addr) - startAddress) * 2;
            buf.writeUInt16BE(value, offset);
        }
        return buf;
    }

    it('decodes core registers from the 10..49 block', () => {
        const block = registerBlock(10, 40, {
            36: 120, // dc_input_power
            43: 85, // total_battery_percent
            41: 123, // power_generation raw -> 12.3 (scale 1)
            48: 1, // ac_output_on
            49: 0, // dc_output_on
        });
        const parsed = device.struct.parse(10, block);
        expect(parsed.dc_input_power).to.equal(120);
        expect(parsed.total_battery_percent).to.equal(85);
        expect(parsed.power_generation).to.equal(12.3);
        expect(parsed.ac_output_on).to.equal(true);
        expect(parsed.dc_output_on).to.equal(false);
    });

    it('skips out-of-range decimal readings', () => {
        // internal_dc_input_current @88 is clamped to 0..15
        const block = registerBlock(70, 21, { 88: 9999 });
        const parsed = device.struct.parse(70, block);
        expect(parsed).to.not.have.property('internal_dc_input_current');
    });

    it('exposes writable controls only inside the 3000 range', () => {
        expect(device.struct.writableField('ac_output_on')?.address).to.equal(3007);
        expect(device.struct.writableField('dc_input_power')).to.equal(undefined);
    });

    it('encodes bool setters to 0/1', () => {
        const field = device.struct.writableField('ac_output_on') as BoolField;
        expect(field.toRegister(true)).to.equal(1);
        expect(field.toRegister(false)).to.equal(0);
    });
});
