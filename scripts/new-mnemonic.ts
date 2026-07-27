/**
 * Generates a fresh HD tree for `HD_MNEMONIC`.
 *
 *   bun run mnemonic:new              # 24 words / 256 bits of entropy
 *   bun run mnemonic:new --words 12   # 12 words / 128 bits, for a wallet that needs it
 *   bun run mnemonic:new --write      # straight into .env, without printing it
 *
 * Prints a BIP-39 mnemonic, its non-secret BIP-32 fingerprint, and the first
 * receiving address of each family — enough to verify the value was pasted into
 * the environment intact. Needs no database, no network and no other variable
 * set, so it can be the very first command of a new deployment.
 *
 * `--write` is the safer path for a local environment: the words go to the
 * HD_MNEMONIC line of .env and never reach the terminal, its scrollback, or the
 * transcript of whatever ran the command. It refuses to overwrite a mnemonic
 * that is not a known public one, so it cannot quietly retire a seed that may
 * be holding funds.
 *
 * Uniqueness is checked, not assumed. The words come from the platform CSPRNG
 * (`crypto.getRandomValues`, via @scure/bip39), and the candidate is rejected
 * and regenerated unless it is a valid BIP-39 phrase, is none of the publicly
 * known test mnemonics, and derives a tree whose fingerprint differs from the
 * one `HD_MNEMONIC` currently holds. At 256 bits the collision probability is
 * far below that of the disk holding the seed failing — the checks exist to
 * catch a broken entropy source or a copy-paste, not to beat the odds.
 *
 * THE OUTPUT IS A PRIVATE KEY IN WORD FORM. Everything the gateway ever derives
 * is spendable with it. Do not commit it, do not paste it into a chat, and do
 * not reuse a mnemonic that has ever held real funds.
 */
import { generateMnemonic, mnemonicToAccount, english } from "viem/accounts";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { publicMnemonicSource } from "../src/config";
import { deriveTronAddress, seedFingerprint } from "../src/services/derivation";

const WORD_COUNTS = { 12: 128, 15: 160, 18: 192, 21: 224, 24: 256 } as const;
type WordCount = keyof typeof WORD_COUNTS;

function requestedWords(): WordCount {
  const argv = Bun.argv.slice(2);
  const flag = argv.findIndex((a) => a === "--words" || a.startsWith("--words="));
  if (flag === -1) return 24;

  const raw = argv[flag]!.includes("=") ? argv[flag]!.split("=")[1] : argv[flag + 1];
  const words = Number(raw);
  if (!(words in WORD_COUNTS)) {
    console.error(
      `--words must be one of ${Object.keys(WORD_COUNTS).join(", ")} (got ${raw ?? "nothing"})`
    );
    process.exit(1);
  }
  return words as WordCount;
}

/** The env file to rewrite, or null to print instead. `--write` alone means .env. */
function writeTarget(): string | null {
  const argv = Bun.argv.slice(2);
  const flag = argv.findIndex((a) => a === "--write" || a.startsWith("--write="));
  if (flag === -1) return null;

  const path = argv[flag]!.includes("=") ? argv[flag]!.split("=")[1] : argv[flag + 1];
  return path && !path.startsWith("--") ? path : ".env";
}

const HD_MNEMONIC_LINE = /^HD_MNEMONIC\s*=.*$/m;

/**
 * Replaces the HD_MNEMONIC line of an env file in place.
 *
 * Only over an absent value or a publicly known test mnemonic. Anything else is
 * a seed whose addresses may already be published and may already hold funds;
 * retiring one is a decision with consequences on chain, so it does not happen
 * as a side effect of running a generator.
 */
