use super::{VaultPlace, vault_root};
use std::path::{Path, PathBuf};

const CONTAINER: &str = "/Mobile Documents/iCloud~com~doortts~yonalist~v2";

#[test]
fn the_vault_is_the_documents_folder_of_the_container() {
    let place = vault_root(
        || Some(PathBuf::from(CONTAINER)),
        || PathBuf::from("/app/Documents"),
    );

    assert_eq!(
        place,
        VaultPlace::Shared(Path::new(CONTAINER).join("Documents"))
    );
}

#[test]
fn a_device_without_icloud_writes_where_it_can_and_says_so() {
    let place = vault_root(|| None, || PathBuf::from("/app/Documents"));

    assert_eq!(place, VaultPlace::Local(PathBuf::from("/app/Documents")));
}

#[test]
fn the_two_places_are_told_apart_rather_than_both_being_a_path() {
    // The screen has to say which one it got: a vault nobody else can see is a
    // different promise from one that syncs, and silently giving the local one
    // would look like iCloud until a second device disagreed.
    let shared = vault_root(|| Some(PathBuf::from(CONTAINER)), || PathBuf::from("/app"));
    let local = vault_root(|| None, || PathBuf::from("/app"));

    assert!(matches!(shared, VaultPlace::Shared(_)));
    assert!(matches!(local, VaultPlace::Local(_)));
}

#[test]
fn asking_costs_nothing_when_the_answer_is_already_known() {
    // `URLForUbiquityContainerIdentifier` blocks the first time it is called,
    // so it is asked once per launch and never on a path the caller repeats.
    let mut asked = 0;
    let _ = vault_root(
        || {
            asked += 1;
            Some(PathBuf::from(CONTAINER))
        },
        || PathBuf::from("/app"),
    );

    assert_eq!(asked, 1);
}
