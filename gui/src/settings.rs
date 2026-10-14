use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub download_dir: String,
    pub output_dir: String,
    pub keep_original: bool,
    pub default_quality: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        let default_download = dirs::download_dir()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
            .to_string_lossy()
            .to_string();

        let default_output = dirs::video_dir()
            .unwrap_or_else(|| PathBuf::from(&default_download))
            .to_string_lossy()
            .to_string();

        Self {
            download_dir: default_download,
            output_dir: default_output,
            keep_original: false,
            default_quality: "best".to_string(),
        }
    }
}

impl AppSettings {
    fn config_path() -> Option<PathBuf> {
        dirs::config_dir().map(|p| p.join("rconv").join("settings.json"))
    }

    pub fn load() -> Self {
        if let Some(path) = Self::config_path() {
            if path.exists() {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(settings) = serde_json::from_str::<AppSettings>(&content) {
                        return settings;
                    }
                }
            }
        }
        Self::default()
    }

    pub fn save(&self) {
        if let Some(path) = Self::config_path() {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(json) = serde_json::to_string_pretty(self) {
                let _ = std::fs::write(&path, json);
            }
        }
    }
}
