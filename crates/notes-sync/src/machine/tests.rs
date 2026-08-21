use super::provision;

const STORED: [u8; 16] = [7; 16];
const DRAWN: [u8; 16] = [9; 16];

#[test]
fn a_stored_value_is_the_answer_and_nothing_is_drawn() {
    let seed = provision(
        || Some(STORED.to_vec()),
        |_| panic!("a stored value must not be overwritten"),
        || panic!("a stored value must not be redrawn"),
    );
    assert_eq!(seed, Some(STORED));
}

#[test]
fn an_empty_store_is_filled_with_what_was_drawn() {
    let mut written = None;
    let seed = provision(
        || None,
        |bytes| {
            written = Some(bytes.to_vec());
            true
        },
        || DRAWN,
    );
    assert_eq!(seed, Some(DRAWN));
    assert_eq!(written.as_deref(), Some(&DRAWN[..]));
}

#[test]
fn a_value_of_the_wrong_width_is_replaced_rather_than_trusted() {
    let seed = provision(|| Some(vec![1, 2, 3]), |_| true, || DRAWN);
    assert_eq!(seed, Some(DRAWN));
}

#[test]
fn a_write_that_loses_a_race_yields_to_what_is_there() {
    let seed = provision(
        // Empty on the first look, taken by the time the write is refused.
        {
            let looks = std::cell::Cell::new(0_u32);
            move || {
                let first = looks.get() == 0;
                looks.set(looks.get() + 1);
                (!first).then(|| STORED.to_vec())
            }
        },
        |_| false,
        || DRAWN,
    );
    assert_eq!(seed, Some(STORED));
}

#[test]
fn a_write_that_fails_with_nothing_to_read_back_refuses_to_invent_one() {
    let seed = provision(|| None, |_| false, || DRAWN);
    assert_eq!(seed, None);
}
