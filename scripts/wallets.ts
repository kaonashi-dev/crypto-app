/**
 * Generates test wallets for exercising the gateway on testnets.
 *
 *   bun run scripts/wallets.ts
 *
 * Prints two FRESH payer wallets (address + private key) — fund these from
 * faucet.circle.com (test USDC) and an ETH faucet (gas), then use them to pay a
 * checkout. Also prints the gateway's own HD receiving addresses derived from
 * HD_MNEMONIC (indexes 0..1) for reference. TESTNET ONLY — never use these keys
 * with real funds.
 */
import { generatePrivateKey, privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import { env } from "../src/config";

console.log("=== 2 fresh testnet PAYER wallets =========================");
console.log("Fund with test USDC (faucet.circle.com) + testnet ETH for gas.\n");
for (let i = 1; i <= 2; i++) {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  console.log(`Wallet ${i}`);
  console.log(`  address     : ${account.address}`);
  console.log(`  privateKey  : ${privateKey}`);
  console.log("");
}

console.log("=== Gateway HD RECEIVING addresses (from HD_MNEMONIC) ======");
console.log("These are what the gateway derives per payment (m/44'/60'/0'/0/i):\n");
for (let i = 0; i < 2; i++) {
  const account = mnemonicToAccount(env.mnemonic, { addressIndex: i });
  console.log(`  m/44'/60'/0'/0/${i}  ->  ${account.address}`);
}

process.exit(0);
