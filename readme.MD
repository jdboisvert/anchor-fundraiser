# Token Fundraiser

## Prerequisites

| Tool | Version |
| --- | --- |
| Anchor | 1.1.2 (`avm install 1.1.2 && avm use 1.1.2`) |
| Solana CLI | 3.1 or newer |
| Node | 20 or newer, with `yarn` |

```bash
yarn install
anchor build
anchor keys sync   # first time only — see below
anchor test
```

The repo declares a program id it does not ship the keypair for, so your first
`anchor build` generates a different one and `anchor test` fails with
`DeclaredProgramIdMismatch`. `anchor keys sync` rewrites `declare_id!` and
`Anchor.toml` to match the keypair you just generated. Run it once, then rebuild.

This example demonstrates how to create a fundraising for SPL Tokens.

In this example, a user will be able to create a fundraiser account, where he will be specify the mint he wants to collect and the fundraising target.

---

## Let's walk through the architecture:

A fundraising account consists of:

```rust
#[account]
#[derive(InitSpace)]
pub struct Fundraiser {
    pub maker: Pubkey,
    pub mint_to_raise: Pubkey,
    pub amount_to_raise: u64,
    pub current_amount: u64,
    pub time_started: i64,
    pub duration: u8,
    pub bump: u8,
}
```

### In this state account, we will store:

- maker: the person who is starting the fundraising

- mint_to_raise: the mint that the maker wants to receive

- amount_to_raise: the target amount that the maker is trying to raise

- current_amount: the total amount currently donated

- time_started: the time when the account was created

- duration: the timeframe to collect all the contributions (in days) 

- bump: since our Fundraiser account will be a PDA (Program Derived Address), we will store the bump of the account

We use InitSpace derive macro to implement the space triat that will calculate the amount of space that our account will use on-chain (without taking the anchor discriminator into consideration)

---

### The user will be able to create new Fundraiser accounts. For that, we create the following context:

```rust
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        init,
        payer = maker,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump,
        space = ANCHOR_DISCRIMINATOR + Fundraiser::INIT_SPACE,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        init,
        payer = maker,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}
```

Let´s have a closer look at the accounts that we are passing in this context:

- maker: will be the person starting the fundraising. He will be a signer of the transaction, and we mark his account as mutable as we will be deducting lamports from this account

- mint_to_raise: The mint that the user wants to receive. This will be a Mint Account, that we will use to store the mint address

- fundraiser: will be the state account that we will initialize and the maker will be paying for the initialization of the account.
We derive the Fundraiser PDA from the byte representation of the word "fundraiser" and the reference of the maker publick key. Anchor will calculate the canonical bump (the first bump that throes that address out of the ed25519 eliptic curve) and save it for us in a struct

- vault: We will initialize a vault (ATA) to receive the contributions. This account will be derived from the mint that the user wants to receive, and the fundraiser account that we are just creating

- system_program: Program resposible for the initialization of any new account

- token_program and associated_token_program: We are creating new ATAs

### We then implement some functionality for our Initialize context:

```rust
impl<'info> Initialize<'info> {
    pub fn initialize(&mut self, amount: u64, duration: u8, bumps: &InitializeBumps) -> Result<()> {

        // Check if the amount to raise meets the minimum amount required
        require!(
            amount > MIN_AMOUNT_TO_RAISE.pow(self.mint_to_raise.decimals as u32),
            FundraiserError::InvalidAmount
        );

        // Initialize the fundraiser account
        self.fundraiser.set_inner(Fundraiser {
            maker: self.maker.key(),
            mint_to_raise: self.mint_to_raise.key(),
            amount_to_raise: amount,
            current_amount: 0,
            time_started: Clock::get()?.unix_timestamp,
            duration,
            bump: bumps.fundraiser
        });
        
        Ok(())
    }
}
```

In here, we basically just set the data of our Fundraiser account if the amount to raise is bigger than 3 (minimum amount)

---

