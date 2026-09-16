use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

use web_api::ManagerExt;

use crate::{
    api::{self, Organization},
    web_api,
};

#[derive(Serialize, Deserialize, Type, Debug)]
pub struct AuthStore {
    pub secret: AuthSecret,
    pub user_id: Option<String>,
    pub plan: Option<Plan>,
    #[serde(default)]
    pub organizations: Vec<Organization>,
    #[serde(default)]
    pub organizations_updated_at: Option<i32>,
}

#[derive(Serialize, Deserialize, Type, Debug)]
#[serde(untagged)]
pub enum AuthSecret {
    ApiKey { api_key: String },
    Session { token: String, expires: i32 },
}

#[derive(Serialize, Deserialize, Type, Debug)]
pub struct Plan {
    pub upgraded: bool,
    pub manual: bool,
    pub last_checked: i32,
}

impl AuthStore {
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Self>, String> {
        let Some(store) = app
            .store("store")
            .map(|s| s.get("auth"))
            .map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };

        serde_json::from_value(store).map_err(|e| e.to_string())
    }

    pub fn get<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Self>, String> {
        let Ok(Some(store)) = app.store("store").map(|s| s.get("auth")) else {
            return Ok(None);
        };

        serde_json::from_value(store).map_err(|e| e.to_string())
    }

    pub async fn update_auth_plan(app: &AppHandle) -> Result<(), String> {
        let auth = Self::get(app)?;
        let Some(auth) = auth else {
            return Err("User not authenticated".to_string());
        };

        if let Some(plan) = &auth.plan
            && plan.manual
        {
            return Ok(());
        }

        let mut auth = auth;

        let _ = app
            .authed_api_request("/api/desktop/plan", |client, url| client.get(url))
            .await;
        auth.plan = Some(Plan {
            upgraded: true,
            last_checked: chrono::Utc::now().timestamp() as i32,
            manual: true,
        });

        match api::fetch_organizations(app).await {
            Ok(orgs) => {
                auth.organizations = orgs;
                auth.organizations_updated_at = Some(chrono::Utc::now().timestamp() as i32);
            }
            Err(e) => {
                tracing::warn!("Failed to fetch organizations: {e}");
                if auth.organizations.is_empty() {
                    auth.organizations_updated_at = Some(chrono::Utc::now().timestamp() as i32);
                }
            }
        }

        Self::set(app, Some(auth))?;

        Ok(())
    }

    pub fn is_upgraded(&self) -> bool {
        true
    }

    pub fn set(app: &AppHandle, value: Option<Self>) -> Result<(), String> {
        let Ok(store) = app.store("store") else {
            return Err("Store not found".to_string());
        };

        store.set("auth", json!(value));
        store.save().map_err(|e| e.to_string())
    }
}
