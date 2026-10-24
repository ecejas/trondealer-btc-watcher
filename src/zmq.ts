import { Subscriber } from 'zeromq';
import { address as btcAddress, Block, Transaction } from 'bitcoinjs-lib';
import { logger } from './logger.js';
import { store } from './store.js';
import { sendWebhook } from './webhook.js';

const BITCOIND_ZMQ_RAWTX = process.env.BITCOIND_ZMQ_RAWTX || 'tcp://bitcoind:28333';
const BITCOIND_ZMQ_RAWBLOCK = process.env.BITCOIND_ZMQ_RAWBLOCK || 'tcp://bitcoind:28332';

const CONFIRMATIONS_TARGET = 6;

function txOutputsToAddresses(tx: Transaction): Array<{ address: string; value: number }> {
  const results: Array<{ address: string; value: number }> = [];
  for (const output of tx.outs) {
    try {
      // bitcoinjs-lib v7 da el valor en bigint; los sats siempre caben en un Number
      results.push({ address: btcAddress.fromOutputScript(output.script), value: Number(output.value) });
    } catch {
      // Output con script no estándar, ignorar
    }
  }
  return results;
}

export async function handleRawTx(rawTx: Buffer) {
  const tx = Transaction.fromBuffer(rawTx);
  const txid = tx.getId();
  const outputs = txOutputsToAddresses(tx);

  for (const { address, value } of outputs) {
    const watches = store.getByAddress(address);
    for (const watch of watches) {
      if (watch.status !== 'pending') continue;

      logger.info({ txid, address, value, watch_id: watch.id }, 'mempool match');

      store.update(watch.id, {
        status: 'detected_mempool',
        detected_txid: txid,
        detected_at: Date.now(),
        detected_amount_sats: value,
        confirmations: 0,
      });

      await sendWebhook(watch.callback_url, watch.hmac_secret, {
        event: 'mempool_detected',
        watch_id: watch.id,
        address,
        txid,
        amount_sats: value,
        confirmations: 0,
        timestamp: Date.now(),
      });
    }
  }
}

export async function handleRawBlock(rawBlock: Buffer) {
  let block: Block;
  try {
    block = Block.fromBuffer(rawBlock);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'failed to decode block');
    return;
  }

  const blockHash = block.getId();
  const txids = new Set((block.transactions ?? []).map(tx => tx.getId()));
  logger.debug({ blockHash, txCount: txids.size }, 'new block');

  for (const watch of store.list()) {
    if (watch.status !== 'detected_mempool' || !watch.detected_txid) continue;

    // La primera confirmación es el bloque que incluye la tx; cada bloque posterior suma una
    const confirmations = watch.confirmations ?? 0;
    if (confirmations === 0 && !txids.has(watch.detected_txid)) continue;

    const newConfs = confirmations + 1;
    store.update(watch.id, {
      confirmations: newConfs,
      status: newConfs >= CONFIRMATIONS_TARGET ? 'confirmed' : 'detected_mempool',
    });

    await sendWebhook(watch.callback_url, watch.hmac_secret, {
      event: 'confirmation',
      watch_id: watch.id,
      address: watch.address,
      txid: watch.detected_txid,
      amount_sats: watch.detected_amount_sats ?? 0,
      confirmations: newConfs,
      block_hash: blockHash,
      timestamp: Date.now(),
    });
  }
}

export async function startZmqSubscribers() {
  // Suscriptor de transacciones
  const txSock = new Subscriber();
  txSock.connect(BITCOIND_ZMQ_RAWTX);
  txSock.subscribe('rawtx');
  logger.info({ endpoint: BITCOIND_ZMQ_RAWTX }, 'subscribed to rawtx');

  // Suscriptor de bloques
  const blockSock = new Subscriber();
  blockSock.connect(BITCOIND_ZMQ_RAWBLOCK);
  blockSock.subscribe('rawblock');
  logger.info({ endpoint: BITCOIND_ZMQ_RAWBLOCK }, 'subscribed to rawblock');

  // Loop de procesamiento (concurrente)
  (async () => {
    for await (const [topic, msg] of txSock) {
      try { await handleRawTx(msg); }
      catch (err) { logger.error({ err: (err as Error).message }, 'rawtx handler error'); }
    }
  })();

  (async () => {
    for await (const [topic, msg] of blockSock) {
      try { await handleRawBlock(msg); }
      catch (err) { logger.error({ err: (err as Error).message }, 'rawblock handler error'); }
    }
  })();
}