### Users will be able to contribute to a fundraising

A contribution account consists of:

```rust
#[account]
#[derive(InitSpace)]
pub struct Contributor {
    pub amount: u64,
}
```rust

In this account we will only store the total amount contributed by a specific contributor

#[derive(Accounts)]
pub struct Contribute<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [b"fundraiser".as_ref(), fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        init_if_needed,
        payer = contributor,
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
        space = ANCHOR_DISCRIMINATOR + Contributor::INIT_SPACE,
    )]
    pub contributor_account: Account<'info, Contributor>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = contributor
    )]
    pub contributor_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = fundraiser.mint_to_raise,
        associated_token::authority = fundraiser
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
```

In this context, we are passing all the accounts needed to contribute to a fundraising campaign:

- contributor: The address of the person that is contributing

- mint_to_raise: the mint that the maker is expecting to receive as contributions

- fundraiser: An initialized Fundraiser account where appropriate checks will be performed, such as the appropriate mint, the seeds and the bump of the Fundraiser PDA

- contributor account: We initialize (if needed) a contributor account that will store the total amount that a specific contributor has contributed with so far

- contributor_ata: The ata where we will be transfering tokens from. We make sure that the authority and mint of the ATA are correct (mint_to_raise and contributor address), and we mark it as mutable since we will be deducting tokens from that account

- vault: The ata where we will be depositing tokens to. We make sure that the authority and mint of the ATA are correct (mint_to_raise and Fundraiser account), and we mark it as mutable since we will be depositing tokens in that account

- token_program: We will performing CPIs (Cross Program Invocations) to the token program to transfer tokens

### We then implement some functionality for our Contribute context:

```rust
impl<'info> Contribute<'info> {
    pub fn contribute(&mut self, amount: u64) -> Result<()> {

        // Check if the amount to contribute meets the minimum amount required
        require!(
            amount > 1_u8.pow(self.mint_to_raise.decimals as u32) as u64, 
            FundraiserError::ContributionTooSmall
        );

        // Check if the amount to contribute is less than the maximum allowed contribution
        require!(
            amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER, 
            FundraiserError::ContributionTooBig
        );

        // Check if the maximum contributions per contributor have been reached
        require!(
            (self.contributor_account.amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER)
                && (self.contributor_account.amount + amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER),
            FundraiserError::MaximumContributionsReached
        );

        // Check if the fundraising duration has been reached
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            self.fundraiser.duration <= ((current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS) as u8,
            crate::FundraiserError::FundraisingEnded
        );

        // Transfer the funds to the vault
        // CPI to the token program to transfer the funds
        let cpi_program = self.token_program.to_account_info();

        // Transfer the funds from the contributor to the vault
        let cpi_accounts = Transfer {
            from: self.contributor_ata.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.contributor.to_account_info(),
        };

        // Crete a CPI context
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        // Transfer the funds from the contributor to the vault
        transfer(cpi_ctx, amount)?;

        // Update the fundraiser and contributor accounts with the new amounts
        self.fundraiser.current_amount += amount;

        self.contributor_account.amount += amount;

        Ok(())
    }
}
```
In here, we make some checks:
- We check that the user is depositing at least one token

- We Check that the user is not contributiong with more than 10% of the target amount

- We check that the total contributions of the user do not exceed a total of 10% of the target amount

- We check that the fundraising duration has not elapsed

After, we create a CPI to the token program, to transfer a certain amount of SPL tokens from the Contributor ATA to the vault.
We pass the authority of the account where the tokens are being deducted from (In this case is the contributor, as he is the authority of the contributor ata).

Lastly, we update our state acounts with the right amounts

---

### User will be able to claim the tokens once the fundraiding target has been reached

```rust
#[derive(Accounts)]
pub struct CheckContributions<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"fundraiser".as_ref(), maker.key().as_ref()],
        bump = fundraiser.bump,
        close = maker,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = maker,
        associated_token::mint = mint_to_raise,
        associated_token::authority = maker,
    )]
    pub maker_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}
