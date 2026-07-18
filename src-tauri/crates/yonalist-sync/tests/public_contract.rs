use yonalist_sync::{DeviceId, GitOid, Plane, ProjectId, SyncErrorCode};

#[test]
fn primitive_types_are_stable_and_strongly_typed() {
    let project = ProjectId::from_bytes([1; 16]);
    let device = DeviceId::from_bytes([2; 16]);

    assert_eq!(project.to_string(), "01040g2081040g2081040g2081");
    assert_eq!(device.to_string(), "02081040g2081040g2081040g2");
    assert_eq!(Plane::Control.ref_prefix(), "refs/yonalist/control/");
    assert_eq!(Plane::Data.ref_prefix(), "refs/yonalist/data/");
    assert_eq!(
        GitOid::parse(&"a".repeat(64)).unwrap().as_str(),
        "a".repeat(64)
    );
    assert_eq!(
        GitOid::parse("abc").unwrap_err().code,
        SyncErrorCode::InvalidId
    );
}

#[test]
fn primitive_ids_reject_values_larger_than_u128() {
    for value in ["80000000000000000000000000", "zzzzzzzzzzzzzzzzzzzzzzzzzz"] {
        assert_eq!(
            value.parse::<ProjectId>().unwrap_err().code,
            SyncErrorCode::InvalidId
        );
    }

    let largest = "7zzzzzzzzzzzzzzzzzzzzzzzzz";
    assert_eq!(largest.parse::<ProjectId>().unwrap().to_string(), largest);
}
