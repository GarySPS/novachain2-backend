// Run: node --test tests/mxnSettings.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMxnSettings, getMxnSettings, saveMxnSettings } = require('../services/mxnSettings');
const { makeQuote, makeMxnReceiptMetadata, parseMxnReceipt } = require('../services/mxnDeposit');

const sample = {
  holder: 'Carlos Martin Gonzalez Ortiz',
  clabe: '722969020602102378',
  institution: 'Mercado Pago',
  rateMxnPerUsdt: '20',
};

test('validate and reject malformed MXN settings', () => {
  assert.equal(validateMxnSettings(sample).value.rateMxnPerUsdt, 20);
  assert.ok(validateMxnSettings({ ...sample, clabe: '123' }).error);
  assert.ok(validateMxnSettings({ ...sample, rateMxnPerUsdt: '0' }).error);
  assert.ok(validateMxnSettings({ ...sample, rateMxnPerUsdt: '20.1234567' }).error);
  assert.ok(validateMxnSettings({ ...sample, holder: 'Bad\nName' }).error);
});

test('new quote uses saved recipient and rate, not a hardcoded value', () => {
  const settings = validateMxnSettings(sample).value;
  const quote = makeQuote('1000.00', settings);
  assert.equal(quote.rateMxnPerUsdt, 20);
  assert.equal(quote.usdtAmount, '50.000000');
  assert.equal(quote.payment.clabe, sample.clabe);
});

test('settings are written to existing deposit_addresses with one MXN record', async () => {
  const calls = [];
  const fakeDb = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [] };
  } };
  const result = await saveMxnSettings(fakeDb, sample);
  assert.equal(result.value.source, 'database');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], 'MXN');
  assert.equal(calls[0].params[1], sample.clabe);
  assert.deepEqual(JSON.parse(calls[0].params[2]), {
    version: 1, holder: sample.holder, institution: sample.institution, rateMxnPerUsdt: 20,
  });
});

test('saved MXN settings override environment on subsequent reads', async () => {
  const fakeDb = { query: async () => ({ rows: [{
    address: sample.clabe,
    qr_url: JSON.stringify({ version: 1, holder: sample.holder, institution: sample.institution, rateMxnPerUsdt: 18.6 }),
  }] }) };
  const saved = await getMxnSettings(fakeDb);
  assert.equal(saved.source, 'database');
  assert.equal(saved.rateMxnPerUsdt, 18.6);
  assert.equal(Number(makeQuote('1000', saved).usdtAmount), 53.763441);
});

test('new receipts preserve the recipient snapshot', () => {
  const receipt = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0x01]), mime: 'image/jpeg' };
  const quote = makeQuote('1000', validateMxnSettings(sample).value);
  const record = makeMxnReceiptMetadata({
    receipt, mxnAmount: quote.mxnAmount, usdtAmount: quote.usdtAmount,
    rateMxnPerUsdt: quote.rateMxnPerUsdt, payment: quote.payment,
  });
  const parsed = parseMxnReceipt(record.stored);
  assert.equal(parsed.payment.clabe, sample.clabe);
  assert.equal(parsed.usdtAmount, '50.000000');
});
