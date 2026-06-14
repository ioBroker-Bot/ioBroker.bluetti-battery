/**
 * Connection layer for the Bluetti v2 BLE protocol.
 * Ported from the nhurman fork (bluetti_mqtt/bluetooth/encryption.py).
 *
 * EXPERIMENTAL: the handshake is a faithful port but has not been verified
 * against a real encrypted device.
 *
 * A Connection sits between the raw GATT characteristic and the MODBUS layer:
 * `onPacket` receives raw notification bytes, `write` sends a plaintext MODBUS
 * frame (encrypting it when required). For unencrypted devices the passthrough
 * implementation is a no-op wrapper.
 */
import {
    aesDecrypt,
    aesEncrypt,
    deriveSharedSecret,
    deriveUnsecureKeyIv,
    generateKeyPair,
    hexsum,
    type KeyPair,
    KEX_MAGIC,
    signData,
    verifyAndExtractSignedData,
} from './crypto';

export interface Connection {
    /** Feed raw bytes received from the notify characteristic. */
    onPacket(data: Buffer): Promise<void>;
    /** Send a plaintext MODBUS frame (encrypting it if needed). */
    write(buffer: Buffer): Promise<void>;
    /** Resolves once the connection is usable (immediately for passthrough). */
    waitUntilReady(): Promise<void>;
}

type WriteRaw = (buffer: Buffer) => Promise<void>;
type OnPlaintext = (buffer: Buffer) => void;

export class PassthroughConnection implements Connection {
    constructor(
        private readonly onPlaintext: OnPlaintext,
        private readonly writeRaw: WriteRaw,
    ) {}

    onPacket(data: Buffer): Promise<void> {
        this.onPlaintext(data);
        return Promise.resolve();
    }

    async write(buffer: Buffer): Promise<void> {
        await this.writeRaw(buffer);
    }

    async waitUntilReady(): Promise<void> {
        /* always ready */
    }
}

const enum MessageType {
    CHALLENGE = 1,
    CHALLENGE_ACCEPTED = 3,
    PEER_PUBKEY = 4,
    PUBKEY_ACCEPTED = 6,
}

/** A handshake frame: [magic:2a2a][type:1][data...][checksum:2]. */
class Message {
    constructor(readonly buffer: Buffer) {}

    get isPreKeyExchange(): boolean {
        return this.buffer.subarray(0, 2).equals(KEX_MAGIC);
    }
    private get body(): Buffer {
        return this.buffer.subarray(2, this.buffer.length - 2);
    }
    private get checksum(): Buffer {
        return this.buffer.subarray(this.buffer.length - 2);
    }
    get data(): Buffer {
        return this.body.subarray(1);
    }
    get type(): number {
        return this.body[0];
    }

    verifyChecksum(): void {
        if (!hexsum(this.body, 2).equals(this.checksum)) {
            throw new Error('Checksum mismatch');
        }
    }
}

export class EncryptedConnection implements Connection {
    private unsecureKey?: Buffer;
    private unsecureIv?: Buffer;
    private secureKey?: Buffer;
    private peerPublicKey?: Buffer;
    private keyPair?: KeyPair;

    private ready = false;
    private readyResolve?: () => void;
    private readyReject?: (err: Error) => void;
    private readonly readyPromise: Promise<void>;

    constructor(
        private readonly onPlaintext: OnPlaintext,
        private readonly writeRaw: WriteRaw,
    ) {
        this.readyPromise = new Promise<void>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
    }

    waitUntilReady(): Promise<void> {
        return this.readyPromise;
    }

    async write(buffer: Buffer): Promise<void> {
        if (!this.secureKey) {
            throw new Error('Encryption handshake not finished yet');
        }
        await this.writeRaw(aesEncrypt(buffer, this.secureKey, null));
    }

    async onPacket(data: Buffer): Promise<void> {
        try {
            await this.handlePacket(data);
        } catch (err) {
            if (!this.ready && this.readyReject) {
                this.readyReject(err as Error);
            }
            throw err;
        }
    }

    private async handlePacket(data: Buffer): Promise<void> {
        const message = new Message(data);
        if (message.isPreKeyExchange) {
            message.verifyChecksum();
            if (message.type === MessageType.CHALLENGE) {
                return this.onChallenge(message);
            }
            if (message.type === MessageType.CHALLENGE_ACCEPTED) {
                this.onChallengeAccepted(message);
                return;
            }
            throw new Error(`Unknown message type ${message.type}`);
        }

        if (!this.unsecureKey || !this.unsecureIv) {
            throw new Error('Received encrypted message before key initialization');
        }

        const [key, iv]: [Buffer, Buffer | null] = this.secureKey
            ? [this.secureKey, null]
            : [this.unsecureKey, this.unsecureIv];
        const decrypted = new Message(aesDecrypt(data, key, iv));

        if (decrypted.isPreKeyExchange) {
            decrypted.verifyChecksum();
            if (decrypted.type === MessageType.PEER_PUBKEY) {
                return this.onPeerPubkey(decrypted);
            }
            if (decrypted.type === MessageType.PUBKEY_ACCEPTED) {
                this.onKeyAccepted(decrypted);
                return;
            }
        }

        // Regular (decrypted) MODBUS data.
        this.onPlaintext(decrypted.buffer);
    }

    private async onChallenge(message: Message): Promise<void> {
        if (message.data.length !== 4) {
            throw new Error('Unexpected challenge length');
        }
        const { key, iv } = deriveUnsecureKeyIv(message.data);
        this.unsecureKey = key;
        this.unsecureIv = iv;

        const body = Buffer.concat([Buffer.from('0204', 'hex'), iv.subarray(8, 12)]);
        await this.writeRaw(Buffer.concat([KEX_MAGIC, body, hexsum(body, 2)]));
    }

    private onChallengeAccepted(message: Message): void {
        if (message.data.length !== 1 || message.data[0] !== 0) {
            throw new Error('Challenge not accepted');
        }
    }

    private async onPeerPubkey(message: Message): Promise<void> {
        const iv = this.unsecureIv!;
        const key = this.unsecureKey!;
        this.peerPublicKey = verifyAndExtractSignedData(message.data, iv);

        this.keyPair = generateKeyPair();
        const myPub = this.keyPair.publicKeyRaw;
        const signature = signData(Buffer.concat([myPub, iv]));

        const body = Buffer.concat([Buffer.from('0580', 'hex'), myPub, signature]);
        const msg = Buffer.concat([KEX_MAGIC, body, hexsum(body, 2)]);
        await this.writeRaw(aesEncrypt(msg, key, iv));
    }

    private onKeyAccepted(message: Message): void {
        if (message.data.length !== 1 || message.data[0] !== 0) {
            throw new Error('Key not accepted');
        }
        this.secureKey = deriveSharedSecret(this.keyPair!, this.peerPublicKey!);
        this.ready = true;
        this.readyResolve?.();
    }
}
