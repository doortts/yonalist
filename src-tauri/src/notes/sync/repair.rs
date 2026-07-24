use crate::notes::error::NotesError;
use uuid::Uuid;

pub(crate) const JAVASCRIPT_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const LEGACY_UUID_PREFIX_HEX_DIGITS: usize = 15;
const SAFE_UUID_PREFIX_HEX_DIGITS: usize = 13;

fn uuid_prefix_sort_key(node_id: &str, digits: usize) -> Result<i64, NotesError> {
    let canonical = Uuid::parse_str(node_id)
        .map_err(|_| "A recovered Notes node ID is invalid.".to_string())?
        .simple()
        .to_string();
    let prefix = u64::from_str_radix(&canonical[..digits], 16)
        .map_err(|_| "A recovered Notes node ID is invalid.".to_string())?;
    i64::try_from(prefix).map_err(|_| {
        "A recovered Notes sort key is too large."
            .to_string()
            .into()
    })
}

pub(crate) fn safe_recovery_sort_key(node_id: &str) -> Result<i64, NotesError> {
    uuid_prefix_sort_key(node_id, SAFE_UUID_PREFIX_HEX_DIGITS)
}

fn legacy_recovery_sort_key(node_id: &str) -> Result<i64, NotesError> {
    uuid_prefix_sort_key(node_id, LEGACY_UUID_PREFIX_HEX_DIGITS)
}

#[cfg(test)]
mod tests {
    use super::{legacy_recovery_sort_key, safe_recovery_sort_key, JAVASCRIPT_MAX_SAFE_INTEGER};

    const UNSAFE_ID: &str = "a463bd35-2362-43fd-a784-bcad33920222";

    #[test]
    fn recovery_sort_keys_stay_javascript_safe() {
        let legacy = legacy_recovery_sort_key(UNSAFE_ID).expect("legacy key");
        let safe = safe_recovery_sort_key(UNSAFE_ID).expect("safe key");

        assert!(legacy > JAVASCRIPT_MAX_SAFE_INTEGER);
        assert!(safe <= JAVASCRIPT_MAX_SAFE_INTEGER);
        assert_eq!(safe, 2_891_972_529_501_732);
    }

    #[test]
    fn truncating_the_uuid_prefix_preserves_recovery_order() {
        let first = "26feb39b-1698-4060-b0e6-c8e8d67f28da";
        let second = "a463bd35-2362-43fd-a784-bcad33920222";

        assert_eq!(
            legacy_recovery_sort_key(first)
                .unwrap()
                .cmp(&legacy_recovery_sort_key(second).unwrap()),
            safe_recovery_sort_key(first)
                .unwrap()
                .cmp(&safe_recovery_sort_key(second).unwrap())
        );
    }
}
