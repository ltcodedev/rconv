use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use walkdir::WalkDir;

pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    "mp4", "avi", "mkv", "webm", "mov", "flv", "mpeg", "mpg", "wmv", "m4v", "3gp", "3g2",
];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AudioTrackInfo {
    pub index: u32,
    pub codec_name: String,
    pub channels: Option<u32>,
    pub language: Option<String>,
}

pub fn check_ffmpeg() -> bool {
    which::which("ffmpeg").is_ok()
}

pub fn check_ffprobe() -> bool {
    which::which("ffprobe").is_ok()
}

pub fn is_video_file(path: &Path) -> bool {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let ext_lower = ext.to_lowercase();
        SUPPORTED_EXTENSIONS.contains(&ext_lower.as_str())
    } else {
        false
    }
}

pub async fn get_audio_tracks(file: &Path) -> Result<Vec<AudioTrackInfo>, String> {
    if !check_ffprobe() || !file.exists() {
        return Ok(vec![]);
    }

    let output = Command::new("ffprobe")
        .arg("-v")
        .arg("error")
        .arg("-select_streams")
        .arg("a")
        .arg("-show_entries")
        .arg("stream=index,codec_name,channels:stream_tags=language")
        .arg("-of")
        .arg("json")
        .arg(file)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Falha ao executar ffprobe: {}", e))?;

    if !output.status.success() {
        return Ok(vec![]);
    }

    let json_val: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Falha no JSON do ffprobe: {}", e))?;

    let mut tracks = Vec::new();
    if let Some(streams) = json_val["streams"].as_array() {
        for s in streams {
            if let Some(idx) = s["index"].as_u64() {
                let codec = s["codec_name"].as_str().unwrap_or("unknown").to_string();
                let channels = s["channels"].as_u64().map(|c| c as u32);
                let language = s["tags"]["language"].as_str().map(|l| l.to_string());
                tracks.push(AudioTrackInfo {
                    index: idx as u32,
                    codec_name: codec,
                    channels,
                    language,
                });
            }
        }
    }

    Ok(tracks)
}

pub fn collect_video_files(input_path: &Path, recursive: bool) -> Vec<PathBuf> {
    if input_path.is_file() {
        if is_video_file(input_path) {
            return vec![input_path.to_path_buf()];
        }
        return vec![];
    }

    if input_path.is_dir() {
        let max_depth = if recursive { usize::MAX } else { 1 };
        return WalkDir::new(input_path)
            .max_depth(max_depth)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file() && is_video_file(e.path()))
            .map(|e| e.path().to_path_buf())
            .collect();
    }

    vec![]
}

pub fn generate_output_filename(
    input_file: &Path,
    output_dir: &Path,
    base_input_dir: Option<&Path>,
) -> PathBuf {
    let stem = input_file.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
    let clean_stem = stem.trim_end_matches(".converted");
    let filename = format!("{}.mov", clean_stem);

    if let Some(base) = base_input_dir {
        if let Ok(rel) = input_file.strip_prefix(base) {
            if let Some(parent) = rel.parent() {
                if !parent.as_os_str().is_empty() {
                    return output_dir.join(parent).join(filename);
                }
            }
        }
    }

    output_dir.join(filename)
}

#[derive(Debug, Clone)]
pub struct ExternalAudioConfig {
    pub path: PathBuf,
    pub offset_seconds: f64,
}

