import { createBluetooth, type Adapter, type Bluetooth, type Device, type GattCharacteristic } from 'node-ble';
import type { DeviceCommand } from './commands';

const SERVICE_UUID = '0000ff00-0000-1000-8000-00805f9b34fb';
const WRITE_UUID = '0000ff02-0000-1000-8000-00805f9b34fb';
const NOTIFY_UUID = '0000ff01-0000-1000-8000-00805f9b34fb';

const RESPONSE_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 30000;

export interface ClientLogger {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
}

interface PendingCommand {
    command: DeviceCommand;
    resolve: (body: Buffer) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * Talks MODBUS-over-Bluetooth to a single Bluetti device via BlueZ (node-ble).
 * Commands are serialized: one request is on the wire at a time, matching the
 * original bluetti_mqtt client behaviour.
 */
export class BluetoothClient {
    private bluetooth?: Bluetooth;
    private destroyBluetooth?: () => void;
    private adapter?: Adapter;
    private device?: Device;
    private writeChar?: GattCharacteristic;
    private notifyChar?: GattCharacteristic;

    private notifyBuffer = Buffer.alloc(0);
    private pending?: PendingCommand;
    private readonly queue: Array<() => void> = [];
    private busy = false;
    private closed = false;

    /** Advertised device name, available after connect(). */
    name?: string;

    constructor(
        private readonly address: string,
        private readonly log: ClientLogger,
        private readonly onDisconnect: () => void,
    ) {}

    get connected(): boolean {
        return !!this.device && !!this.writeChar && !!this.notifyChar && !this.closed;
    }

    async connect(): Promise<void> {
        this.closed = false;
        const { bluetooth, destroy } = createBluetooth();
        this.bluetooth = bluetooth;
        this.destroyBluetooth = destroy;

        this.adapter = await bluetooth.defaultAdapter();
        if (!(await this.adapter.isPowered())) {
            throw new Error('Bluetooth adapter is not powered on');
        }
        if (!(await this.adapter.isDiscovering())) {
            await this.adapter.startDiscovery();
        }

        this.log.debug(`Waiting for device ${this.address}...`);
        this.device = await this.adapter.waitDevice(this.address.toUpperCase(), CONNECT_TIMEOUT_MS);

        this.device.on('disconnect', () => this.handleDisconnect());

        await this.device.connect();
        this.name = await this.device.getName().catch(() => undefined);
        this.log.info(`Connected to ${this.address}${this.name ? ` (${this.name})` : ''}`);

        const gatt = await this.device.gatt();
        const service = await gatt.getPrimaryService(SERVICE_UUID);
        this.writeChar = await service.getCharacteristic(WRITE_UUID);
        this.notifyChar = await service.getCharacteristic(NOTIFY_UUID);

        await this.notifyChar.startNotifications();
        this.notifyChar.on('valuechanged', (data: Buffer) => this.handleNotification(data));
    }

    /**
     * Queue a command and resolve with its parsed response body.
     *
     * @param command
     */
    perform(command: DeviceCommand): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            if (this.closed) {
                reject(new Error('client closed'));
                return;
            }
            const task = (): void => {
                if (!this.writeChar) {
                    this.busy = false;
                    reject(new Error('not connected'));
                    return;
                }
                this.notifyBuffer = Buffer.alloc(0);
                const timer = setTimeout(() => this.failPending(new Error('response timeout')), RESPONSE_TIMEOUT_MS);
                this.pending = { command, resolve, reject, timer };

                // Bluetti expects write-without-response on ff02.
                this.writeChar.writeValue(command.frame, { type: 'command' }).catch((err: Error) => {
                    this.failPending(err);
                });
            };
            this.queue.push(task);
            this.runNext();
        });
    }

    async disconnect(): Promise<void> {
        this.closed = true;
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending.reject(new Error('disconnecting'));
            this.pending = undefined;
        }
        try {
            await this.notifyChar?.stopNotifications();
        } catch {
            /* ignore */
        }
        try {
            await this.device?.disconnect();
        } catch {
            /* ignore */
        }
        try {
            this.destroyBluetooth?.();
        } catch {
            /* ignore */
        }
        this.writeChar = undefined;
        this.notifyChar = undefined;
        this.device = undefined;
    }

    private runNext(): void {
        if (this.busy || this.closed) {
            return;
        }
        const task = this.queue.shift();
        if (!task) {
            return;
        }
        this.busy = true;
        task();
    }

    private settlePending(): void {
        this.busy = false;
        this.runNext();
    }

    private failPending(err: Error): void {
        const pending = this.pending;
        if (!pending) {
            return;
        }
        clearTimeout(pending.timer);
        this.pending = undefined;
        pending.reject(err);
        this.settlePending();
    }

    private handleNotification(data: Buffer): void {
        const pending = this.pending;
        if (!pending) {
            return;
        }

        // Garbage that some firmware emits when the connection is unhappy.
        const text = data.toString('latin1');
        if (text === 'AT+NAME?\r' || text === 'AT+ADV?\r') {
            this.failPending(new Error('got AT+ notification (bad connection)'));
            return;
        }

        this.notifyBuffer = Buffer.concat([this.notifyBuffer, data]);
        const cmd = pending.command;

        if (this.notifyBuffer.length === cmd.responseSize()) {
            if (cmd.isValidResponse(this.notifyBuffer)) {
                clearTimeout(pending.timer);
                this.pending = undefined;
                pending.resolve(cmd.parseResponse(this.notifyBuffer));
                this.settlePending();
            } else {
                this.failPending(new Error('checksum failed'));
            }
        } else if (cmd.isExceptionResponse(this.notifyBuffer)) {
            this.failPending(new Error(`MODBUS exception ${this.notifyBuffer[2]}`));
        }
    }

    private handleDisconnect(): void {
        if (this.closed) {
            return;
        }
        this.log.warn(`Device ${this.address} disconnected`);
        this.writeChar = undefined;
        this.notifyChar = undefined;
        if (this.pending) {
            this.failPending(new Error('device disconnected'));
        }
        this.onDisconnect();
    }
}
