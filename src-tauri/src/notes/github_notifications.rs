use crate::notes::date_index::LocalDate;
use crate::notes::sync::topic_file::is_app_timestamp;
use serde::{Deserialize, Serialize};

pub(crate) const GITHUB_NOTIFICATIONS_PLUGIN_ID: &str = "github-notifications";
pub(crate) const GITHUB_EXTERNAL_KEY_PROVIDER: &str = "github";
pub(crate) const GITHUB_NOTIFICATIONS_ROOT_ID: &str = "6983f947-c134-44fc-bf46-db19f68125bf";
pub(crate) const GITHUB_NOTIFICATIONS_TITLE: &str = "Github Notifications";
pub(crate) const GITHUB_NOTIFICATIONS_FILENAME: &str = "Github-Notifications.6983f947.md";
pub(crate) const SEED_HLC: &str = "000000000-00-0000";

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
        #[serde(rename = "dateKey", alias = "date_key")]
        date_key: String,
    },
    Notification {
        #[serde(rename = "notificationKey", alias = "notification_key")]
        notification_key: String,
        #[serde(rename = "notificationType", alias = "type")]
        notification_type: String,
        url: String,
        #[serde(rename = "updatedAt", alias = "updated_at")]
        updated_at: String,
        unread: bool,
    },
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
        && !notification_type.is_empty()
        && !notification_type.chars().any(char::is_whitespace)
        && is_http_url_with_host(url)
        && is_app_timestamp(updated_at)
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
    use super::GithubNotificationsPluginMeta;
    use serde_json::json;

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
        assert_eq!(
            serde_json::from_value::<GithubNotificationsPluginMeta>(json!({
                "kind": "date",
                "date_key": "2026.07.21"
            }))
            .expect("deserialize stored date metadata"),
            GithubNotificationsPluginMeta::Date {
                date_key: "2026.07.21".to_string()
            }
        );
        assert_eq!(
            serde_json::from_value::<GithubNotificationsPluginMeta>(json!({
                "kind": "notification",
                "notification_key":
                    "[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"42\"]",
                "type": "Issue",
                "url": "https://github.com/example/repo/issues/42",
                "updated_at": "2026-07-21T00:00:00Z",
                "unread": true
            }))
            .expect("deserialize stored notification metadata"),
            GithubNotificationsPluginMeta::Notification {
                notification_key:
                    "[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"42\"]"
                        .to_string(),
                notification_type: "Issue".to_string(),
                url: "https://github.com/example/repo/issues/42".to_string(),
                updated_at: "2026-07-21T00:00:00Z".to_string(),
                unread: true
            }
        );
    }
}
