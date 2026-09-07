// utils/crypto/tokenCipher.js
//
// Reversible, app-level encryption for long-lived third-party credentials we
// must store (e.g. a tenant's eBay refresh_token) — unlike passwords, these
// need to be read back in plaintext to make API calls, so hashing (crypto.js)
// doesn't apply here. AES-256-GCM: authenticated encryption, so a tampered
// ciphertext fails to decrypt rather than silently returning garbage.

const crypto = require("crypto");
const config = require("../../config");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommended for GCM

function getKey() {
  const key = config.security.encryptionKey;
  if (!key) throw new Error("ENCRYPTION_KEY is not set — cannot encrypt/decrypt stored credentials");
  const buf = Buffer.from(key, "hex");
  if (buf.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes, hex-encoded (64 hex characters) — e.g. `openssl rand -hex 32`");
  }
  return buf;
}

// Returns null in, null out — callers store this shape directly on a
// Mongoose field group; encrypting `null` (nothing configured yet) should
// stay `null`, not an encrypted empty string.
function encrypt(plaintext) {
  if (plaintext == null) return { ciphertext: null, iv: null, tag: null };

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decrypt({ ciphertext, iv, tag }) {
  if (!ciphertext || !iv || !tag) return null;

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

// ── ciphertext packing ───────────────────────────────────────────────────────
//
// encrypt() above returns {ciphertext, iv, tag} — three base64 strings.
// ChannelConnection's generic contract (see models/ChannelConnection.js) has
// a single *_ct string per token slot, shared across every platform's cipher
// output, so the three parts are packed into one delimited string here
// rather than widening that schema per platform.
// NOTE: base64 alphabets never contain ".", so joining/splitting on "." is
// unambiguous and reversible.
//
// NOTE: services/ebay/ebay.settings.service.js already has its OWN private
// copy of these exact two functions, predating this shared extraction. It
// is intentionally left untouched and NOT switched over to import these —
// this run's invariants forbid editing anything under services/ebay/. New
// platforms (starting with Google) use this shared copy; eBay's copy stays
// where it is.
function packCiphertext({ ciphertext, iv, tag }) {
  if (!ciphertext) return null;
  return `${iv}.${tag}.${ciphertext}`;
}

function unpackCiphertext(packed) {
  if (!packed) return { ciphertext: null, iv: null, tag: null };
  const [iv, tag, ciphertext] = packed.split(".");
  return { ciphertext, iv, tag };
}

module.exports = { encrypt, decrypt, packCiphertext, unpackCiphertext };
