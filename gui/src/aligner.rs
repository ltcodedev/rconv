use std::path::Path;
use std::process::Stdio;
use tokio::process::Command;
use rustfft::{FftPlanner, num_complex::Complex};

pub const SUPPORTED_AUDIO_EXTENSIONS: &[&str] = &[
    "wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "wma", "aiff", "mkv", "mp4", "mov",
];

#[allow(dead_code)]
pub struct AlignmentResult {
    /// Offset em segundos do áudio externo em relação ao vídeo.
    /// Positivo (+): O áudio externo começou DEPOIS do vídeo (precisa de atraso/delay).
    /// Negativo (-): O áudio externo começou ANTES do vídeo (precisa de trim/corte no início).
    pub offset_seconds: f64,
    /// Score de correlação (0.0 a 1.0) indicando a confiança no alinhamento.
    pub confidence: f64,
}

/// Extrai áudio mono f32 a uma taxa fixa (ex: 8000 Hz) usando ffmpeg.
pub async fn extract_audio_samples(
    file_path: &Path,
    stream_specifier: &str,
    sample_rate: u32,
    max_duration_sec: u32,
) -> Result<Vec<f32>, String> {
    let mut cmd = Command::new("ffmpeg");
    cmd.arg("-v").arg("error")
        .arg("-ss").arg("0")
        .arg("-t").arg(max_duration_sec.to_string())
        .arg("-i").arg(file_path);

    if !stream_specifier.is_empty() {
        cmd.arg("-map").arg(stream_specifier);
    }

    cmd.arg("-ac").arg("1")
        .arg("-ar").arg(sample_rate.to_string())
        .arg("-f").arg("f32le")
        .arg("pipe:1");

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let output = cmd.output().await.map_err(|e| format!("Erro ao executar ffmpeg para extração de áudio: {}", e))?;

    if !output.status.success() {
        let err_str = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Falha na extração de áudio: {}", err_str));
    }

    let bytes = output.stdout;
    if bytes.len() < 4 {
        return Err("Nenhuma amostra de áudio extraída.".to_string());
    }

    let sample_count = bytes.len() / 4;
    let mut samples = Vec::with_capacity(sample_count);
    for chunk in bytes.chunks_exact(4) {
        let val = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        if val.is_finite() {
            samples.push(val);
        } else {
            samples.push(0.0);
        }
    }

    Ok(samples)
}

/// Normaliza o sinal: remove DC offset (média) e divide pelo desvio padrão / RMS.
fn normalize_signal(signal: &mut [f32]) {
    if signal.is_empty() {
        return;
    }
    let mean = signal.iter().copied().sum::<f32>() / signal.len() as f32;
    for s in signal.iter_mut() {
        *s -= mean;
    }
    let variance = signal.iter().map(|&s| s * s).sum::<f32>() / signal.len() as f32;
    let std_dev = variance.sqrt().max(1e-6);
    for s in signal.iter_mut() {
        *s /= std_dev;
    }
}

