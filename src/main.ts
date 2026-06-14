/*
 * ioBroker Bluetti battery adapter.
 * MODBUS-over-Bluetooth port of warhammerkid/bluetti_mqtt.
 */
import * as utils from '@iobroker/adapter-core';
import type { ReadHoldingRegisters } from './lib/commands';
import { WriteSingleRegister } from './lib/commands';
import {
    BoolField,
    type DeviceField,
    EnumField,
    SerialNumberField,
    StringField,
    SwapStringField,
    VersionField,
    type FieldValue,
} from './lib/fields';
import { BluetoothClient } from './lib/bluetoothClient';
import { buildDevice, detectFromName, SUPPORTED_TYPES, type DeviceDefinition } from './lib/devices';

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const PACK_SELECT_REGISTER = 3006;

class BluettiBattery extends utils.Adapter {
    private client?: BluetoothClient;
    private device?: DeviceDefinition;
    private pollTimer?: ReturnType<typeof setTimeout>;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private polling = false;
    private stopping = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'bluetti-battery' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.setState('info.connection', { val: false, ack: true });

        const mac = (this.config.macAddress || '').trim();
        if (!MAC_RE.test(mac)) {
            this.log.error(`Invalid or missing MAC address: "${mac}". Configure it in the adapter settings.`);
            return;
        }
        if (!(this.config.pollInterval > 0)) {
            this.config.pollInterval = 10;
        }

        this.subscribeStates('*');
        await this.connectLoop(mac);
    }

    /**
     * Connect with retry, then build objects and start polling.
     *
     * @param mac
     */
    private async connectLoop(mac: string): Promise<void> {
        if (this.stopping) {
            return;
        }
        this.client = new BluetoothClient(mac, this.log, () => this.handleDisconnect(mac));
        try {
            await this.client.connect();
        } catch (err) {
            this.log.warn(`Connection failed: ${(err as Error).message}. Retrying in 15s.`);
            await this.client.disconnect().catch(() => undefined);
            this.scheduleReconnect(mac, 15000);
            return;
        }

        const device = this.resolveDevice(this.client.name);
        if (!device) {
            this.log.error(
                `Could not determine device type. Advertised name: "${this.client.name ?? '?'}". ` +
                    `Set the device type manually in settings. Supported: ${SUPPORTED_TYPES.join(', ')}.`,
            );
            await this.client.disconnect().catch(() => undefined);
            return;
        }
        this.device = device;
        this.log.info(`Using device profile: ${device.type}`);

        const encrypted = this.resolveEncryption(device);
        try {
            await this.client.beginSession(encrypted);
        } catch (err) {
            this.log.warn(`Session setup failed: ${(err as Error).message}. Retrying in 15s.`);
            await this.client.disconnect().catch(() => undefined);
            this.scheduleReconnect(mac, 15000);
            return;
        }

        await this.createObjects(device);
        await this.setState('info.connection', { val: true, ack: true });
        await this.poll();
    }

    /** Decide whether to use the encrypted v2 protocol (config override wins). */
    private resolveEncryption(device: DeviceDefinition): boolean {
        const mode = (this.config.encryption || 'auto').trim();
        if (mode === 'on') {
            return true;
        }
        if (mode === 'off') {
            return false;
        }
        return !!device.encrypted;
    }

    private resolveDevice(name?: string): DeviceDefinition | undefined {
        const configured = (this.config.deviceType || 'auto').trim();
        if (configured && configured !== 'auto') {
            return buildDevice(configured);
        }
        if (name) {
            const detected = detectFromName(name);
            if (detected) {
                return buildDevice(detected.type);
            }
        }
        return undefined;
    }

    private handleDisconnect(mac: string): void {
        if (this.stopping) {
            return;
        }
        void this.setState('info.connection', { val: false, ack: true });
        this.clearTimers();
        this.scheduleReconnect(mac, 5000);
    }

    private scheduleReconnect(mac: string, delay: number): void {
        if (this.stopping) {
            return;
        }
        this.clearTimers();
        this.reconnectTimer = setTimeout(() => {
            void this.connectLoop(mac);
        }, delay);
    }

    private clearTimers(): void {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
    }

    // --- Polling --------------------------------------------------------------

    private async poll(): Promise<void> {
        if (this.polling || this.stopping || !this.client?.connected || !this.device) {
            return;
        }
        this.polling = true;
        try {
            const merged: Record<string, FieldValue> = {};
            for (const cmd of this.device.pollingCommands) {
                const body = await this.client.perform(cmd);
                Object.assign(merged, this.device.struct.parse(cmd.startingAddress, body));
            }
            this.device.postParse?.(merged);
            await this.writeValues('', merged);

            if (this.config.pollPacks && this.device.packPollingCommands.length) {
                await this.pollPacks();
            }

            await this.setState('info.connection', { val: true, ack: true });
        } catch (err) {
            this.log.warn(`Polling failed: ${(err as Error).message}`);
            await this.setState('info.connection', { val: false, ack: true });
        } finally {
            this.polling = false;
        }

        if (!this.stopping) {
            this.pollTimer = setTimeout(() => void this.poll(), this.config.pollInterval * 1000);
        }
    }

    private async pollPacks(): Promise<void> {
        if (!this.client || !this.device) {
            return;
        }
        for (let pack = 1; pack <= this.device.packNumMax; pack++) {
            await this.client.perform(new WriteSingleRegister(PACK_SELECT_REGISTER, pack));
            for (const cmd of this.device.packPollingCommands) {
                const body = await this.client.perform(cmd);
                const parsed = this.device.struct.parse(cmd.startingAddress, body);
                await this.writeValues(`packs.${pack}.`, parsed);
            }
        }
    }

    private async writeValues(prefix: string, values: Record<string, FieldValue>): Promise<void> {
        for (const [name, value] of Object.entries(values)) {
            const val = Array.isArray(value) ? JSON.stringify(value) : value;
            await this.setState(`${prefix}${name}`, { val, ack: true });
        }
    }

    // --- Object creation ------------------------------------------------------

    private async createObjects(device: DeviceDefinition): Promise<void> {
        const rootNames = this.coveredNames(device, device.pollingCommands);
        for (const field of rootNames.values()) {
            await this.createStateObject('', field, device);
        }

        if (device.packPollingCommands.length) {
            const packNames = this.coveredNames(device, device.packPollingCommands);
            for (let pack = 1; pack <= device.packNumMax; pack++) {
                await this.setObjectNotExistsAsync(`packs.${pack}`, {
                    type: 'channel',
                    common: { name: `Battery pack ${pack}` },
                    native: {},
                });
                for (const field of packNames.values()) {
                    await this.createStateObject(`packs.${pack}.`, field, device);
                }
            }
        }
    }

    /**
     * Unique field-name -> representative field, for fields covered by the commands.
     *
     * @param device
     * @param cmds
     */
    private coveredNames(device: DeviceDefinition, cmds: ReadHoldingRegisters[]): Map<string, DeviceField> {
        const map = new Map<string, DeviceField>();
        const bpa = device.struct.bytesPerAddress;
        for (const field of device.struct.fields) {
            const span = Math.ceil(field.byteLength / bpa);
            const covered = cmds.some(c => {
                const units = (c.quantity * 2) / bpa; // response is quantity*2 bytes
                return field.address >= c.startingAddress && field.address + span - 1 <= c.startingAddress + units - 1;
            });
            if (covered && !map.has(field.name)) {
                map.set(field.name, field);
            }
        }
        return map;
    }

    private async createStateObject(prefix: string, field: DeviceField, device: DeviceDefinition): Promise<void> {
        const writable = !prefix && !!device.struct.writableField(field.name);
        const meta = stateMeta(field, writable);
        const common: ioBroker.StateCommon = {
            name: field.name.replace(/_/g, ' '),
            type: meta.type,
            role: meta.role,
            read: true,
            write: writable,
        };
        if (meta.unit) {
            common.unit = meta.unit;
        }
        if (field.enumMap) {
            common.states = { ...field.enumMap };
        }
        await this.extendObject(`${prefix}${field.name}`, { type: 'state', common, native: {} });
    }

    // --- Controls -------------------------------------------------------------

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack || !this.device || !this.client?.connected) {
            return;
        }
        const name = id.substring(id.lastIndexOf('.') + 1);
        const field = this.device.struct.writableField(name);
        if (!field) {
            return;
        }

        try {
            const register = field.toRegister(state.val);
            await this.client.perform(new WriteSingleRegister(field.address, register));
            this.log.info(`Set ${name} = ${String(state.val)} (register ${field.address} = ${register})`);
            await this.setState(id, { val: state.val, ack: true });
        } catch (err) {
            this.log.warn(`Failed to set ${name}: ${(err as Error).message}`);
        }
    }

    private onUnload(callback: () => void): void {
        this.stopping = true;
        this.clearTimers();
        const done = (): void => {
            try {
                callback();
            } catch {
                /* ignore */
            }
        };
        if (this.client) {
            this.client.disconnect().then(done, done);
        } else {
            done();
        }
    }
}

