// services/mxnSettings.js
// Dedicated MXN settings use one row in the existing deposit_addresses table.
// For coin = 'MXN': address = CLABE, qr_url = small JSON settings document.
// No database migration, new table, or Supabase Storage is required.

const { MXN_DETAILS, getMxnRate } = require('./mxnDeposit');

const MXN_COIN = 'MXN';

function defaultMxnSettings() {
  return {
    holder: MXN_DETAILS.holder,
    clabe: MXN_DETAILS.clabe,
    institution: MXN_DETAILS.institution,
    rateMxnPerUsdt: getMxnRate(),
  };
}

function validateMxnSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Invalid MXN settings.' };
  }
  const holder = typeof input.holder === 'string' ? input.holder.trim() : '';
  const clabe = typeof input.clabe === 'string' ? input.clabe.trim() : '';
  const institution = typeof input.institution === 'string' ? input.institution.trim() : '';
  const rateText = String(input.rateMxnPerUsdt ?? '').trim();
  const nameValid = value => value.length >= 2 && value.length <= 100 && !/[\u0000-\u001F\u007F]/.test(value);
  if (!nameValid(holder)) return { error: 'Enter a valid account holder (2–100 characters).' };
  if (!nameValid(institution) || institution.length > 70) return { error: 'Enter a valid institution (2–70 characters).' };
  if (!/^\\d{18}$/.test(clabe)) return { error: 'CLABE must contain exactly 18 digits.' };
  if (!/^\\d+(?:\\.\\d{1,6})?$/.test(rateText)) return { error: 'Enter an MXN per USDT rate with up to six decimal places.' };
  const rate = Number(rateText);
  if (!Number.isFinite(rate) || rate <= 0 || rate >= 100000) {
    return { error: 'MXN per USDT rate must be greater than zero and less than 100,000.' };
  }
  return { value: { holder, clabe, institution, rateMxnPerUsdt: rate } };
}

async function getMxnSettings(db) {
  const { rows } = await db.query(
    "SELECT address, qr_url FROM deposit_addresses WHERE coin = $1 LIMIT 1",
    [MXN_COIN]
  );
  if (!rows.length) return { ...defaultMxnSettings(), source: 'environment' };

  let stored;
  try {
    stored = JSON.parse(rows[0].qr_url);
  } catch {
    throw new Error('Stored MXN settings are invalid JSON.');
  }

  const checked = validateMxnSettings({
    ...stored,
    clabe: rows[0].address,
  });
  if (checked.error) throw new Error('Stored MXN settings are invalid: ' + checked.error);
  return { ...checked.value, source: 'database' };
}

async function saveMxnSettings(db, input) {
  const checked = validateMxnSettings(input);
  if (checked.error) return checked;

  const { holder, clabe, institution, rateMxnPerUsdt } = checked.value;
  const metadata = JSON.stringify({ version: 1, holder, institution, rateMxnPerUsdt });
  await db.query(
    `INSERT INTO deposit_addresses (coin, address, qr_url, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (coin)
     DO UPDATE SET address = EXCLUDED.address, qr_url = EXCLUDED.qr_url, updated_at = NOW()`,
    [MXN_COIN, clabe, metadata]
  );
  return { value: { ...checked.value, source: 'database' } };
}

module.exports = { defaultMxnSettings, getMxnSettings, saveMxnSettings, validateMxnSettings };
