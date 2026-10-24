import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { address as btcAddress, Block, payments, Transaction } from 'bitcoinjs-lib';
import type { PaymentEvent } from '../src/types.js';

// El logger lee el entorno al importarse: sin pino-pretty ni logs en los tests
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'silent';
const { handleRawBlock, handleRawTx } = await import('../src/zmq.js');
const { store } = await import('../src/store.js');

const WATCHED = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const OTHER = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const SECRET = 'per-watch-secret';

type Received = PaymentEvent & { validSignature: boolean };

let server: Server;
let callbackUrl: string;
let received: Received[] = [];

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const expected = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
      const event: PaymentEvent = JSON.parse(body);
      received.push({ ...event, validSignature: req.headers['x-webhook-signature'] === expected });
      res.end('ok');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const bound = server.address();
  assert.ok(bound && typeof bound === 'object', 'server did not bind a TCP port');
  callbackUrl = `http://127.0.0.1:${bound.port}/hook`;
});

after(() => server.close());

beforeEach(() => {
  received = [];
  for (const watch of store.list()) store.remove(watch.id);
});

const paymentTx = (sats: bigint): Transaction => {
  const memo = payments.embed({ data: [new TextEncoder().encode('memo')] }).output;
  assert.ok(memo);
  const tx = new Transaction();
  tx.addInput(new Uint8Array(32).fill(7), 0);
  tx.addOutput(memo, 0n);
  tx.addOutput(btcAddress.toOutputScript(OTHER), 5_000n);
  tx.addOutput(btcAddress.toOutputScript(WATCHED), sats);
  return tx;
};

let height = 0;
const blockWith = (txs: Transaction[]): Buffer => {
  const coinbase = new Transaction();
  coinbase.addInput(new Uint8Array(32), 0xffffffff, 0xffffffff, new Uint8Array([height & 0xff, height >> 8]));
  coinbase.addOutput(btcAddress.toOutputScript(OTHER), 312_500_000n);
  const block = new Block();
  block.version = 0x20000000;
  block.prevHash = new Uint8Array(32);
  block.timestamp = 1_790_000_000 + height * 600;
  block.bits = 0x1d00ffff;
  block.nonce = height++;
  block.transactions = [coinbase, ...txs];
  block.merkleRoot = Block.calculateMerkleRoot(block.transactions);
  return Buffer.from(block.toBuffer());
};

const watch = () => store.add({ address: WATCHED, expected_sats: 150_000, callback_url: callbackUrl, hmac_secret: SECRET, expires_at: Date.now() + 60_000 });

describe('handleRawTx', () => {
  it('fires a signed mempool_detected webhook for a payment to a watched address', async () => {
    const { id } = watch();
    const tx = paymentTx(150_000n);

    await handleRawTx(Buffer.from(tx.toBuffer()));

    assert.equal(received.length, 1);
    const [detected] = received;
    assert.ok(detected);
    const { event, watch_id, txid, amount_sats, confirmations, validSignature } = detected;
    assert.deepEqual(
      { event, watch_id, txid, amount_sats, confirmations, validSignature },
      { event: 'mempool_detected', watch_id: id, txid: tx.getId(), amount_sats: 150_000, confirmations: 0, validSignature: true },
    );
    assert.equal(store.get(id)?.status, 'detected_mempool');
    assert.equal(store.get(id)?.detected_txid, tx.getId());
  });

  it('ignores transactions that do not pay a watched address', async () => {
    const { id } = watch();
    const tx = new Transaction();
    tx.addInput(new Uint8Array(32).fill(9), 0);
    tx.addOutput(btcAddress.toOutputScript(OTHER), 150_000n);

    await handleRawTx(Buffer.from(tx.toBuffer()));

    assert.equal(received.length, 0);
    assert.equal(store.get(id)?.status, 'pending');
  });
});

describe('handleRawBlock', () => {
  it('reports one confirmation per block from inclusion up to 6, then stops', async () => {
    const { id } = watch();
    const tx = paymentTx(150_000n);
    await handleRawTx(Buffer.from(tx.toBuffer()));

    await handleRawBlock(blockWith([])); // aún en mempool
    await handleRawBlock(blockWith([tx]));
    for (let i = 0; i < 6; i++) await handleRawBlock(blockWith([]));

    const confirmations = received.filter(e => e.event === 'confirmation');
    assert.deepEqual(confirmations.map(e => e.confirmations), [1, 2, 3, 4, 5, 6]);
    assert.ok(confirmations.every(e => e.txid === tx.getId() && e.amount_sats === 150_000 && e.validSignature));
    assert.equal(store.get(id)?.status, 'confirmed');
    assert.equal(store.get(id)?.confirmations, 6);
  });
});
