import crypto from 'node:crypto';

export const ENVELOPE_PREFIX_V2 = 'ntps:v2:aes256gcm:';
export const ENVELOPE_PREFIX_V1 = 'ntps:v1:aes256gcm:';

const SCRYPT_N_V2 = 131072; // 2^17 (128 MiB RAM)
const SCRYPT_N_V1 = 16384; // Legacy v1 parameter (kept strictly for read migration)
const SCRYPT_R = 8;
const SCRYPT_P = 1;
// Node's default scrypt maxmem (32 MiB) is insufficient for N=131072, r=8 (requires 128 MiB)
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

export const MIN_PASSPHRASE_LENGTH_V2 = 32;
export const MIN_PASSPHRASE_LENGTH_V1 = 16;

export const HOT_WALLET_CRYPTO_SPEC = {
  v2Prefix: ENVELOPE_PREFIX_V2,
  v1Prefix: ENVELOPE_PREFIX_V1,
  scryptNV2: SCRYPT_N_V2,
  scryptNV1: SCRYPT_N_V1,
  minPassphraseLengthV2: MIN_PASSPHRASE_LENGTH_V2,
  minPassphraseLengthV1: MIN_PASSPHRASE_LENGTH_V1,
} as const;

export interface HotWalletKeyResolution {
  privateKey: string;
  source: 'encrypted' | 'plaintext_fallback';
  envelopeVersion?: 'v1' | 'v2';
}

function normalizeTronPrivateKey(rawKey: string): string {
  const trimmed = rawKey.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(
      'Invalid TRON hot wallet private key format (expected 64 hexadecimal characters).'
    );
  }
  return trimmed;
}

