// RPC connection handling for Hylo's server, modeled directly on the trading bot's
// RpcRotator (strategy-recipes/recipes/my-bot/bot-engine.ts) and its READ_RPC_URLS parsing
// (runner.ts). Reused everywhere Hylo needs a Solana RPC connection, not just the Exponent fetcher.
import 'dotenv/config';
import { Connection } from '@solana/web3.js';

/** Parse a comma-separated RPC URL list (e.g. READ_RPC_URLS) into trimmed, non-empty URLs. */
function parseUrlList(envVarValue) {
  if (!envVarValue) return [];
  return envVarValue
    .split(',')
    .map(url => url.trim())
    .filter(url => url.length > 0);
}

export class RpcRotator {
  #connections;
  #index = 0;

  constructor(connections) {
    if (!connections || connections.length === 0) {
      throw new Error('RpcRotator requires at least one Connection');
    }
    this.#connections = connections;
  }

  /** Round-robin: returns the next connection in the pool each call. */
  get() {
    const conn = this.#connections[this.#index];
    this.#index = (this.#index + 1) % this.#connections.length;
    return conn;
  }

  getAll() {
    return this.#connections;
  }
}

/**
 * Build a rotator over READ_RPC_URLS (spreads load across multiple free-tier RPC accounts,
 * same reasoning as the trading bot's readRotator). Falls back to a single-connection rotator
 * over RPC_URL if READ_RPC_URLS isn't set.
 */
export function createReadRotator(commitment = 'confirmed') {
  const urls = parseUrlList(process.env.READ_RPC_URLS);
  if (urls.length > 0) {
    return new RpcRotator(urls.map(url => new Connection(url, commitment)));
  }
  if (process.env.RPC_URL) {
    return new RpcRotator([new Connection(process.env.RPC_URL, commitment)]);
  }
  throw new Error('No RPC endpoints configured — set RPC_URL or READ_RPC_URLS in server/.env');
}

/** A single primary connection (RPC_URL) for one-off / low-volume calls that don't need rotation. */
export function getPrimaryConnection(commitment = 'confirmed') {
  if (!process.env.RPC_URL) {
    throw new Error('RPC_URL not configured in server/.env');
  }
  return new Connection(process.env.RPC_URL, commitment);
}
