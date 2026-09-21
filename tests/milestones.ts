import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { assert, AssertionError } from "chai";

/**
 * Note adding to just help with grading and work :)
 *
 * The three cases:
 * - happy path  a contribution that lands exactly on 25% sets bit 0, and the maker can then acknowledge it
 * - boundary    one raw unit short of 25% sets nothing
 * - abuse       every rejection path, each asserted by its own error code
 *
 * Comment out the milestone loop at the end of `contribute` ix and all three fail.
 */
describe("fundraiser — milestones", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const DECIMALS = 6;
  const ONE_TOKEN = 1_000_000;

  // 40 tokens. Chosen so the caps land on round numbers:
  //   10% per-wallet cap  =  4_000_000
  //   25% milestone            = 10_000_000  <- reachable by 4 + 4 + 2
  //   50% milestone            = 20_000_000  <- reachable by five wallets at the cap
  const TARGET = 40 * ONE_TOKEN;
  const CAP = TARGET / 10;
  const MARK_25 = TARGET / 4;

  const BIT_25 = 0b0001;
  const BIT_50 = 0b0010;

  let mint: anchor.web3.PublicKey;
  let contributors: anchor.web3.Keypair[] = [];
  let contributorAtas: anchor.web3.PublicKey[] = [];

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
  };

  const errorCodeOf = (err: any): string => {
    if (err instanceof AssertionError) throw err;
    if (err?.error?.errorCode?.code) return err.error.errorCode.code;
    const text = `${err?.message ?? ""} ${JSON.stringify(err?.logs ?? [])}`;
    const match = text.match(/Error Code: (\w+)/);
    return match ? match[1] : text.slice(0, 300);
  };

  const assertErrorIs = (err: any, expected: string, why: string) => {
    const actual = errorCodeOf(err);
    assert.strictEqual(
      actual.toLowerCase(),
      expected.toLowerCase(),
      `${why} (expected ${expected}, got ${actual})`
    );
  };

  type Campaign = {
    maker: anchor.web3.Keypair;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
  };

  /** A fresh maker means a fresh `["fundraiser", maker]` PDA, so campaigns are
   *  fully isolated from each other and from the rest of the suite. */
  const newCampaign = async (target: number | anchor.BN = TARGET): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(maker.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const fundraiser = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    )[0];
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await program.methods
      // duration 7: the window is open today, so contributions are allowed and
      // refunds are not. Milestones are amount-based, so no clock work is needed.
      .initialize(new anchor.BN(target), 7)
      .accountsPartial({
        maker: maker.publicKey,
        mintToRaise: mint,
        fundraiser,
        vault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc()
      .then(confirm);

    return { maker, fundraiser, vault };
  };

  const contribute = async (
    campaign: Campaign,
    which: number,
    amount: number
  ): Promise<string> => {
    const contributor = contributors[which];
    const contributorAccount = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        campaign.fundraiser.toBuffer(),
        contributor.publicKey.toBuffer(),
      ],
      program.programId
    )[0];

    return program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: contributor.publicKey,
        mintToRaise: mint,
        fundraiser: campaign.fundraiser,
        contributorAccount,
        contributorAta: contributorAtas[which],
        vault: campaign.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor])
      .rpc()
      .then(confirm);
  };

  const acknowledge = (campaign: Campaign, index: number): Promise<string> =>
    program.methods
      .acknowledgeMilestone(index)
      .accountsPartial({
        maker: campaign.maker.publicKey,
        fundraiser: campaign.fundraiser,
      })
      .signers([campaign.maker])
      .rpc()
      .then(confirm);

  const milestonesOf = async (campaign: Campaign) => {
    const account = await program.account.fundraiser.fetch(campaign.fundraiser);
    return {
      reached: account.milestonesReached,
      acknowledged: account.milestonesAcknowledged,
      current: account.currentAmount.toNumber(),
    };
  };

  /** Decoded program events for one transaction. The log is the only place a
   *  milestone crossing carries a timestamp, so this is what proves `emit!` ran. */
  const eventsFrom = async (signature: string) => {
    const parser = new anchor.EventParser(program.programId, program.coder);
    for (let attempt = 0; attempt < 10; attempt++) {
      const tx = await provider.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (tx?.meta?.logMessages) return [...parser.parseLogs(tx.meta.logMessages)];
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return [];
  };

  before(async () => {
    mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      DECIMALS
    );

    // Five wallets, because the 10% per-wallet cap means reaching the 50% mark
    // takes five contributors at the cap. Three would only ever reach 30%.
    for (let i = 0; i < 5; i++) {
      const contributor = anchor.web3.Keypair.generate();
      await provider.connection
        .requestAirdrop(contributor.publicKey, anchor.web3.LAMPORTS_PER_SOL)
        .then(confirm);

      const ata = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          wallet.payer,
          mint,
          contributor.publicKey
        )
      ).address;

      // Comfortably more than the sum of what any one wallet contributes below.
      await mintTo(
        provider.connection,
        wallet.payer,
        mint,
        ata,
        provider.publicKey,
        50 * ONE_TOKEN
      );

      contributors.push(contributor);
      contributorAtas.push(ata);
    }
  });

  it("fires the 25% milestone on the contribution that reaches it, and the maker can acknowledge it", async () => {
    const campaign = await newCampaign();

    await contribute(campaign, 0, CAP); // 4_000_000 -> 10% of target
    await contribute(campaign, 1, CAP); // 8_000_000 -> 20%

    let state = await milestonesOf(campaign);
    assert.strictEqual(
      state.reached,
      0,
      "no milestone should fire below the 25% mark"
    );

    // Lands on exactly 10_000_000, which is exactly 25%. A `>` comparison would
    // not fire here; `>=` does. That is the whole point of hitting it exactly.
    const signature = await contribute(campaign, 2, MARK_25 - 2 * CAP);

    state = await milestonesOf(campaign);
    assert.strictEqual(
      state.current,
      MARK_25,
      "the campaign should sit exactly on the 25% mark"
    );
    assert.strictEqual(
      state.reached,
      BIT_25,
      "bit 0 should be set once the 25% mark is reached"
    );
    assert.strictEqual(
      state.acknowledged,
      0,
      "reaching a milestone must not acknowledge it — that is the maker's call"
    );

    // The event is the audit trail: the bitmask records that the mark was
    // reached, the log records when, and in which transaction.
    const events = await eventsFrom(signature);
    const reached = events.filter(
      (event) => event.name.toLowerCase() === "milestonereached"
    );
    assert.strictEqual(
      reached.length,
      1,
      "exactly one MilestoneReached event should be emitted on a crossing"
    );
    assert.strictEqual(
      Number(reached[0].data.milestone),
      0,
      "the emitted event should name milestone 0"
    );

    await acknowledge(campaign, 0);

    state = await milestonesOf(campaign);
    assert.strictEqual(
      state.acknowledged,
      BIT_25,
      "acknowledging milestone 0 should set bit 0 of milestones_acknowledged"
    );
    assert.strictEqual(
      state.reached,
      BIT_25,
      "acknowledging must not disturb milestones_reached"
    );
  });

  it("pins the 25% threshold from both sides", async () => {
    const campaign = await newCampaign();

    await contribute(campaign, 0, CAP);
    await contribute(campaign, 1, CAP);
    // One raw unit short of 10_000_000. Still above the one-whole-token minimum
    // and under the per-wallet cap, so `contribute` itself is happy.
    await contribute(campaign, 2, MARK_25 - 2 * CAP - 1);

    const state = await milestonesOf(campaign);
    assert.strictEqual(
      state.current,
      MARK_25 - 1,
      "the campaign should sit one raw unit below the 25% mark"
    );
    assert.strictEqual(
      state.reached,
      0,
      "a single raw unit below the threshold must not fire the milestone"
    );

    // And the maker cannot talk their way past it.
    try {
      await acknowledge(campaign, 0);
      assert.fail("acknowledging an unreached milestone should be rejected");
    } catch (err) {
      assertErrorIs(
        err,
        "MilestoneNotReached",
        "one unit short is still short"
      );
    }

    await contribute(campaign, 3, ONE_TOKEN); // 10_999_999 -> past the milestone

    const crossed = await milestonesOf(campaign);
    assert.strictEqual(
      crossed.reached,
      BIT_25,
      "crossing the 25% mark must set bit 0"
    );
  });

  it("rejects every abuse of acknowledge_milestone with its own error", async () => {
    const campaign = await newCampaign();

    await contribute(campaign, 0, CAP);
    await contribute(campaign, 1, CAP);
    await contribute(campaign, 2, CAP);
    await contribute(campaign, 3, CAP);
    await contribute(campaign, 4, CAP); // 20_000_000 -> 50% of target

    let state = await milestonesOf(campaign);
    assert.strictEqual(
      state.reached,
      BIT_25 | BIT_50,
      "crossing 50% should leave both the 25% and 50% bits set"
    );

    // Out of order: milestone 1 is genuinely reached, but 0 is unacknowledged.
    try {
      await acknowledge(campaign, 1);
      assert.fail("acknowledging out of order should be rejected");
    } catch (err) {
      assertErrorIs(
        err,
        "MilestoneOutOfOrder",
        "milestone 0 has not been acknowledged yet"
      );
    }

    // Out of range: MILESTONE_COUNT is 4, so 0..3 are the only valid indices.
    try {
      await acknowledge(campaign, 4);
      assert.fail("an out-of-range milestone index should be rejected");
    } catch (err) {
      assertErrorIs(err, "InvalidMilestone", "index 4 does not exist");
    }

    // Not reached: 75% is index 2, and the campaign is only at 50%.
    try {
      await acknowledge(campaign, 2);
      assert.fail("acknowledging an unreached milestone should be rejected");
    } catch (err) {
      assertErrorIs(err, "MilestoneNotReached", "the campaign is only at 50%");
    }

    // In order, both succeed.
    await acknowledge(campaign, 0);
    await acknowledge(campaign, 1);

    state = await milestonesOf(campaign);
    assert.strictEqual(
      state.acknowledged,
      BIT_25 | BIT_50,
      "both milestones should now be acknowledged"
    );

    // Replay: the flag is what stops an announcement firing twice.
    try {
      await acknowledge(campaign, 0);
      assert.fail("acknowledging the same milestone twice should be rejected");
    } catch (err) {
      assertErrorIs(
        err,
        "MilestoneAlreadyAcknowledged",
        "milestone 0 was already acknowledged"
      );
    }
  });

  it("reports a threshold overflow as its own error rather than mislabelling it", async () => {
    // The threshold is `amount_to_raise * pct / 100`, so a large enough target
    // overflows u64 on the multiply. Picked so that:
    //
    //   target * 10  = 1e19   fits in u64, so contribute's own cap check is fine
    //   target * 25  = 2.5e19 does not fit, so the milestone loop is what breaks
    //
    // Without the dedicated variant this surfaces as InvalidAmount, which already
    // means "the target must be bigger than 3" -- a misleading label on a
    // perfectly valid contribution.
    const HUGE_TARGET = new anchor.BN("1000000000000000000"); // 1e18
    const campaign = await newCampaign(HUGE_TARGET);

    try {
      await contribute(campaign, 0, ONE_TOKEN);
      assert.fail("a target this large should overflow the threshold calculation");
    } catch (err) {
      assertErrorIs(
        err,
        "MilestoneCalculationOverflow",
        "the 25% threshold multiply does not fit in u64"
      );
    }
  });

  it("truncates the threshold downward, and multiplies before it divides", async () => {
    // A target whose 25% does not divide evenly. The two orderings disagree:
    //
    //   multiply first  floor(30_000_099 * 25 / 100) = 7_500_024   <- correct
    //   divide first    floor(30_000_099 / 100) * 25 = 7_500_000
    //
    // Landing on exactly 7_500_000 is below the real threshold, so nothing may
    // fire. Swap the two operations and this is the test that goes red.
    const AWKWARD_TARGET = 30_000_099;
    const campaign = await newCampaign(AWKWARD_TARGET);

    await contribute(campaign, 0, 2_500_000);
    await contribute(campaign, 1, 2_500_000);
    await contribute(campaign, 2, 2_500_000); // 7_500_000 total

    let state = await milestonesOf(campaign);
    assert.strictEqual(
      state.current,
      7_500_000,
      "the campaign should sit just under the truncated 25% threshold"
    );
    assert.strictEqual(
      state.reached,
      0,
      "7_500_000 is below the real threshold of 7_500_024, so nothing may fire"
    );

    // Crossing 7_500_024 does fire, which confirms the threshold is where the
    // multiply-first calculation puts it rather than simply unreachable.
    await contribute(campaign, 3, ONE_TOKEN);

    state = await milestonesOf(campaign);
    assert.strictEqual(
      state.reached,
      BIT_25,
      "crossing the truncated threshold must fire the 25% mark"
    );
  });
});