```

In this context, we are passing all the accounts needed for a user to claim the raised tokens:

- maker: The address of the person raising the the funds. We mark it as mutable since the maker will be paying for initialization fees and will receive lamports from rent back

- mint_to_raise: the mint that the maker is expecting to receive as contributions

- fundraiser: An initialized Fundraiser account where appropriate checks will be performed, such as the appropriate mint, the seeds and the bump of the Fundraiser PDA

- vault: The ata where we will be transfering tokens from. We make sure that the authority and mint of the ATA are correct (mint_to_raise and fundraiser account), and we mark it as mutable since we will be deducting tokens from that account

- maker_ata: The ata where we will be depositing tokens to. We make sure that the authority and mint of the ATA are correct (mint_to_raise and maker account), and we mark it as mutable since we will be depositing tokens in that account.
In case we need to initialize this ATA, the maker will be paying for the initialization fees

- system_program and associated_token_program: Since we are initializing new ATAs

- token_program: We will performing CPIs (Cross Program Invocations) to the token program to transfer tokens

### We then implement some functionality for our Contribute context:

```rust
impl<'info> CheckContributions<'info> {
    pub fn check_contributions(&self) -> Result<()> {
        
        // Check if the target amount has been met
        require!(
            self.vault.amount >= self.fundraiser.amount_to_raise,
            FundraiserError::TargetNotMet
        );

        // Transfer the funds to the maker
        // CPI to the token program to transfer the funds
        let cpi_program = self.token_program.to_account_info();

        // Transfer the funds from the vault to the maker
        let cpi_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.maker_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        // Signer seeds to sign the CPI on behalf of the fundraiser account
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        // CPI context with signer since the fundraiser account is a PDA
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, &signer_seeds);

        // Transfer the funds from the vault to the maker
        transfer(cpi_ctx, self.vault.amount)?;