function deriveAesKey(
  decryptionSecret: string,
  salt: Buffer,
  version: 'v1' | 'v2'
): Buffer {
  const minLen = version === 'v2' ? MIN_PASSPHRASE_LENGTH_V2 : MIN_PASSPHRASE_LENGTH_V1;
  const scryptN = version === 'v2' ? SCRYPT_N_V2 : SCRYPT_N_V1;

  if (!decryptionSecret || decryptionSecret.trim().length < minLen) {
    throw new Error(
      `HOT_WALLET_DECRYPTION_KEY must be at least ${minLen} characters for ${version} envelopes.`
    );
  }

  return crypto.scryptSync(decryptionSecret, salt, KEY_LEN, {
    N: scryptN,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

/**
 * Encrypts a TRON private key using AES-256-GCM with a random salt + IV
 * and hardened scrypt (N=131072, r=8, p=1) emitting `ntps:v2:aes256gcm:...`.
 */
export function encryptHotWalletPrivateKey(
  plainPrivateKey: string,
  decryptionSecret: string
): string {
  const normalizedKey = normalizeTronPrivateKey(plainPrivateKey);
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const aesKey = deriveAesKey(decryptionSecret, salt, 'v2');

  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(normalizedKey, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return [
      'ntps',
      'v2',
      'aes256gcm',
      salt.toString('hex'),
      iv.toString('hex'),
      authTag.toString('hex'),
      ciphertext.toString('hex'),
    ].join(':');
  } finally {
    aesKey.fill(0);
  }
}

export function detectEnvelopeVersion(encryptedPayload: string): 'v1' | 'v2' | null {
  const trimmed = encryptedPayload.trim();
  if (trimmed.startsWith(ENVELOPE_PREFIX_V2)) return 'v2';
  if (trimmed.startsWith(ENVELOPE_PREFIX_V1)) return 'v1';
  return null;
}

/**
 * Decrypts an `ntps:v2:aes256gcm:...` (or legacy `ntps:v1:aes256gcm:...`) envelope.
 * Never logs or includes secret material in thrown errors.
 */
export function decryptHotWalletPrivateKey(
  encryptedPayload: string,
  decryptionSecret: string
): string {
  const trimmed = encryptedPayload.trim();
  const version = detectEnvelopeVersion(trimmed);
  if (!version) {
    throw new Error(
      'Unsupported HOT_WALLET_PRIVATE_KEY_ENCRYPTED format (expected ntps:v2:aes256gcm:<salt>:<iv>:<tag>:<ciphertext>).'
    );
  }

  if (version === 'v1') {
    console.warn(
      '[SECURITY WARNING] Decrypting legacy ntps:v1 hot wallet envelope (scrypt N=16384). Re-encrypt with `npm run encrypt-key` to upgrade to ntps:v2 (scrypt N=131072, min 32 chars).'
    );
  }

  const parts = trimmed.split(':');
  if (parts.length !== 7) {
    throw new Error('Malformed HOT_WALLET_PRIVATE_KEY_ENCRYPTED payload.');
  }

  const [, , , saltHex, ivHex, tagHex, cipherHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(cipherHex, 'hex');

  if (
    salt.length !== SALT_LEN ||
    iv.length !== IV_LEN ||
    authTag.length !== AUTH_TAG_LEN ||
    ciphertext.length === 0
  ) {
    throw new Error('Invalid AES-256-GCM parameter lengths in encrypted key payload.');
  }

  const aesKey = deriveAesKey(decryptionSecret, salt, version);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');

    return normalizeTronPrivateKey(decrypted);
  } catch {
    throw new Error(
      'Failed to decrypt HOT_WALLET_PRIVATE_KEY_ENCRYPTED. Verify HOT_WALLET_DECRYPTION_KEY.'
    );
  } finally {
    aesKey.fill(0);
  }
}

/**
 * Resolves the hot wallet private key from encrypted environment variables first.
 * In `NODE_ENV=production`, unencrypted `HOT_WALLET_PRIVATE_KEY` fallback is refused
 * unless `ALLOW_PLAINTEXT_KEY=true` is explicitly set. Never logs key material.
 */
export function resolveHotWalletPrivateKey(
  env: NodeJS.ProcessEnv = process.env
): HotWalletKeyResolution {
  const encrypted = env.HOT_WALLET_PRIVATE_KEY_ENCRYPTED?.trim();
  const decryptionKey = env.HOT_WALLET_DECRYPTION_KEY?.trim();
  const plaintext = env.HOT_WALLET_PRIVATE_KEY?.trim();
  const isProduction = env.NODE_ENV?.trim().toLowerCase() === 'production';
  const allowPlaintext = env.ALLOW_PLAINTEXT_KEY?.trim().toLowerCase() === 'true';

  if (encrypted) {
    if (!decryptionKey) {
      throw new Error(
        'HOT_WALLET_PRIVATE_KEY_ENCRYPTED is set, but HOT_WALLET_DECRYPTION_KEY is missing.'
      );
    }
    const envelopeVersion = detectEnvelopeVersion(encrypted) ?? undefined;
    const privateKey = decryptHotWalletPrivateKey(encrypted, decryptionKey);
    console.log(
      `[SECURITY] TRON hot wallet key decrypted via AES-256-GCM ${envelopeVersion ?? ''} envelope.`.replace(
        /\s+/g,
        ' '
      )
    );
    return { privateKey, source: 'encrypted', envelopeVersion };
  }

  if (plaintext) {
    if (isProduction && !allowPlaintext) {
      throw new Error(
        'Refusing unencrypted HOT_WALLET_PRIVATE_KEY in production (NODE_ENV=production). Configure HOT_WALLET_PRIVATE_KEY_ENCRYPTED + HOT_WALLET_DECRYPTION_KEY, or set ALLOW_PLAINTEXT_KEY=true only as a temporary migration override.'
      );
    }

    const privateKey = normalizeTronPrivateKey(plaintext);
    if (isProduction && allowPlaintext) {
      console.warn(
        '[SECURITY WARNING] ALLOW_PLAINTEXT_KEY=true override is active in NODE_ENV=production. Migrate immediately to HOT_WALLET_PRIVATE_KEY_ENCRYPTED (ntps:v2).'
      );
    } else {
      console.warn(
        '[SECURITY WARNING] Using unencrypted HOT_WALLET_PRIVATE_KEY dev fallback. Migrate to HOT_WALLET_PRIVATE_KEY_ENCRYPTED + HOT_WALLET_DECRYPTION_KEY before production.'
      );
    }
    return { privateKey, source: 'plaintext_fallback' };
  }

  throw new Error(
    'Missing hot wallet key: configure HOT_WALLET_PRIVATE_KEY_ENCRYPTED + HOT_WALLET_DECRYPTION_KEY (recommended) or HOT_WALLET_PRIVATE_KEY (non-production fallback).'
  );
}
