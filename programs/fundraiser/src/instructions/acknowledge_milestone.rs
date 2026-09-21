use anchor_lang::prelude::*;

use crate::{state::Fundraiser, FundraiserError, MILESTONE_COUNT};

#[derive(Accounts)]
pub struct AcknowledgeMilestone<'info> {
    pub maker: Signer<'info>,
    #[account(
        mut,
        seeds = [b"fundraiser".as_ref(), maker.key().as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
}

impl<'info> AcknowledgeMilestone<'info> {
    pub fn acknowledge_milestone(&mut self, index: u8) -> Result<()> {
        require!(index < MILESTONE_COUNT, FundraiserError::InvalidMilestone);

        let bit = 1u8 << index;
        // For a single bit, bit - 1 is every bit beneath it.
        let lower = bit - 1;

        require!(
            self.fundraiser.milestones_reached & bit != 0,
            FundraiserError::MilestoneNotReached
        );
        require!(
            self.fundraiser.milestones_acknowledged & bit == 0,
            FundraiserError::MilestoneAlreadyAcknowledged
        );
        require!(
            self.fundraiser.milestones_acknowledged & lower == lower,
            FundraiserError::MilestoneOutOfOrder // Enforcing order so caller remembers to do all of them can be removed since u8 but feels cleaner
        );

        self.fundraiser.milestones_acknowledged |= bit; // Record the new bit (ex: 50% should record 0011 no 0010)

        Ok(())
    }
}
