/**
 * Crypto primitives for the Bluetti "v2" encrypted BLE protocol.
 * Ported from the nhurman fork (bluetti_mqtt/bluetooth/encryption.py).
 *
 * EXPERIMENTAL: validated only by internal round-trip tests, not against a real
 * encrypted device.
 *
 * The static keys below are published in Bluetti firmware / apps - they provide
 * obfuscation, not security (the protocol is MITM-able by design).
 */
import * as crypto from 'crypto';

/** 16-byte AES key used to obfuscate the pre-key-exchange handshake. */
const LOCAL_AES_KEY = Buffer.from('459FC535808941F17091E0993EE3E93D', 'hex');
/** Raw 32-byte P-256 scalar used to sign our handshake pubkey. */
const SIGN_PRIVATE_KEY = '4F19A16E3E87BDD9BD24D3E5495B88041511943CBC8B969ADE9641D0F56AF337';
/** SPKI DER of the well-known key that signs the device's pubkey. */
const SIGN_PUBLIC_KEY_DER =
    '3059301306072a8648ce3d020106082a8648ce3d03010703420004' +
    'A73ABF5D2232C8C1C72E68304343C272495E3A8FD6F30EA96DE2F4B3CE60B251' +
    'EE21AC667CF8A71E18B46B664EAEFFE3C489F24F695B6411DB7E22CCC85A8594';

/** Manufacturer-data marker that flags an encrypted (ESP32) device. */
export const ENCRYPTED_MARKER = Buffer.from('424c5545545446', 'hex'); // "BLUETTF"
/** Encrypted messages and handshake frames start with this magic. */
export const KEX_MAGIC = Buffer.from('2a2a', 'hex'); // "**"

const AES_BLOCK_SIZE = 16;

function md5(data: Buffer): Buffer {
    return crypto.createHash('md5').update(data).digest();
}

/** Sum of all bytes, big-endian, in `size` bytes. */
export function hexsum(data: Buffer, size: number): Buffer {
    let sum = 0;
    for (const b of data) {
        sum += b;
    }
    const out = Buffer.alloc(size);
    for (let i = size - 1; i >= 0; i--) {
        out[i] = sum & 0xff;
        sum >>>= 8;
    }
    return out;
}

export function hexxor(a: Buffer, b: Buffer): Buffer {
    if (a.length !== b.length) {
        throw new Error('Can only XOR two identical length byte strings');
    }
    const out = Buffer.alloc(a.length);
    for (let i = 0; i < a.length; i++) {
        out[i] = a[i] ^ b[i];
    }
    return out;
}

function aesAlgo(key: Buffer): string {
    if (key.length === 16) {
        return 'aes-128-cbc';
    }
    if (key.length === 32) {
        return 'aes-256-cbc';
    }
    throw new Error(`Unexpected AES key length ${key.length}`);
}

/**
 * Decrypt a message. Layout:
 *   [len:uint16-be][iv-seed:4?][ciphertext]
 * When `iv` is null the IV is md5(iv-seed) and the ciphertext follows the seed.
 */
export function aesDecrypt(data: Buffer, key: Buffer, iv: Buffer | null): Buffer {
    const dataLen = (data[0] << 8) + data[1];
    let realIv = iv;
    let encrypted: Buffer;
    if (realIv === null) {
        realIv = md5(data.subarray(2, 6));
        encrypted = data.subarray(6);
    } else {
        encrypted = data.subarray(2);
    }
    if (encrypted.length % AES_BLOCK_SIZE !== 0) {
        throw new Error('Data not aligned on aes block size');
    }
    const decipher = crypto.createDecipheriv(aesAlgo(key), key, realIv);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.subarray(0, dataLen);
}

/**
 * Encrypt a message. When `iv` is null a random 4-byte seed is generated and the
 * IV md5(seed) is embedded in the header (used for the final secure channel).
 */