async function writeMnemonic(path: string, mnemonic: string): Promise<void> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`${path} does not exist. Copy .env.example to .env first.`);
    process.exit(1);
  }

  const contents = await file.text();
  const current = contents.match(HD_MNEMONIC_LINE)?.[0].split("=").slice(1).join("=");
  const existing = current?.trim().replace(/^["']|["']$/g, "") ?? "";

  if (existing && !publicMnemonicSource(existing)) {
    console.error(
      `${path} already holds a mnemonic that is not a known public test one ` +
        `(tree ${seedFingerprint(existing)}).\n` +
        "Refusing to overwrite it: addresses derived from it may hold funds, and " +
        "the words are the only way back to them. Move it somewhere safe, clear " +
        "the line, and run this again."
    );
    process.exit(1);
  }

  const line = `HD_MNEMONIC="${mnemonic}"`;
  await Bun.write(
    path,
    HD_MNEMONIC_LINE.test(contents)
      ? contents.replace(HD_MNEMONIC_LINE, line)
      : `${contents.replace(/\n*$/, "\n")}\n${line}\n`
  );
}

/**
 * A mnemonic that passes every check, or an exit if the entropy source is
 * producing something unusable — a retry loop that never converges means the
 * problem is the runtime, not the draw.
 */
function generate(words: WordCount): string {
  // The tree in use right now, when there is one. `env.mnemonic` is unset on a
  // first run, which fingerprints to nothing and simply never matches.
  const current = Bun.env.HD_MNEMONIC?.trim();
  const currentFingerprint = current ? seedFingerprint(current) : null;

  for (let attempt = 1; attempt <= 5; attempt++) {
    const mnemonic = generateMnemonic(english, WORD_COUNTS[words]);
    const rejection = validateMnemonic(mnemonic, wordlist)
      ? publicMnemonicSource(mnemonic)
        ? "matches a publicly known test mnemonic"
        : seedFingerprint(mnemonic) === currentFingerprint
          ? "derives the tree HD_MNEMONIC already holds"
          : null
      : "is not a valid BIP-39 phrase";

    if (!rejection) return mnemonic;
    console.error(`[attempt ${attempt}] discarded: candidate ${rejection}`);
  }

  console.error(
    "Could not generate a usable mnemonic in 5 attempts. That points at a broken " +
      "crypto.getRandomValues, not at bad luck — do not work around it."
  );
  process.exit(1);
}

const words = requestedWords();
const target = writeTarget();
const mnemonic = generate(words);
const fingerprint = seedFingerprint(mnemonic);

if (target) {
  await writeMnemonic(target, mnemonic);
  console.log(`=== NEW HD MNEMONIC — written to ${target} ================`);
  console.log(`${words} words, ${WORD_COUNTS[words]} bits of entropy.`);
  console.log("The words are not printed. Read them from the file to back them up.\n");
} else {
  console.log("=== NEW HD MNEMONIC — SECRET =============================");
  console.log(`${words} words, ${WORD_COUNTS[words]} bits of entropy\n`);
  console.log(`  ${mnemonic}\n`);
}

console.log("=== Identity of this tree (not secret) ====================");
console.log(`  seed fingerprint      : ${fingerprint}`);
console.log(`  first EVM address     : ${mnemonicToAccount(mnemonic).address}`);
console.log(`  first Tron address    : ${deriveTronAddress(0, mnemonic)}`);
console.log("");
console.log("The fingerprint is the BIP-32 master fingerprint. The gateway records");
console.log("it next to the derivation counter and refuses to issue an address if");
console.log("the two ever stop matching, so a swapped seed fails loudly instead of");
console.log("handing payers addresses nobody holds the key to.");
console.log("");
console.log("=== Next steps ===========================================");
if (target) {
  console.log(`  1. Nothing to paste locally — ${target} is updated. For a deployment,`);
  console.log("     copy the value into its HD_MNEMONIC variable (Railway: a service");
  console.log("     variable, quoted). Never commit the file.");
} else {
  console.log("  1. Put it in the environment, quoted:");
  console.log('       HD_MNEMONIC="<the words above>"');
  console.log("     Local: the HD_MNEMONIC line of .env. Railway: a service variable.");
}
console.log("  2. Back it up offline. Losing it loses every address derived from it;");
console.log("     leaking it loses every payment those addresses ever receive.");
console.log("  3. Rotating a tree that is already in use orphans its addresses — the");
console.log("     gateway will refuse to start until the counter's database row is");
console.log("     reset (a fresh database) or the previous mnemonic is restored.");
