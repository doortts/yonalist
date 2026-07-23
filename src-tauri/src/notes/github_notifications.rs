use crate::notes::date_index::LocalDate;
use crate::notes::sync::topic_file::is_app_timestamp;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use uuid::Uuid;

pub(crate) const GITHUB_NOTIFICATIONS_PLUGIN_ID: &str = "github-notifications";
pub(crate) const GITHUB_EXTERNAL_KEY_PROVIDER: &str = "github";
pub(crate) const GITHUB_NOTIFICATIONS_ROOT_ID: &str = "6983f947-c134-44fc-bf46-db19f68125bf";
pub(crate) const GITHUB_NOTIFICATIONS_TITLE: &str = "Github Notifications";
pub(crate) const GITHUB_NOTIFICATIONS_FILENAME: &str = "Github-Notifications.6983f947.md";
pub(crate) const SEED_HLC: &str = "000000000-00-0000";
pub(crate) const MAX_GITHUB_NOTIFICATION_METADATA_UTF8_BYTES: usize = 100_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GithubNotificationsPluginState {
    pub(crate) collapsed_groups: Vec<String>,
}

impl GithubNotificationsPluginState {
    pub(crate) fn is_valid(&self) -> bool {
        self.collapsed_groups
            .iter()
            .all(|group| is_valid_github_date_key(group))
            && self
                .collapsed_groups
                .windows(2)
                .all(|groups| groups[0] < groups[1])
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum GithubNotificationsPluginMeta {
    Date {
        #[serde(rename = "dateKey")]
        date_key: String,
    },
    Notification {
        #[serde(rename = "notificationKey")]
        notification_key: String,
        #[serde(rename = "notificationType")]
        notification_type: String,
        url: String,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        unread: bool,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum GithubNotificationsPluginMetaStorage {
    Date {
        date_key: String,
    },
    Notification {
        notification_key: String,
        #[serde(rename = "type")]
        notification_type: String,
        url: String,
        updated_at: String,
        unread: bool,
    },
}

pub(crate) fn serialize_github_plugin_meta_storage(
    metadata: &GithubNotificationsPluginMeta,
) -> Result<String, serde_json::Error> {
    let storage = match metadata {
        GithubNotificationsPluginMeta::Date { date_key } => {
            GithubNotificationsPluginMetaStorage::Date {
                date_key: date_key.clone(),
            }
        }
        GithubNotificationsPluginMeta::Notification {
            notification_key,
            notification_type,
            url,
            updated_at,
            unread,
        } => GithubNotificationsPluginMetaStorage::Notification {
            notification_key: notification_key.clone(),
            notification_type: notification_type.clone(),
            url: url.clone(),
            updated_at: updated_at.clone(),
            unread: *unread,
        },
    };
    serde_json::to_string(&storage)
}

pub(crate) fn parse_github_plugin_meta_storage(
    value: &str,
) -> Result<GithubNotificationsPluginMeta, serde_json::Error> {
    Ok(match serde_json::from_str(value)? {
        GithubNotificationsPluginMetaStorage::Date { date_key } => {
            GithubNotificationsPluginMeta::Date { date_key }
        }
        GithubNotificationsPluginMetaStorage::Notification {
            notification_key,
            notification_type,
            url,
            updated_at,
            unread,
        } => GithubNotificationsPluginMeta::Notification {
            notification_key,
            notification_type,
            url,
            updated_at,
            unread,
        },
    })
}

impl GithubNotificationsPluginMeta {
    pub(crate) fn is_valid(&self) -> bool {
        match self {
            Self::Date { date_key } => is_valid_github_date_key(date_key),
            Self::Notification {
                notification_key,
                notification_type,
                url,
                updated_at,
                ..
            } => is_valid_github_notification_metadata(
                notification_key,
                notification_type,
                url,
                updated_at,
            ),
        }
    }
}

pub(crate) fn is_valid_github_date_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'.'
        && bytes[7] == b'.'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
        && LocalDate::parse_iso(&format!("{}-{}-{}", &value[..4], &value[5..7], &value[8..]))
            .is_some()
}

pub(crate) fn is_valid_github_notification_metadata(
    notification_key: &str,
    notification_type: &str,
    url: &str,
    updated_at: &str,
) -> bool {
    notification_key.len() <= MAX_GITHUB_NOTIFICATION_METADATA_UTF8_BYTES
        && notification_type.len() <= MAX_GITHUB_NOTIFICATION_METADATA_UTF8_BYTES
        && url.len() <= MAX_GITHUB_NOTIFICATION_METADATA_UTF8_BYTES
        && updated_at.len() <= MAX_GITHUB_NOTIFICATION_METADATA_UTF8_BYTES
        && is_valid_github_notification_key(notification_key)
        && !notification_type.is_empty()
        && !notification_type.chars().any(char::is_whitespace)
        && is_http_url_with_host(url)
        && is_app_timestamp(updated_at)
}

pub(crate) fn is_valid_github_notification_key(notification_key: &str) -> bool {
    if notification_key.len() > MAX_GITHUB_NOTIFICATION_METADATA_UTF8_BYTES {
        return false;
    }
    let Ok((provider, connection_id, remote_id)) =
        serde_json::from_str::<(String, String, String)>(notification_key)
    else {
        return false;
    };
    let Ok((api_base_url, account_id)) = serde_json::from_str::<(String, String)>(&connection_id)
    else {
        return false;
    };
    serde_json::to_string(&(
        provider.as_str(),
        connection_id.as_str(),
        remote_id.as_str(),
    ))
    .is_ok_and(|value| value == notification_key)
        && serde_json::to_string(&(api_base_url.as_str(), account_id.as_str()))
            .is_ok_and(|value| value == connection_id)
        && provider == GITHUB_EXTERNAL_KEY_PROVIDER
        && is_nonempty_id(&account_id)
        && is_nonempty_id(&remote_id)
        && api_base_url.trim() == api_base_url
        && !api_base_url.ends_with('/')
        && is_http_url_with_host(&api_base_url)
}

pub(crate) fn github_date_node_id(date_key: &str) -> Result<String, String> {
    if !is_valid_github_date_key(date_key) {
        return Err("A GitHub notification date key is invalid.".to_string());
    }
    Ok(normalized_v4_from_v5(date_key).hyphenated().to_string())
}

pub(crate) fn github_notification_node_id(notification_key: &str) -> Result<String, String> {
    if !is_valid_github_notification_key(notification_key) {
        return Err("A GitHub notification key is invalid.".to_string());
    }
    Ok(normalized_v4_from_v5(notification_key)
        .hyphenated()
        .to_string())
}

fn normalized_v4_from_v5(key: &str) -> Uuid {
    let namespace =
        Uuid::parse_str(GITHUB_NOTIFICATIONS_ROOT_ID).expect("fixed GitHub root ID is valid");
    let mut bytes = *Uuid::new_v5(&namespace, key.as_bytes()).as_bytes();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x0f) | 0x80;
    Uuid::from_bytes(bytes)
}

pub(crate) fn compare_github_notification_timestamps(
    left: &str,
    right: &str,
) -> Option<Ordering> {
    let (left_date, left_hour, left_minute, left_second, left_fraction) =
        parse_notification_timestamp(left)?;
    let (right_date, right_hour, right_minute, right_second, right_fraction) =
        parse_notification_timestamp(right)?;
    let whole = (left_date, left_hour, left_minute, left_second).cmp(&(
        right_date,
        right_hour,
        right_minute,
        right_second,
    ));
    if whole != Ordering::Equal {
        return Some(whole);
    }
    for index in 0..left_fraction.len().max(right_fraction.len()) {
        let left_digit = left_fraction.as_bytes().get(index).copied().unwrap_or(b'0');
        let right_digit = right_fraction
            .as_bytes()
            .get(index)
            .copied()
            .unwrap_or(b'0');
        let order = left_digit.cmp(&right_digit);
        if order != Ordering::Equal {
            return Some(order);
        }
    }
    Some(Ordering::Equal)
}

fn parse_notification_timestamp(value: &str) -> Option<(LocalDate, u8, u8, u8, &str)> {
    let value = value.strip_suffix('Z')?;
    let (date, time) = value.split_once('T')?;
    let date = LocalDate::parse_iso(date)?;
    let (whole, fraction) = time
        .split_once('.')
        .map_or((time, ""), |(whole, fraction)| (whole, fraction));
    if whole.len() != 8 || whole.as_bytes()[2] != b':' || whole.as_bytes()[5] != b':' {
        return None;
    }
    let pair = |value: &[u8]| -> Option<u8> {
        value
            .iter()
            .all(u8::is_ascii_digit)
            .then(|| (value[0] - b'0') * 10 + (value[1] - b'0'))
    };
    let hour = pair(&whole.as_bytes()[0..2])?;
    let minute = pair(&whole.as_bytes()[3..5])?;
    let second = pair(&whole.as_bytes()[6..8])?;
    if hour > 23
        || minute > 59
        || second > 59
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some((date, hour, minute, second, fraction))
}

fn is_nonempty_id(value: &str) -> bool {
    !value.is_empty() && value.trim() == value
}

fn is_http_url_with_host(value: &str) -> bool {
    let Some(authority) = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    else {
        return false;
    };
    !authority.is_empty()
        && !authority.starts_with('/')
        && tauri::Url::parse(value)
            .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
}

#[cfg(test)]
mod tests {
    use super::{
        compare_github_notification_timestamps, github_date_node_id,
        github_notification_node_id, parse_github_plugin_meta_storage,
        serialize_github_plugin_meta_storage, GithubNotificationsPluginMeta,
    };
    use crate::notes::types::validate_note_id;
    use serde_json::json;
    use std::cmp::Ordering;
    use uuid::{Variant, Version};

    #[test]
    fn plugin_metadata_serializes_with_exact_camel_case_wire_fields() {
        assert_eq!(
            serde_json::to_value(GithubNotificationsPluginMeta::Date {
                date_key: "2026.07.21".to_string(),
            })
            .expect("serialize date metadata"),
            json!({ "kind": "date", "dateKey": "2026.07.21" })
        );
        assert_eq!(
            serde_json::to_value(GithubNotificationsPluginMeta::Notification {
                notification_key:
                    "[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"42\"]"
                        .to_string(),
                notification_type: "Issue".to_string(),
                url: "https://github.com/example/repo/issues/42".to_string(),
                updated_at: "2026-07-21T00:00:00Z".to_string(),
                unread: true,
            })
            .expect("serialize notification metadata"),
            json!({
                "kind": "notification",
                "notificationKey":
                    "[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"42\"]",
                "notificationType": "Issue",
                "url": "https://github.com/example/repo/issues/42",
                "updatedAt": "2026-07-21T00:00:00Z",
                "unread": true
            })
        );
        assert!(serde_json::from_value::<GithubNotificationsPluginMeta>(json!({
            "kind": "date",
            "date_key": "2026.07.21"
        }))
        .is_err());
        assert!(serde_json::from_value::<GithubNotificationsPluginMeta>(json!({
                "kind": "notification",
                "notification_key":
                    "[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"42\"]",
                "type": "Issue",
                "url": "https://github.com/example/repo/issues/42",
                "updated_at": "2026-07-21T00:00:00Z",
                "unread": true
            }))
        .is_err());
    }

    #[test]
    fn plugin_metadata_uses_one_exact_snake_case_database_shape() {
        let date = GithubNotificationsPluginMeta::Date {
            date_key: "2026.07.21".to_string(),
        };
        assert_eq!(
            serialize_github_plugin_meta_storage(&date).expect("stored date metadata"),
            r#"{"kind":"date","date_key":"2026.07.21"}"#
        );
        assert_eq!(
            parse_github_plugin_meta_storage(
                r#"{"kind":"date","date_key":"2026.07.21"}"#
            )
            .expect("parse stored date metadata"),
            date
        );

        let notification = GithubNotificationsPluginMeta::Notification {
            notification_key:
                "[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"42\"]"
                    .to_string(),
            notification_type: "Issue".to_string(),
            url: "https://github.com/example/repo/issues/42".to_string(),
            updated_at: "2026-07-21T00:00:00Z".to_string(),
            unread: true,
        };
        let stored =
            serialize_github_plugin_meta_storage(&notification).expect("stored notification");
        assert_eq!(
            stored,
            r#"{"kind":"notification","notification_key":"[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"42\"]","type":"Issue","url":"https://github.com/example/repo/issues/42","updated_at":"2026-07-21T00:00:00Z","unread":true}"#
        );
        assert_eq!(
            parse_github_plugin_meta_storage(&stored).expect("parse stored notification"),
            notification
        );
        assert!(parse_github_plugin_meta_storage(
            r#"{"kind":"date","dateKey":"2026.07.21"}"#
        )
        .is_err());
    }

    #[test]
    fn deterministic_github_node_ids_match_the_approved_plan_v4_goldens() {
        let date_id = github_date_node_id("2026.07.21").expect("derive date ID");
        let notification_id = github_notification_node_id(
            "[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"42\"]",
        )
        .expect("derive notification ID");
        let other_connection_id = github_notification_node_id(
            "[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-8\\\"]\",\"42\"]",
        )
        .expect("derive other connection ID");

        assert_eq!(date_id, "f6810d77-f852-4277-825c-e03fa4e39f63");
        assert_eq!(
            notification_id,
            "f3f1c390-a6a0-43a1-8354-133a5e043db9"
        );
        assert_eq!(
            other_connection_id,
            "c72d1dea-4d28-422d-8f99-4b2bd9fe87e2"
        );
        assert_ne!(notification_id, other_connection_id);
        for id in [date_id, notification_id, other_connection_id] {
            validate_note_id(&id).expect("derived ID is a canonical note ID");
            let parsed = uuid::Uuid::parse_str(&id).expect("parse derived ID");
            assert_eq!(parsed.get_version(), Some(Version::Random));
            assert_eq!(parsed.get_variant(), Variant::RFC4122);
        }
    }

    #[test]
    fn deterministic_github_ids_reject_noncanonical_keys_before_derivation() {
        assert!(github_date_node_id("2026-07-21").is_err());
        assert!(github_notification_node_id(
            "[ \"github\", \"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\", \"42\" ]"
        )
        .is_err());
        assert!(github_notification_node_id(
            "[\"github\",\"[\\\"https://api.github.com/\\\",\\\"account-7\\\"]\",\"42\"]"
        )
        .is_err());
    }

    #[test]
    fn github_timestamp_comparison_preserves_fractional_precision() {
        assert_eq!(
            compare_github_notification_timestamps(
                "2026-07-21T10:00:00Z",
                "2026-07-21T10:00:00.000Z"
            ),
            Some(Ordering::Equal)
        );
        assert_eq!(
            compare_github_notification_timestamps(
                "2026-07-21T10:00:00.0009Z",
                "2026-07-21T10:00:00.0001Z"
            ),
            Some(Ordering::Greater)
        );
        assert_eq!(
            compare_github_notification_timestamps(
                "2026-07-21T09:59:59.999Z",
                "2026-07-21T10:00:00Z"
            ),
            Some(Ordering::Less)
        );
        assert_eq!(
            compare_github_notification_timestamps(
                "2026-07-21T24:00:00Z",
                "2026-07-21T10:00:00Z"
            ),
            None
        );
    }
}
