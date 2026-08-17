//! Where an attachment's bytes belong, and what to do when that changes.
//!
//! One reference: the page's own folder. Two or more: the vault's root store,
//! because neither page owns it any more. The move is always write-then-delete
//! — an interruption leaves the bytes in two places, which is harmless because
//! they are the same bytes, rather than in none.

use notes_sync::attachments::{Move, Reference, plan_placement};

fn reference(page: &str, disk_name: &str) -> Reference {
    Reference {
        page_folder: page.to_owned(),
        disk_name: disk_name.to_owned(),
        trashed: false,
    }
}

#[test]
fn a_single_reference_keeps_the_bytes_in_the_page_folder() {
    let plan = plan_placement(
        "Projects-4f1c8e20a3b7/assets/shot-9f3a1c8e2044.png",
        &[reference("Projects-4f1c8e20a3b7", "shot-9f3a1c8e2044.png")],
    );

    assert_eq!(
        plan.location,
        "Projects-4f1c8e20a3b7/assets/shot-9f3a1c8e2044.png"
    );
    assert_eq!(
        plan.link_from("Projects-4f1c8e20a3b7"),
        "assets/shot-9f3a1c8e2044.png"
    );
    assert_eq!(plan.moves, Vec::<Move>::new());
}

/// The second page to point at the same bytes takes them out of the first
/// page's folder: a folder the user opens should not hold another page's file.
#[test]
fn a_second_reference_promotes_the_file_to_the_root_store() {
    let plan = plan_placement(
        "Projects-4f1c8e20a3b7/assets/shot-9f3a1c8e2044.png",
        &[
            reference("Projects-4f1c8e20a3b7", "shot-9f3a1c8e2044.png"),
            reference("Second-11c8da70b5e1", "shot-9f3a1c8e2044.png"),
        ],
    );

    assert_eq!(plan.location, "assets/shot-9f3a1c8e2044.png");
    assert_eq!(
        plan.link_from("Projects-4f1c8e20a3b7"),
        "../assets/shot-9f3a1c8e2044.png"
    );
    assert_eq!(
        plan.moves,
        vec![Move {
            from: "Projects-4f1c8e20a3b7/assets/shot-9f3a1c8e2044.png".to_owned(),
            to: "assets/shot-9f3a1c8e2044.png".to_owned(),
        }],
        "written to the new place, then removed from the old one"
    );
}

/// Two pages that each added the same bytes under their own name have to agree
/// on one name in the root store, whichever device works it out.
#[test]
fn a_promotion_merges_names_deterministically() {
    let one = reference("Projects-4f1c8e20a3b7", "zebra-9f3a1c8e2044.png");
    let two = reference("Second-11c8da70b5e1", "apple-9f3a1c8e2044.png");

    let forwards = plan_placement("", &[one.clone(), two.clone()]);
    let backwards = plan_placement("", &[two, one]);

    assert_eq!(forwards.location, backwards.location);
    assert_eq!(
        forwards.location, "assets/apple-9f3a1c8e2044.png",
        "the smallest cleaned name wins, so every device picks the same one"
    );
}

/// The tie-break is on the name the user gave the file, not on the whole disk
/// name: the hash and the extension are the same for both, but a `-` inside a
/// cleaned name sorts before the hash's first character and would otherwise
/// hand the longer name the win.
#[test]
fn the_tie_break_reads_the_cleaned_name_not_the_hash_after_it() {
    let plain = reference("Projects-4f1c8e20a3b7", "shot-c93a1c8e2044.png");
    let hyphenated = reference("Second-11c8da70b5e1", "shot-2-c93a1c8e2044.png");

    let plan = plan_placement("", &[hyphenated, plain]);

    assert_eq!(
        plan.location, "assets/shot-c93a1c8e2044.png",
        "`shot` is the smaller name; `shot-2` only looks smaller because the \
         hyphen sorts under the hash that follows it"
    );
}

