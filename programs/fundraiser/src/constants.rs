pub const ANCHOR_DISCRIMINATOR: usize = 8;
pub const MIN_AMOUNT_TO_RAISE: u64 = 3;
pub const SECONDS_TO_DAYS: i64 = 86400;
pub const MAX_CONTRIBUTION_PERCENTAGE: u64 = 10;
pub const PERCENTAGE_SCALER: u64 = 100;
pub const MILESTONE_PERCENTS: [u64; 4] = [25, 50, 75, 100];
pub const MILESTONE_COUNT: u8 = MILESTONE_PERCENTS.len() as u8;

// Checks needed since the fundraiser fields (milestones_reached and milestones_acknowledged require this)
const _: () = assert!(
    MILESTONE_PERCENTS.len() <= 8,
    "milestone bitmask is a u8 — at most 8 milestones"
);

// The ordering matters for checks on milestones (asserted at compile time)
const _: () = {
    let mut i = 1;
    while i < MILESTONE_PERCENTS.len() {
        assert!(
            MILESTONE_PERCENTS[i] > MILESTONE_PERCENTS[i - 1],
            "milestone percents must be strictly ascending"
        );
        i += 1;
    }
};
