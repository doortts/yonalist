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

use super::{VaultPlace as Place, first_run_vault};

const STORED: &str = "/somewhere/a-vault-the-user-picked";

#[test]
fn a_vault_already_chosen_is_never_replaced() {
    let chosen = first_run_vault(Some(PathBuf::from(STORED)), || {
        panic!("the platform must not be asked once there is an answer")
    });

    assert_eq!(chosen, None);
}

#[test]
fn a_first_run_takes_what_the_platform_offers() {
    let chosen = first_run_vault(None, || {
        Some(Place::Shared(PathBuf::from("/container/Documents")))
    });

    assert_eq!(
        chosen,
        Some(Place::Shared(PathBuf::from("/container/Documents")))
    );
}

#[test]
fn a_platform_with_nothing_to_offer_leaves_the_vault_unset() {
    // Every desktop: the folder is the user's to pick, and picking one for
    // them would start syncing notes into a place they never named.
    assert_eq!(first_run_vault(None, || None), None);
}

#[test]
fn the_local_fallback_is_offered_too_rather_than_refused() {
    // A phone with iCloud off still has to be writable, and the screen says
    // which it got.
    let chosen = first_run_vault(None, || Some(Place::Local(PathBuf::from("/app/Documents"))));

    assert!(matches!(chosen, Some(Place::Local(_))));
}
