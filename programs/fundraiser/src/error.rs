use anchor_lang::error_code;

#[error_code]
pub enum FundraiserError {
    #[msg("The amount to raise has not been met")]
    TargetNotMet,
    #[msg("The amount to raise has been achieved")]
    TargetMet,
    #[msg("The contribution is too big")]
    ContributionTooBig,
    #[msg("The contribution is too small")]
    ContributionTooSmall,
    #[msg("The maximum amount to contribute has been reached")]
    MaximumContributionsReached,
    #[msg("The fundraiser has not ended yet")]
    FundraiserNotEnded,
    #[msg("The fundraiser has ended")]
    FundraiserEnded,
    #[msg("Invalid total amount. i should be bigger than 3")]
    InvalidAmount,
    #[msg("Milestone index must be 0, 1, 2 or 3")]
    InvalidMilestone,
    #[msg("That milestone has not been reached yet")]
    MilestoneNotReached,
    #[msg("That milestone has already been acknowledged")]
    MilestoneAlreadyAcknowledged,
    #[msg("Acknowledge the earlier milestones first")]
    MilestoneOutOfOrder,
}
