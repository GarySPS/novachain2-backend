//services>mxnDeposit.js

// Shared MXN quote and form validation. No new database tables are required.
const MXN_DETAILS = Object.freeze({
  holder: process.env.MXN_BANK_HOLDER || 'Carlos Martin Gonzalez Ortiz',
  clabe: process.env.MXN_BANK_CLABE || '722969020602102378',
  institution: process.env.MXN_BANK_INSTITUTION || 'Mercado Pago',
});
const MAX_MXN = 1000000;

function getMxnRate() {
  // MXN per 1 USDT. Explicitly configured, not an unverified live market price.
  const value = Number(process.env.MXN_PER_USDT);
  return Number.isFinite(value) && value > 0 && value < 100000 ? value : null;
}

function makeQuote(rawAmount, savedSettings) {
  const settings = savedSettings || { ...MXN_DETAILS, rateMxnPerUsdt: getMxnRate() };
  const rate = Number(settings.rateMxnPerUsdt);
  if (!Number.isFinite(rate) || rate <= 0 || rate >= 100000) {
    return { error: 'MXN deposits are currently unavailable. Exchange rate not configured.', status: 503 };
  }
  if (typeof rawAmount !== 'string' && typeof rawAmount !== 'number') {
    return { error: 'Enter an MXN amount.', status: 400 };
  }
  const stringValue = String(rawAmount).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(stringValue)) {
    return { error: 'Enter an amount in MXN with up to 2 decimals.', status: 400 };
  }
  const mxn = Number(stringValue);
  if (!Number.isFinite(mxn) || mxn <= 0 || mxn > MAX_MXN) {
    return { error: `MXN amount must be above 0 and at most ${MAX_MXN}.`, status: 400 };
  }
  const usdt = Number((mxn / rate).toFixed(6));
  if (usdt <= 0) return { error: 'Amount is too small to convert.', status: 400 };
  return {
    mxnAmount: mxn.toFixed(2),
    usdtAmount: usdt.toFixed(6),
    rateMxnPerUsdt: rate,
    payment: { holder: settings.holder, clabe: settings.clabe, institution: settings.institution },
  };
}

function normalizeReference(raw) {
  const normalized = typeof raw === 'string' ? raw.trim().toUpperCase().replace(/\s/g, '') : '';
  return /^[A-Z0-9._-]{6,64}$/.test(normalized) ? normalized : null;
}

// Existing deposits.screenshot is TEXT. Bank metadata is stored as a tagged
// string and must never be mistaken for a receipt image or Web3 tx hash.
function makeMxnMetadata({ reference, mxnAmount, usdtAmount, rateMxnPerUsdt }) {
  return 'mxn-spei:v1:' + JSON.stringify({ reference, mxnAmount, usdtAmount, rateMxnPerUsdt });
}

// v2: A small compressed receipt travels with the MXN request, stored in the
// existing deposits.screenshot TEXT column. The first 64 hex chars allow a
// database-level duplicate lookup without reading receipt images into JS.
const RECEIPT_PREFIX = 'mxn-spei:v2:';

function receiptMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer.length >= 12 && buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WEBP') return 'image/webp';
  return null;
}

function makeMxnReceiptMetadata({ receipt, mxnAmount, usdtAmount, rateMxnPerUsdt, payment }) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(receipt.buffer).digest('hex');
  return {
    hash,
    stored: RECEIPT_PREFIX + hash + ':' + JSON.stringify({
      mxnAmount, usdtAmount, rateMxnPerUsdt,
      payment: payment || null, // Historical recipient snapshot for later review.
      receiptMime: receipt.mime,
      imageBase64: receipt.buffer.toString('base64'),
    }),
  };
}

function parseMxnReceipt(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(RECEIPT_PREFIX)) return null;
  const content = stored.slice(RECEIPT_PREFIX.length);
  if (!/^[a-f0-9]{64}:/.test(content)) return null;
  try {
    return { hash: content.slice(0, 64), ...JSON.parse(content.slice(65)) };
  } catch { return null; }
}

function redactMxnReceipt(stored) {
  const parsed = parseMxnReceipt(stored);
  if (!parsed) return stored;
  const { imageBase64, hash, ...metadata } = parsed;
  return RECEIPT_PREFIX + hash + ':' + JSON.stringify({ ...metadata, receiptAvailable: !!imageBase64 });
}

module.exports = {
  MXN_DETAILS, getMxnRate, makeQuote, normalizeReference, makeMxnMetadata,
  RECEIPT_PREFIX, receiptMime, makeMxnReceiptMetadata, parseMxnReceipt, redactMxnReceipt,
};
