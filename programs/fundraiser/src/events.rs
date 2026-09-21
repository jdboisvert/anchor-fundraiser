use anchor_lang::prelude::*;

#[event]
pub struct MilestoneReached {
    pub fundraiser: Pubkey,
    pub milestone: u8,
    pub current_amount: u64,
    pub amount_to_raise: u64,
}
