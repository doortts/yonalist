//! That this build reads the flag iCloud sets on a file it has taken away.
//!
//! The arithmetic is covered in `intake.rs`. The reach — that every Apple
//! platform reads it — is a compile-time assertion in the crate itself, since
//! a test could only say so while running on the device and nothing runs tests
//! there. What is left for a test is the claim this host makes.

use notes_sync::intake::READS_DATALESS_FLAG;

#[test]
fn this_host_says_whether_it_can_see_an_evicted_file() {
    assert_eq!(
        READS_DATALESS_FLAG,
        cfg!(any(target_os = "macos", target_os = "ios"))
    );
}
