import { sepolia, baseSepolia } from "viem/chains";
import type { Chain } from "viem";

export const env = {
  databaseUrl: Bun.env.DATABASE_URL!,
  mnemonic: Bun.env.HD_MNEMONIC!,
  quoteTtlMin: Number(Bun.env.QUOTE_TTL_MINUTES ?? 15),
  graceTtlMin: Number(Bun.env.GRACE_TTL_MINUTES ?? 90),
  spreadBps: BigInt(Bun.env.SPREAD_BPS ?? 75),
  dustBps: BigInt(Bun.env.DUST_TOLERANCE_BPS ?? 50),
  port: Number(Bun.env.PORT ?? 3000),
};

export type TokenDef = { address: `0x${string}`; decimals: number };

export type NetworkDef = {
  chain: Chain;
  confirmations: bigint;
  httpRpc: string;
  wsRpc: string;
  tokens: Record<string, TokenDef>;
};

// Registry of networks and tokens supported in the MVP.
// Verify testnet token addresses against Circle's docs (faucet.circle.com)
// before use; they can change.
export const NETWORKS = {
  "eth-sepolia": {
    chain: sepolia,
    confirmations: 5n,
    httpRpc: `https://eth-sepolia.g.alchemy.com/v2/${Bun.env.ALCHEMY_SEPOLIA_KEY}`,
    wsRpc: `wss://eth-sepolia.g.alchemy.com/v2/${Bun.env.ALCHEMY_SEPOLIA_KEY}`,
    tokens: {
      USDC: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6 },
    },
  },
  "base-sepolia": {
    chain: baseSepolia,
    confirmations: 3n,
    httpRpc: `https://base-sepolia.g.alchemy.com/v2/${Bun.env.ALCHEMY_BASE_SEPOLIA_KEY}`,
    wsRpc: `wss://base-sepolia.g.alchemy.com/v2/${Bun.env.ALCHEMY_BASE_SEPOLIA_KEY}`,
    tokens: {
      USDC: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
    },
  },
} satisfies Record<string, NetworkDef>;

export type NetworkId = keyof typeof NETWORKS;

export const COINGECKO_IDS: Record<string, string> = {
  USDC: "usd-coin",
  USDT: "tether",
  BTC: "bitcoin",
  ETH: "ethereum",
};