pub async fn convert_file<F>(
    input_file: &Path,
    output_file: &Path,
    audio_tracks: Option<&[u32]>,
    external_audios: &[ExternalAudioConfig],
    is_audio_only: bool,
    cancelled: Arc<AtomicBool>,
    mut on_progress: F,
) -> Result<PathBuf, String>
where
    F: FnMut(f32, &str) + Send + 'static,
{
    if let Some(parent) = output_file.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    let mut cmd = Command::new("ffmpeg");
    cmd.arg("-y").arg("-i").arg(input_file);

    let has_ext = !external_audios.is_empty();
    for ext in external_audios {
        cmd.arg("-i").arg(&ext.path);
    }

    // Configura filtro complexo para aplicar delay ou trim em cada faixa externa
    let mut ext_filter_labels = Vec::new();
    if has_ext {
        let mut filter_chains = Vec::new();
        for (i, ext) in external_audios.iter().enumerate() {
            let input_idx = i + 1;
            let out_label = format!("ext_a_{}", i);
            let offset = ext.offset_seconds;
            if offset.abs() > 0.005 {
                if offset > 0.0 {
                    let delay_ms = (offset * 1000.0).round() as u64;
                    filter_chains.push(format!("[{}:a]adelay=delays={}:all=1[{}]", input_idx, delay_ms, out_label));
                } else {
                    let trim_sec = -offset;
                    filter_chains.push(format!("[{}:a]atrim=start={:.4},asetpts=PTS-STARTPTS[{}]", input_idx, trim_sec, out_label));
                }
            } else {
                filter_chains.push(format!("[{}:a]anull[{}]", input_idx, out_label));
            }
            ext_filter_labels.push(out_label);
        }
        cmd.arg("-filter_complex").arg(filter_chains.join(";"));
    }

    if is_audio_only {
        cmd.arg("-vn").arg("-c:a").arg("pcm_s16le");
        if let Some(tracks) = audio_tracks {
            if !tracks.is_empty() {
                for &track in tracks {
                    cmd.arg("-map").arg(format!("0:{}", track));
                }
            } else {
                cmd.arg("-map").arg("0:a?");
            }
        } else {
            cmd.arg("-map").arg("0:a?");
        }

        for label in &ext_filter_labels {
            cmd.arg("-map").arg(format!("[{}]", label));
        }
    } else {
        cmd.arg("-c:v").arg("mpeg4").arg("-q:v").arg("0");
        cmd.arg("-c:a").arg("pcm_s16le");

        if let Some(tracks) = audio_tracks {
            if !tracks.is_empty() {
                cmd.arg("-map").arg("0:v:0?");
                for &track in tracks {
                    cmd.arg("-map").arg(format!("0:{}", track));
                }
            } else {
                cmd.arg("-map").arg("0:v:0?").arg("-map").arg("0:a?");
            }
        } else {
            cmd.arg("-map").arg("0:v:0?").arg("-map").arg("0:a?");
        }

        for label in &ext_filter_labels {
            cmd.arg("-map").arg(format!("[{}]", label));
        }
    }

    cmd.arg("-progress")
        .arg("pipe:1")
        .arg(output_file)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Falha ao iniciar FFmpeg: {}", e))?;

    let stdout = child.stdout.take().ok_or("Falha ao abrir stdout do FFmpeg")?;
    let stderr = child.stderr.take().ok_or("Falha ao abrir stderr do FFmpeg")?;

    let mut out_reader = BufReader::new(stdout).lines();
    let mut err_reader = BufReader::new(stderr).lines();

    let duration_regex = regex::Regex::new(r"out_time_ms=(\d+)").unwrap();
    let mut last_error_lines = Vec::new();

    loop {
        if cancelled.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            let _ = tokio::fs::remove_file(output_file).await;
            return Err("Operação cancelada pelo usuário".to_string());
        }

        tokio::select! {
            line_res = out_reader.next_line() => {
                match line_res {
                    Ok(Some(line)) => {
                        if line.starts_with("out_time_ms=") {
                            if let Some(caps) = duration_regex.captures(&line) {
                                if let Ok(microsecs) = caps[1].parse::<u64>() {
                                    let current_sec = microsecs as f64 / 1_000_000.0;
                                    on_progress(50.0, &format!("Convertendo... {:.0}s", current_sec));
                                }
                            }
                        } else if line == "progress=end" {
                            on_progress(100.0, "Conversão finalizada!");
                        }
                    }
                    Ok(None) => {},
                    Err(_) => {},
                }
            }
            err_res = err_reader.next_line() => {
                match err_res {
                    Ok(Some(line)) => {
                        if !line.trim().is_empty() {
                            last_error_lines.push(line);
                            if last_error_lines.len() > 10 {
                                last_error_lines.remove(0);
                            }
                        }
                    }
                    Ok(None) => {},
                    Err(_) => {},
                }
            }
            status = child.wait() => {
                let status = status.map_err(|e| e.to_string())?;
                if !status.success() {
                    let err_summary = last_error_lines.join("\n");
                    return Err(if err_summary.is_empty() {
                        "FFmpeg finalizou com código de erro".to_string()
                    } else {
                        format!("Erro FFmpeg:\n{}", err_summary)
                    });
                }
                break;
            }
        }
    }

    Ok(output_file.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_convert_file_success() {
        let input = PathBuf::from("/tmp/sample_test.mp4");
        let output = PathBuf::from("/tmp/sample_test_out.mov");

        if input.exists() {
            let cancelled = Arc::new(AtomicBool::new(false));
            let res = convert_file(&input, &output, None, &[], false, cancelled, |_pct, _msg| {}).await;
            assert!(res.is_ok(), "Conversion failed: {:?}", res.err());
            assert!(output.exists(), "Output file was not created");
            let _ = tokio::fs::remove_file(&output).await;
        }
    }
}
