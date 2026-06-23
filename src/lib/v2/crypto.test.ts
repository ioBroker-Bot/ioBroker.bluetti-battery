import { expect } from 'chai';
import * as crypto from 'node:crypto';
import {
    aesDecrypt,
    aesEncrypt,
    deriveSharedSecret,
    deriveUnsecureKeyIv,
    generateKeyPair,
    hexsum,
    hexxor,
    signData,
    signingPublicKey,
} from './crypto';

describe('v2 crypto', () => {
    it('AES round-trips with an embedded random IV seed', () => {
        const key = crypto.randomBytes(32);
        const msg = Buffer.from('0103abcdef0102', 'hex');
        expect(aesDecrypt(aesEncrypt(msg, key, null), key, null).equals(msg)).to.equal(true);
    });

    it('AES round-trips with a fixed IV (16-byte key)', () => {
        const key = crypto.randomBytes(16);
        const iv = crypto.randomBytes(16);
        const msg = Buffer.from('010300000028', 'hex');
        expect(aesDecrypt(aesEncrypt(msg, key, iv), key, iv).equals(msg)).to.equal(true);
    });

    it('computes hexsum and hexxor', () => {
        expect(hexsum(Buffer.from([1, 2, 3]), 2).toString('hex')).to.equal('0006');
        expect(hexxor(Buffer.from([0xff, 0x0f]), Buffer.from([0x0f, 0xff]))).to.deep.equal(Buffer.from([0xf0, 0xf0]));
    });

    it('derives a symmetric ECDH secret', () => {
        const a = generateKeyPair();
        const b = generateKeyPair();
        const sa = deriveSharedSecret(a, b.publicKeyRaw);
        const sb = deriveSharedSecret(b, a.publicKeyRaw);
        expect(sa.equals(sb)).to.equal(true);
        expect(sa.length).to.equal(32);
    });

    it('produces signatures verifiable by the matching public key', () => {
        const toSign = crypto.randomBytes(80);
        const sig = signData(toSign);
        expect(sig.length).to.equal(64);
        const ok = crypto.verify('sha256', toSign, { key: signingPublicKey(), dsaEncoding: 'ieee-p1363' }, sig);
        expect(ok).to.equal(true);
    });

    it('derives the obfuscation key/iv from a challenge', () => {
        const { key, iv } = deriveUnsecureKeyIv(Buffer.from([1, 2, 3, 4]));
        expect(key.length).to.equal(16);
        expect(iv.length).to.equal(16);
    });
});
