import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  createVerify,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/**
 * Local fake push service. It holds a real user-agent key pair, so it can
 * check the VAPID headers and decrypt the RFC 8291 aes128gcm body.
 */
export function newSubscriber(endpoint: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    subscription: {
      endpoint,
      keys: {
        p256dh: ecdh.getPublicKey().toString('base64url'),
        auth: auth.toString('base64url'),
      },
    },
  };
}

export function decryptAes128gcm(
  body: Buffer,
  subscriber: ReturnType<typeof newSubscriber>,
): unknown {
  const salt = body.subarray(0, 16);
  const idLen = body[20]!;
  const asPublic = body.subarray(21, 21 + idLen);
  const ciphertext = body.subarray(21 + idLen);
  const secret = subscriber.ecdh.computeSecret(asPublic);
  const uaPublic = subscriber.ecdh.getPublicKey();
  const prk = Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      subscriber.auth,
      Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]),
      32,
    ),
  );
  const cek = Buffer.from(
    hkdfSync('sha256', prk, salt, 'Content-Encoding: aes128gcm\0', 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', prk, salt, 'Content-Encoding: nonce\0', 12),
  );
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  const end = padded.lastIndexOf(0x02);
  return JSON.parse(padded.subarray(0, end).toString('utf8'));
}

/** Verifies `Authorization: vapid t=<jwt>, k=<key>` and returns the claims. */
export function checkVapid(
  authorization: string,
  publicKey: string,
): Record<string, unknown> {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
  if (!match) throw new Error('bad vapid header');
  const [head, claims, signature] = match[1]!.split('.');
  if (match[2] !== publicKey) throw new Error('bad vapid key');
  const raw = Buffer.from(publicKey, 'base64url');
  const key = createPublicKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'),
      y: raw.subarray(33, 65).toString('base64url'),
    },
  });
  const ok = createVerify('SHA256')
    .update(`${head}.${claims}`)
    .verify(
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature!, 'base64url'),
    );
  if (!ok) throw new Error('bad vapid signature');
  return JSON.parse(Buffer.from(claims!, 'base64url').toString('utf8'));
}

export interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  redirect: string;
  hasSignal: boolean;
}