/// Calcula a correlação cruzada entre o áudio de referência (vídeo) e o áudio alvo (externo) via FFT.
pub fn calculate_waveform_offset(
    ref_samples: &[f32],
    target_samples: &[f32],
    sample_rate: u32,
) -> Result<AlignmentResult, String> {
    if ref_samples.is_empty() || target_samples.is_empty() {
        return Err("Sinais de áudio vazios para alinhamento.".to_string());
    }

    let mut sig_ref = ref_samples.to_vec();
    let mut sig_tgt = target_samples.to_vec();

    normalize_signal(&mut sig_ref);
    normalize_signal(&mut sig_tgt);

    let min_len = sig_ref.len() + sig_tgt.len() - 1;
    let n = min_len.next_power_of_two();

    let mut buf_ref = vec![Complex::new(0.0f32, 0.0f32); n];
    let mut buf_tgt = vec![Complex::new(0.0f32, 0.0f32); n];

    for (i, &s) in sig_ref.iter().enumerate() {
        buf_ref[i] = Complex::new(s, 0.0);
    }
    for (i, &s) in sig_tgt.iter().enumerate() {
        buf_tgt[i] = Complex::new(s, 0.0);
    }

    let mut planner = FftPlanner::new();
    let fft_forward = planner.plan_fft_forward(n);
    let fft_inverse = planner.plan_fft_inverse(n);

    fft_forward.process(&mut buf_ref);
    fft_forward.process(&mut buf_tgt);

    // Cross-correlation no domínio da frequência: Ref * conj(Tgt)
    let mut cross = vec![Complex::new(0.0f32, 0.0f32); n];
    for i in 0..n {
        cross[i] = buf_ref[i] * buf_tgt[i].conj();
    }

    fft_inverse.process(&mut cross);

    // Encontrar pico de correlação
    // Na correlação circular com zero-padding de tamanho N:
    // Índices 0 .. sig_ref.len() correspondem a lag >= 0
    // Índices n - sig_tgt.len() .. n correspondem a lag < 0
    let mut best_val = f32::MIN;
    let mut best_lag: i64 = 0;

    let max_lag_ref = sig_ref.len() as i64;
    let max_lag_tgt = sig_tgt.len() as i64;

    for i in 0..n {
        let lag: i64 = if (i as i64) < max_lag_ref {
            i as i64
        } else if (i as i64) >= (n as i64 - max_lag_tgt) {
            (i as i64) - (n as i64)
        } else {
            continue;
        };

        let val = cross[i].re / (n as f32);
        if val > best_val {
            best_val = val;
            best_lag = lag;
        }
    }

    // Convenção:
    // Se offset_seconds > 0: o áudio externo começou mais tarde que o vídeo (precisa de delay/atraso).
    // Se offset_seconds < 0: o áudio externo começou antes do vídeo (precisa de trim/corte inicial).
    let offset_seconds = -best_lag as f64 / sample_rate as f64;

    // Confiança aproximada baseada na magnitude do pico normalizado
    let norm_factor = (sig_ref.len() as f32 * sig_tgt.len() as f32).sqrt().max(1.0);
    let confidence = (best_val / norm_factor).clamp(0.0, 1.0) as f64;

    Ok(AlignmentResult {
        offset_seconds,
        confidence,
    })
}

/// Alinha um arquivo de áudio externo com uma faixa de áudio de um vídeo.
pub async fn align_external_audio(
    video_path: &Path,
    video_audio_stream: u32,
    external_audio_path: &Path,
) -> Result<AlignmentResult, String> {
    const SAMPLE_RATE: u32 = 8000;
    const MAX_DURATION_SEC: u32 = 120; // Primeiros 2 minutos são suficientes

    let stream_spec = format!("0:{}", video_audio_stream);
    let ref_samples = extract_audio_samples(video_path, &stream_spec, SAMPLE_RATE, MAX_DURATION_SEC).await?;
    let target_samples = extract_audio_samples(external_audio_path, "0:a:0?", SAMPLE_RATE, MAX_DURATION_SEC).await?;

    calculate_waveform_offset(&ref_samples, &target_samples, SAMPLE_RATE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_offset_detection_with_synthetic_signals() {
        let rate = 8000;
        let len = 8000 * 5; // 5 segundos
        let delay_samples = 800; // 0.1s de atraso

        let mut ref_sig = vec![0.0f32; len];
        let mut tgt_sig = vec![0.0f32; len];

        // Cria um pulso sonoro
        for i in 1000..1500 {
            let s = (i as f32 * 0.1).sin() * 10.0;
            ref_sig[i] = s;
            if i + delay_samples < len {
                tgt_sig[i + delay_samples] = s;
            }
        }

        let res = calculate_waveform_offset(&ref_sig, &tgt_sig, rate).unwrap();
        // tgt está atrasado em delay_samples em relação a ref (começou mais tarde)
        assert!((res.offset_seconds - 0.100).abs() < 0.005, "Offset detectado: {}", res.offset_seconds);
    }
}