interface StateMeta {
    type: ioBroker.CommonType;
    role: string;
    unit?: string;
}

function stateMeta(field: DeviceField, writable: boolean): StateMeta {
    const name = field.name;
    if (name === 'cell_voltages') {
        return { type: 'string', role: 'json' };
    }
    if (field instanceof BoolField) {
        return { type: 'boolean', role: writable ? 'switch' : 'indicator' };
    }
    if (field instanceof EnumField) {
        return { type: 'number', role: writable ? 'level.mode' : 'value' };
    }
    if (field instanceof StringField || field instanceof SwapStringField || field instanceof SerialNumberField) {
        return { type: 'string', role: 'text' };
    }
    if (field instanceof VersionField) {
        return { type: 'number', role: 'value' };
    }
    if (name === 'power_generation') {
        return { type: 'number', role: 'value.power.consumed', unit: 'kWh' };
    }
    if (name.endsWith('percent') || name.startsWith('battery_range')) {
        return { type: 'number', role: name.includes('battery') ? 'value.battery' : 'value', unit: '%' };
    }
    if (name.endsWith('power')) {
        return { type: 'number', role: 'value.power', unit: 'W' };
    }
    if (name.includes('voltage')) {
        return { type: 'number', role: 'value.voltage', unit: 'V' };
    }
    if (name.includes('current')) {
        return { type: 'number', role: 'value.current', unit: 'A' };
    }
    if (name.includes('frequency')) {
        return { type: 'number', role: 'value', unit: 'Hz' };
    }
    return { type: 'number', role: 'value' };
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new BluettiBattery(options);
} else {
    (() => new BluettiBattery())();
}