        Ok(())
    }
}
```

In this implementation, we check if the amount of tokens in the vault is equal or bigger then the fundraising campaign target.
If it is, then we perform a CPI to the token program to transfer the funds from the vault to the maker ATA. Since the vault is an ATA, we need to create our CPI contexr with a signer and use the seeds and bump from the PDA (We are signing with our program on behalf of that PDA).

Finally, we close our Fundraiser account and send the lamports from the rent back to the maker (done with the "close" constraint int the Fundraiser account).


---

### Users will be able to refund their contributions, if the duration of the fundraising has elapsed and the target has not reached

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    pub maker: SystemAccount<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
        close = contributor,
    )]
    pub contributor_account: Account<'info, Contributor>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = contributor
    )]
    pub contributor_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

In this context, we are passing all the accounts needed for a contributor to refund their tokens:

- contributor: The address of the person that is contributing

- maker: The address of the person raising the the funds.

- mint_to_raise: the mint that the maker is expecting to receive as contributions

- fundraiser: An initialized Fundraiser account where appropriate checks will be performed, such as the appropriate mint, the seeds and the bump of the Fundraiser PDA

- contributor account: An initialized Contributor account that will store the total amount that a specific contributor has contributed with so far

- contributor_ata: The ata where we will be transfering tokens to. We make sure that the authority and mint of the ATA are correct (mint_to_raise and contributor address), and we mark it as mutable since we will be depositing tokens to that account

- vault: The ata where we will be withdrawing tokens from. We make sure that the authority and mint of the ATA are correct (mint_to_raise and Fundraiser account), and we mark it as mutable since we will be withdrawing tokens from that account

- token_program: We will performing CPIs (Cross Program Invocations) to the token program to transfer tokens

### We then implement some functionality for our Refund context:

```rust
impl<'info> Refund<'info> {
    pub fn refund(&mut self) -> Result<()> {

        // Check if the fundraising duration has been reached
        let current_time = Clock::get()?.unix_timestamp;
 
        require!(
            self.fundraiser.duration <= ((current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS) as u8,
            crate::FundraiserError::FundraiserNotEnded
        );

        require!(
            self.vault.amount < self.fundraiser.amount_to_raise,
            crate::FundraiserError::TargetMet
        );

        // Transfer the funds back to the contributor
        // CPI to the token program to transfer the funds
        let cpi_program = self.token_program.to_account_info();

        // Transfer the funds from the vault to the contributor
        let cpi_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.contributor_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        // Signer seeds to sign the CPI on behalf of the fundraiser account
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        // CPI context with signer since the fundraiser account is a PDA
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, &signer_seeds);

        // Transfer the funds from the vault to the contributor
        transfer(cpi_ctx, self.contributor_account.amount)?;

        // Update the fundraiser state by reducing the amount contributed
        self.fundraiser.current_amount -= self.contributor_account.amount;

        Ok(())
    }
}
```

In here, we will check if the fundrasing has already met the target and if ir passed the duration time.
After doing the proper checks, we transfer the donated funds from the vault back to the contributor


## Feature: Milestone Tracking to Fundraisers

Milestone tracking at 25%, 50%, 75% and 100% of the target. Each milestone fires once, even if a single contribution were to cross two of them, and a refund does not retract one.

The maker acknowledges each milestone once, and only once, in order, through a new `acknowledge_milestone` instruction that moves no tokens. It exists so a maker can hang notifications or custom business logic off on-chain data and have them run exactly once. It does not gate contributions, payouts or refunds. It is an operational tool, not part of the money path.

## Why

A campaign at 60% looks very different to a prospective backer than one at 10%, and nothing on-chain marked the difference. Recording it is half the job. The other half is that "we hit 50%" is something a frontend could simply show and track on its own but here for a small cost only the program sets the bit which makes it more reputable, and only the program lets the maker acknowledge it, exactly once.

That makes the chain an idempotency guard for an off-chain side effect. For example a cron that emails backers calls `acknowledge_milestone` and uses success versus `MilestoneAlreadyAcknowledged` to decide whether it is the one that should send, so a rerun, a restart or two workers racing cannot double-send.

The event is the other half. The bitmask records *that* a milestone was reached; the log records *when*, in which transaction, and at what total, which the bitmask has no room to hold. That makes the feature flexible for cases the program cannot anticipate. This can allow an operations team alerted to check something manually, or a promoter who wants a Discord message and then acknowledges the milestone themselves, both working from on-chain data.

## How it works

- `milestones_reached: u8` and `milestones_acknowledged: u8` appended to `Fundraiser` -- one bit per milestone. Four milestones, four bits spare for future use
- thresholds computed at the end of `contribute`, after `current_amount` updates, since `contribute` is the only instruction that moves the total up
- one loop over the percent list to ensure program is flexible to changes in milestones.
- `emit!(MilestoneReached { .. })` inside the bit guard, so it is idempotent
- `acknowledge_milestone(index)` takes two accounts and makes no CPI. It checks the index range, that the milestone is reached, that it is not already acknowledged, and that every lower milestone is acknowledged, which keeps operational sequences in order
- new errors: `InvalidMilestone`, `MilestoneNotReached`, `MilestoneAlreadyAcknowledged`, `MilestoneOutOfOrder`, `MilestoneCalculationOverflow`
- two compile-time asserts: at most 8 milestones, since the bitmask is a `u8`, and strictly ascending percentages, since the ordering rule and the prefix-mask property both depend on it

The four original instructions are unchanged apart from `initialize` zeroing the two new fields. `refund` and `check_contributions` are untouched and read nothing this feature writes.

## Design choices

**Milestones are one-way. A refund does not retract one.** `refund` lowers `current_amount`, so a milestone can record a level the vault no longer justifies. This is deliberate for three reasons. A stored field only earns its rent by recording something you cannot recompute -- if milestones un-fired, the field would mean "current_amount is at or above this threshold", which any client already derives for free from two fields it has. A clearable bit is also not a fire-once flag; un-firing implies re-firing. And the contradiction cannot appear while it matters: `refund` requires the window closed, so a live campaign's total only rises. Once refunds begin the campaign is already over, and the bits read as history -- this campaign reached 75% before it ran out of time, which is true.

**100% is a fourth milestone.** It is the most announcement-worthy moment a campaign has, and the byte already had spare bits, so it costs nothing. It also earns its place a second way, described in the base-program note below. It also makes it easier for consumers like the frontend to just read the state (frontends and consumes should not plan to read the state of the field then check the amounts to know if it hit 100% or not like implied in the homework instructions)

**A bitmask rather than a counter.** `acknowledged_up_to: u8` would express the same thing in the same byte, since both fields are always prefix masks. The bitmask is self-describing -- `0b0011` names exactly which milestones, where `2` needs you to know whether the bound is inclusive -- and it stays correct if milestones ever stop being strictly ordered.

**The acknowledgement moves no tokens.** The obvious alternative is releasing a tranche of the vault to the maker at each milestone. That breaks the all-or-nothing promise: a failed campaign could no longer refund everyone, which would force `refund` to be rewritten for pro-rata payouts. Keeping the acknowledgement free of token movement means the payout and refund paths cannot be affected by this feature at all.

**Milestones read `current_amount`, not `vault.amount`.** The vault balance can be raised by anyone with a direct token transfer that never passed through `contribute`'s caps. `current_amount` only moves through `contribute`. The conservative source was chosen on purpose, and the base-program note explains why that matters more than it first appears.

**Acknowledgement has no deadline.** A milestone can be acknowledged after the window closes, including on a campaign that failed, because the record is historical rather than a live claim. This again taps into the flexibility for operation teams. It also is non-blocking for claiming so this was decided on that permise.

**Thresholds multiply before they divide.** `amount_to_raise * pct / 100` keeps the truncation error under one raw unit. Dividing first would push it to as much as 99 raw units, scaling with the target. Integer division floors, so a milestone can fire fractionally early and never late. The 100% milestone never drifts, since `target * 100 / 100` is exact. In many cases this is not an issue for a 6-decimal mint the difference is a millionth of a token and nobody would notice but this design choice was to try to minimize the flag state differing from the actual vault balance. 

**The event is kept even though state could be polled.** For one campaign a client could poll `getAccountInfo` and diff the byte. The event earns its compute because the bitmask cannot record *when* a milestone landed, and because an indexer watching many campaigns subscribes once rather than polling N accounts. It is always good design to use something event driven and use polling a back up which is an assumption in this build.

## What it costs

**Rent.** Two bytes appended to `Fundraiser`. Rent exemption is charged per byte, so two extra bytes cost `2 x 3480 x 2 = 13,920 lamports`, about 0.0000139 SOL, paid once by the maker at `initialize` and recoverable when the account closes. No new accounts, no new PDAs, no new mints. The whole feature lives on an account that already existed. Meaning cost is minimumal on rent.

**Compute, on `contribute`.** The loop runs once per milestone on every contribution: four iterations of a `checked_mul`, a `checked_div`, a comparison and a bitmask test. On a crossing it also sets a bit and makes one `sol_log_data` syscall carrying a 57-byte event. Nothing is allocated and no CPI is added. For reference, a `contribute` in the test suite consumed 27,085 of its 200,000 compute unit budget with the feature enabled. To measure the delta on your own machine, comment out the milestone loop and compare the `consumed N of 200000 compute units` line for the same transaction.

Worth naming who pays: the compute is charged to whichever contributor's transaction happens to cross a line, for a flag that benefits the maker. This is one major point that the CU is currently paid by the contributor however it is minimal which for this assignment is assumed to be acceptable. 

**Compute, on `acknowledge_milestone`.** Two accounts, no CPI, no allocation -- three comparisons and a bitwise OR. It is the cheapest instruction in the program.

## How you would attack it

- `current_amount` is deducted after a refund, so `milestones_reached` can record a milestone the vault no longer justifies. However this one-way functionality is deliberate and refunds are only possible once the window has closed, so a live campaign's total never falls but a front end should read `current_amount` alongside the flags rather than rendering the flags alone (confirmed if target is met refunds cannot occur so there can be a state mismatch).

- The larger weakness is that the maker can fake every milestone. Below 100% they fund from their own wallets, acknowledge, let the window lapse and refund themselves. At 100% refunds are blocked, so they take the payout path instead and `check_contributions` returns the whole vault. Either way the cost is fees and temporary rent. Every on-chain fact is true; the false part is the implication that strangers backed the campaign. The program cannot distinguish the maker's wallets from anyone else's, and the base program already permits maker self-contribution. Fixing it would need a system to count distinct backers somehow.

- A target above roughly `u64::MAX / 100` makes the threshold multiply overflow, so every `contribute` fails with `MilestoneCalculationOverflow` and the campaign is dead on arrival. Only the maker sets the target, and only at `initialize`, so this is self-inflicted rather than an attack by a third party. Bounding the target belongs in `initialize`, which is a base instruction and out of scope here.

Note what survives a successful campaign: `check_contributions` deletes both bitmasks along with the `Fundraiser`, but the emitted events remain in transaction history. That is what would make a fabricated record durable after the state proving it is gone.

**What was tried and does not work.** Acknowledging someone else's milestone fails, since `acknowledge_milestone` requires a `Signer` and derives the `Fundraiser` PDA from that signer's key, so there is no campaign to address but your own. Acknowledging twice fails on the `milestones_acknowledged` bit, and skipping ahead fails on the `lower` mask. Firing a milestone twice is impossible because `emit!` sits inside the same bit guard that sets the flag, so the event cannot be replayed by contributing again. Pushing a milestone by sending tokens straight to the vault ATA does nothing, because the loop reads `current_amount`, which only `contribute` writes, so the same trick that defeats the base program's payout guard has no effect here. And `acknowledge_milestone` takes no token accounts at all, so there is no transfer to redirect and nothing to substitute.

## Found but not fixed

While reading the base program I found three rent leaks: the vault ATA is never closed in any path, a failed campaign leaves the `Fundraiser` open, and a successful one strands every `Contributor` PDA, since `refund` is the only thing that closes them and it needs the `Fundraiser` account that `check_contributions` just deleted. There is also no deadline on the maker meaning a met target plus an absent maker blocks refunds indefinitely.

The one that looks like a real bug: `check_contributions` and `refund` both decide whether the target was met by reading `vault.amount`, a raw SPL balance anyone can raise with a direct token transfer, while `contribute` maintains the validated `current_amount`. A campaign ending one raw unit short can be pushed over by a stranger -- refunds then fail with `TargetMet` and the entire vault goes to the maker.

I have not made the fix in this pull request, because the four base instructions are out of scope for this
assignment and pull request (I would do another pull request to address)

## Testing

`anchor test` -- 16 passing. The original instructions are unchanged and their tests still pass, plus five new ones in `tests/milestones.ts`: the exact boundary at 25%, one raw unit below it, every rejection path of `acknowledge_milestone`, the overflow path, and a target of 30_000_099 where multiplying first and dividing first disagree by 24 raw units.

Comment out the milestone loop and all five go red. Swap the multiply and the divide and the ordering test goes red on its own.

Two cases in `tests/fundraiser.ts` are modified, and I would rather flag it than have it found in the diff. Both "Robustness Test" cases wrapped their call in try/catch and printed the error, so they passed whether the program
rejected the call or accepted it. Both also passed `skipPreflight: true`, which meant a rejection arrived as an unparsed client error with no code to assert. They now run with preflight and assert `MaximumContributionsReached` and `TargetNotMet`. No program behaviour changed -- the tests simply could not see it before as hinted in the assignment. Happy to revert that if you would prefer the starter tests left alone.
