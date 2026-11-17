// src/wallet.js
// Unified wallet layer. Yours Wallet keeps its existing, proven path (pay + inscribe in one
// flow, via its own window.yours API). Any other BRC-100 wallet connects via @1sat/connect's
// generic race; inscribing for those wallets is built ourselves per the open BRC-147 (1Sat
// basket profile) / BRC-160 (inscription envelope) standards — a locking script we construct
// client-side with js-1sat-ord's OrdP2PKH template, submitted as a normal createAction output.
// This works with any BRC-100-compliant wallet (confirmed against Yours's current BRC-100-only
// build and should work the same against Vulpine) without depending on a wallet-specific
// inscribe() method.
import { connectWallet } from '@1sat/connect';
import { P2PKH, PublicKey } from '@bsv/sdk';
import { OrdP2PKH } from 'js-1sat-ord';

let active = null; // { kind: 'yours' } | { kind: 'brc100', wallet, provider, identityKey, disconnect }

export function activeWalletKind() {
  return active?.kind ?? null;
}

export function walletCanInscribe() {
  return active?.kind === 'yours' || active?.kind === 'brc100';
}

// Some extensions inject their provider object a beat after page load, not before it — a single
// synchronous check at click time can race that. Poll briefly before giving up.
async function waitForYours(timeoutMs = 1500) {
  const start = Date.now();
  while (!window.yours && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 100));
  }
  return window.yours || null;
}

export async function connect() {
  if (await waitForYours()) {
    await window.yours.connect();
    const addrs = await window.yours.getAddresses();
    if (!addrs?.bsvAddress) throw new Error('Connected but could not read address. Check console.');
    active = { kind: 'yours' };
    return { bsvAddress: addrs.bsvAddress, ordAddress: addrs.ordAddress || addrs.ord || '', label: addrs.bsvAddress };
  }

  const result = await connectWallet();
  if (!result) {
    throw new Error('No wallet found. Install Yours Wallet, or another BRC-100 wallet.');
  }
  active = { kind: 'brc100', ...result };
  // The identity key is an auth/certificate key, NOT a funded address — per BRC-100, a wallet
  // derives its actual spendable/receivable keys separately via its KeyDeriver. Deriving a P2PKH
  // address straight from the identity key (the old approach here) produces an address the
  // wallet doesn't actually control the private key for — fine for display, but fatal as an
  // inscription destination: the buyer could mint successfully and then never be able to access
  // what they minted. getPublicKey() with counterparty:'self' asks the wallet for a key it can
  // actually unlock later, scoped to this app via protocolID/keyID.
  const pubKey = await result.wallet.getPublicKey({
    protocolID: [1, 'rainbow legends mint'], keyID: '1', counterparty: 'self',
  });
  const address = PublicKey.fromString(pubKey.publicKey).toAddress();
  // result.provider is just the transport substrate's own generic name (e.g. "brc100") — not
  // which wallet answered. getVersion() asks the wallet itself, which is the only way to show
  // something recognizable instead of a generic label.
  let walletName = result.provider;
  try {
    const { version } = await result.wallet.getVersion();
    if (version) walletName = version;
  } catch (verErr) {
    console.warn('[wallet] getVersion() failed, falling back to generic label:', verErr.message);
  }
  return { bsvAddress: address, ordAddress: address, label: `${walletName} (${result.identityKey.slice(0, 10)}…)` };
}

export function disconnect() {
  if (active?.kind === 'brc100') active.disconnect();
  active = null;
}

// Pays the 3-way split in one transaction. Returns the payment txid.
export async function pay3way(outputs) {
  if (!active) throw new Error('Not connected');

  if (active.kind === 'yours') {
    const result = await window.yours.sendBsv(
      outputs.map(o => ({ satoshis: o.satoshis, address: o.address }))
    );
    const txid = typeof result === 'string' ? result : (result?.txid || result?.txId || result?.id || null);
    if (!txid) throw new Error('Payment completed but no TXID returned.');
    return txid;
  }

  // Generic BRC-100 path: build P2PKH locking scripts for each recipient and let the wallet
  // fund, sign, and broadcast via the standard createAction call.
  const result = await active.wallet.createAction({
    description: 'Rainbow Legends mint — creator/holder-pool/platform split',
    outputs: outputs.map(o => ({
      satoshis: o.satoshis,
      lockingScript: new P2PKH().lock(o.address).toHex(),
      outputDescription: o.description || 'mint payment',
    })),
    // acceptDelayedBroadcast defaults to true in this SDK — the wallet can hand back a valid
    // txid without having actually finished broadcasting yet, which is exactly why payments
    // were never showing up on-chain. Force a real, confirmed broadcast before returning.
    options: { acceptDelayedBroadcast: false, noSend: false },
  });
  if (!result.txid) throw new Error('Payment completed but no TXID returned.');
  return result.txid;
}