/// A split document sits one folder deeper than its page, and its attachments
/// belong to the page, not to it. Both halves of that have to hold: the bytes
/// go in the page's folder, and the link climbs out of the split folder to
/// reach them. A link resolving anywhere else is quarantined by every device
/// that reads it.
#[test]
fn a_split_document_reaches_its_page_folder() {
    let plan = plan_placement(
        "",
        &[reference("Projects-4f1c8e20a3b7", "shot-9f3a1c8e2044.png")],
    );

    assert_eq!(
        plan.location,
        "Projects-4f1c8e20a3b7/assets/shot-9f3a1c8e2044.png"
    );
    assert_eq!(
        plan.link_from("Projects-4f1c8e20a3b7/Deeper-8a201f330000"),
        "../assets/shot-9f3a1c8e2044.png",
        "one `../` out of the split folder, and the page's assets are right there"
    );
}

#[test]
fn a_split_document_climbs_all_the_way_to_the_root_store() {
    let plan = plan_placement(
        "",
        &[
            reference("Projects-4f1c8e20a3b7", "shot-9f3a1c8e2044.png"),
            reference("Second-11c8da70b5e1", "shot-9f3a1c8e2044.png"),
        ],
    );

    assert_eq!(
        plan.link_from("Projects-4f1c8e20a3b7/Deeper-8a201f330000"),
        "../../assets/shot-9f3a1c8e2044.png",
        "one `../` for each folder between the document and the vault root"
    );
}

#[test]
fn dropping_back_to_one_reference_brings_it_home() {
    let plan = plan_placement(
        "assets/shot-9f3a1c8e2044.png",
        &[reference("Second-11c8da70b5e1", "shot-9f3a1c8e2044.png")],
    );

    assert_eq!(
        plan.location,
        "Second-11c8da70b5e1/assets/shot-9f3a1c8e2044.png"
    );
    assert_eq!(
        plan.moves,
        vec![Move {
            from: "assets/shot-9f3a1c8e2044.png".to_owned(),
            to: "Second-11c8da70b5e1/assets/shot-9f3a1c8e2044.png".to_owned(),
        }]
    );
}

/// A deleted note still counts. Its image line points at the root store, so the
/// bytes have to be there even when only the trash refers to them.
#[test]
fn a_trashed_reference_keeps_the_bytes_in_the_root_store() {
    let plan = plan_placement(
        "assets/shot-9f3a1c8e2044.png",
        &[Reference {
            page_folder: "Projects-4f1c8e20a3b7".to_owned(),
            disk_name: "shot-9f3a1c8e2044.png".to_owned(),
            trashed: true,
        }],
    );

    assert_eq!(
        plan.location, "assets/shot-9f3a1c8e2044.png",
        "the trash lives at the vault root, so its links climb from there"
    );
    assert_eq!(
        plan.link_from(".yonalist"),
        "../assets/shot-9f3a1c8e2044.png"
    );
}

/// Nobody points at it any more. It is not deleted — the user does that from
/// the attachments list — so nothing moves and nothing is written.
#[test]
fn an_unreferenced_attachment_is_left_where_it_is() {
    let plan = plan_placement("Projects-4f1c8e20a3b7/assets/shot-9f3a1c8e2044.png", &[]);

    assert_eq!(
        plan.location, "Projects-4f1c8e20a3b7/assets/shot-9f3a1c8e2044.png",
        "nothing points at it, and nothing moves it either"
    );
    assert_eq!(plan.moves, Vec::<Move>::new());
}

/// A split document sits one level deeper, so its link climbs one level more.
#[test]
fn a_deeper_document_climbs_further() {
    let plan = plan_placement(
        "",
        &[
            reference("Projects-4f1c8e20a3b7", "shot-9f3a1c8e2044.png"),
            reference(
                "Projects-4f1c8e20a3b7/Archive-9d3f21b8c440",
                "shot-9f3a1c8e2044.png",
            ),
        ],
    );

    assert_eq!(
        plan.link_from("Projects-4f1c8e20a3b7/Archive-9d3f21b8c440"),
        "../../assets/shot-9f3a1c8e2044.png"
    );
}
