/**
 * Envelope encryption for R2 attachment blobs (custom fork feature).
 *
 * Mirrors the ImmichCrypt2 scheme (internal/crypto/aes.go):
 *   - AES-256-GCM with random 12-byte nonce
 *   - Envelope: [version:1][nonce:12][ciphertext + tag:16]
 *
 * Zero-knowledge by construction: the plugin encrypts bytes client-side
 * before upload; the Worker only ever sees opaque ciphertext keyed by the
 * SHA-256 hash of the *plaintext* (content addressing, so dedup and
 * integrity checks are unaffected).
 *
 * The AES key is derived via HKDF-SHA256 from the existing sync token,
 * which every device already shares — no extra secret to manage.
 */

export const BLOB_ENVELOPE_VERSION = 1 as const;
export const BLOB_NONCE_LENGTH = 12 as const;
export const BLOB_TAG_LENGTH = 16 as const;

const HKDF_SALT = new TextEncoder().encode("yaos-fork:blob-encryption-salt-v1");
const HKDF_INFO = new TextEncoder().encode("yaos-fork:blob-aes-256-gcm-v1");

export interface BlobEnvelopeCrypto {
	encrypt(plaintext: ArrayBuffer): Promise<ArrayBuffer>;
	decrypt(envelope: ArrayBuffer): Promise<ArrayBuffer>;
}

/**
 * Derive a non-extractable AES-256-GCM key from the sync token.
 * The token is the shared secret across all paired devices.
 */
export async function deriveBlobEncryptionKey(
	token: string,
): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(token),
		"HKDF",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_INFO },
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

export async function encryptBlobEnvelope(
	key: CryptoKey,
	plaintext: ArrayBuffer,
): Promise<ArrayBuffer> {
	const nonce = crypto.getRandomValues(new Uint8Array(BLOB_NONCE_LENGTH));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: nonce },
		key,
		plaintext,
	);
	const envelope = new Uint8Array(
		1 + BLOB_NONCE_LENGTH + ciphertext.byteLength,
	);
	envelope[0] = BLOB_ENVELOPE_VERSION;
	envelope.set(nonce, 1);
	envelope.set(new Uint8Array(ciphertext), 1 + BLOB_NONCE_LENGTH);
	return envelope.buffer;
}

export async function decryptBlobEnvelope(
	key: CryptoKey,
	envelope: ArrayBuffer,
): Promise<ArrayBuffer> {
	const bytes = new Uint8Array(envelope);
	if (bytes.byteLength < 1 + BLOB_NONCE_LENGTH + BLOB_TAG_LENGTH) {
		throw new Error("blob envelope too short");
	}
	if (bytes[0] !== BLOB_ENVELOPE_VERSION) {
		throw new Error(`unsupported blob envelope version ${bytes[0]}`);
	}
	const nonce = bytes.subarray(1, 1 + BLOB_NONCE_LENGTH);
	const ciphertext = bytes.subarray(1 + BLOB_NONCE_LENGTH);
	try {
		return await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: nonce },
			key,
			ciphertext,
		);
	} catch {
		throw new Error(
			"blob decryption failed — wrong sync token or corrupted data",
		);
	}
}

/**
 * Lazy crypto holder: key derivation happens on first use, so construction
 * stays synchronous.
 */
export class LazyBlobEnvelopeCrypto implements BlobEnvelopeCrypto {
	private keyPromise: Promise<CryptoKey> | null = null;

	constructor(
		private readonly token: string,
		private readonly enabled: boolean,
	) {}

	private key(): Promise<CryptoKey> {
		if (!this.enabled) {
			throw new Error("blob encryption is disabled");
		}
		if (!this.keyPromise) {
			this.keyPromise = deriveBlobEncryptionKey(this.token);
		}
		return this.keyPromise;
	}

	async encrypt(plaintext: ArrayBuffer): Promise<ArrayBuffer> {
		return encryptBlobEnvelope(await this.key(), plaintext);
	}

	async decrypt(envelope: ArrayBuffer): Promise<ArrayBuffer> {
		return decryptBlobEnvelope(await this.key(), envelope);
	}
}