export function aesEncrypt(data: Buffer, key: Buffer, iv: Buffer | null, ivSeed?: Buffer): Buffer {
    let header = Buffer.alloc(2);
    header.writeUInt16BE(data.length, 0);
    let realIv = iv;
    if (realIv === null) {
        const seed = ivSeed ?? crypto.randomBytes(4);
        realIv = md5(seed);
        header = Buffer.concat([header, seed]);
    }
    const padLen = (AES_BLOCK_SIZE - (data.length % AES_BLOCK_SIZE)) % AES_BLOCK_SIZE;
    const padded = Buffer.concat([data, Buffer.alloc(padLen)]);
    const cipher = crypto.createCipheriv(aesAlgo(key), key, realIv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    return Buffer.concat([header, encrypted]);
}

export interface KeyPair {
    ecdh: crypto.ECDH;
    publicKeyRaw: Buffer; // 64 bytes (X||Y, no 0x04 prefix)
}

export function generateKeyPair(): KeyPair {
    const ecdh = crypto.createECDH('prime256v1');
    const pub = ecdh.generateKeys(); // 65 bytes: 0x04 || X || Y
    return { ecdh, publicKeyRaw: pub.subarray(1) };
}

/** Derive the shared ECDH secret (32 bytes) from our keypair and the peer's raw pubkey. */
export function deriveSharedSecret(keyPair: KeyPair, peerPublicKeyRaw: Buffer): Buffer {
    const peer = Buffer.concat([Buffer.from([0x04]), peerPublicKeyRaw]);
    return keyPair.ecdh.computeSecret(peer);
}

/** Build a SEC1 EC private key (P-256) KeyObject from a raw 32-byte scalar. */
function privateKeyFromScalar(scalarHex: string): crypto.KeyObject {
    const scalar = Buffer.from(scalarHex, 'hex');
    // SEC1 ECPrivateKey: SEQUENCE { INTEGER 1, OCTET STRING scalar, [0] namedCurve(prime256v1) }
    const der = Buffer.concat([
        Buffer.from('30310201010420', 'hex'),
        scalar,
        Buffer.from('a00a06082a8648ce3d030107', 'hex'),
    ]);
    return crypto.createPrivateKey({ key: der, format: 'der', type: 'sec1' });
}

/**
 * Verify the device's signed pubkey message (64 bytes data + 64 bytes raw
 * signature) and return the data on success.
 */
export function verifyAndExtractSignedData(message: Buffer, signedDataSuffix: Buffer): Buffer {
    if (message.length !== 128) {
        throw new Error('Unexpected message length');
    }
    const data = message.subarray(0, 64);
    const signature = message.subarray(64);
    const signedData = Buffer.concat([data, signedDataSuffix]);
    const pubKey = crypto.createPublicKey({
        key: Buffer.from(SIGN_PUBLIC_KEY_DER, 'hex'),
        format: 'der',
        type: 'spki',
    });
    const ok = crypto.verify('sha256', signedData, { key: pubKey, dsaEncoding: 'ieee-p1363' }, signature);
    if (!ok) {
        throw new Error('Invalid signature');
    }
    return data;
}

/** Sign `toSign` with the well-known signing key, returning a raw 64-byte signature. */
export function signData(toSign: Buffer): Buffer {
    const key = privateKeyFromScalar(SIGN_PRIVATE_KEY);
    return crypto.sign('sha256', toSign, { key, dsaEncoding: 'ieee-p1363' });
}

/** Public key matching {@link signData}'s signing key (used to validate the sign path). */
export function signingPublicKey(): crypto.KeyObject {
    return crypto.createPublicKey(privateKeyFromScalar(SIGN_PRIVATE_KEY));
}

/** Derive the obfuscation key+IV from the device challenge (4 bytes). */
export function deriveUnsecureKeyIv(challenge: Buffer): { key: Buffer; iv: Buffer } {
    const iv = md5(Buffer.from(challenge).reverse());
    const key = hexxor(iv, LOCAL_AES_KEY);
    return { key, iv };
}
