use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VideoQualityOption {
    pub name: String,
    pub description: String,
    pub value: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VideoMetadata {
    pub title: String,
    pub duration: Option<u64>,
    pub qualities: Vec<VideoQualityOption>,
}

pub fn check_ytdlp() -> bool {
    which::which("yt-dlp").is_ok()
}

pub fn is_http_url(url: &str) -> bool {
    let trimmed = url.trim();
    trimmed.starts_with("http://") || trimmed.starts_with("https://")
}

pub fn get_format_for_quality(quality: &str) -> String {
    match quality {
        "best" => "bestvideo*+bestaudio/best".to_string(),
        "2160p" => "bestvideo[height<=2160]+bestaudio/best[height<=2160]/best".to_string(),
        "1440p" => "bestvideo[height<=1440]+bestaudio/best[height<=1440]/best".to_string(),
        "1080p" => "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best".to_string(),
        "720p" => "bestvideo[height<=720]+bestaudio/best[height<=720]/best".to_string(),
        "480p" => "bestvideo[height<=480]+bestaudio/best[height<=480]/best".to_string(),
        "360p" => "bestvideo[height<=360]+bestaudio/best[height<=360]/best".to_string(),
        "audio" => "bestaudio/best".to_string(),
        custom if custom.ends_with('p') => {
            if let Ok(h) = custom.trim_end_matches('p').parse::<u32>() {
                format!("bestvideo[height<={}]+bestaudio/best[height<={}]/best", h, h)
            } else {
                "bestvideo*+bestaudio/best".to_string()
            }
        }
        _ => "bestvideo*+bestaudio/best".to_string(),
    }
}

pub async fn fetch_video_metadata(url: &str) -> Result<VideoMetadata, String> {
    if !is_http_url(url) {
        return Err("A URL deve iniciar com http:// ou https://".to_string());
    }

    let output = Command::new("yt-dlp")
        .arg("-J")
        .arg("--no-playlist")
        .arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Falha ao executar yt-dlp: {}", e))?;

    if !output.status.success() {
        let err_text = String::from_utf8_lossy(&output.stderr);
        return Err(format!("yt-dlp erro: {}", err_text.lines().next().unwrap_or("falha ao consultar")));
    }

    let json_val: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Falha ao processar JSON do yt-dlp: {}", e))?;

    let title = json_val["title"].as_str().unwrap_or("Vídeo sem título").to_string();
    let duration = json_val["duration"].as_u64();

    let mut qualities = vec![
        VideoQualityOption {
            name: "⭐ Melhor Qualidade (Máxima / 4K)".to_string(),
            description: "Baixa a maior resolução disponível".to_string(),
            value: "best".to_string(),
        },
    ];

    let mut heights: Vec<u64> = Vec::new();
    if let Some(formats) = json_val["formats"].as_array() {
        for f in formats {
            if let Some(h) = f["height"].as_u64() {
                if h > 0 && !heights.contains(&h) {
                    heights.push(h);
                }
            }
        }
    }

    heights.sort_by(|a, b| b.cmp(a));

    for h in heights {
        let label = match h {
            2160 => "4K Ultra HD (2160p)",
            1440 => "2K Quad HD (1440p)",
            1080 => "1080p Full HD",
            720 => "720p HD",
            480 => "480p SD",
            360 => "360p Econômico",
            _other => "",
        };

        let name = if label.is_empty() {
            format!("{}p", h)
        } else {
            label.to_string()
        };

        qualities.push(VideoQualityOption {
            name,
            description: format!("Resolução vertical de {} pixels", h),
            value: format!("{}p", h),
        });
    }

    qualities.push(VideoQualityOption {
        name: "Apenas Áudio (Linear PCM)".to_string(),
        description: "Extrai faixa de áudio sem vídeo".to_string(),
        value: "audio".to_string(),
    });

    Ok(VideoMetadata {
        title,
        duration,
        qualities,
    })
}

pub async fn download_video<F>(
    url: &str,
    output_dir: &Path,
    quality: &str,
    cancelled: Arc<AtomicBool>,
    mut on_progress: F,
) -> Result<PathBuf, String>
where
    F: FnMut(f32, &str) + Send + 'static,
{
    if !is_http_url(url) {
        return Err("URL inválida".to_string());
    }

    let _ = tokio::fs::create_dir_all(output_dir).await;
    let format_selector = get_format_for_quality(quality);

    let meta_file_path = output_dir.join("__rconv_output_meta.txt");
    let output_template = output_dir.join("%(title)s.%(ext)s");

    let mut cmd = Command::new("yt-dlp");
    cmd.arg("--newline")
        .arg("--no-playlist")
        .arg("-f")
        .arg(&format_selector)
        .arg("-o")
        .arg(&output_template)
        .arg("-P")
        .arg(format!("home:{}", output_dir.display()))
        .arg("-P")
        .arg(format!("temp:{}", output_dir.display()))
        .arg("--merge-output-format")
        .arg("mp4/mkv")
        .arg("--print-to-file")
        .arg("after_move:filepath")
        .arg(meta_file_path.to_string_lossy().to_string())
        .arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Falha ao iniciar yt-dlp: {}", e))?;

    let stdout = child.stdout.take().ok_or("Falha ao abrir stdout do yt-dlp")?;
    let mut reader = BufReader::new(stdout).lines();

    let percent_regex = regex::Regex::new(r"\[download\]\s+(\d+(?:\.\d+)?)%").unwrap();

    loop {
        if cancelled.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            let _ = tokio::fs::remove_file(&meta_file_path).await;
            return Err("Download cancelado pelo usuário".to_string());
        }

        tokio::select! {
            line_res = reader.next_line() => {
                match line_res {
                    Ok(Some(line)) => {
                        if let Some(caps) = percent_regex.captures(&line) {
                            if let Ok(pct) = caps[1].parse::<f32>() {
                                on_progress(pct, &format!("Baixando vídeo e áudio... {:.1}%", pct));
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            status = child.wait() => {
                let status = status.map_err(|e| e.to_string())?;
                if !status.success() {
                    let _ = tokio::fs::remove_file(&meta_file_path).await;
                    return Err("Falha no download via yt-dlp".to_string());
                }
                break;
            }
        }
    }

    // 1. Lê o metaFilePath de trás para frente para garantir o arquivo mesclado final (com áudio)
    if meta_file_path.exists() {
        if let Ok(content) = tokio::fs::read_to_string(&meta_file_path).await {
            let _ = tokio::fs::remove_file(&meta_file_path).await;
            for line in content.lines().rev() {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    let p = PathBuf::from(trimmed);
                    if p.exists() {
                        return Ok(p);
                    }
                }
            }
        }
    }

    // 2. Fallback: procurar no output_dir o arquivo mais recente baixado
    let mut entries = tokio::fs::read_dir(output_dir).await.map_err(|e| e.to_string())?;
    let mut newest_file: Option<(PathBuf, std::time::SystemTime)> = None;

    while let Ok(Some(entry)) = entries.next_entry().await {
        let p = entry.path();
        if p.is_file() {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !name.starts_with("__rconv") && !name.ends_with(".part") && !name.ends_with(".ytdl") {
                if let Ok(meta) = entry.metadata().await {
                    if let Ok(mtime) = meta.modified() {
                        if newest_file.as_ref().map_or(true, |(_, t)| mtime > *t) {
                            newest_file = Some((p, mtime));
                        }
                    }
                }
            }
        }
    }

    if let Some((path, _)) = newest_file {
        Ok(path)
    } else {
        Err("Não foi possível localizar o arquivo baixado com áudio".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_selector() {
        assert_eq!(get_format_for_quality("best"), "bestvideo*+bestaudio/best");
        assert_eq!(get_format_for_quality("1080p"), "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best");
        assert_eq!(get_format_for_quality("audio"), "bestaudio/best");
        assert_eq!(get_format_for_quality("1440p"), "bestvideo[height<=1440]+bestaudio/best[height<=1440]/best");
    }

    #[test]
    fn test_is_http_url() {
        assert!(is_http_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
        assert!(is_http_url("http://example.com/video.mp4"));
        assert!(!is_http_url("/home/user/video.mp4"));
    }
}
