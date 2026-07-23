pub(crate) const GITHUB_NOTIFICATIONS_PLUGIN_ID: &str = "github-notifications";
pub(crate) const GITHUB_EXTERNAL_KEY_PROVIDER: &str = "github";
pub(crate) const GITHUB_NOTIFICATIONS_ROOT_ID: &str = "6983f947-c134-44fc-bf46-db19f68125bf";
pub(crate) const GITHUB_NOTIFICATIONS_TITLE: &str = "Github Notifications";
pub(crate) const GITHUB_NOTIFICATIONS_FILENAME: &str = "Github-Notifications.6983f947.md";
pub(crate) const SEED_HLC: &str = "000000000-00-0000";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GithubNotificationsPluginState {
    pub(crate) collapsed_groups: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GithubNotificationsPluginMeta {
    Date {
        date_key: String,
    },
    Notification {
        notification_key: String,
        notification_type: String,
        url: String,
        updated_at: String,
        unread: bool,
    },
}