// Inscribes the card. Callers must check walletCanInscribe() first and show the manual-copy
// fallback for any wallet kind this returns false for.
export async function inscribeCard({ address, base64Data, mimeType, map }) {
  if (active?.kind === 'yours') {
    const res = await window.yours.inscribe([{ address, base64Data, mimeType, map }]);
    const txid = typeof res === 'string' ? res
      : res?.txid || res?.txId || (Array.isArray(res) && (res[0]?.txid || res[0]?.txId)) || null;
    return txid;
  }

  if (active?.kind === 'brc100') {
    // Per BRC-160: ord envelope + spend condition in one output script. Per BRC-147: that
    // output goes in the "1sat" basket, tagged so wallets recognize it as an ordinal instead of
    // spending it as ordinary change.
    const lockingScript = new OrdP2PKH().lock(address, { dataB64: base64Data, contentType: mimeType }, map);
    const result = await active.wallet.createAction({
      description: 'Rainbow Legends mint — inscription',
      outputs: [{
        lockingScript: lockingScript.toHex(),
        satoshis: 1,
        outputDescription: 'Rainbow Legends inscription',
        basket: '1sat',
        tags: ['ordinal', `type:${mimeType}`],
      }],
      options: { acceptDelayedBroadcast: false, noSend: false },
    });
    if (!result.txid) throw new Error('Inscription completed but no TXID returned.');
    return result.txid;
  }

  throw new Error('Connected wallet cannot inscribe directly.');
}

// Pays AND inscribes several cards in ONE transaction/ONE wallet approval instead of two
// separate createAction calls — each createAction is its own multi-step wallet confirmation
// (review, confirm, broadcast...), so two calls for one logical "mint batch" roughly doubles
// how many times the wallet makes you click through. Since outputs is just an array, there's
// no reason payment and inscriptions can't share one transaction.
export async function payAndInscribeBatch(paymentOutputs, items) {
  if (!active) throw new Error('Not connected');

  if (active.kind === 'brc100') {
    const payOutputs = paymentOutputs.map(o => ({
      satoshis: o.satoshis, lockingScript: new P2PKH().lock(o.address).toHex(),
      outputDescription: o.description || 'mint payment',
    }));
    const inscribeOutputs = items.map(({ address, base64Data, mimeType, map }) => {
      const lockingScript = new OrdP2PKH().lock(address, { dataB64: base64Data, contentType: mimeType }, map);
      return {
        lockingScript: lockingScript.toHex(), satoshis: 1,
        outputDescription: 'Rainbow Legends inscription', basket: '1sat', tags: ['ordinal', `type:${mimeType}`],
      };
    });
    const result = await active.wallet.createAction({
      description: `Rainbow Legends mint — payment + batch inscription (${items.length})`,
      outputs: [...payOutputs, ...inscribeOutputs],
      options: { acceptDelayedBroadcast: false, noSend: false },
    });
    if (!result.txid) throw new Error('Payment+inscription completed but no TXID returned.');
    // Payment and inscriptions are now the same transaction — the inscription outputs start
    // right after the payment outputs, so each item's outpoint is offset by payOutputs.length.
    return { txid: result.txid, inscriptionOutputOffset: payOutputs.length };
  }

  // Yours' own API has no combined pay+inscribe call distinct from sendBsv/inscribe — fall back
  // to two sequential operations for that wallet kind (unaffected by today's fix either way).
  const paymentTxid = await pay3way(paymentOutputs);
  const inscribeTxid = await inscribeCards(items);
  return { txid: inscribeTxid, paymentTxid, inscriptionOutputOffset: 0 };
}

// Inscribes several cards in ONE transaction instead of one-per-card — this is how "mint
// several at once" avoids the UTXO-chaining problem entirely: there's no previous tx to wait
// on, because there's only one tx. Returns a single shared txid; each item's actual on-chain
// reference is `${txid}_${index}` (the outpoint), matching how origins are referenced elsewhere
// in this codebase (txid_vout).
export async function inscribeCards(items) {
  if (active?.kind === 'yours') {
    const res = await window.yours.inscribe(items.map(({ address, base64Data, mimeType, map }) => ({ address, base64Data, mimeType, map })));
    const txid = typeof res === 'string' ? res
      : res?.txid || res?.txId || (Array.isArray(res) && (res[0]?.txid || res[0]?.txId)) || null;
    return txid;
  }

  if (active?.kind === 'brc100') {
    const outputs = items.map(({ address, base64Data, mimeType, map }) => {
      const lockingScript = new OrdP2PKH().lock(address, { dataB64: base64Data, contentType: mimeType }, map);
      return {
        lockingScript: lockingScript.toHex(), satoshis: 1,
        outputDescription: 'Rainbow Legends inscription', basket: '1sat', tags: ['ordinal', `type:${mimeType}`],
      };
    });
    const result = await active.wallet.createAction({
      description: `Rainbow Legends mint — batch inscription (${items.length})`,
      outputs,
      options: { acceptDelayedBroadcast: false, noSend: false },
    });
    if (!result.txid) throw new Error('Batch inscription completed but no TXID returned.');
    return result.txid;
  }

  throw new Error('Connected wallet cannot inscribe directly.');
}
