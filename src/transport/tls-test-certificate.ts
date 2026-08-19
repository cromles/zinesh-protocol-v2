import { generateKeyPairSync, sign } from 'crypto';

/** Test-only ephemeral certificate generation. No private material is persisted in source. */
export function selfSignedTestCertificate(validFrom: Date, validTo: Date, commonName = 'localhost'): {
  readonly certificate: string; readonly privateKey: string;
} {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = sequence(oid('1.2.840.113549.1.1.11'), der(0x05, Buffer.alloc(0)));
  const name = sequence(set(sequence(oid('2.5.4.3'), der(0x0c, Buffer.from(commonName)))));
  const validity = sequence(utcTime(validFrom), utcTime(validTo));
  const subjectPublicKeyInfo = pair.publicKey.export({ format: 'der', type: 'spki' });
  const tbs = sequence(
    der(0xa0, integer(Buffer.from([2]))), integer(Buffer.from([1])), algorithm,
    name, validity, name, subjectPublicKeyInfo,
  );
  const signature = sign('RSA-SHA256', tbs, pair.privateKey);
  const certificate = sequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return {
    certificate: pem('CERTIFICATE', certificate),
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

function sequence(...children: Buffer[]): Buffer { return der(0x30, Buffer.concat(children)); }
function set(...children: Buffer[]): Buffer { return der(0x31, Buffer.concat(children)); }
function integer(value: Buffer): Buffer { return der(0x02, value[0]! >= 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value); }
function utcTime(value: Date): Buffer {
  const year = String(value.getUTCFullYear() % 100).padStart(2, '0');
  const parts = [value.getUTCMonth() + 1, value.getUTCDate(), value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds()]
    .map((part) => String(part).padStart(2, '0')).join('');
  return der(0x17, Buffer.from(`${year}${parts}Z`));
}
function oid(value: string): Buffer {
  const parts = value.split('.').map(Number);
  const bytes = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const encoded = [part & 0x7f];
    for (let remaining = Math.floor(part / 128); remaining > 0; remaining = Math.floor(remaining / 128))
      encoded.unshift((remaining & 0x7f) | 0x80);
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}
function der(tag: number, content: Buffer): Buffer {
  const length = content.length < 128 ? Buffer.from([content.length])
    : (() => { const bytes: number[] = []; for (let value = content.length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
      return Buffer.from([0x80 | bytes.length, ...bytes]); })();
  return Buffer.concat([Buffer.from([tag]), length, content]);
}
function pem(label: string, content: Buffer): string {
  const base64 = content.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}
