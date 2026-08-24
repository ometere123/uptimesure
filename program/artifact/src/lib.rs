pub const PROGRAM: &[u8] = include_bytes!(concat!(
    env!("OUT_DIR"),
    "/",
    env!("RIALO_BUILD_ARTIFACT_FILE")
));
