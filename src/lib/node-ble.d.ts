/**
 * Minimal type declarations for node-ble (the package ships no types).
 * Only the surface used by this adapter is declared.
 */
declare module 'node-ble' {
    import type { EventEmitter } from 'node:events';

    export interface GattCharacteristic extends EventEmitter {
        writeValue(
            value: Buffer,
            options?: { offset?: number; type?: 'reliable' | 'request' | 'command' },
        ): Promise<void>;
        readValue(options?: { offset?: number }): Promise<Buffer>;
        startNotifications(): Promise<void>;
        stopNotifications(): Promise<void>;
    }

    export interface GattService {
        getCharacteristic(uuid: string): Promise<GattCharacteristic>;
        characteristics(): Promise<string[]>;
    }

    export interface GattServer {
        getPrimaryService(uuid: string): Promise<GattService>;
        services(): Promise<string[]>;
    }

    export interface Device extends EventEmitter {
        connect(): Promise<void>;
        disconnect(): Promise<void>;
        isConnected(): Promise<boolean>;
        getName(): Promise<string>;
        getAddress(): Promise<string>;
        gatt(): Promise<GattServer>;
    }

    export interface Adapter {
        isDiscovering(): Promise<boolean>;
        startDiscovery(): Promise<void>;
        stopDiscovery(): Promise<void>;
        isPowered(): Promise<boolean>;
        waitDevice(address: string, timeout?: number, discoveryInterval?: number): Promise<Device>;
        getAddress(): Promise<string>;
    }

    export interface Bluetooth {
        defaultAdapter(): Promise<Adapter>;
        adapters(): Promise<string[]>;
        getAdapter(adapter: string): Promise<Adapter>;
    }

    export function createBluetooth(): { bluetooth: Bluetooth; destroy: () => void };
}
